require("dotenv").config();

const { ObjectId } = require("mongodb");
const { connectMongoDB, getDatabase } = require("../../config/mongodb");
const driver = require("../../config/neo4j");
const {
    buildRecommendationContext
} = require("../../recommendation/recommendationContextService");

const DATASET = "SYSTEM_TEST_V1";

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

function assertClose(label, actual, expected, tolerance = 0.000001) {
    if (
        typeof actual !== "number" ||
        Math.abs(actual - expected) > tolerance
    ) {
        throw new Error(
            `${label}: expected ${expected}, found ${actual}`
        );
    }
}

function findCandidateByTitle(context, title) {
    return context.candidates.find(
        (candidate) => candidate.activity?.title === title
    );
}

function requireCandidate(context, title) {
    const candidate = findCandidateByTitle(context, title);

    assert(
        candidate,
        `${context.child.identity?.firstName}: missing candidate "${title}"`
    );

    return candidate;
}

function hasInterest(candidate, name) {
    return (candidate.evidence?.interests ?? []).some(
        (interest) => interest.name === name
    );
}

function hasGoal(candidate, name) {
    return (candidate.evidence?.goals ?? []).some(
        (goal) => goal.name === name
    );
}

function requireGoal(candidate, name) {
    const goal = (candidate.evidence?.goals ?? []).find(
        (item) => item.name === name
    );

    assert(
        goal,
        `${candidate.activity.title}: missing goal "${name}"`
    );

    return goal;
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
            `${candidate.activity?.title}: unexpected D5 field "${field}"`
        );
    }
}

function assertNoContextDecisionFields(context) {
    const forbiddenFields = [
        "recommendations",
        "scores",
        "ranking",
        "eligibility",
        "topN"
    ];

    for (const field of forbiddenFields) {
        assert(
            !Object.prototype.hasOwnProperty.call(context, field),
            `context: unexpected D5 field "${field}"`
        );
    }
}

function assertUniqueActivityIds(label, context, expectedCount) {
    const ids = context.candidates.map(
        (candidate) => candidate.activity.activityId
    );

    assertEqual(`${label} candidate count`, ids.length, expectedCount);
    assertEqual(
        `${label} unique Activity IDs`,
        new Set(ids).size,
        ids.length
    );
}

function assertCandidateStructure(context) {
    for (const candidate of context.candidates) {
        assert(candidate.activity, "candidate.activity is required");
        assert(candidate.evidence, "candidate.evidence is required");
        assert(
            Array.isArray(candidate.evidence.interests),
            `${candidate.activity.title}: interests must be an array`
        );
        assert(
            Array.isArray(candidate.evidence.goals),
            `${candidate.activity.title}: goals must be an array`
        );
        assert(
            Array.isArray(candidate.evidence.summary),
            `${candidate.activity.title}: summary must be an array`
        );
        assert(
            candidate.currentActivity,
            `${candidate.activity.title}: currentActivity is required`
        );
        assert(
            candidate.currentVendor,
            `${candidate.activity.title}: currentVendor is required`
        );
        assert(
            Array.isArray(candidate.currentSessions),
            `${candidate.activity.title}: currentSessions must be an array`
        );
        assertEqual(
            `${candidate.activity.title} Activity join`,
            String(candidate.currentActivity._id),
            candidate.activity.activityId
        );
        assertEqual(
            `${candidate.activity.title} Vendor join`,
            String(candidate.currentVendor._id),
            String(candidate.currentActivity.vendorId)
        );
        assertEqual(
            `${candidate.activity.title} Session count`,
            candidate.currentSessions.length,
            0
        );
        assertNoD5DecisionFields(candidate);
    }
}

function assertOperationalMongoShape(context) {
    for (const candidate of context.candidates) {
        const activity = candidate.currentActivity;
        const vendor = candidate.currentVendor;

        assert(
            activity._id instanceof ObjectId,
            `${candidate.activity.title}: Activity _id must be ObjectId`
        );
        assert(
            activity.vendorId instanceof ObjectId,
            `${candidate.activity.title}: Activity vendorId must be ObjectId`
        );
        assert(
            vendor._id instanceof ObjectId,
            `${candidate.activity.title}: Vendor _id must be ObjectId`
        );
        assert(
            activity.basicInformation,
            `${candidate.activity.title}: basicInformation is required`
        );
        assert(
            activity.classification,
            `${candidate.activity.title}: classification is required`
        );
        assert(
            activity.eligibility,
            `${candidate.activity.title}: eligibility is required`
        );
        assert(
            activity.classification.subcategoryId instanceof ObjectId,
            `${candidate.activity.title}: subcategoryId must be ObjectId`
        );
    }
}

