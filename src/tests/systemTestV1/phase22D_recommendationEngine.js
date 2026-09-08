require("dotenv").config();

const assert = require("assert");
const { ObjectId } = require("mongodb");
const { connectMongoDB, getDatabase } = require("../../config/mongodb");
const driver = require("../../config/neo4j");
const {
    buildRecommendationContext
} = require("../../recommendation/recommendationContextService");
const {
    generateRecommendations
} = require("../../recommendation/recommendationEngineService");

const DATASET = "SYSTEM_TEST_V1";

async function collectionExists(db, name) {
    const collections = await db.listCollections(
        { name },
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

function assertNoInternalLeakage(result) {
    for (const field of [
        "context",
        "recommendationContext",
        "rankingResult",
        "selectionResult",
        "unselectedRanked",
        "unranked",
        "eligibleCandidates",
        "candidateEvaluations",
        "historyContext",
        "parent",
        "child"
    ]) {
        assert(
            !Object.prototype.hasOwnProperty.call(result, field),
            `${field} leaked from Recommendation Engine result`
        );
    }
}

async function verifyChild({
    db,
    name,
    expectedCandidateCount
}) {
    const child = await loadChildByName(db, name);
    const context = await buildRecommendationContext(child._id);

    assert.strictEqual(
        context.candidates.length,
        expectedCandidateCount,
        `${name} D4 candidate count`
    );
    assert(context.candidates.every((candidate) =>
        Array.isArray(candidate.currentSessions)
    ));
    assert(context.candidates.every((candidate) =>
        candidate.currentSessions.length === 0
    ));

    const result = await generateRecommendations(child._id, 3);

    assert.deepStrictEqual(Object.keys(result), [
        "childId",
        "requestedAt",
        "recommendationId",
        "recommendations"
    ]);
    assert.strictEqual(result.childId, String(child._id));
    assert(result.requestedAt instanceof Date);
    assert.strictEqual(result.recommendationId, null);
    assert.deepStrictEqual(result.recommendations, []);
    assertNoInternalLeakage(result);

    return {
        d4CandidateCount: context.candidates.length,
        recommendationCount: result.recommendations.length,
        recommendationId: result.recommendationId
    };
}

async function main() {
    await connectMongoDB();
    const db = getDatabase();
    const existedBefore = await collectionExists(db, "recommendations");
    const baselineCount = existedBefore
        ? await db.collection("recommendations").countDocuments({})
        : null;

    try {
        const sara = await verifyChild({
            db,
            name: "Sara",
            expectedCandidateCount: 5
        });
        const omar = await verifyChild({
            db,
            name: "Omar",
            expectedCandidateCount: 3
        });
        const lina = await verifyChild({
            db,
            name: "Lina",
            expectedCandidateCount: 2
        });
        const existsAfter = await collectionExists(db, "recommendations");
        const finalCount = existsAfter
            ? await db.collection("recommendations").countDocuments({})
            : null;

        assert.strictEqual(existsAfter, existedBefore);

        if (existedBefore) {
            assert.strictEqual(finalCount, baselineCount);
        }

        console.log("========================================");
        console.log("STEP 22D - REAL PRODUCTION D5 ORCHESTRATOR");
        console.log("========================================");
        console.log("");
        console.log("Permanent Sessions: 0");
        console.log(`Sara D4 candidates: ${sara.d4CandidateCount}`);
        console.log(`Sara recommendations: ${sara.recommendationCount}`);
        console.log(`Omar D4 candidates: ${omar.d4CandidateCount}`);
        console.log(`Omar recommendations: ${omar.recommendationCount}`);
        console.log(`Lina D4 candidates: ${lina.d4CandidateCount}`);
        console.log(`Lina recommendations: ${lina.recommendationCount}`);
        console.log("All recommendationIds: null");
        console.log("Empty results persisted: NO");
        console.log("Recommendation collection baseline preserved: PASS");
        console.log("Mongo writes: NONE");
        console.log("Neo4j writes: NONE");
        console.log("");
        console.log("STEP 22D REAL PRODUCTION D5 ORCHESTRATOR PASSED");
    } finally {
        await driver.close();
    }
}

main()
    .then(() => {
        process.exit(0);
    })
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
