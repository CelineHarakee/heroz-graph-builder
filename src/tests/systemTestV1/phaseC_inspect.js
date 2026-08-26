require("dotenv").config();

const { connectMongoDB, getDatabase } = require("../../config/mongodb");
const driver = require("../../config/neo4j");
const { toGraphId } = require("../../utils/idUtils");

const DATASET = "SYSTEM_TEST_V1";

async function main() {
    await connectMongoDB();

    const db = getDatabase();
    const session = driver.session();

    try {
        console.log("🚀 Starting Step 9 — Phase C");
        console.log("🔍 Inspecting Neo4j graph");

        // ==================================================
        // 1. Load SYSTEM_TEST_V1 Mongo IDs
        // ==================================================

        const parents = await db.collection("parents")
            .find({ "metadata.testDataset": DATASET })
            .toArray();

        const children = await db.collection("children")
            .find({ "metadata.testDataset": DATASET })
            .toArray();

        const subcategories = await db.collection("subcategories")
            .find({ "metadata.testDataset": DATASET })
            .toArray();

        const outcomes = await db.collection("learning_outcomes")
            .find({ "metadata.testDataset": DATASET })
            .toArray();

        const goals = await db.collection("goal_library")
            .find({ "metadata.testDataset": DATASET })
            .toArray();

        const activities = await db.collection("activities")
            .find({ "metadata.testDataset": DATASET })
            .toArray();

        // ==================================================
        // 2. Expected node counts
        // ==================================================

        const expectedNodes = {
            Parent: 2,
            Child: 3,
            Subcategory: 4,
            LearningOutcome: 3,
            Goal: 3,
            Activity: 5
        };

        console.log("\n========================================");
        console.log("PHASE C1 — NODE INSPECTION");
        console.log("========================================");

        for (const [label, expected] of Object.entries(expectedNodes)) {

            const result = await session.run(
                `
                MATCH (n:${label})
                RETURN count(n) AS count
                `
            );

            const actual = result.records[0]
                .get("count")
                .toNumber();

            console.log(
                `${label.padEnd(18)} ${actual} / ${expected}`
            );

            if (actual !== expected) {
                throw new Error(
                    `Expected ${expected} ${label} nodes, found ${actual}`
                );
            }
        }

        console.log("\n✅ Node counts PASSED");

        // ==================================================
        // 3. Expected relationship counts
        // ==================================================

        const expectedRelationships = {
            HAS_CHILD: 3,
            LIKES: 3,
            HAS_GOAL: 4,
            RELATES_TO_OUTCOME: 3,
            SUPPORTS_OUTCOME: 8,
            CLASSIFIED_AS: 5
        };

        console.log("\n========================================");
        console.log("PHASE C2 — RELATIONSHIP COUNTS");
        console.log("========================================");

        for (const [type, expected] of Object.entries(
            expectedRelationships
        )) {

            const result = await session.run(
                `
                MATCH ()-[r:${type}]->()
                RETURN count(r) AS count
                `
            );

            const actual = result.records[0]
                .get("count")
                .toNumber();

            console.log(
                `${type.padEnd(24)} ${actual} / ${expected}`
            );

            if (actual !== expected) {
                throw new Error(
                    `Expected ${expected} ${type} relationships, found ${actual}`
                );
            }
        }

        console.log("\n✅ Relationship counts PASSED");

        // ==================================================
        // 4. Verify Parent → Child
        // ==================================================

        console.log("\n========================================");
        console.log("PHASE C3 — STRUCTURAL RELATIONSHIPS");
        console.log("========================================");

        const hasChildResult = await session.run(`
            MATCH (p:Parent)-[:HAS_CHILD]->(c:Child)
            RETURN count(*) AS count
        `);

        const hasChildCount =
            hasChildResult.records[0].get("count").toNumber();

        if (hasChildCount !== 3) {
            throw new Error(
                `Expected 3 HAS_CHILD relationships, found ${hasChildCount}`
            );
        }

        // ==================================================
        // 5. Verify Child → Goal properties
        // ==================================================

        const hasGoalResult = await session.run(`
            MATCH (c:Child)-[r:HAS_GOAL]->(g:Goal)
            RETURN
                c.childId AS childId,
                g.goalId AS goalId,
                r.priority AS priority,
                r.status AS status
            ORDER BY childId, priority
        `);

        if (hasGoalResult.records.length !== 4) {
            throw new Error(
                `Expected 4 HAS_GOAL records, found ${hasGoalResult.records.length}`
            );
        }

        for (const record of hasGoalResult.records) {

            const priority = record.get("priority");
            const status = record.get("status");

            if (typeof priority !== "number") {
                throw new Error(
                    `Invalid HAS_GOAL priority for child ${record.get("childId")}`
                );
            }

            if (status !== "Active") {
                throw new Error(
                    `Invalid HAS_GOAL status for child ${record.get("childId")}`
                );
            }
        }

        console.log("HAS_GOAL properties VALID");

        // ==================================================
        // 6. Verify LIKES properties
        // ==================================================

        const likesResult = await session.run(`
            MATCH (c:Child)-[r:LIKES]->(s:Subcategory)
            RETURN
                c.childId AS childId,
                s.subcategoryId AS subcategoryId,
                r.score AS score,
                r.confidence AS confidence,
                r.evidenceCount AS evidenceCount,
                r.lastUpdated AS lastUpdated
            ORDER BY childId, subcategoryId
        `);

        if (likesResult.records.length !== 3) {
            throw new Error(
                `Expected 3 LIKES relationships, found ${likesResult.records.length}`
            );
        }

        for (const record of likesResult.records) {

            const score = record.get("score");
            const confidence = record.get("confidence");
            const evidenceCount = record.get("evidenceCount");

            if (typeof score !== "number") {
                throw new Error("LIKES score is not numeric");
            }

            if (typeof confidence !== "number") {
                throw new Error("LIKES confidence is not numeric");
            }

            if (typeof evidenceCount !== "number") {
                throw new Error("LIKES evidenceCount is not numeric");
            }
        }

        console.log("LIKES properties VALID");

        // ==================================================
        // 7. Verify Goal → Outcome weights
        // ==================================================

        const goalOutcomeResult = await session.run(`
            MATCH (g:Goal)-[r:RELATES_TO_OUTCOME]->(o:LearningOutcome)
            RETURN
                g.goalId AS goalId,
                o.outcomeId AS outcomeId,
                r.weight AS weight
            ORDER BY goalId, outcomeId
        `);

        if (goalOutcomeResult.records.length !== 3) {
            throw new Error(
                `Expected 3 RELATES_TO_OUTCOME relationships, found ${goalOutcomeResult.records.length}`
            );
        }

        for (const record of goalOutcomeResult.records) {

            const weight = record.get("weight");

            if (
                typeof weight !== "number" ||
                weight < 0 ||
                weight > 1
            ) {
                throw new Error(
                    "Invalid RELATES_TO_OUTCOME weight"
                );
            }
        }

        console.log("RELATES_TO_OUTCOME weights VALID");

        // ==================================================
        // 8. Verify Activity → Outcome weights
        // ==================================================

        const activityOutcomeResult = await session.run(`
            MATCH (a:Activity)-[r:SUPPORTS_OUTCOME]->(o:LearningOutcome)
            RETURN
                a.activityId AS activityId,
                o.outcomeId AS outcomeId,
                r.weight AS weight
            ORDER BY activityId, outcomeId
        `);

        if (activityOutcomeResult.records.length !== 8) {
            throw new Error(
                `Expected 8 SUPPORTS_OUTCOME relationships, found ${activityOutcomeResult.records.length}`
            );
        }

        for (const record of activityOutcomeResult.records) {

            const weight = record.get("weight");

            if (
                typeof weight !== "number" ||
                weight < 0 ||
                weight > 1
            ) {
                throw new Error(
                    "Invalid SUPPORTS_OUTCOME weight"
                );
            }
        }

        console.log("SUPPORTS_OUTCOME weights VALID");

        // ==================================================
        // 9. Verify Activity → Subcategory
        // ==================================================

        const classificationResult = await session.run(`
            MATCH (a:Activity)-[:CLASSIFIED_AS]->(s:Subcategory)
            RETURN count(*) AS count
        `);

        const classificationCount =
            classificationResult.records[0]
                .get("count")
                .toNumber();

        if (classificationCount !== 5) {
            throw new Error(
                `Expected 5 CLASSIFIED_AS relationships, found ${classificationCount}`
            );
        }

        console.log("CLASSIFIED_AS relationships VALID");

        // ==================================================
        // 10. Verify expected controlled graph total
        // ==================================================

        const totalNodesResult = await session.run(`
            MATCH (n)
            WHERE
                n.parentId IS NOT NULL OR
                n.childId IS NOT NULL OR
                n.activityId IS NOT NULL OR
                n.subcategoryId IS NOT NULL OR
                n.goalId IS NOT NULL OR
                n.outcomeId IS NOT NULL
            RETURN count(n) AS count
        `);

        const totalNodes =
            totalNodesResult.records[0]
                .get("count")
                .toNumber();

        if (totalNodes !== 20) {
            throw new Error(
                `Expected 20 controlled Neo4j nodes, found ${totalNodes}`
            );
        }

        const totalRelationshipsResult = await session.run(`
            MATCH (a)-[r]->(b)
            WHERE
                type(r) IN [
                    "HAS_CHILD",
                    "LIKES",
                    "HAS_GOAL",
                    "RELATES_TO_OUTCOME",
                    "SUPPORTS_OUTCOME",
                    "CLASSIFIED_AS"
                ]
            RETURN count(r) AS count
        `);

        const totalRelationships =
            totalRelationshipsResult.records[0]
                .get("count")
                .toNumber();

        if (totalRelationships !== 26) {
            throw new Error(
                `Expected 26 controlled relationships, found ${totalRelationships}`
            );
        }

        // ==================================================
        // SUCCESS
        // ==================================================

        console.log("\n========================================");
        console.log("✅ PHASE C PASSED");
        console.log("========================================");
        console.log("Controlled nodes:         20");
        console.log("Controlled relationships: 26");
        console.log("Node counts:              VALID");
        console.log("Relationship counts:      VALID");
        console.log("HAS_CHILD:                VALID");
        console.log("HAS_GOAL:                 VALID");
        console.log("LIKES:                    VALID");
        console.log("RELATES_TO_OUTCOME:       VALID");
        console.log("SUPPORTS_OUTCOME:         VALID");
        console.log("CLASSIFIED_AS:            VALID");
        console.log("Relationship properties:  VALID");
        console.log("Neo4j graph inspection:   PASSED");
        console.log("========================================");

    } finally {
        await session.close();
        await driver.close();
    }
}

main().catch(error => {
    console.error("\n❌ PHASE C FAILED");
    console.error(error);
    process.exit(1);
});