function assertExactTitles(context, expectedTitles) {
    assertEqual(
        `${context.child.identity?.firstName} title count`,
        context.candidates.length,
        expectedTitles.length
    );

    for (const title of expectedTitles) {
        const matchingCandidates = context.candidates.filter(
            (candidate) => candidate.activity.title === title
        );

        assertEqual(`${title} candidate occurrences`, matchingCandidates.length, 1);
        assertEqual(
            `${title} Mongo title`,
            matchingCandidates[0].currentActivity.basicInformation.nameEn,
            title
        );
    }
}

function assertSaraEvidence(context) {
    const roboticsLab = requireCandidate(context, "Robotics Lab");
    assert(hasInterest(roboticsLab, "Robotics"), "Robotics Lab missing Robotics");
    assert(
        hasGoal(roboticsLab, "Improve Problem Solving"),
        "Robotics Lab missing Improve Problem Solving"
    );
    assert(
        hasGoal(roboticsLab, "Build Teamwork"),
        "Robotics Lab missing Build Teamwork"
    );

    const paintingStudio = requireCandidate(context, "Painting Studio");
    assert(
        hasInterest(paintingStudio, "Painting"),
        "Painting Studio missing Painting"
    );
    assertEqual(
        "Painting Studio goal count",
        paintingStudio.evidence.goals.length,
        0
    );

    const footballCamp = requireCandidate(context, "Football Team Camp");
    assertEqual(
        "Football Team Camp interest count",
        footballCamp.evidence.interests.length,
        0
    );
    assert(
        hasGoal(footballCamp, "Build Teamwork"),
        "Football Team Camp missing Build Teamwork"
    );

    const strategyChallenge =
        requireCandidate(context, "Strategy Escape Challenge");
    assert(
        hasGoal(strategyChallenge, "Improve Problem Solving"),
        "Strategy Escape Challenge missing Improve Problem Solving"
    );
    assert(
        hasGoal(strategyChallenge, "Build Teamwork"),
        "Strategy Escape Challenge missing Build Teamwork"
    );

    const creativeRobotics = requireCandidate(context, "Creative Robotics");
    assert(
        hasInterest(creativeRobotics, "Robotics"),
        "Creative Robotics missing Robotics"
    );
    assert(
        hasGoal(creativeRobotics, "Improve Problem Solving"),
        "Creative Robotics missing Improve Problem Solving"
    );
}

function assertOmarEvidence(context) {
    const footballCamp = requireCandidate(context, "Football Team Camp");
    assert(hasInterest(footballCamp, "Football"), "Omar Football missing interest");
    assert(
        hasGoal(footballCamp, "Build Teamwork"),
        "Omar Football missing Build Teamwork"
    );

    const strategyChallenge =
        requireCandidate(context, "Strategy Escape Challenge");
    assert(
        hasGoal(strategyChallenge, "Build Teamwork"),
        "Omar Strategy missing Build Teamwork"
    );
    assertEqual(
        "Omar Strategy interest count",
        strategyChallenge.evidence.interests.length,
        0
    );

    const roboticsLab = requireCandidate(context, "Robotics Lab");
    assert(
        hasGoal(roboticsLab, "Build Teamwork"),
        "Omar Robotics missing Build Teamwork"
    );
    assertEqual(
        "Omar Robotics interest count",
        roboticsLab.evidence.interests.length,
        0
    );
}

