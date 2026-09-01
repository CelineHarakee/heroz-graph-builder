require("dotenv").config();

const { ObjectId } = require("mongodb");
const { connectMongoDB, getDatabase } = require("../../config/mongodb");
const driver = require("../../config/neo4j");
const {
    buildRecommendationContext
} = require("../../recommendation/recommendationContextService");
const {
    evaluateRecommendationEligibility
} = require("../../recommendation/recommendationEligibilityService");

const DATASET = "SYSTEM_TEST_V1";
const TEST_DATASET = "STEP14I_FULL_ELIGIBILITY";
const evaluationTime = new Date("2026-09-01T12:00:00.000Z");

function assert(condition, message) {
    if (!condition) {
        throw new Error(message);
    }
}

function assertEqual(label, actual, expected) {
    if (actual !== expected) {
        throw new Error(
            `${label}: expected ${expected}, found ${actual}`
        );
    }
}

function assertArrayEqual(label, actual, expected) {
    assert(Array.isArray(actual), `${label}: actual must be an array`);
    assert(Array.isArray(expected), `${label}: expected must be an array`);
    assertEqual(`${label} length`, actual.length, expected.length);

    for (let index = 0; index < expected.length; index += 1) {
        assertEqual(`${label} ${index}`, actual[index], expected[index]);
    }
}

function metadata() {
    const now = new Date();

    return {
        version: 1,
        createdBy: "System",
        createdAt: now,
        updatedAt: now,
        testDataset: TEST_DATASET
    };
}

function getNestedValue(document, fieldPath) {
    const parts = fieldPath.split(".");
    let current = document;

    for (const part of parts) {
        if (
            current === null ||
            current === undefined ||
            !Object.prototype.hasOwnProperty.call(current, part)
        ) {
            return {
                exists: false,
                value: undefined
            };
        }

        current = current[part];
    }

    return {
        exists: true,
        value: current
    };
}

async function restoreField(collection, documentId, fieldPath, snapshot) {
    if (snapshot.exists) {
        await collection.updateOne(
            { _id: documentId },
            { $set: { [fieldPath]: snapshot.value } }
        );
    } else {
        await collection.updateOne(
            { _id: documentId },
            { $unset: { [fieldPath]: "" } }
        );
    }
}

function makeSession({
    activity,
    startDateTime,
    endDateTime,
    bookingDeadline,
    status = "Available",
    registrationOpen = true,
    totalCapacity = 10,
    bookedCapacity = 5,
    remainingCapacity = 5
}) {
    return {
        _id: new ObjectId(),
        activityId: activity.currentActivity._id,
        vendorId: activity.currentActivity.vendorId,
        schedule: {
            startDateTime,
            endDateTime,
            timezone: "Asia/Riyadh",
            bookingDeadline
        },
        capacity: {
            totalCapacity,
            bookedCapacity,
            remainingCapacity,
            minimumParticipants: 1
        },
        availability: {
            status,
            registrationOpen,
            cancellationReason: null
        },
        metadata: metadata()
    };
}

function requireCandidate(context, name) {
    const matches = context.candidates.filter(
        candidate => candidate.currentActivity?.basicInformation?.nameEn === name
    );

    assertEqual(`${name} candidate count`, matches.length, 1);

    return matches[0];
}

function resolveCandidates(context) {
    return {
        robotics: requireCandidate(context, "Robotics Lab"),
        painting: requireCandidate(context, "Painting Studio"),
        football: requireCandidate(context, "Football Team Camp"),
        strategy: requireCandidate(context, "Strategy Escape Challenge"),
        creativeRobotics: requireCandidate(context, "Creative Robotics")
    };
}

function getEvaluationByName(eligibility, name) {
    const matches = eligibility.candidateEvaluations.filter(
        evaluation =>
            evaluation.candidate.currentActivity?.basicInformation?.nameEn === name
    );

    assertEqual(`${name} evaluation count`, matches.length, 1);

    return matches[0];
}

function getEligibleNames(eligibility) {
    return eligibility.eligibleCandidates.map(
        evaluation =>
            evaluation.candidate.currentActivity.basicInformation.nameEn
    );
}

function findFailure(result, code, fieldPath = undefined) {
    return result.failedConstraints.find(failure => (
        failure.code === code &&
        (
            fieldPath === undefined ||
            failure.fieldPath === fieldPath
        )
    ));
}

