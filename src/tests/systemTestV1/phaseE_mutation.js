require("dotenv").config();

const { connectMongoDB, getDatabase } = require("../../config/mongodb");
const driver = require("../../config/neo4j");
const graphBuilderService = require("../../services/graphBuilderService");
const { toGraphId, toMongoId } = require("../../utils/idUtils");

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

function asNumber(value) {
    if (
        value !== null &&
        value !== undefined &&
        typeof value.toNumber === "function"
    ) {
        return value.toNumber();
    }

    return value;
}

async function getRelationship(session, query, params) {
    const result = await session.run(query, params);

    if (result.records.length === 0) {
        return null;
    }

    const record = result.records[0];

    return {
        count: asNumber(record.get("count")),
        properties: record.get("properties")
    };
}

async function assertRelationshipExists(
    session,
    label,
    query,
    params,
    expectedProperties = {}
) {
    const relationship = await getRelationship(
        session,
        query,
        params
    );

    assert(
        relationship,
        `${label}: relationship not found`
    );

    assertEqual(
        `${label} count`,
        relationship.count,
        1
    );

    for (const [property, expected] of Object.entries(
        expectedProperties
    )) {
        assertEqual(
            `${label}.${property}`,
            relationship.properties[property],
            expected
        );
    }
}

async function assertRelationshipMissing(
    session,
    label,
    query,
    params
) {
    const relationship = await getRelationship(
        session,
        query,
        params
    );

    if (!relationship) {
        return;
    }

    assertEqual(
        `${label} count`,
        relationship.count,
        0
    );
}

async function processSyntheticJob(
    db,
    entityType,
    entityId
) {
    const job = {
        entityType,
        entityId,
        operation: "UPDATE",
        status: "PENDING",
        testDataset: DATASET,
        createdAt: new Date()
    };

    await graphBuilderService.process(job);
}