function assertLinaEvidence(context) {
    assertExactTitles(context, [
        "Painting Studio",
        "Creative Robotics"
    ]);

    for (const candidate of context.candidates) {
        assertEqual(
            `${candidate.activity.title} Lina interest count`,
            candidate.evidence.interests.length,
            0
        );
        requireGoal(candidate, "Grow Creativity");
    }

    const creativeRobotics = requireCandidate(context, "Creative Robotics");
    const creativity = requireGoal(creativeRobotics, "Grow Creativity");

    assertClose(
        "Lina Creative Robotics activityOutcomeWeight",
        creativity.activityOutcomeWeight,
        0.60
    );
}

function assertContextShape(context, child, expectedCount) {
    assert(context, `${child.identity?.firstName} context is required`);
    assert(context.child, "context.child is required");
    assert(context.parent, "context.parent is required");
    assert(
        Array.isArray(context.candidates),
        "context.candidates must be an array"
    );
    assertEqual(
        `${child.identity?.firstName} Child _id`,
        String(context.child._id),
        String(child._id)
    );
    assertEqual(
        `${child.identity?.firstName} Parent _id`,
        String(context.parent._id),
        String(child.parentId)
    );
    assertEqual(
        `${child.identity?.firstName} candidate count`,
        context.candidates.length,
        expectedCount
    );
    assertNoContextDecisionFields(context);
}

function assertSaraChildDocument(context) {
    assert(context.child.identity, "Sara identity is required");
    assertEqual(
        "Sara firstName",
        context.child.identity.firstName,
        "Sara"
    );
    assert(
        context.child.identity.dateOfBirth,
        "Sara dateOfBirth is required"
    );
    assert(context.child.parentId, "Sara parentId is required");
    assert(context.child.preferences, "Sara preferences are required");
    assert(
        Array.isArray(context.child.parentGoals),
        "Sara parentGoals must be an array"
    );
    assert(context.child.status, "Sara status is required");
}

async function loadChildByName(db, name) {
    const child = await db.collection("children").findOne({
        "identity.firstName": name,
        "metadata.testDataset": DATASET
    });

    assert(child, `${name} not found`);
    assert(child.parentId, `${name} parentId is required`);

    return child;
}

async function assertBaseline(db) {
    const sara = await loadChildByName(db, "Sara");
    const omar = await loadChildByName(db, "Omar");
    const lina = await loadChildByName(db, "Lina");

    const activityCount = await db.collection("activities").countDocuments({
        "metadata.testDataset": DATASET
    });
    const vendorCount = await db.collection("vendors").countDocuments({
        "metadata.testDataset": DATASET
    });
    const sessionCount = await db.collection("sessions").countDocuments({
        "metadata.testDataset": DATASET
    });

    assertEqual("SYSTEM_TEST_V1 Activity count", activityCount, 5);
    assertEqual("SYSTEM_TEST_V1 Vendor count", vendorCount, 2);
    assertEqual("SYSTEM_TEST_V1 Session count", sessionCount, 0);

    return {
        sara,
        omar,
        lina
    };
}