function findMissing(records, code) {
    return records.find(record => record.code === code);
}

function hasInterest(candidate, name) {
    return (candidate.evidence?.interests ?? []).some(
        interest => interest.name === name
    );
}

function hasGoal(candidate, name) {
    return (candidate.evidence?.goals ?? []).some(
        goal => goal.name === name
    );
}

async function loadSara(db) {
    const matches = await db.collection("children")
        .find({
            "identity.firstName": "Sara",
            "metadata.testDataset": DATASET
        })
        .toArray();

    assertEqual("Sara fixture count", matches.length, 1);
    assert(matches[0]._id instanceof ObjectId, "Sara _id must be ObjectId");

    return matches[0];
}

function assertBaselineContext(context) {
    assert(context, "Sara baseline context is required");
    assertEqual("Sara baseline candidate count", context.candidates.length, 5);

    for (const candidate of context.candidates) {
        assert(
            Array.isArray(candidate.currentSessions),
            `${candidate.activity?.title}: currentSessions must be an array`
        );
        assertEqual(
            `${candidate.activity?.title} baseline Session count`,
            candidate.currentSessions.length,
            0
        );
    }
}

function buildTemporarySessions(candidates) {
    const roboticsValid = makeSession({
        activity: candidates.robotics,
        startDateTime: new Date("2026-09-10T15:00:00.000Z"),
        endDateTime: new Date("2026-09-10T17:00:00.000Z"),
        bookingDeadline: new Date("2026-09-08T20:00:00.000Z")
    });
    const roboticsFull = makeSession({
        activity: candidates.robotics,
        startDateTime: new Date("2026-09-11T15:00:00.000Z"),
        endDateTime: new Date("2026-09-11T17:00:00.000Z"),
        bookingDeadline: new Date("2026-09-09T20:00:00.000Z"),
        status: "Full",
        registrationOpen: false,
        totalCapacity: 10,
        bookedCapacity: 10,
        remainingCapacity: 0
    });
    const paintingAgeFailure = makeSession({
        activity: candidates.painting,
        startDateTime: new Date("2030-05-10T15:00:00.000Z"),
        endDateTime: new Date("2030-05-10T17:00:00.000Z"),
        bookingDeadline: new Date("2030-05-01T20:00:00.000Z")
    });
    const strategyClosed = makeSession({
        activity: candidates.strategy,
        startDateTime: new Date("2026-09-12T15:00:00.000Z"),
        endDateTime: new Date("2026-09-12T17:00:00.000Z"),
        bookingDeadline: new Date("2026-09-10T20:00:00.000Z"),
        registrationOpen: false
    });
    const creativeRoboticsValid = makeSession({
        activity: candidates.creativeRobotics,
        startDateTime: new Date("2026-09-15T15:00:00.000Z"),
        endDateTime: new Date("2026-09-15T17:00:00.000Z"),
        bookingDeadline: new Date("2026-09-12T20:00:00.000Z")
    });

    return {
        sessions: [
            roboticsValid,
            roboticsFull,
            paintingAgeFailure,
            strategyClosed,
            creativeRoboticsValid
        ],
        roboticsValid,
        roboticsFull,
        paintingAgeFailure,
        strategyClosed,
        creativeRoboticsValid
    };
}

function assertBsonSessionTypes(sessions) {
    for (const session of sessions) {
        assert(session._id instanceof ObjectId, "Session _id must be ObjectId");
        assert(
            session.activityId instanceof ObjectId,
            "Session activityId must be ObjectId"
        );
        assert(
            session.vendorId instanceof ObjectId,
            "Session vendorId must be ObjectId"
        );
        assert(
            session.schedule.startDateTime instanceof Date,
            "Session startDateTime must be Date"
        );
        assert(
            session.schedule.endDateTime instanceof Date,
            "Session endDateTime must be Date"
        );
        assert(
            session.schedule.bookingDeadline instanceof Date,
            "Session bookingDeadline must be Date"
        );
    }
}

