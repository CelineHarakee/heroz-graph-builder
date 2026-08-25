require("dotenv").config();

const {
    connectMongoDB,
    getDatabase
} = require("../../config/mongodb");

const graphBuilderService = require("../../services/graphBuilderService");

const DATASET = "SYSTEM_TEST_V1";

const NODE_ENTITIES = [
    ["Parent", "parents"],
    ["Child", "children"],
    ["Subcategory", "subcategories"],
    ["LearningOutcome", "learning_outcomes"],
    ["Goal", "goal_library"],
    ["Activity", "activities"]
];

const RELATIONSHIP_ENTITIES = [
    ["ChildInterest", "child_interests"]
];

async function main() {
    await connectMongoDB();

    const db = getDatabase();
    const queue = db.collection("graph_sync_queue");

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

    console.log(`\n📦 Node jobs: ${nodeJobs.length}`);
    console.log(`📦 Relationship jobs: ${relationshipJobs.length}`);
    console.log(`📦 Total jobs: ${allJobs.length}`);

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
    // 4. PASS 1 — CREATE ALL NODES
    // ==================================================

    console.log("\n========================================");
    console.log("PHASE B1 — NODE SYNCHRONIZATION");
    console.log("========================================");

    let nodeProcessed = 0;
    let nodeFailed = 0;

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
                        phase: "B1_NODES"
                    }
                }
            );

            nodeProcessed++;

            console.log("✅ Node job marked as PROCESSED");

        } catch (error) {
            nodeFailed++;

            console.error(
                `❌ ${job.entityType} node synchronization failed`
            );
            console.error(error);

            await queue.updateOne(
                { _id: job._id },
                {
                    $set: {
                        status: "FAILED",
                        error: error.message,
                        failedAt: new Date(),
                        phase: "B1_NODES"
                    }
                }
            );
        }
    }

    if (nodeFailed !== 0) {
        throw new Error(
            `PHASE B1 FAILED: ${nodeFailed} node jobs failed.`
        );
    }

    console.log("\n✅ PHASE B1 PASSED");
    console.log(`Nodes synchronized: ${nodeProcessed}`);

    // ==================================================
    // 5. PASS 2 — RELATIONSHIPS
    // ==================================================

    console.log("\n========================================");
    console.log("PHASE B2 — RELATIONSHIP SYNCHRONIZATION");
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
                        phase: "B2_RELATIONSHIPS"
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
                        phase: "B2_RELATIONSHIPS"
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
        `Relationships synchronized: ${relationshipProcessed}`
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

    console.log("\n========================================");
    console.log("PHASE B RESULT");
    console.log("========================================");

    console.log(`Jobs processed: ${processedCount}`);
    console.log(`Jobs failed:    ${failedCount}`);
    console.log(`Jobs pending:   ${pendingCount}`);

    if (
        processedCount !== 23 ||
        failedCount !== 0 ||
        pendingCount !== 0
    ) {
        throw new Error(
            "PHASE B FAILED: expected 23 PROCESSED, 0 FAILED, 0 PENDING."
        );
    }

    console.log("----------------------------------------");
    console.log("MongoDB → Neo4j synchronization: VALID");
    console.log("Node synchronization: PASSED");
    console.log("Relationship synchronization: PASSED");
    console.log("Queue jobs: 23 PROCESSED");
    console.log("Failures: 0");
    console.log("Pending: 0");
    console.log("Neo4j synchronization: PASSED");
    console.log("========================================");
}

main().catch(error => {
    console.error("\n❌ PHASE B FAILED");
    console.error(error);
    process.exitCode = 1;
});