async function main() {
    await connectMongoDB();

    const db = getDatabase();

    try {
        const { sara, omar, lina } = await assertBaseline(db);

        const saraContext =
            await buildRecommendationContext(sara._id);
        const omarContext =
            await buildRecommendationContext(omar._id);
        const linaContext =
            await buildRecommendationContext(lina._id);

        assertContextShape(saraContext, sara, 5);
        assertContextShape(omarContext, omar, 3);
        assertContextShape(linaContext, lina, 2);

        assertSaraChildDocument(saraContext);
        assert(saraContext.parent.account, "Sara parent account is required");

        assertCandidateStructure(saraContext);
        assertCandidateStructure(omarContext);
        assertCandidateStructure(linaContext);

        assertOperationalMongoShape(saraContext);
        assertOperationalMongoShape(omarContext);
        assertOperationalMongoShape(linaContext);

        assertUniqueActivityIds("Sara", saraContext, 5);
        assertUniqueActivityIds("Omar", omarContext, 3);
        assertUniqueActivityIds("Lina", linaContext, 2);

        assertExactTitles(saraContext, [
            "Robotics Lab",
            "Painting Studio",
            "Football Team Camp",
            "Strategy Escape Challenge",
            "Creative Robotics"
        ]);

        assertSaraEvidence(saraContext);
        assertOmarEvidence(omarContext);
        assertLinaEvidence(linaContext);

        assertEqual(
            "Sara/Omar shared Parent",
            String(saraContext.parent._id),
            String(omarContext.parent._id)
        );
        assert(
            String(linaContext.parent._id) !== String(saraContext.parent._id),
            "Lina must resolve to a different Parent"
        );

        const saraStringContext =
            await buildRecommendationContext(String(sara._id));

        assert(saraStringContext, "Sara string context is required");
        assertEqual(
            "Sara string Child _id",
            String(saraStringContext.child._id),
            String(saraContext.child._id)
        );
        assertEqual(
            "Sara string Parent _id",
            String(saraStringContext.parent._id),
            String(saraContext.parent._id)
        );
        assertEqual(
            "Sara string candidate count",
            saraStringContext.candidates.length,
            5
        );

        const saraActivityIds = new Set(
            saraContext.candidates.map(
                (candidate) => candidate.activity.activityId
            )
        );
        const saraStringActivityIds = new Set(
            saraStringContext.candidates.map(
                (candidate) => candidate.activity.activityId
            )
        );

        assertEqual(
            "Sara string Activity ID set size",
            saraStringActivityIds.size,
            saraActivityIds.size
        );

        for (const activityId of saraActivityIds) {
            assert(
                saraStringActivityIds.has(activityId),
                `Sara string context missing Activity ${activityId}`
            );
        }

        const missingContext =
            await buildRecommendationContext(new ObjectId().toString());

        assertEqual("Missing Child context", missingContext, null);

        const allContexts = [
            saraContext,
            omarContext,
            linaContext
        ];

        for (const context of allContexts) {
            assertNoContextDecisionFields(context);

            for (const candidate of context.candidates) {
                assertNoD5DecisionFields(candidate);
                assertEqual(
                    `${context.child.identity.firstName} ` +
                    `${candidate.activity.title} Session count`,
                    candidate.currentSessions.length,
                    0
                );
            }
        }

        const totalCandidates =
            saraContext.candidates.length +
            omarContext.candidates.length +
            linaContext.candidates.length;

        assertEqual("Total candidate rows", totalCandidates, 10);

        console.log("========================================");
        console.log("STEP 13G — RECOMMENDATION CONTEXT TEST");
        console.log("========================================");
        console.log("");
        console.log("Child loading:                    PASSED");
        console.log("Parent loading:                   PASSED");
        console.log("D4 candidate discovery:           PASSED");
        console.log("Mongo Activity revalidation:      PASSED");
        console.log("Mongo Vendor loading:             PASSED");
        console.log("Mongo Session loading:            PASSED");
        console.log("");
        console.log("Sara candidates:                  5 / 5");
        console.log("Omar candidates:                  3 / 3");
        console.log("Lina candidates:                  2 / 2");
        console.log("Total candidate rows:            10");
        console.log("");
        console.log("Candidate IDs:                    VALID");
        console.log("Candidate uniqueness:             VALID");
        console.log("Current Activity joins:           VALID");
        console.log("Current Vendor joins:             VALID");
        console.log("Current Session arrays:           VALID");
        console.log("");
        console.log("Interest evidence:                PRESERVED");
        console.log("Goal evidence:                    PRESERVED");
        console.log("Evidence summaries:               PRESERVED");
        console.log("");
        console.log("String childId input:             PASSED");
        console.log("Missing Child returns null:       PASSED");
        console.log("");
        console.log("Positive Session join:            NOT COVERED");
        console.log("Reason: SYSTEM_TEST_V1 has 0 Sessions");
        console.log("");
        console.log("Candidate filtering:              NONE");
        console.log("Eligibility decisions:            NONE");
        console.log("Scoring fields:                   NONE");
        console.log("Ranking fields:                   NONE");
        console.log("");
        console.log("========================================");
        console.log("✅ PHASE 13G PASSED");
        console.log("========================================");
        console.log("✅ STEP 13 RECOMMENDATION CONTEXT: COMPLETE");
        console.log("========================================");

    } finally {
        await driver.close();
    }
}

main()
    .then(() => {
        process.exit(0);
    })
    .catch((error) => {
        console.error("❌ PHASE 13G FAILED");
        console.error(error);
        process.exit(1);
    });
