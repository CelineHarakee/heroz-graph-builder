require("dotenv").config();

const { ObjectId } = require("mongodb");
const { connectMongoDB, getDatabase } = require("../../config/mongodb");
const driver = require("../../config/neo4j");
const recommendationDataService =
    require("../../recommendation/recommendationDataService");
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

function sameId(left, right) {
    return String(left) === String(right);
}

async function loadChildByName(db, name) {
    const child = await db.collection("children").findOne({
        "identity.firstName": name,
        "metadata.testDataset": DATASET
    });

    assert(child, `${name} not found`);

    return child;
}

function requireCandidate(context, title) {
    const matches = context.candidates.filter(
        (candidate) => candidate.activity?.title === title
    );

    assertEqual(`${title} candidate count`, matches.length, 1);

    return matches[0];
}

function assertNoScoringFields(context) {
    const forbiddenFields = [
        "score",
        "rank",
        "finalScore",
        "factorScore",
        "goalFactor",
        "goalScore",
        "weightedScore",
        "normalizedWeights",
        "recommendation"
    ];

    for (const field of forbiddenFields) {
        assert(
            !Object.prototype.hasOwnProperty.call(context, field),
            `context must not include scoring field ${field}`
        );
    }

    for (const candidate of context.candidates) {
        for (const field of forbiddenFields) {
            assert(
                !Object.prototype.hasOwnProperty.call(candidate, field),
                `${candidate.activity?.title} must not include scoring ` +
                `field ${field}`
            );
        }
    }
}

function assertGoalContextShape(context, expectedGoalNames) {
    assert(context.goalContext, "goalContext is required");
    assert(
        Array.isArray(context.goalContext.goals),
        "goalContext.goals must be an Array"
    );
    assertEqual(
        `${context.child.identity?.firstName} resolved Goal count`,
        context.goalContext.goals.length,
        expectedGoalNames.length
    );

    for (const goalName of expectedGoalNames) {
        const goal = context.goalContext.goals.find(
            (item) => item.name === goalName
        );

        assert(goal, `${goalName} Goal document not resolved`);
        assert(goal._id instanceof ObjectId, `${goalName} _id must be ObjectId`);
        assert(goal.name, `${goalName} name is required`);
        assert(
            Array.isArray(goal.relatedOutcomes),
            `${goalName} relatedOutcomes must be an Array`
        );

        for (const relatedOutcome of goal.relatedOutcomes) {
            assert(
                relatedOutcome.outcomeId instanceof ObjectId,
                `${goalName} relatedOutcomes.outcomeId must be ObjectId`
            );
            assert(
                !Object.prototype.hasOwnProperty.call(
                    relatedOutcome,
                    "weight"
                ),
                `${goalName} relatedOutcomes must not include weight`
            );
        }

        for (const field of [
            "score",
            "goalScore",
            "factorScore",
            "coverage"
        ]) {
            assert(
                !Object.prototype.hasOwnProperty.call(goal, field),
                `${goalName} must not include scoring field ${field}`
            );
        }
    }
}

function assertGoalContextMatchesParentGoals(context) {
    const parentGoalIds = new Set(
        (context.child.parentGoals ?? []).map(
            (parentGoal) => String(parentGoal.goalId)
        )
    );

    for (const goal of context.goalContext.goals) {
        assert(
            parentGoalIds.has(String(goal._id)),
            `${goal.name} is not referenced by child.parentGoals`
        );
    }
}

function assertInterestContextIntact(context, expectedInterests) {
    assert(context.interestContext, "interestContext is required");
    assert(
        Array.isArray(context.interestContext.childInterests),
        "interestContext.childInterests must be an Array"
    );
    assert(
        Array.isArray(context.interestContext.subcategories),
        "interestContext.subcategories must be an Array"
    );
    assertEqual(
        `${context.child.identity?.firstName} interest count`,
        context.interestContext.childInterests.length,
        expectedInterests
    );
}

function assertD4EvidencePreserved(context, expectations) {
    for (const [title, expected] of Object.entries(expectations)) {
        const candidate = requireCandidate(context, title);

        assertEqual(
            `${context.child.identity?.firstName} ${title} interest evidence`,
            candidate.evidence.interests.length,
            expected.interests
        );
        assertEqual(
            `${context.child.identity?.firstName} ${title} goal evidence`,
            candidate.evidence.goals.length,
            expected.goals.length
        );

        for (const goalName of expected.goals) {
            assert(
                candidate.evidence.goals.some(
                    (goal) => goal.name === goalName
                ),
                `${context.child.identity?.firstName} ${title} missing ` +
                `goal evidence ${goalName}`
            );
        }
    }
}

async function assertMissingGoalReferencesTolerated(db) {
    const goal = await db.collection("goal_library").findOne({
        "metadata.testDataset": DATASET
    });

    assert(goal, "Baseline Goal document is required");

    const missingGoalId = new ObjectId();
    const goals = await recommendationDataService.getGoalsByIds([
        goal._id,
        String(goal._id),
        null,
        undefined,
        "not-a-valid-object-id",
        missingGoalId
    ]);

    assertEqual("Resolved Goal count with missing refs", goals.length, 1);
    assert(
        sameId(goals[0]._id, goal._id),
        "Resolved Goal must match baseline Goal"
    );
}