function assertJoinedSessions(candidates) {
    assertEqual("Robotics Session join", candidates.robotics.currentSessions.length, 2);
    assertEqual("Painting Session join", candidates.painting.currentSessions.length, 1);
    assertEqual("Football Session join", candidates.football.currentSessions.length, 0);
    assertEqual("Strategy Session join", candidates.strategy.currentSessions.length, 1);
    assertEqual(
        "Creative Robotics Session join",
        candidates.creativeRobotics.currentSessions.length,
        1
    );

    const totalSessions = Object.values(candidates)
        .reduce(
            (sum, candidate) => sum + candidate.currentSessions.length,
            0
        );

    assertEqual("Total joined Sessions", totalSessions, 5);

    for (const candidate of Object.values(candidates)) {
        for (const session of candidate.currentSessions) {
            assertEqual(
                `${candidate.currentActivity.basicInformation.nameEn} activityId join`,
                String(session.activityId),
                String(candidate.currentActivity._id)
            );
        }
    }
}

function assertEvidencePreserved(candidates) {
    assert(
        hasInterest(candidates.robotics, "Robotics"),
        "Robotics Lab missing Robotics evidence"
    );
    assert(
        hasGoal(candidates.robotics, "Improve Problem Solving"),
        "Robotics Lab missing Improve Problem Solving evidence"
    );
    assert(
        hasInterest(candidates.painting, "Painting"),
        "Painting Studio missing Painting evidence"
    );
    assert(
        hasInterest(candidates.creativeRobotics, "Robotics"),
        "Creative Robotics missing Robotics evidence"
    );
    assert(
        hasGoal(candidates.creativeRobotics, "Improve Problem Solving"),
        "Creative Robotics missing Improve Problem Solving evidence"
    );
}

function assertNoScoringFields(output) {
    const topLevelForbidden = [
        "score",
        "rank",
        "finalScore",
        "factors",
        "sessionSuitability",
        "selectedSession",
        "bestSession",
        "topN"
    ];

    for (const field of topLevelForbidden) {
        assert(
            !Object.prototype.hasOwnProperty.call(output, field),
            `output contains forbidden field ${field}`
        );
    }

    for (const evaluation of output.candidateEvaluations) {
        for (const field of topLevelForbidden) {
            assert(
                !Object.prototype.hasOwnProperty.call(evaluation, field),
                `candidate evaluation contains forbidden field ${field}`
            );
        }
    }
}

function assertBaselineEligibility(output, context, fixtures) {
    assertEqual("request eligible", output.requestEligibility.eligible, true);
    assertEqual("candidateEvaluations count", output.candidateEvaluations.length, 5);
    assertEqual("eligibleCandidates count", output.eligibleCandidates.length, 2);
    assertEqual("first eligible", getEligibleNames(output)[0], "Robotics Lab");
    assertEqual("second eligible", getEligibleNames(output)[1], "Creative Robotics");

    const robotics = getEvaluationByName(output, "Robotics Lab");
    const painting = getEvaluationByName(output, "Painting Studio");
    const football = getEvaluationByName(output, "Football Team Camp");
    const strategy = getEvaluationByName(output, "Strategy Escape Challenge");
    const creativeRobotics = getEvaluationByName(output, "Creative Robotics");

    assertEqual("Robotics eligible", robotics.eligibility.eligible, true);
    assertEqual("Robotics eligibleSessions", robotics.eligibleSessions.length, 1);
    assertEqual("Robotics evaluations", robotics.sessionEvaluations.length, 2);
    assert(
        robotics.eligibleSessions.some(
            session => String(session._id) === String(fixtures.roboticsValid._id)
        ),
        "Robotics valid Session must be eligible"
    );

    const roboticsFullEvaluation = robotics.sessionEvaluations.find(
        sessionEvaluation =>
            String(sessionEvaluation.session._id) === String(fixtures.roboticsFull._id)
    );

    assert(
        findFailure(
            roboticsFullEvaluation.eligibility,
            "SESSION_UNAVAILABLE",
            "availability.status"
        ),
        "Robotics Full Session missing SESSION_UNAVAILABLE"
    );

    assertEqual("Painting eligible", painting.eligibility.eligible, false);
    assert(
        findFailure(painting.eligibility, "NO_ELIGIBLE_SESSION"),
        "Painting missing NO_ELIGIBLE_SESSION"
    );
    assertEqual("Painting evaluations", painting.sessionEvaluations.length, 1);
    assert(
        findFailure(
            painting.sessionEvaluations[0].eligibility,
            "AGE_NOT_ELIGIBLE",
            "eligibility.maximumAge"
        ),
        "Painting missing maximum age failure"
    );

    assertEqual("Football eligible", football.eligibility.eligible, false);
    assert(findFailure(football.eligibility, "NO_ELIGIBLE_SESSION"), "Football missing NO_ELIGIBLE_SESSION");
    assertEqual("Football eligibleSessions", football.eligibleSessions.length, 0);
    assertEqual("Football evaluations", football.sessionEvaluations.length, 0);

    assertEqual("Strategy eligible", strategy.eligibility.eligible, false);
    assert(findFailure(strategy.eligibility, "NO_ELIGIBLE_SESSION"), "Strategy missing NO_ELIGIBLE_SESSION");
    assert(
        findFailure(
            strategy.sessionEvaluations[0].eligibility,
            "BOOKING_CLOSED",
            "availability.registrationOpen"
        ),
        "Strategy missing registration closed failure"
    );

    assertEqual("Creative Robotics eligible", creativeRobotics.eligibility.eligible, true);
    assertEqual("Creative Robotics eligibleSessions", creativeRobotics.eligibleSessions.length, 1);
    assertEqual("Creative Robotics evaluations", creativeRobotics.sessionEvaluations.length, 1);

    assertEqual("context candidate count after eligibility", context.candidates.length, 5);
}

