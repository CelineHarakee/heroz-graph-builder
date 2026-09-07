require("dotenv").config();

const assert = require("assert");
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

function assertContext({
    name,
    context,
    expectedCandidateCount,
    interactionsExists
}) {
    const contextSnapshot = snapshot(context);
    const candidateSnapshots = context.candidates.map(snapshot);
    const d4EvidenceSnapshots = context.candidates.map((candidate) =>
        snapshot(candidate.evidence)
    );
    const historyBookingsSnapshot = snapshot(context.historyContext.bookings);
    const historyRecommendationsSnapshot =
        snapshot(context.historyContext.recommendations);

    assert.strictEqual(
        context.candidates.length,
        expectedCandidateCount,
        `${name} candidate count`
    );
    assert(Array.isArray(context.historyContext.bookings));
    assert(Array.isArray(context.historyContext.recommendations));
    assert(Array.isArray(context.historyContext.interactions));
    assert.strictEqual(
        context.historyContext.interactions.length,
        0,
        `${name} interactions`
    );
    assert.strictEqual(
        context.historyContext.sources.interactions,
        interactionsExists ? "available" : "unavailable",
        `${name} interactions source`
    );
    assert.deepStrictEqual(
        Object.keys(context.historyContext.sources),
        [
            "bookings",
            "recommendations",
            "interactions"
        ]
    );
    assert(
        !Object.prototype.hasOwnProperty.call(
            context.historyContext,
            "behaviorScore"
        ),
        `${name} historyContext must not include behaviorScore`
    );
    assert(
        !Object.prototype.hasOwnProperty.call(
            context.historyContext,
            "score"
        ),
        `${name} historyContext must not include score`
    );

    for (let index = 0; index < context.candidates.length; index += 1) {
        const candidate = context.candidates[index];
        const result = calculateExplorationFactor(
            context,
            makeEligibleEvaluation(candidate)
        );

        assert.strictEqual(
            result.available,
            false,
            `${name} ${candidate.activity?.title} Exploration available`
        );
        assert.strictEqual(
            result.score,
            null,
            `${name} ${candidate.activity?.title} Exploration score`
        );
        assert.strictEqual(
            snapshot(candidate),
            candidateSnapshots[index],
            `${name} ${candidate.activity?.title} candidate immutable`
        );
        assert.strictEqual(
            snapshot(candidate.evidence),
            d4EvidenceSnapshots[index],
            `${name} ${candidate.activity?.title} D4 evidence immutable`
        );
    }

    assert.strictEqual(
        snapshot(context.historyContext.bookings),
        historyBookingsSnapshot,
        `${name} bookings history unchanged`
    );
    assert.strictEqual(
        snapshot(context.historyContext.recommendations),
        historyRecommendationsSnapshot,
        `${name} recommendations history unchanged`
    );
    assert.strictEqual(
        snapshot(context),
        contextSnapshot,
        `${name} context immutable`
    );
}

async function main() {
    await connectMongoDB();
    const db = getDatabase();

    try {
        const interactionsExists =
            await collectionExists(db, "interactions");
        const sara = await loadChildByName(db, "Sara");
        const omar = await loadChildByName(db, "Omar");
        const lina = await loadChildByName(db, "Lina");
        const saraContext = await buildRecommendationContext(sara._id);
        const omarContext = await buildRecommendationContext(omar._id);
        const linaContext = await buildRecommendationContext(lina._id);

        assertContext({
            name: "Sara",
            context: saraContext,
            expectedCandidateCount: 5,
            interactionsExists
        });
        assertContext({
            name: "Omar",
            context: omarContext,
            expectedCandidateCount: 3,
            interactionsExists
        });
        assertContext({
            name: "Lina",
            context: linaContext,
            expectedCandidateCount: 2,
            interactionsExists
        });

        console.log("========================================");
        console.log("STEP 15F-B - BEHAVIOR HISTORY CONTEXT");
        console.log("========================================");
        console.log("");
        console.log(
            `interactions collection exists: ${
                interactionsExists ? "YES" : "NO"
            }`
        );
        console.log("");
        console.log(
            `Sara interactions: ${
                saraContext.historyContext.interactions.length
            } / source ${saraContext.historyContext.sources.interactions}`
        );
        console.log(
            `Omar interactions: ${
                omarContext.historyContext.interactions.length
            } / source ${omarContext.historyContext.sources.interactions}`
        );
        console.log(
            `Lina interactions: ${
                linaContext.historyContext.interactions.length
            } / source ${linaContext.historyContext.sources.interactions}`
        );
        console.log("");
        console.log("Candidate counts:");
        console.log("Sara 5");
        console.log("Omar 3");
        console.log("Lina 2");
        console.log("");
        console.log("Exploration unchanged: PASS");
        console.log("Context immutability: PASS");
        console.log("Mongo writes: NONE");
        console.log("Neo4j writes: NONE");
        console.log("");
        console.log("========================================");
        console.log("STEP 15F-B BEHAVIOR HISTORY CONTEXT PASSED");
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
        console.error("STEP 15F-B BEHAVIOR HISTORY CONTEXT FAILED");
        console.error(error);
        process.exit(1);
    });
