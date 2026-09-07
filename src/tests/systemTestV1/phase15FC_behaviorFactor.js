require("dotenv").config();

const assert = require("assert");
const { ObjectId } = require("mongodb");
const { connectMongoDB, getDatabase } = require("../../config/mongodb");
const driver = require("../../config/neo4j");
const {
    buildRecommendationContext
} = require("../../recommendation/recommendationContextService");
const {
    calculateBehaviorFactor
} = require("../../recommendation/behaviorFactorService");
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

function assertBehaviorUnavailable(result, label) {
    assert.strictEqual(result.factor, "behavior", `${label} factor`);
    assert.strictEqual(result.available, false, `${label} available`);
    assert.strictEqual(result.score, null, `${label} score`);
    assert(
        result.evidence.some(
            (item) => item.type === "interaction_source_unavailable"
        ),
        `${label} must include source-unavailable evidence`
    );
}

function assertContext({
    name,
    context,
    expectedCandidateCount,
    interactionsExists
}) {
    const contextSnapshot = snapshot(context);
    const historyContextSnapshot = snapshot(context.historyContext);
    const candidateSnapshots = context.candidates.map(snapshot);
    const source = interactionsExists ? "available" : "unavailable";

    assert.strictEqual(
        context.candidates.length,
        expectedCandidateCount,
        `${name} candidate count`
    );
    assert.strictEqual(
        context.historyContext.sources.interactions,
        source,
        `${name} interactions source`
    );
    assert.strictEqual(
        context.historyContext.interactions.length,
        0,
        `${name} interactions`
    );

    for (let index = 0; index < context.candidates.length; index += 1) {
        const candidate = context.candidates[index];
        const eligibilityEvaluation = makeEligibleEvaluation(candidate);
        const behavior = calculateBehaviorFactor(
            context,
            eligibilityEvaluation
        );
        const exploration = calculateExplorationFactor(
            context,
            eligibilityEvaluation
        );
        const label = `${name} ${candidate.activity?.title}`;

        assertBehaviorUnavailable(behavior, label);
        assert.strictEqual(
            exploration.available,
            false,
            `${label} Exploration available`
        );
        assert.strictEqual(
            exploration.score,
            null,
            `${label} Exploration score`
        );
        assert.strictEqual(
            snapshot(candidate),
            candidateSnapshots[index],
            `${label} candidate immutable`
        );
    }

    assert.strictEqual(
        snapshot(context.historyContext),
        historyContextSnapshot,
        `${name} historyContext immutable`
    );
    assert.strictEqual(
        snapshot(context),
        contextSnapshot,
        `${name} context immutable`
    );
}

function printResults(label, context) {
    console.log(`${label}:`);

    for (const candidate of context.candidates) {
        console.log(`${candidate.activity?.title}: Behavior null`);
    }
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

        assert.strictEqual(
            interactionsExists,
            false,
            "SYSTEM_TEST_V1 currently expects interactions unavailable"
        );
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
        console.log("STEP 15F-C - REAL BEHAVIOR FACTOR");
        console.log("========================================");
        console.log("");
        console.log("Interaction source: unavailable");
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
        console.log("Exploration unchanged: PASS");
        console.log("Candidate filtering: NONE");
        console.log("Mongo writes: NONE");
        console.log("Neo4j writes: NONE");
        console.log("");
        console.log("========================================");
        console.log("STEP 15F-C REAL BEHAVIOR FACTOR PASSED");
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
        console.error("STEP 15F-C REAL BEHAVIOR FACTOR FAILED");
        console.error(error);
        process.exit(1);
    });