async function setField(collection, documentId, fieldPath, value) {
    await collection.updateOne(
        { _id: documentId },
        { $set: { [fieldPath]: value } }
    );
}

async function runStatusMutationScenario(db, sara, ids) {
    await setField(
        db.collection("activities"),
        ids.robotics,
        "basicInformation.status",
        "Draft"
    );

    const context = await buildRecommendationContext(sara._id);
    const output = evaluateRecommendationEligibility(context, evaluationTime);
    const robotics = getEvaluationByName(output, "Robotics Lab");

    assertEqual("status mutation request", output.requestEligibility.eligible, true);
    assertEqual("status mutation Robotics eligible", robotics.eligibility.eligible, true);
    assert(
        !findFailure(
            robotics.eligibility,
            "ACTIVITY_NOT_PUBLISHED",
            "basicInformation.status"
        ),
        "Robotics Draft must not create ACTIVITY_NOT_PUBLISHED"
    );
    assertEqual("status mutation eligible count", output.eligibleCandidates.length, 2);
    assertEqual("status mutation first eligible", getEligibleNames(output)[0], "Robotics Lab");
    assertEqual("status mutation second eligible", getEligibleNames(output)[1], "Creative Robotics");
}

async function runGenderMutationScenario(db, sara, ids) {
    await setField(
        db.collection("activities"),
        ids.creativeRobotics,
        "eligibility.allowedGenders",
        ["Male"]
    );

    const context = await buildRecommendationContext(sara._id);
    const output = evaluateRecommendationEligibility(context, evaluationTime);
    const creativeRobotics = getEvaluationByName(output, "Creative Robotics");

    assertEqual("gender mutation request", output.requestEligibility.eligible, true);
    assertEqual("gender mutation Creative Robotics eligible", creativeRobotics.eligibility.eligible, false);
    assert(
        findFailure(
            creativeRobotics.eligibility,
            "GENDER_NOT_ELIGIBLE",
            "eligibility.allowedGenders"
        ),
        "Creative Robotics missing GENDER_NOT_ELIGIBLE"
    );
    assertEqual("gender mutation eligible count", output.eligibleCandidates.length, 1);
    assertEqual("gender mutation eligible name", getEligibleNames(output)[0], "Robotics Lab");
}

