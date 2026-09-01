require("dotenv").config();

const { ObjectId } = require("mongodb");
const { connectMongoDB, getDatabase } = require("../../config/mongodb");
const driver = require("../../config/neo4j");
const {
    buildRecommendationContext
} = require("../../recommendation/recommendationContextService");
const {
    evaluateActivitySessions
} = require("../../recommendation/activitySessionEligibilityService");

const DATASET = "SYSTEM_TEST_V1";
const TEST_DATASET = "STEP14G_E";
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

function findCandidatesByActivityName(context, name) {
    return context.candidates.filter(
        candidate => candidate.currentActivity?.basicInformation?.nameEn === name
    );
}

function requireCandidate(context, name) {
    const matches = findCandidatesByActivityName(context, name);

    assertEqual(`${name} candidate count`, matches.length, 1);

    return matches[0];
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

function findFailure(result, code, fieldPath = undefined) {
    return result.failedConstraints.find(failure => (
        failure.code === code &&
        (
            fieldPath === undefined ||
            failure.fieldPath === fieldPath
        )
    ));
}

function assertNoD5DecisionFields(candidate) {
    const forbiddenFields = [
        "score",
        "rank",
        "finalScore",
        "eligible",
        "eligibility",
        "eligibilityStatus",
        "factors",
        "normalizedWeights",
        "recommendation"
    ];

    for (const field of forbiddenFields) {
        assert(
            !Object.prototype.hasOwnProperty.call(candidate, field),
            `${candidate.activity?.title}: unexpected D5 field ${field}`
        );
    }
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
    assertEqual("Sara candidate count", context.candidates.length, 5);

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
        assertNoD5DecisionFields(candidate);
    }
}

