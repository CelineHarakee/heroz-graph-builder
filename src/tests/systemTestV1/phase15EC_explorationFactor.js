require("dotenv").config();

const { ObjectId } = require("mongodb");
const { connectMongoDB, getDatabase } = require("../../config/mongodb");
const driver = require("../../config/neo4j");
const {
    buildRecommendationContext
} = require("../../recommendation/recommendationContextService");
const {
    calculateExplorationFactor
} = require("../../recommendation/explorationFactorService");

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

function snapshot(value) {
    return JSON.stringify(value);
}

async function loadChildByName(db, name) {
    const child = await db.collection("children").findOne({
        "identity.firstName": name,
        "metadata.testDataset": DATASET
    });

    assert(child, `${name} not found`);
    assert(child._id instanceof ObjectId, `${name} _id must be ObjectId`);

    return child;
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

function assertUnavailableExploration(context, label) {
    const contextSnapshot = snapshot(context);

    for (const candidate of context.candidates) {
        const candidateSnapshot = snapshot(candidate);
        const result = calculateExplorationFactor(
            context,
            makeEligibleEvaluation(candidate)
        );

        assertEqual(
            `${label} ${candidate.activity.title} factor`,
            result.factor,
            "exploration"
        );
        assertEqual(
            `${label} ${candidate.activity.title} available`,
            result.available,
            false
        );
        assertEqual(
            `${label} ${candidate.activity.title} score`,
            result.score,
            null
        );
        assert(
            result.evidence.some((item) =>
                item.type === "history_source_unavailable" &&
                item.source === "bookings"
            ),
            `${label} ${candidate.activity.title} missing bookings ` +
            "unavailable evidence"
        );
        assert(
            result.evidence.some((item) =>
                item.type === "history_source_unavailable" &&
                item.source === "recommendations"
            ),
            `${label} ${candidate.activity.title} missing recommendations ` +
            "unavailable evidence"
        );
        assertEqual(
            `${label} ${candidate.activity.title} candidate immutable`,
            snapshot(candidate),
            candidateSnapshot
        );
    }

    assertEqual(`${label} context immutable`, snapshot(context), contextSnapshot);
}

async function main() {
    await connectMongoDB();

    const db = getDatabase();

    try {
        const sara = await loadChildByName(db, "Sara");
        const omar = await loadChildByName(db, "Omar");
        const lina = await loadChildByName(db, "Lina");

        const saraContext = await buildRecommendationContext(sara._id);
        const omarContext = await buildRecommendationContext(omar._id);
        const linaContext = await buildRecommendationContext(lina._id);

        assertEqual("Sara candidate count", saraContext.candidates.length, 5);
        assertEqual("Omar candidate count", omarContext.candidates.length, 3);
        assertEqual("Lina candidate count", linaContext.candidates.length, 2);

        assertEqual(
            "Sara bookings source",
            saraContext.historyContext.sources.bookings,
            "unavailable"
        );
        assertEqual(
            "Sara recommendations source",
            saraContext.historyContext.sources.recommendations,
            "unavailable"
        );
        assertEqual(
            "Omar bookings source",
            omarContext.historyContext.sources.bookings,
            "unavailable"
        );
        assertEqual(
            "Omar recommendations source",
            omarContext.historyContext.sources.recommendations,
            "unavailable"
        );
        assertEqual(
            "Lina bookings source",
            linaContext.historyContext.sources.bookings,
            "unavailable"
        );
        assertEqual(
            "Lina recommendations source",
            linaContext.historyContext.sources.recommendations,
            "unavailable"
        );

        assertUnavailableExploration(saraContext, "Sara");
        assertUnavailableExploration(omarContext, "Omar");
        assertUnavailableExploration(linaContext, "Lina");

        console.log("========================================");
        console.log("STEP 15E-C - REAL EXPLORATION FACTOR");
        console.log("========================================");
        console.log("");
        console.log("History sources:");
        console.log("Bookings: unavailable");
        console.log("Recommendations: unavailable");
        console.log("");
        console.log("Sara candidates: 5 - all Exploration unavailable/null");
        console.log("Omar candidates: 3 - all Exploration unavailable/null");
        console.log("Lina candidates: 2 - all Exploration unavailable/null");
        console.log("");
        console.log("Candidate filtering: NONE");
        console.log("Mongo writes: NONE");
        console.log("Neo4j writes: NONE");
        console.log("");
        console.log("========================================");
        console.log("STEP 15E-C REAL EXPLORATION FACTOR TEST PASSED");
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
        console.error("STEP 15E-C REAL EXPLORATION FACTOR TEST FAILED");
        console.error(error);
        process.exit(1);
    });