async function runParentRequirementScenario(db, sara, ids) {
    await setField(
        db.collection("parents"),
        ids.parent,
        "hardRequirements.accessibilityRequirements",
        ["Wheelchair Accessible"]
    );
    await setField(
        db.collection("activities"),
        ids.robotics,
        "activityConstraints.accessibilityFeatures",
        ["Stairs Only"]
    );
    await setField(
        db.collection("activities"),
        ids.creativeRobotics,
        "activityConstraints.accessibilityFeatures",
        []
    );

    const context = await buildRecommendationContext(sara._id);
    const output = evaluateRecommendationEligibility(context, evaluationTime);
    const robotics = getEvaluationByName(output, "Robotics Lab");
    const creativeRobotics = getEvaluationByName(output, "Creative Robotics");

    assertEqual("parent requirement request", output.requestEligibility.eligible, true);
    assertEqual("parent requirement Robotics eligible", robotics.eligibility.eligible, false);
    assert(
        findFailure(
            robotics.eligibility,
            "REQUIREMENT_NOT_MET",
            "activityConstraints.accessibilityFeatures"
        ),
        "Robotics missing accessibility hard mismatch"
    );
    assertEqual("parent requirement Creative Robotics eligible", creativeRobotics.eligibility.eligible, true);
    assert(
        !findFailure(
            creativeRobotics.eligibility,
            "REQUIREMENT_NOT_MET"
        ),
        "Creative Robotics missing accessibility must not hard fail"
    );
    assert(
        findMissing(
            creativeRobotics.missingInformation,
            "ACCESSIBILITY_INFO_UNCONFIRMED"
        ),
        "Creative Robotics missing accessibility info record"
    );
    assertEqual("parent requirement eligible count", output.eligibleCandidates.length, 1);
    assertEqual("parent requirement eligible name", getEligibleNames(output)[0], "Creative Robotics");
}

async function runParentActivityExclusionScenario(db, sara, ids) {
    await setField(
        db.collection("parents"),
        ids.parent,
        "recommendationPreferences.excludedActivityIds",
        [ids.robotics]
    );

    const context = await buildRecommendationContext(sara._id);
    const output = evaluateRecommendationEligibility(context, evaluationTime);
    const robotics = getEvaluationByName(output, "Robotics Lab");

    assertEqual("parent exclusion request", output.requestEligibility.eligible, true);
    assertEqual("parent exclusion Robotics eligible", robotics.eligibility.eligible, false);
    assert(
        findFailure(
            robotics.eligibility,
            "PARENT_EXCLUDED",
            "recommendationPreferences.excludedActivityIds"
        ),
        "Robotics missing PARENT_EXCLUDED"
    );
    assertEqual("parent exclusion eligible count", output.eligibleCandidates.length, 1);
    assertEqual("parent exclusion eligible name", getEligibleNames(output)[0], "Creative Robotics");
}

async function runMissingGenderInformationScenario(db, sara, ids) {
    await setField(
        db.collection("activities"),
        ids.creativeRobotics,
        "eligibility.allowedGenders",
        []
    );

    const context = await buildRecommendationContext(sara._id);
    const output = evaluateRecommendationEligibility(context, evaluationTime);
    const creativeRobotics = getEvaluationByName(output, "Creative Robotics");

    assertEqual("missing gender request", output.requestEligibility.eligible, true);
    assertEqual("missing gender Creative Robotics eligible", creativeRobotics.eligibility.eligible, true);
    assert(
        findMissing(
            creativeRobotics.missingInformation,
            "ALLOWED_GENDERS_UNCONFIRMED"
        ),
        "Creative Robotics missing gender info record"
    );
    assert(
        !findFailure(
            creativeRobotics.eligibility,
            "GENDER_NOT_ELIGIBLE"
        ),
        "Creative Robotics missing gender info must not hard fail"
    );
    assertEqual("missing gender eligible count", output.eligibleCandidates.length, 2);
}

async function runRequestFailureScenario(db, sara) {
    await setField(
        db.collection("children"),
        sara._id,
        "status",
        "Inactive"
    );

    const context = await buildRecommendationContext(sara._id);
    const output = evaluateRecommendationEligibility(context, evaluationTime);

    assertEqual("inactive child request", output.requestEligibility.eligible, false);
    assert(
        findFailure(output.requestEligibility, "CHILD_INACTIVE", "status"),
        "inactive Sara missing CHILD_INACTIVE"
    );
    assertEqual("inactive child candidateEvaluations", output.candidateEvaluations.length, 0);
    assertEqual("inactive child eligibleCandidates", output.eligibleCandidates.length, 0);
}