async function main() {
    await connectMongoDB();

    const db = getDatabase();
    const originalGetGoalsByIds =
        recommendationDataService.getGoalsByIds;

    let goalLoadCount = 0;
    const goalLoadSizes = [];

    try {
        await assertMissingGoalReferencesTolerated(db);

        const sara = await loadChildByName(db, "Sara");
        const omar = await loadChildByName(db, "Omar");
        const lina = await loadChildByName(db, "Lina");

        recommendationDataService.getGoalsByIds = async function(goalIds) {
            goalLoadCount += 1;
            goalLoadSizes.push(goalIds.length);

            return await originalGetGoalsByIds(goalIds);
        };

        const saraContext =
            await buildRecommendationContext(sara._id);
        const omarContext =
            await buildRecommendationContext(omar._id);
        const linaContext =
            await buildRecommendationContext(lina._id);

        assertEqual("Sara candidate count", saraContext.candidates.length, 5);
        assertEqual("Omar candidate count", omarContext.candidates.length, 3);
        assertEqual("Lina candidate count", linaContext.candidates.length, 2);

        assertGoalContextShape(saraContext, [
            "Improve Problem Solving",
            "Build Teamwork"
        ]);
        assertGoalContextShape(omarContext, [
            "Build Teamwork"
        ]);
        assertGoalContextShape(linaContext, [
            "Grow Creativity"
        ]);

        assertGoalContextMatchesParentGoals(saraContext);
        assertGoalContextMatchesParentGoals(omarContext);
        assertGoalContextMatchesParentGoals(linaContext);

        assertInterestContextIntact(saraContext, 2);
        assertInterestContextIntact(omarContext, 1);
        assertInterestContextIntact(linaContext, 0);

        assertD4EvidencePreserved(saraContext, {
            "Robotics Lab": {
                interests: 1,
                goals: [
                    "Improve Problem Solving",
                    "Build Teamwork"
                ]
            },
            "Painting Studio": {
                interests: 1,
                goals: []
            },
            "Football Team Camp": {
                interests: 0,
                goals: [
                    "Build Teamwork"
                ]
            },
            "Strategy Escape Challenge": {
                interests: 0,
                goals: [
                    "Improve Problem Solving",
                    "Build Teamwork"
                ]
            },
            "Creative Robotics": {
                interests: 1,
                goals: [
                    "Improve Problem Solving"
                ]
            }
        });

        assertD4EvidencePreserved(omarContext, {
            "Robotics Lab": {
                interests: 0,
                goals: [
                    "Build Teamwork"
                ]
            },
            "Football Team Camp": {
                interests: 1,
                goals: [
                    "Build Teamwork"
                ]
            },
            "Strategy Escape Challenge": {
                interests: 0,
                goals: [
                    "Build Teamwork"
                ]
            }
        });

        assertD4EvidencePreserved(linaContext, {
            "Painting Studio": {
                interests: 0,
                goals: [
                    "Grow Creativity"
                ]
            },
            "Creative Robotics": {
                interests: 0,
                goals: [
                    "Grow Creativity"
                ]
            }
        });

        assertNoScoringFields(saraContext);
        assertNoScoringFields(omarContext);
        assertNoScoringFields(linaContext);

        assertEqual(
            "Goal loader call count",
            goalLoadCount,
            3
        );
        assertEqual("Sara Goal load input count", goalLoadSizes[0], 2);
        assertEqual("Omar Goal load input count", goalLoadSizes[1], 1);
        assertEqual("Lina Goal load input count", goalLoadSizes[2], 1);

        console.log("========================================");
        console.log("STEP 15D-B — GOAL CONTEXT TEST");
        console.log("========================================");
        console.log("");
        console.log("Goal bulk loader:                 PASSED");
        console.log("One Goal load per context:        PASSED");
        console.log("goalContext.goals shape:          PASSED");
        console.log("");
        console.log("Sara resolved Goals:              2");
        console.log("Omar resolved Goals:              1");
        console.log("Lina resolved Goals:              1");
        console.log("");
        console.log("No Goal Outcome weights:          PASSED");
        console.log("Missing Goal references tolerated:PASSED");
        console.log("No scoring fields added:          PASSED");
        console.log("No filtering performed:           PASSED");
        console.log("");
        console.log("Candidate counts unchanged:       PASSED");
        console.log("Interest Context preserved:       PASSED");
        console.log("D4 evidence preserved:            PASSED");
        console.log("");
        console.log("Mongo writes:                     NONE");
        console.log("Neo4j writes:                     NONE");
        console.log("");
        console.log("========================================");
        console.log("STEP 15D-B GOAL CONTEXT TEST PASSED");
        console.log("========================================");

    } finally {
        recommendationDataService.getGoalsByIds =
            originalGetGoalsByIds;
        await driver.close();
    }
}

main()
    .then(() => {
        process.exit(0);
    })
    .catch((error) => {
        console.error("STEP 15D-B GOAL CONTEXT TEST FAILED");
        console.error(error);
        process.exit(1);
    });
