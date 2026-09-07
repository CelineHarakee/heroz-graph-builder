require("dotenv").config();

const nodeAssert = require("assert");
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

function snapshot(value) {
    return JSON.stringify(value);
}

async function collectionExists(db, collectionName) {
    const collections = await db.listCollections(
        { name: collectionName },
        { nameOnly: true }
    ).toArray();

    return collections.length > 0;
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

function assertHistoryContext(context, expectedSources) {
    assert(context.historyContext, "historyContext is required");
    assert(
        Array.isArray(context.historyContext.bookings),
        "historyContext.bookings must be an Array"
    );
    assert(
        Array.isArray(context.historyContext.recommendations),
        "historyContext.recommendations must be an Array"
    );
    assert(
        Array.isArray(context.historyContext.interactions),
        "historyContext.interactions must be an Array"
    );
    nodeAssert.deepStrictEqual(
        context.historyContext.sources,
        expectedSources
    );
    assert(
        !Object.prototype.hasOwnProperty.call(
            context.historyContext,
            "score"
        ),
        "historyContext must not contain score"
    );
    assert(
        !Object.prototype.hasOwnProperty.call(
            context.historyContext,
            "novelty"
        ),
        "historyContext must not contain novelty"
    );
    assert(
        !Object.prototype.hasOwnProperty.call(
            context.historyContext,
            "experienced"
        ),
        "historyContext must not contain experienced"
    );
}

function assertNoDecisionFields(context) {
    for (const candidate of context.candidates) {
        for (const field of [
            "finalScore",
            "weightedScore",
            "normalizedScore",
            "rank",
            "explorationScore",
            "behaviorScore"
        ]) {
            assert(
                !Object.prototype.hasOwnProperty.call(candidate, field),
                `${candidate.activity?.title} must not include ${field}`
            );
        }
    }
}

async function main() {
    await connectMongoDB();

    const db = getDatabase();

    try {
        const bookingsExists =
            await collectionExists(db, "bookings");
        const recommendationsExists =
            await collectionExists(db, "recommendations");
        const interactionsExists =
            await collectionExists(db, "interactions");
        const expectedSources = {
            bookings: bookingsExists ? "available" : "unavailable",
            recommendations: recommendationsExists ? "available" : "unavailable",
            interactions: interactionsExists ? "available" : "unavailable"
        };

        const sara = await loadChildByName(db, "Sara");
        const omar = await loadChildByName(db, "Omar");
        const lina = await loadChildByName(db, "Lina");

        const saraContext = await buildRecommendationContext(sara._id);
        const omarContext = await buildRecommendationContext(omar._id);
        const linaContext = await buildRecommendationContext(lina._id);

        const saraSnapshot = snapshot(saraContext);
        const omarSnapshot = snapshot(omarContext);
        const linaSnapshot = snapshot(linaContext);

        assertEqual("Sara candidate count", saraContext.candidates.length, 5);
        assertEqual("Omar candidate count", omarContext.candidates.length, 3);
        assertEqual("Lina candidate count", linaContext.candidates.length, 2);

        assertHistoryContext(saraContext, expectedSources);
        assertHistoryContext(omarContext, expectedSources);
        assertHistoryContext(linaContext, expectedSources);

        assertEqual("Sara bookings", saraContext.historyContext.bookings.length, 0);
        assertEqual(
            "Sara recommendations",
            saraContext.historyContext.recommendations.length,
            0
        );
        assertEqual("Omar bookings", omarContext.historyContext.bookings.length, 0);
        assertEqual(
            "Omar recommendations",
            omarContext.historyContext.recommendations.length,
            0
        );
        assertEqual("Lina bookings", linaContext.historyContext.bookings.length, 0);
        assertEqual(
            "Lina recommendations",
            linaContext.historyContext.recommendations.length,
            0
        );

        assert(saraContext.interestContext, "Sara interestContext required");
        assert(saraContext.goalContext, "Sara goalContext required");
        assert(omarContext.interestContext, "Omar interestContext required");
        assert(omarContext.goalContext, "Omar goalContext required");
        assert(linaContext.interestContext, "Lina interestContext required");
        assert(linaContext.goalContext, "Lina goalContext required");

        assertNoDecisionFields(saraContext);
        assertNoDecisionFields(omarContext);
        assertNoDecisionFields(linaContext);

        assertEqual("Sara context immutable", snapshot(saraContext), saraSnapshot);
        assertEqual("Omar context immutable", snapshot(omarContext), omarSnapshot);
        assertEqual("Lina context immutable", snapshot(linaContext), linaSnapshot);

        console.log("========================================");
        console.log("STEP 15E-B - EXPLORATION HISTORY CONTEXT");
        console.log("========================================");
        console.log("");
        console.log(
            `bookings collection exists: ${
                bookingsExists ? "YES" : "NO"
            }`
        );
        console.log(
            `recommendations collection exists: ${
                recommendationsExists ? "YES" : "NO"
            }`
        );
        console.log("");
        console.log(`Sara bookings: ${saraContext.historyContext.bookings.length}`);
        console.log(
            `Sara recommendations: ${
                saraContext.historyContext.recommendations.length
            }`
        );
        console.log(`Omar bookings: ${omarContext.historyContext.bookings.length}`);
        console.log(
            `Omar recommendations: ${
                omarContext.historyContext.recommendations.length
            }`
        );
        console.log(`Lina bookings: ${linaContext.historyContext.bookings.length}`);
        console.log(
            `Lina recommendations: ${
                linaContext.historyContext.recommendations.length
            }`
        );
        console.log("");
        console.log("Candidate counts:");
        console.log("Sara 5");
        console.log("Omar 3");
        console.log("Lina 2");
        console.log("");
        console.log("No Exploration scoring: YES");
        console.log("No Behavioral scoring: YES");
        console.log("Mongo writes: NONE");
        console.log("Neo4j writes: NONE");
        console.log("");
        console.log("========================================");
        console.log("STEP 15E-B EXPLORATION HISTORY CONTEXT TEST PASSED");
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
        console.error("STEP 15E-B EXPLORATION HISTORY CONTEXT TEST FAILED");
        console.error(error);
        process.exit(1);
    });