function resolveRequiredCandidates(context) {
    return {
        robotics: requireCandidate(context, "Robotics Lab"),
        painting: requireCandidate(context, "Painting Studio"),
        football: requireCandidate(context, "Football Team Camp"),
        strategy: requireCandidate(context, "Strategy Escape Challenge"),
        creativeRobotics: requireCandidate(context, "Creative Robotics")
    };
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

function assertJoinedSessionCounts(candidates) {
    assertEqual(
        "Robotics joined Sessions",
        candidates.robotics.currentSessions.length,
        2
    );
    assertEqual(
        "Painting joined Sessions",
        candidates.painting.currentSessions.length,
        1
    );
    assertEqual(
        "Football joined Sessions",
        candidates.football.currentSessions.length,
        0
    );
    assertEqual(
        "Strategy joined Sessions",
        candidates.strategy.currentSessions.length,
        1
    );
    assertEqual(
        "Creative Robotics joined Sessions",
        candidates.creativeRobotics.currentSessions.length,
        1
    );

    const totalSessions = Object.values(candidates)
        .reduce(
            (sum, candidate) => sum + candidate.currentSessions.length,
            0
        );

    assertEqual("Total Sara Sessions loaded", totalSessions, 5);
}

function assertJoinedSessionActivityIds(candidates) {
    for (const candidate of Object.values(candidates)) {
        for (const session of candidate.currentSessions) {
            assertEqual(
                `${candidate.currentActivity.basicInformation.nameEn} Session activityId`,
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
        hasGoal(candidates.robotics, "Build Teamwork"),
        "Robotics Lab missing Build Teamwork evidence"
    );
    assert(
        hasInterest(candidates.painting, "Painting"),
        "Painting Studio missing Painting evidence"
    );
}

function assertCandidateNoEligibleSession(result) {
    assertEqual("candidate eligible", result.eligibility.eligible, false);
    assert(
        findFailure(result.eligibility, "NO_ELIGIBLE_SESSION", "currentSessions"),
        "missing NO_ELIGIBLE_SESSION"
    );
}

function assertRobotics(result, fixtures) {
    assertEqual("Robotics eligible", result.eligibility.eligible, true);
    assertEqual("Robotics eligibleSessions", result.eligibleSessions.length, 1);
    assertEqual("Robotics sessionEvaluations", result.sessionEvaluations.length, 2);
    assert(
        result.eligibleSessions.some(
            session => String(session._id) === String(fixtures.roboticsValid._id)
        ),
        "Robotics valid Session must be eligible"
    );
    assert(
        !result.eligibleSessions.some(
            session => String(session._id) === String(fixtures.roboticsFull._id)
        ),
        "Robotics Full Session must not be eligible"
    );

    const failedEvaluation = result.sessionEvaluations.find(
        evaluation => String(evaluation.session._id) === String(fixtures.roboticsFull._id)
    );

    assert(failedEvaluation, "Robotics Full evaluation is required");
    assert(
        findFailure(
            failedEvaluation.eligibility,
            "SESSION_UNAVAILABLE",
            "availability.status"
        ),
        "Robotics Full Session missing SESSION_UNAVAILABLE"
    );
}

function assertPainting(result) {
    assertCandidateNoEligibleSession(result);
    assertEqual("Painting eligibleSessions", result.eligibleSessions.length, 0);
    assertEqual("Painting sessionEvaluations", result.sessionEvaluations.length, 1);
    assertEqual(
        "Painting operational eligible",
        result.sessionEvaluations[0].operationalEligibility.eligible,
        true
    );
    assertEqual(
        "Painting age eligible",
        result.sessionEvaluations[0].ageEligibility.eligible,
        false
    );
    assert(
        findFailure(
            result.sessionEvaluations[0].ageEligibility,
            "AGE_NOT_ELIGIBLE",
            "eligibility.maximumAge"
        ),
        "Painting missing maximum age failure"
    );
}

function assertFootball(result) {
    assertCandidateNoEligibleSession(result);
    assertEqual("Football eligibleSessions", result.eligibleSessions.length, 0);
    assertEqual("Football sessionEvaluations", result.sessionEvaluations.length, 0);
}

function assertStrategy(result) {
    assertCandidateNoEligibleSession(result);
    assertEqual("Strategy eligibleSessions", result.eligibleSessions.length, 0);
    assertEqual("Strategy sessionEvaluations", result.sessionEvaluations.length, 1);
    assert(
        findFailure(
            result.sessionEvaluations[0].eligibility,
            "BOOKING_CLOSED",
            "availability.registrationOpen"
        ),
        "Strategy missing registration closed failure"
    );
}

function assertCreativeRobotics(result) {
    assertEqual("Creative Robotics eligible", result.eligibility.eligible, true);
    assertEqual(
        "Creative Robotics eligibleSessions",
        result.eligibleSessions.length,
        1
    );
    assertEqual(
        "Creative Robotics sessionEvaluations",
        result.sessionEvaluations.length,
        1
    );
    assertEqual(
        "Creative Robotics combined eligible",
        result.sessionEvaluations[0].eligibility.eligible,
        true
    );
}

async function main() {
    await connectMongoDB();

    const db = getDatabase();
    const sessionsCollection = db.collection("sessions");

    try {
        const preClean = await sessionsCollection.deleteMany({
            "metadata.testDataset": TEST_DATASET
        });
        const staleCount = await sessionsCollection.countDocuments({
            "metadata.testDataset": TEST_DATASET
        });

        assertEqual("pre-clean stale Session count", staleCount, 0);

        const sara = await loadSara(db);
        const baselineContext =
            await buildRecommendationContext(sara._id);

        assertBaselineContext(baselineContext);

        const baselineCandidates =
            resolveRequiredCandidates(baselineContext);
        const fixtures = buildTemporarySessions(baselineCandidates);

        assertBsonSessionTypes(fixtures.sessions);

        const insertResult =
            await sessionsCollection.insertMany(fixtures.sessions);

        assertEqual("inserted Session count", insertResult.insertedCount, 5);

        const insertedCount = await sessionsCollection.countDocuments({
            "metadata.testDataset": TEST_DATASET
        });

        assertEqual("temporary Session marker count", insertedCount, 5);

        const rebuiltContext =
            await buildRecommendationContext(sara._id);

        assert(rebuiltContext, "rebuilt Sara context is required");
        assertEqual("rebuilt Sara candidate count", rebuiltContext.candidates.length, 5);

        const candidates = resolveRequiredCandidates(rebuiltContext);

        assertJoinedSessionCounts(candidates);
        assertJoinedSessionActivityIds(candidates);
        assertEvidencePreserved(candidates);

        const roboticsResult = evaluateActivitySessions(
            rebuiltContext,
            candidates.robotics,
            evaluationTime
        );
        const paintingResult = evaluateActivitySessions(
            rebuiltContext,
            candidates.painting,
            evaluationTime
        );
        const footballResult = evaluateActivitySessions(
            rebuiltContext,
            candidates.football,
            evaluationTime
        );
        const strategyResult = evaluateActivitySessions(
            rebuiltContext,
            candidates.strategy,
            evaluationTime
        );
        const creativeRoboticsResult = evaluateActivitySessions(
            rebuiltContext,
            candidates.creativeRobotics,
            evaluationTime
        );

        assertRobotics(roboticsResult, fixtures);
        assertPainting(paintingResult);
        assertEqual(
            "Football currentSessions",
            candidates.football.currentSessions.length,
            0
        );
        assertFootball(footballResult);
        assertStrategy(strategyResult);
        assertCreativeRobotics(creativeRoboticsResult);

        console.log("========================================");
        console.log("STEP 14G-E — REAL SESSION INTEGRATION");
        console.log("========================================");
        console.log("");
        console.log("Stale test Sessions pre-cleaned:       PASSED");
        console.log(`Pre-clean deleted count:               ${preClean.deletedCount}`);
        console.log("Sara fixture resolved exactly once:    PASSED");
        console.log("Baseline zero Sessions:                PASSED");
        console.log("");
        console.log("Temporary Sessions inserted:           5 / 5");
        console.log("Temporary marker count:                5 / 5");
        console.log("BSON Session types:                    PASSED");
        console.log("");
        console.log("Step 13 context rebuilt from Mongo:    PASSED");
        console.log("Robotics Session join:                 2 / 2");
        console.log("Painting Session join:                 1 / 1");
        console.log("Football zero Session join:            0 / 0");
        console.log("Strategy Session join:                 1 / 1");
        console.log("Creative Robotics Session join:        1 / 1");
        console.log("");
        console.log("Session activityId joins:              PASSED");
        console.log("D4 evidence preserved:                 PASSED");
        console.log("");
        console.log("Robotics aggregation:                  PASSED");
        console.log("Painting age rejection:                PASSED");
        console.log("Football no-session rejection:         PASSED");
        console.log("Strategy operational rejection:        PASSED");
        console.log("Creative Robotics aggregation:         PASSED");
        console.log("");
        console.log("Manual Session attachment:             NONE");
        console.log("Seed modification:                     NONE");
        console.log("Scoring/ranking:                       NONE");
        console.log("");
        console.log("========================================");
        console.log("✅ PHASE 14G-E PASSED");
        console.log("========================================");

    } finally {
        const cleanupResult = await sessionsCollection.deleteMany({
            "metadata.testDataset": TEST_DATASET
        });
        const remainingCount = await sessionsCollection.countDocuments({
            "metadata.testDataset": TEST_DATASET
        });

        console.log(
            `STEP14G_E cleanup deleted Sessions: ${cleanupResult.deletedCount}`
        );
        console.log(
            `STEP14G_E remaining Sessions: ${remainingCount}`
        );

        await driver.close();
    }
}

main()
    .then(() => {
        process.exit(0);
    })
    .catch((error) => {
        console.error("❌ PHASE 14G-E FAILED");
        console.error(error);
        process.exit(1);
    });