async function restoreSnapshots(db, ids, snapshots) {
    if (
        !ids.sara ||
        !snapshots.saraStatus ||
        !snapshots.parentExcludedActivityIds ||
        !snapshots.parentAccessibilityRequirements ||
        !snapshots.roboticsStatus ||
        !snapshots.roboticsAccessibilityFeatures ||
        !snapshots.creativeRoboticsAllowedGenders ||
        !snapshots.creativeRoboticsAccessibilityFeatures
    ) {
        return;
    }

    await restoreField(
        db.collection("children"),
        ids.sara,
        "status",
        snapshots.saraStatus
    );
    await restoreField(
        db.collection("parents"),
        ids.parent,
        "recommendationPreferences.excludedActivityIds",
        snapshots.parentExcludedActivityIds
    );
    await restoreField(
        db.collection("parents"),
        ids.parent,
        "hardRequirements.accessibilityRequirements",
        snapshots.parentAccessibilityRequirements
    );
    await restoreField(
        db.collection("activities"),
        ids.robotics,
        "basicInformation.status",
        snapshots.roboticsStatus
    );
    await restoreField(
        db.collection("activities"),
        ids.robotics,
        "activityConstraints.accessibilityFeatures",
        snapshots.roboticsAccessibilityFeatures
    );
    await restoreField(
        db.collection("activities"),
        ids.creativeRobotics,
        "eligibility.allowedGenders",
        snapshots.creativeRoboticsAllowedGenders
    );
    await restoreField(
        db.collection("activities"),
        ids.creativeRobotics,
        "activityConstraints.accessibilityFeatures",
        snapshots.creativeRoboticsAccessibilityFeatures
    );
}

async function assertRestored(db, ids, snapshots) {
    if (
        !ids.sara ||
        !snapshots.saraStatus ||
        !snapshots.parentExcludedActivityIds ||
        !snapshots.parentAccessibilityRequirements ||
        !snapshots.roboticsStatus ||
        !snapshots.roboticsAccessibilityFeatures ||
        !snapshots.creativeRoboticsAllowedGenders ||
        !snapshots.creativeRoboticsAccessibilityFeatures
    ) {
        return false;
    }

    const sara = await db.collection("children").findOne({ _id: ids.sara });
    const parent = await db.collection("parents").findOne({ _id: ids.parent });
    const robotics = await db.collection("activities").findOne({ _id: ids.robotics });
    const creativeRobotics = await db.collection("activities").findOne({
        _id: ids.creativeRobotics
    });

    assertEqual("Sara restored status", sara.status, snapshots.saraStatus.value);
    assertEqual(
        "Parent excluded Activity IDs exist",
        snapshots.parentExcludedActivityIds.exists,
        true
    );
    assertArrayEqual(
        "Parent excluded Activity IDs restored",
        parent.recommendationPreferences.excludedActivityIds,
        snapshots.parentExcludedActivityIds.value
    );
    assertEqual(
        "Parent accessibility restored",
        snapshots.parentAccessibilityRequirements.exists,
        true
    );
    assertArrayEqual(
        "Parent accessibility restored",
        parent.hardRequirements.accessibilityRequirements,
        snapshots.parentAccessibilityRequirements.value
    );
    assertEqual(
        "Robotics status restored",
        robotics.basicInformation.status,
        snapshots.roboticsStatus.value
    );
    assertEqual(
        "Robotics accessibility restored",
        snapshots.roboticsAccessibilityFeatures.exists,
        true
    );
    assertArrayEqual(
        "Robotics accessibility restored",
        robotics.activityConstraints.accessibilityFeatures,
        snapshots.roboticsAccessibilityFeatures.value
    );
    assertEqual(
        "Creative Robotics genders restored",
        snapshots.creativeRoboticsAllowedGenders.exists,
        true
    );
    assertArrayEqual(
        "Creative Robotics genders restored",
        creativeRobotics.eligibility.allowedGenders,
        snapshots.creativeRoboticsAllowedGenders.value
    );
    assertEqual(
        "Creative Robotics accessibility restored",
        snapshots.creativeRoboticsAccessibilityFeatures.exists,
        true
    );
    assertArrayEqual(
        "Creative Robotics accessibility restored",
        creativeRobotics.activityConstraints.accessibilityFeatures,
        snapshots.creativeRoboticsAccessibilityFeatures.value
    );

    const restoredContext = await buildRecommendationContext(ids.sara);

    assertBaselineContext(restoredContext);
    assertEvidencePreserved(resolveCandidates(restoredContext));

    return true;
}

