require("dotenv").config();

const {
    connectMongoDB,
    getDatabase
} = require("../../config/mongodb");

const graphBuilderService = require("../../services/graphBuilderService");

const DATASET = "SYSTEM_TEST_V1";

const NODE_ENTITIES = [
    ["Parent", "parents"],
    ["Subcategory", "subcategories"],
    ["LearningOutcome", "learning_outcomes"],
    ["Goal", "goal_library"],
    ["Child", "children"],
    ["Activity", "activities"]
];

const RELATIONSHIP_ENTITIES = [
    ["ChildInterest", "child_interests"]
];

async function main() {
    await connectMongoDB();

    const db = getDatabase();
    const queue = db.collection("graph_sync_queue");

    await queue.deleteMany({
        testDataset: DATASET
    });

    console.log("🧹 Removed previous SYSTEM_TEST_V1 queue jobs");

    console.log("🚀 Starting Step 9 — Phase B");
    console.log("🔄 Two-pass MongoDB → Neo4j synchronization");

    // ==================================================
    // 1. Read SYSTEM_TEST_V1 documents
    // ==================================================

    const documents = {};

    for (const [entityType, collectionName] of [
        ...NODE_ENTITIES,
        ...RELATIONSHIP_ENTITIES
    ]) {
        documents[entityType] = await db
            .collection(collectionName)
            .find({
                "metadata.testDataset": DATASET
            })
            .toArray();

        console.log(
            `${entityType}: ${documents[entityType].length}`
        );
    }

    // ==================================================
    // 2. Build jobs
    // ==================================================

    const nodeJobs = [];
    const relationshipJobs = [];

    for (const [entityType] of NODE_ENTITIES) {
        for (const document of documents[entityType]) {
            nodeJobs.push({
                entityType,
                entityId: document._id,
                operation: "CREATE",
                status: "PENDING",
                testDataset: DATASET,
                createdAt: new Date()
            });
        }
    }

    for (const [entityType] of RELATIONSHIP_ENTITIES) {
        for (const document of documents[entityType]) {
            relationshipJobs.push({
                entityType,
                entityId: document._id,
                operation: "CREATE",
                status: "PENDING",
                testDataset: DATASET,
                createdAt: new Date()
            });
        }
    }

    const allJobs = [
        ...nodeJobs,
        ...relationshipJobs
    ];

    console.log(`\n📦 Entity jobs: ${nodeJobs.length}`);
    console.log(`📦 ChildInterest jobs: ${relationshipJobs.length}`);
    console.log(`📦 Total jobs: ${allJobs.length}`);

    if (nodeJobs.length !== 20) {
        throw new Error(
            `Expected 20 entity jobs, found ${nodeJobs.length}`
        );
    }

    if (relationshipJobs.length !== 3) {
        throw new Error(
            `Expected 3 ChildInterest jobs, found ${relationshipJobs.length}`
        );
    }

    if (allJobs.length !== 23) {
        throw new Error(
            `Expected 23 SYSTEM_TEST_V1 jobs, found ${allJobs.length}`
        );
    }

    // ==================================================
    // 3. Insert jobs
    // ==================================================

    const insertResult = await queue.insertMany(allJobs);

    console.log(
        `✅ Inserted ${insertResult.insertedCount} test jobs`
    );

    // ==================================================
    // 4. PASS 1 — DEPENDENCY-ORDERED ENTITY SYNCHRONIZATION
    // ==================================================

    console.log("\n========================================");
    console.log("PHASE B1 — DEPENDENCY-ORDERED ENTITY SYNCHRONIZATION");
    console.log("========================================");

    let entityProcessed = 0;
    let entityFailed = 0;

    for (const job of nodeJobs) {
        console.log("--------------------------------");
        console.log(
            `${job.entityType}: ${job.entityId}`
        );

        try {
            await graphBuilderService.process(job);

            await queue.updateOne(
                { _id: job._id },
                {
                    $set: {
                        status: "PROCESSED",
                        processedAt: new Date(),
                        phase: "B1_ENTITIES"
                    }
                }
            );

            entityProcessed++;

            console.log("✅ Entity job marked as PROCESSED");

        } catch (error) {
            entityFailed++;

            console.error(
                `❌ ${job.entityType} entity synchronization failed`
            );
            console.error(error);

            await queue.updateOne(
                { _id: job._id },
                {
                    $set: {
                        status: "FAILED",
                        error: error.message,
                        failedAt: new Date(),
                        phase: "B1_ENTITIES"
                    }
                }
            );
        }
    }

    if (entityFailed !== 0) {
        throw new Error(
            `PHASE B1 FAILED: ${entityFailed} entity jobs failed.`
        );
    }

    console.log("\n✅ PHASE B1 PASSED");
    console.log(`Entity jobs synchronized: ${entityProcessed}`);

    // ==================================================
    // 5. PASS 2 — LEARNED-INTEREST SYNCHRONIZATION
    // ==================================================

    console.log("\n========================================");
    console.log("PHASE B2 — LEARNED-INTEREST SYNCHRONIZATION");
    console.log("========================================");

    let relationshipProcessed = 0;
    let relationshipFailed = 0;

    /*
     * ChildInterest jobs are the only standalone
     * relationship jobs in this queue.
     *
     * Child jobs already ran in B1 and therefore
     * created:
     *
     *   HAS_CHILD
     *   HAS_GOAL
     *
     * Activity jobs already created:
     *
     *   CLASSIFIED_AS
     *   SUPPORTS_OUTCOME
     *
     * Goal jobs already created:
     *
     *   RELATES_TO_OUTCOME
     *
     * ChildInterest jobs create:
     *
     *   LIKES
     *
     * All endpoints now exist because B1 completed first.
     */

    for (const job of relationshipJobs) {
        console.log("--------------------------------");
        console.log(
            `${job.entityType}: ${job.entityId}`
        );

        try {
            await graphBuilderService.process(job);

            await queue.updateOne(
                { _id: job._id },
                {
                    $set: {
                        status: "PROCESSED",
                        processedAt: new Date(),
                        phase: "B2_CHILD_INTERESTS"
                    }
                }
            );

            relationshipProcessed++;

            console.log(
                "✅ Relationship job marked as PROCESSED"
            );

        } catch (error) {
            relationshipFailed++;

            console.error(
                `❌ ${job.entityType} relationship synchronization failed`
            );
            console.error(error);

            await queue.updateOne(
                { _id: job._id },
                {
                    $set: {
                        status: "FAILED",
                        error: error.message,
                        failedAt: new Date(),
                        phase: "B2_CHILD_INTERESTS"
                    }
                }
            );
        }
    }

    if (relationshipFailed !== 0) {
        throw new Error(
            `PHASE B2 FAILED: ${relationshipFailed} relationship jobs failed.`
        );
    }

    console.log("\n✅ PHASE B2 PASSED");
    console.log(
        `ChildInterest jobs synchronized: ${relationshipProcessed}`
    );

    // ==================================================
    // 6. FINAL QUEUE ASSERTIONS
    // ==================================================

    const processedCount = await queue.countDocuments({
        testDataset: DATASET,
        status: "PROCESSED"
    });

    const failedCount = await queue.countDocuments({
        testDataset: DATASET,
        status: "FAILED"
    });

    const pendingCount = await queue.countDocuments({
        testDataset: DATASET,
        status: "PENDING"
    });

    if (
        processedCount !== 23 ||
        failedCount !== 0 ||
        pendingCount !== 0
    ) {
        throw new Error(
            "PHASE B FAILED: expected 23 PROCESSED, 0 FAILED, 0 PENDING."
        );
    }

    console.log("\n========================================");
    console.log("✅ PHASE B PASSED");
    console.log("========================================");
    console.log("Entity jobs:         20");
    console.log("ChildInterest jobs:   3");
    console.log("Total jobs:          23");
    console.log("----------------------------------------");
    console.log("Dependency order: VALID");
    console.log("Graph Builder processing: VALID");
    console.log("Entity synchronization: PASSED");
    console.log("Learned-interest synchronization: PASSED");
    console.log("Queue jobs: 23 PROCESSED");
    console.log("Failures: 0");
    console.log("Pending: 0");
    console.log("MongoDB → Neo4j synchronization: PASSED");
    console.log("========================================");

    process.exit(0);
}

main().catch(error => {
    console.error("\n❌ PHASE B FAILED");
    console.error(error);
    process.exit(1);
});