async function main() {
    await connectMongoDB();

    const db = getDatabase();
    const session = driver.session();

    try {
        console.log("🚀 Starting Step 9 — Phase E");
        console.log("🔄 Testing mutation and stale relationship handling");

        // ==================================================
        // Load synthetic dataset
        // ==================================================

        const sara = await db.collection("children").findOne({
            "identity.firstName": "Sara",
            "metadata.testDataset": DATASET
        });

        const goals = await db.collection("goal_library")
            .find({
                "metadata.testDataset": DATASET
            })
            .toArray();

        const activities = await db.collection("activities")
            .find({
                "metadata.testDataset": DATASET
            })
            .toArray();

        assert(sara, "Sara not found");

        const problemSolvingGoal = goals.find(
            goal => goal.name === "Improve Problem Solving"
        );

        const roboticsLab = activities.find(
            activity =>
                activity.basicInformation?.nameEn === "Robotics Lab"
        );

        assert(
            problemSolvingGoal,
            "Improve Problem Solving goal not found"
        );

        assert(
            roboticsLab,
            "Robotics Lab activity not found"
        );

        // ==================================================
        // Save original Mongo state
        // ==================================================

        const originalSaraParentGoals =
            JSON.parse(
                JSON.stringify(sara.parentGoals ?? [])
            );

        const originalGoalOutcomes =
            JSON.parse(
                JSON.stringify(
                    problemSolvingGoal.relatedOutcomes ?? []
                )
            );

        const originalActivityOutcomes =
            JSON.parse(
                JSON.stringify(
                    roboticsLab.learningOutcomes ?? []
                )
            );

        // ==================================================
        // E1 — HAS_GOAL stale relationship removal
        // ==================================================

        console.log("\n========================================");
        console.log("PHASE E1 — HAS_GOAL MUTATION");
        console.log("========================================");

        const removedGoal =
            originalSaraParentGoals.find(
                goal =>
                    String(goal.goalId) ===
                    String(problemSolvingGoal._id)
            );

        assert(
            removedGoal,
            "Sara does not currently have Improve Problem Solving"
        );

        const remainingGoals =
            originalSaraParentGoals.filter(
                goal =>
                    String(goal.goalId) !==
                    String(problemSolvingGoal._id)
            );

        await db.collection("children").updateOne(
            { _id: sara._id },
            {
                $set: {
                    parentGoals: remainingGoals
                }
            }
        );

        await processSyntheticJob(
            db,
            "Child",
            sara._id
        );

        const saraId = toGraphId(sara._id);
        const removedGoalId =
            toGraphId(problemSolvingGoal._id);

        await assertRelationshipMissing(
            session,
            "Sara → Improve Problem Solving",
            `
                MATCH (c:Child {childId: $childId})
                      -[r:HAS_GOAL]->
                      (g:Goal {goalId: $goalId})
                RETURN count(r) AS count,
                       properties(r) AS properties
            `,
            {
                childId: saraId,
                goalId: removedGoalId
            }
        );

        console.log(
            "✅ Stale HAS_GOAL relationship removed"
        );

        // ==================================================
        // E2 — RELATES_TO_OUTCOME mutation
        // ==================================================

        console.log("\n========================================");
        console.log("PHASE E2 — RELATES_TO_OUTCOME MUTATION");
        console.log("========================================");

        const originalGoalOutcome =
            originalGoalOutcomes[0];

        assert(
            originalGoalOutcome,
            "Goal has no original outcome"
        );

        const alternativeOutcome =
            goals
                .flatMap(goal => goal.relatedOutcomes ?? [])
                .find(
                    outcome =>
                        String(outcome.outcomeId) !==
                        String(originalGoalOutcome.outcomeId)
                );

        assert(
            alternativeOutcome,
            "Could not find alternative LearningOutcome"
        );

        const mutatedGoalOutcomes = [
            {
                outcomeId: alternativeOutcome.outcomeId,
                weight: 0.65
            }
        ];

        await db.collection("goal_library").updateOne(
            { _id: problemSolvingGoal._id },
            {
                $set: {
                    relatedOutcomes: mutatedGoalOutcomes
                }
            }
        );

        await processSyntheticJob(
            db,
            "Goal",
            problemSolvingGoal._id
        );

        const goalId =
            toGraphId(problemSolvingGoal._id);

        const oldOutcomeId =
            toGraphId(originalGoalOutcome.outcomeId);

        const newOutcomeId =
            toGraphId(alternativeOutcome.outcomeId);

        await assertRelationshipMissing(
            session,
            "Old Goal → Outcome relationship",
            `
                MATCH (g:Goal {goalId: $goalId})
                      -[r:RELATES_TO_OUTCOME]->
                      (o:LearningOutcome {outcomeId: $outcomeId})
                RETURN count(r) AS count,
                       properties(r) AS properties
            `,
            {
                goalId,
                outcomeId: oldOutcomeId
            }
        );

        await assertRelationshipExists(
            session,
            "New Goal → Outcome relationship",
            `
                MATCH (g:Goal {goalId: $goalId})
                      -[r:RELATES_TO_OUTCOME]->
                      (o:LearningOutcome {outcomeId: $outcomeId})
                RETURN count(r) AS count,
                       properties(r) AS properties
            `,
            {
                goalId,
                outcomeId: newOutcomeId
            },
            {
                weight: 0.65
            }
        );

        console.log(
            "✅ RELATES_TO_OUTCOME mutation PASSED"
        );

        // ==================================================
        // E3 — SUPPORTS_OUTCOME mutation
        // ==================================================

        console.log("\n========================================");
        console.log("PHASE E3 — SUPPORTS_OUTCOME MUTATION");
        console.log("========================================");

        const originalActivityOutcome =
            originalActivityOutcomes[0];

        assert(
            originalActivityOutcome,
            "Robotics Lab has no original outcome"
        );

        const remainingActivityOutcomes =
            originalActivityOutcomes.filter(
                outcome =>
                    String(outcome.outcomeId) !==
                    String(originalActivityOutcome.outcomeId)
            );

        await db.collection("activities").updateOne(
            { _id: roboticsLab._id },
            {
                $set: {
                    learningOutcomes:
                        remainingActivityOutcomes
                }
            }
        );

        await processSyntheticJob(
            db,
            "Activity",
            roboticsLab._id
        );

        const activityId =
            toGraphId(roboticsLab._id);

        const removedActivityOutcomeId =
            toGraphId(
                originalActivityOutcome.outcomeId
            );

        await assertRelationshipMissing(
            session,
            "Old Activity → Outcome relationship",
            `
                MATCH (a:Activity {activityId: $activityId})
                      -[r:SUPPORTS_OUTCOME]->
                      (o:LearningOutcome {
                          outcomeId: $outcomeId
                      })
                RETURN count(r) AS count,
                       properties(r) AS properties
            `,
            {
                activityId,
                outcomeId: removedActivityOutcomeId
            }
        );

        for (const outcome of remainingActivityOutcomes) {
            await assertRelationshipExists(
                session,
                "Remaining Activity → Outcome relationship",
                `
                    MATCH (a:Activity {
                        activityId: $activityId
                    })
                    -[r:SUPPORTS_OUTCOME]->
                    (o:LearningOutcome {
                        outcomeId: $outcomeId
                    })
                    RETURN count(r) AS count,
                           properties(r) AS properties
                `,
                {
                    activityId,
                    outcomeId: toGraphId(
                        outcome.outcomeId
                    )
                },
                {
                    weight: outcome.weight
                }
            );
        }

        console.log(
            "✅ SUPPORTS_OUTCOME mutation PASSED"
        );

        // ==================================================
        // E4 — HAS_GOAL property mutation
        // ==================================================

        console.log("\n========================================");
        console.log("PHASE E4 — RELATIONSHIP PROPERTY UPDATE");
        console.log("========================================");

        const retainedGoal =
            remainingGoals[0];

        assert(
            retainedGoal,
            "Sara has no remaining goal for property test"
        );

        await db.collection("children").updateOne(
            { _id: sara._id },
            {
                $set: {
                    parentGoals: [
                        ...remainingGoals.map(goal => ({
                            ...goal,
                            ...(String(goal.goalId) ===
                                String(retainedGoal.goalId)
                                ? {
                                    priority: 99,
                                    status: "UPDATED"
                                }
                                : {})
                        }))
                    ]
                }
            }
        );

        await processSyntheticJob(
            db,
            "Child",
            sara._id
        );

        await assertRelationshipExists(
            session,
            "Updated HAS_GOAL",
            `
                MATCH (c:Child {childId: $childId})
                      -[r:HAS_GOAL]->
                      (g:Goal {goalId: $goalId})
                RETURN count(r) AS count,
                       properties(r) AS properties
            `,
            {
                childId: saraId,
                goalId: toGraphId(
                    retainedGoal.goalId
                )
            },
            {
                priority: 99,
                status: "UPDATED"
            }
        );

        console.log(
            "✅ HAS_GOAL property update PASSED"
        );

        // ==================================================
        // Restore MongoDB state
        // ==================================================

        console.log("\n========================================");
        console.log("RESTORING SYSTEM_TEST_V1 DATASET");
        console.log("========================================");

        await db.collection("children").updateOne(
            { _id: sara._id },
            {
                $set: {
                    parentGoals:
                        originalSaraParentGoals
                }
            }
        );

        await db.collection("goal_library").updateOne(
            { _id: problemSolvingGoal._id },
            {
                $set: {
                    relatedOutcomes:
                        originalGoalOutcomes
                }
            }
        );

        await db.collection("activities").updateOne(
            { _id: roboticsLab._id },
            {
                $set: {
                    learningOutcomes:
                        originalActivityOutcomes
                }
            }
        );

        // Re-sync restored state
        await processSyntheticJob(
            db,
            "Child",
            sara._id
        );

        await processSyntheticJob(
            db,
            "Goal",
            problemSolvingGoal._id
        );

        await processSyntheticJob(
            db,
            "Activity",
            roboticsLab._id
        );

        console.log(
            "✅ MongoDB synthetic dataset restored"
        );

        // ==================================================
        // Final validation
        // ==================================================

        console.log("\n========================================");
        console.log("PHASE E5 — FINAL RESTORATION CHECK");
        console.log("========================================");

        const restoredSara =
            await db.collection("children").findOne({
                _id: sara._id
            });

        const restoredGoal =
            await db.collection("goal_library").findOne({
                _id: problemSolvingGoal._id
            });

        const restoredActivity =
            await db.collection("activities").findOne({
                _id: roboticsLab._id
            });

        assertEqual(
            "Sara parentGoals restored",
            JSON.stringify(restoredSara.parentGoals),
            JSON.stringify(originalSaraParentGoals)
        );

        assertEqual(
            "Goal relatedOutcomes restored",
            JSON.stringify(
                restoredGoal.relatedOutcomes
            ),
            JSON.stringify(originalGoalOutcomes)
        );

        assertEqual(
            "Activity learningOutcomes restored",
            JSON.stringify(
                restoredActivity.learningOutcomes
            ),
            JSON.stringify(originalActivityOutcomes)
        );

        console.log(
            "✅ MongoDB restoration PASSED"
        );

        console.log("\n========================================");
        console.log("✅ PHASE E PASSED");
        console.log("========================================");
        console.log("HAS_GOAL stale removal:       PASSED");
        console.log("RELATES_TO_OUTCOME mutation:  PASSED");
        console.log("SUPPORTS_OUTCOME mutation:    PASSED");
        console.log("Relationship property update: PASSED");
        console.log("MongoDB restoration:           PASSED");
        console.log("========================================");

    } finally {
        await session.close();
        await driver.close();
    }
}

main()
    .then(() => {
        process.exit(0);
    })
    .catch(error => {
        console.error("\n❌ PHASE E FAILED");
        console.error(error);
        process.exit(1);
    });