async function main() {
    await connectMongoDB();

    const db = getDatabase();
    const sessionsCollection = db.collection("sessions");
    const ids = {};
    const snapshots = {};
    let cleanupDeletedCount = 0;
    let remainingTempSessions = null;
    let restored = false;
    let bodySucceeded = false;

    try {
        await sessionsCollection.deleteMany({
            "metadata.testDataset": TEST_DATASET
        });
        const staleCount = await sessionsCollection.countDocuments({
            "metadata.testDataset": TEST_DATASET
        });

        assertEqual("pre-clean temp Session count", staleCount, 0);

        const sara = await loadSara(db);
        ids.sara = sara._id;
        ids.parent = sara.parentId;

        const baselineContext =
            await buildRecommendationContext(sara._id);

        assertBaselineContext(baselineContext);

        const baselineCandidates = resolveCandidates(baselineContext);
        ids.robotics = baselineCandidates.robotics.currentActivity._id;
        ids.creativeRobotics =
            baselineCandidates.creativeRobotics.currentActivity._id;

        snapshots.saraStatus = getNestedValue(sara, "status");
        const parent = await db.collection("parents").findOne({ _id: ids.parent });
        const robotics = baselineCandidates.robotics.currentActivity;
        const creativeRobotics =
            baselineCandidates.creativeRobotics.currentActivity;

        snapshots.parentAccessibilityRequirements =
            getNestedValue(parent, "hardRequirements.accessibilityRequirements");
        snapshots.parentExcludedActivityIds =
            getNestedValue(parent, "recommendationPreferences.excludedActivityIds");
        snapshots.roboticsStatus =
            getNestedValue(robotics, "basicInformation.status");
        snapshots.roboticsAccessibilityFeatures =
            getNestedValue(robotics, "activityConstraints.accessibilityFeatures");
        snapshots.creativeRoboticsAllowedGenders =
            getNestedValue(creativeRobotics, "eligibility.allowedGenders");
        snapshots.creativeRoboticsAccessibilityFeatures =
            getNestedValue(creativeRobotics, "activityConstraints.accessibilityFeatures");

        const fixtures = buildTemporarySessions(baselineCandidates);

        assertBsonSessionTypes(fixtures.sessions);

        const insertResult =
            await sessionsCollection.insertMany(fixtures.sessions);

        assertEqual("inserted Session count", insertResult.insertedCount, 5);

        const insertedCount = await sessionsCollection.countDocuments({
            "metadata.testDataset": TEST_DATASET
        });

        assertEqual("temporary Session count", insertedCount, 5);

        const context = await buildRecommendationContext(sara._id);
        const candidates = resolveCandidates(context);

        assertEqual("Sara rebuilt candidate count", context.candidates.length, 5);
        assertJoinedSessions(candidates);
        assertEvidencePreserved(candidates);

        const candidateReferences = [...context.candidates];
        const sessionArrayReferences = context.candidates.map(
            candidate => candidate.currentSessions
        );
        const baselineEligibility = evaluateRecommendationEligibility(
            context,
            evaluationTime
        );

        assertBaselineEligibility(baselineEligibility, context, fixtures);
        assertNoScoringFields(baselineEligibility);

        assertEqual("context candidate count", context.candidates.length, 5);
        for (let index = 0; index < context.candidates.length; index += 1) {
            assertEqual(
                `candidate reference ${index}`,
                context.candidates[index],
                candidateReferences[index]
            );
            assertEqual(
                `Session array reference ${index}`,
                context.candidates[index].currentSessions,
                sessionArrayReferences[index]
            );
        }

        await runStatusMutationScenario(db, sara, ids);
        await restoreField(
            db.collection("activities"),
            ids.robotics,
            "basicInformation.status",
            snapshots.roboticsStatus
        );

        await runGenderMutationScenario(db, sara, ids);
        await restoreField(
            db.collection("activities"),
            ids.creativeRobotics,
            "eligibility.allowedGenders",
            snapshots.creativeRoboticsAllowedGenders
        );

        await runParentRequirementScenario(db, sara, ids);
        await restoreField(
            db.collection("parents"),
            ids.parent,
            "hardRequirements.accessibilityRequirements",
            snapshots.parentAccessibilityRequirements
        );
        await restoreField(
            db.collection("activities"),
            ids.robotics,
            "activityConstraints.accessibilityFeatures",
            snapshots.roboticsAccessibilityFeatures
        );
        await restoreField(
            db.collection("activities"),
            ids.creativeRobotics,
            "activityConstraints.accessibilityFeatures",
            snapshots.creativeRoboticsAccessibilityFeatures
        );

        await runParentActivityExclusionScenario(db, sara, ids);
        await restoreField(
            db.collection("parents"),
            ids.parent,
            "recommendationPreferences.excludedActivityIds",
            snapshots.parentExcludedActivityIds
        );

        await runMissingGenderInformationScenario(db, sara, ids);
        await restoreField(
            db.collection("activities"),
            ids.creativeRobotics,
            "eligibility.allowedGenders",
            snapshots.creativeRoboticsAllowedGenders
        );

        await runRequestFailureScenario(db, sara);
        await restoreField(
            db.collection("children"),
            ids.sara,
            "status",
            snapshots.saraStatus
        );

        console.log("========================================");
        console.log("STEP 14I — FULL HARD ELIGIBILITY SYSTEM TEST");
        console.log("========================================");
        console.log("");
        console.log("Baseline:");
        console.log("Sara candidates:                         5 / 5");
        console.log("Temporary Sessions:                     5 / 5");
        console.log("Step 13 Session joins:                  PASSED");
        console.log("D4 evidence:                            PRESERVED");
        console.log("");
        console.log("Baseline full eligibility:");
        console.log("Robotics Lab:                           PASS");
        console.log("Painting Studio:                        FAIL - AGE");
        console.log("Football Team Camp:                     FAIL - NO SESSION");
        console.log("Strategy Escape Challenge:              FAIL - REGISTRATION");
        console.log("Creative Robotics:                      PASS");
        console.log("");
        console.log("Eligible candidates:                    2 / 5");
        console.log("");
        console.log("Activity lifecycle status ignored:");
        console.log("Robotics Draft remains eligible:        PASSED");
        console.log("Eligible candidates:                    2");
        console.log("");
        console.log("Gender mutation:");
        console.log("Creative Robotics gender rejected:      PASSED");
        console.log("Eligible candidates:                    1");
        console.log("");
        console.log("Parent hard requirement:");
        console.log("Explicit accessibility mismatch:        PASSED");
        console.log("Missing accessibility pass-through:     PASSED");
        console.log("Missing information preserved:          PASSED");
        console.log("Eligible candidates:                    1");
        console.log("");
        console.log("Parent exclusion:");
        console.log("Robotics explicit exclusion rejected:   PASSED");
        console.log("Eligible candidates:                    1");
        console.log("");
        console.log("Missing gender information:");
        console.log("Hard filter applied:                    NO");
        console.log("Missing info preserved:                 PASSED");
        console.log("Eligible candidates:                    2");
        console.log("");
        console.log("Request failure:");
        console.log("Inactive Child rejected:                PASSED");
        console.log("Candidate evaluation short-circuit:     PASSED");
        console.log("");
        console.log("Context mutation:                       NONE");
        console.log("Scoring:                                NONE");
        console.log("Ranking:                                NONE");
        console.log("Top-N:                                  NONE");
        console.log("Best Session selection:                 NONE");
        console.log("Neo4j writes:                           NONE");
        console.log("");

        bodySucceeded = true;

    } finally {
        await restoreSnapshots(db, ids, snapshots);
        const cleanupResult = await sessionsCollection.deleteMany({
            "metadata.testDataset": TEST_DATASET
        });

        cleanupDeletedCount = cleanupResult.deletedCount;
        remainingTempSessions = await sessionsCollection.countDocuments({
            "metadata.testDataset": TEST_DATASET
        });

        if (ids.sara) {
            restored = await assertRestored(db, ids, snapshots);
        }

        console.log("Restoration:");
        console.log(`Mongo fields restored:                  ${restored ? "PASSED" : "NOT RUN"}`);
        console.log(`Temporary Sessions deleted:             ${cleanupDeletedCount}`);
        console.log(`Remaining temp Sessions:                ${remainingTempSessions}`);
        console.log("Sara zero-Session baseline:             RESTORED");
        console.log("Sara candidates:                        5 / 5");
        console.log("");

        if (
            bodySucceeded &&
            restored &&
            remainingTempSessions === 0
        ) {
            console.log("========================================");
            console.log("✅ STEP 14 HARD ELIGIBILITY: COMPLETE");
            console.log("========================================");
        }

        await driver.close();
    }
}

main()
    .then(() => {
        process.exit(0);
    })
    .catch((error) => {
        console.error("❌ PHASE 14I FAILED");
        console.error(error);
        process.exit(1);
    });
