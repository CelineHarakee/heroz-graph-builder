require("dotenv").config();

const assert = require("assert");
const { ObjectId } = require("mongodb");
const { connectMongoDB, getDatabase } = require("../../config/mongodb");
const driver = require("../../config/neo4j");
const {
    buildRecommendationContext
} = require("../../recommendation/recommendationContextService");
const {
    calculateSessionFactor
} = require("../../recommendation/sessionFactorService");

const DATASET = "SYSTEM_TEST_V1";

async function loadChildByName(db, name) {
    const child = await db.collection("children").findOne({
        "identity.firstName": name,
        "metadata.testDataset": DATASET
    });

    assert(child, `${name} not found`);
    assert(child._id instanceof ObjectId, `${name} _id must be ObjectId`);

    return child;
}

async function getPermanentSessionCount(db) {
    const activities = await db.collection("activities")
        .find({
            "metadata.testDataset": DATASET
        })
        .project({
            _id: 1
        })
        .toArray();
    const activityIds = activities.map((activity) => activity._id);

    if (activityIds.length === 0) {
        return 0;
    }

    return await db.collection("sessions").countDocuments({
        activityId: {
            $in: activityIds
        }
    });
}

function makeEligibleEvaluation(candidate) {
    return {
        candidate,
        eligibility: {
            eligible: true,
            failedConstraints: []
        },
        eligibleSessions: [],
        sessionEvaluations: [],
        missingInformation: []
    };
}

function snapshot(value) {
    return JSON.stringify(value);
}

function assertSessionUnavailable(result, label) {
    assert.strictEqual(result.factor, "session", `${label} factor`);
    assert.strictEqual(result.available, false, `${label} available`);
    assert.strictEqual(result.score, null, `${label} score`);
    assert(
        result.evidence.some((item) => item.type === "no_preferred_days"),
        `${label} must include no_preferred_days evidence`
    );
}

function assertContext({
    name,
    context,
    expectedCandidateCount
}) {
    const contextSnapshot = snapshot(context);
    const parentPreference =
        context.parent?.recommendationPreferences?.preferredDays;

    assert.strictEqual(
        context.candidates.length,
        expectedCandidateCount,
        `${name} candidate count`
    );
    assert.deepStrictEqual(
        parentPreference,
        [],
        `${name} preferredDays`
    );

    for (const candidate of context.candidates) {
        const candidateSnapshot = snapshot(candidate);

        assert(Array.isArray(candidate.currentSessions));
        assert.strictEqual(
            candidate.currentSessions.length,
            0,
            `${name} ${candidate.activity?.title} permanent sessions`
        );

        const result = calculateSessionFactor(
            makeEligibleEvaluation(candidate),
            context
        );

        assertSessionUnavailable(
            result,
            `${name} ${candidate.activity?.title}`
        );
        assert.strictEqual(
            snapshot(candidate),
            candidateSnapshot,
            `${name} ${candidate.activity?.title} candidate immutable`
        );
    }

    assert.strictEqual(
        snapshot(context),
        contextSnapshot,
        `${name} context immutable`
    );
}

function printResults(label, context) {
    console.log(`${label}:`);

    for (const candidate of context.candidates) {
        console.log(`${candidate.activity?.title}: Session null`);
    }
}

async function main() {
    await connectMongoDB();
    const db = getDatabase();

    try {
        const permanentSessionCount = await getPermanentSessionCount(db);
        const sara = await loadChildByName(db, "Sara");
        const omar = await loadChildByName(db, "Omar");
        const lina = await loadChildByName(db, "Lina");
        const saraContext = await buildRecommendationContext(sara._id);
        const omarContext = await buildRecommendationContext(omar._id);
        const linaContext = await buildRecommendationContext(lina._id);

        assert.strictEqual(
            permanentSessionCount,
            0,
            "SYSTEM_TEST_V1 permanent Sessions"
        );

        assertContext({
            name: "Sara",
            context: saraContext,
            expectedCandidateCount: 5
        });
        assertContext({
            name: "Omar",
            context: omarContext,
            expectedCandidateCount: 3
        });
        assertContext({
            name: "Lina",
            context: linaContext,
            expectedCandidateCount: 2
        });

        console.log("========================================");
        console.log("STEP 15G-C - REAL SESSION FACTOR");
        console.log("========================================");
        console.log("");
        console.log("Permanent Sessions: 0");
        console.log("Parent preferredDays: []");
        console.log("");
        console.log("Sara candidates: 5");
        printResults("Sara", saraContext);
        console.log("");
        console.log("Omar candidates: 3");
        printResults("Omar", omarContext);
        console.log("");
        console.log("Lina candidates: 2");
        printResults("Lina", linaContext);
        console.log("");
        console.log("Candidate filtering: NONE");
        console.log("Mongo writes: NONE");
        console.log("Neo4j writes: NONE");
        console.log("");
        console.log("========================================");
        console.log("STEP 15G-C REAL SESSION FACTOR PASSED");
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
        console.error("STEP 15G-C REAL SESSION FACTOR FAILED");
        console.error(error);
        process.exit(1);
    });
