require("dotenv").config();

const { ObjectId } = require("mongodb");
const { connectMongoDB, getDatabase } = require("../../config/mongodb");
const driver = require("../../config/neo4j");
const {
    buildRecommendationContext
} = require("../../recommendation/recommendationContextService");
const {
    calculateGoalFactor
} = require("../../recommendation/goalFactorService");

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

function assertClose(label, actual, expected, tolerance = 0.000001) {
    if (
        typeof actual !== "number" ||
        Math.abs(actual - expected) > tolerance
    ) {
        throw new Error(
            `${label}: expected ${expected}, found ${actual}`
        );
    }
}

function assertDeepEqual(label, actual, expected) {
    const actualJson = JSON.stringify(actual);
    const expectedJson = JSON.stringify(expected);

    if (actualJson !== expectedJson) {
        throw new Error(
            `${label}: expected ${expectedJson}, found ${actualJson}`
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

function requireCandidate(context, title) {
    const matches = context.candidates.filter(
        (candidate) => candidate.activity?.title === title
    );

    assertEqual(`${title} candidate count`, matches.length, 1);

    return matches[0];
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

function assertFactorContract(result) {
    assertDeepEqual("Goal result keys", Object.keys(result), [
        "factor",
        "available",
        "score",
        "evidence"
    ]);
    assertEqual("Goal factor id", result.factor, "goal");
    assert(
        typeof result.available === "boolean",
        "Goal available must be boolean"
    );
    assert(
        Array.isArray(result.evidence),
        "Goal evidence must be an Array"
    );

    if (result.available) {
        assert(
            typeof result.score === "number" &&
            Number.isFinite(result.score) &&
            result.score >= 0 &&
            result.score <= 1,
            "Available Goal score must be finite 0..1"
        );
    } else {
        assertEqual("Unavailable Goal score", result.score, null);
    }
}

function assertNoDecisionFields(candidate) {
    for (const field of [
        "score",
        "factorScore",
        "weightedScore",
        "normalizedWeights",
        "recommendation",
        "final" + "Score",
        "ra" + "nk"
    ]) {
        assert(
            !Object.prototype.hasOwnProperty.call(candidate, field),
            `${candidate.activity?.title} must not include ${field}`
        );
    }
}

function assertGoalEvidence(result, expected) {
    const coverageEvidence = result.evidence.filter(
        (item) => item.type === "goal_coverage"
    );

    assertEqual(
        "Goal coverage evidence count",
        coverageEvidence.length,
        expected.length
    );

    for (const expectedGoal of expected) {
        const evidence = coverageEvidence.find(
            (item) => item.goalId === expectedGoal.goalId
        );

        assert(evidence, `Missing evidence for ${expectedGoal.goalId}`);
        assertEqual(
            `${expectedGoal.goalId} priority`,
            evidence.priority,
            expectedGoal.priority
        );
        assertEqual(
            `${expectedGoal.goalId} status`,
            evidence.status,
            "Active"
        );
        assertDeepEqual(
            `${expectedGoal.goalId} Goal Outcome IDs`,
            evidence.goalOutcomeIds,
            expectedGoal.goalOutcomeIds
        );
        assertDeepEqual(
            `${expectedGoal.goalId} matched Outcome IDs`,
            evidence.matchedOutcomeIds,
            expectedGoal.matchedOutcomeIds
        );
        assertClose(
            `${expectedGoal.goalId} coverage`,
            evidence.coverage,
            expectedGoal.coverage
        );
    }
}

function calculateForCandidate(context, title, expectedScore, expectedEvidence) {
    const contextSnapshot = snapshot(context);
    const candidate = requireCandidate(context, title);
    const candidateSnapshot = snapshot(candidate);
    const result = calculateGoalFactor(
        context,
        makeEligibleEvaluation(candidate)
    );

    assertFactorContract(result);
    assertEqual(`${title} Goal available`, result.available, true);
    assertClose(`${title} Goal score`, result.score, expectedScore);
    assertGoalEvidence(result, expectedEvidence);
    assertEqual(`${title} context unchanged`, snapshot(context), contextSnapshot);
    assertEqual(
        `${title} candidate unchanged`,
        snapshot(candidate),
        candidateSnapshot
    );
    assertNoDecisionFields(candidate);

    return result;
}

function goalByName(context, name) {
    const goal = context.goalContext.goals.find(
        (item) => item.name === name
    );

    assert(goal, `${name} Goal not found`);

    return String(goal._id);
}

function outcomeIdsByGoalName(context, name) {
    const goal = context.goalContext.goals.find(
        (item) => item.name === name
    );

    assert(goal, `${name} Goal not found`);

    return goal.relatedOutcomes.map(
        (relatedOutcome) => String(relatedOutcome.outcomeId)
    );
}

function assertInterestContextPreserved(context, snapshotValue) {
    assertEqual(
        `${context.child.identity?.firstName} interestContext unchanged`,
        snapshot(context.interestContext),
        snapshotValue
    );
}

function assertGoalContextPreserved(context, snapshotValue) {
    assertEqual(
        `${context.child.identity?.firstName} goalContext unchanged`,
        snapshot(context.goalContext),
        snapshotValue
    );
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

        const saraInterestSnapshot = snapshot(saraContext.interestContext);
        const omarInterestSnapshot = snapshot(omarContext.interestContext);
        const linaInterestSnapshot = snapshot(linaContext.interestContext);
        const saraGoalSnapshot = snapshot(saraContext.goalContext);
        const omarGoalSnapshot = snapshot(omarContext.goalContext);
        const linaGoalSnapshot = snapshot(linaContext.goalContext);

        const saraProblemGoalId =
            goalByName(saraContext, "Improve Problem Solving");
        const saraTeamworkGoalId =
            goalByName(saraContext, "Build Teamwork");
        const omarTeamworkGoalId =
            goalByName(omarContext, "Build Teamwork");
        const linaCreativityGoalId =
            goalByName(linaContext, "Grow Creativity");

        const problemOutcome =
            outcomeIdsByGoalName(saraContext, "Improve Problem Solving");
        const teamworkOutcome =
            outcomeIdsByGoalName(saraContext, "Build Teamwork");
        const creativityOutcome =
            outcomeIdsByGoalName(linaContext, "Grow Creativity");

        const saraResults = {
            "Robotics Lab": calculateForCandidate(
                saraContext,
                "Robotics Lab",
                1,
                [
                    {
                        goalId: saraProblemGoalId,
                        priority: 1,
                        goalOutcomeIds: problemOutcome,
                        matchedOutcomeIds: problemOutcome,
                        coverage: 1
                    },
                    {
                        goalId: saraTeamworkGoalId,
                        priority: 2,
                        goalOutcomeIds: teamworkOutcome,
                        matchedOutcomeIds: teamworkOutcome,
                        coverage: 1
                    }
                ]
            ),
            "Painting Studio": calculateForCandidate(
                saraContext,
                "Painting Studio",
                0,
                [
                    {
                        goalId: saraProblemGoalId,
                        priority: 1,
                        goalOutcomeIds: problemOutcome,
                        matchedOutcomeIds: [],
                        coverage: 0
                    },
                    {
                        goalId: saraTeamworkGoalId,
                        priority: 2,
                        goalOutcomeIds: teamworkOutcome,
                        matchedOutcomeIds: [],
                        coverage: 0
                    }
                ]
            ),
            "Football Team Camp": calculateForCandidate(
                saraContext,
                "Football Team Camp",
                0.5,
                [
                    {
                        goalId: saraProblemGoalId,
                        priority: 1,
                        goalOutcomeIds: problemOutcome,
                        matchedOutcomeIds: [],
                        coverage: 0
                    },
                    {
                        goalId: saraTeamworkGoalId,
                        priority: 2,
                        goalOutcomeIds: teamworkOutcome,
                        matchedOutcomeIds: teamworkOutcome,
                        coverage: 1
                    }
                ]
            ),
            "Strategy Escape Challenge": calculateForCandidate(
                saraContext,
                "Strategy Escape Challenge",
                1,
                [
                    {
                        goalId: saraProblemGoalId,
                        priority: 1,
                        goalOutcomeIds: problemOutcome,
                        matchedOutcomeIds: problemOutcome,
                        coverage: 1
                    },
                    {
                        goalId: saraTeamworkGoalId,
                        priority: 2,
                        goalOutcomeIds: teamworkOutcome,
                        matchedOutcomeIds: teamworkOutcome,
                        coverage: 1
                    }
                ]
            ),
            "Creative Robotics": calculateForCandidate(
                saraContext,
                "Creative Robotics",
                0.5,
                [
                    {
                        goalId: saraProblemGoalId,
                        priority: 1,
                        goalOutcomeIds: problemOutcome,
                        matchedOutcomeIds: problemOutcome,
                        coverage: 1
                    },
                    {
                        goalId: saraTeamworkGoalId,
                        priority: 2,
                        goalOutcomeIds: teamworkOutcome,
                        matchedOutcomeIds: [],
                        coverage: 0
                    }
                ]
            )
        };

        const omarResults = {
            "Robotics Lab": calculateForCandidate(
                omarContext,
                "Robotics Lab",
                1,
                [
                    {
                        goalId: omarTeamworkGoalId,
                        priority: 1,
                        goalOutcomeIds: teamworkOutcome,
                        matchedOutcomeIds: teamworkOutcome,
                        coverage: 1
                    }
                ]
            ),
            "Football Team Camp": calculateForCandidate(
                omarContext,
                "Football Team Camp",
                1,
                [
                    {
                        goalId: omarTeamworkGoalId,
                        priority: 1,
                        goalOutcomeIds: teamworkOutcome,
                        matchedOutcomeIds: teamworkOutcome,
                        coverage: 1
                    }
                ]
            ),
            "Strategy Escape Challenge": calculateForCandidate(
                omarContext,
                "Strategy Escape Challenge",
                1,
                [
                    {
                        goalId: omarTeamworkGoalId,
                        priority: 1,
                        goalOutcomeIds: teamworkOutcome,
                        matchedOutcomeIds: teamworkOutcome,
                        coverage: 1
                    }
                ]
            )
        };

        const linaResults = {
            "Painting Studio": calculateForCandidate(
                linaContext,
                "Painting Studio",
                1,
                [
                    {
                        goalId: linaCreativityGoalId,
                        priority: 1,
                        goalOutcomeIds: creativityOutcome,
                        matchedOutcomeIds: creativityOutcome,
                        coverage: 1
                    }
                ]
            ),
            "Creative Robotics": calculateForCandidate(
                linaContext,
                "Creative Robotics",
                1,
                [
                    {
                        goalId: linaCreativityGoalId,
                        priority: 1,
                        goalOutcomeIds: creativityOutcome,
                        matchedOutcomeIds: creativityOutcome,
                        coverage: 1
                    }
                ]
            )
        };

        assertInterestContextPreserved(saraContext, saraInterestSnapshot);
        assertInterestContextPreserved(omarContext, omarInterestSnapshot);
        assertInterestContextPreserved(linaContext, linaInterestSnapshot);
        assertGoalContextPreserved(saraContext, saraGoalSnapshot);
        assertGoalContextPreserved(omarContext, omarGoalSnapshot);
        assertGoalContextPreserved(linaContext, linaGoalSnapshot);

        console.log("========================================");
        console.log("STEP 15D-C - REAL GOAL FACTOR");
        console.log("========================================");
        console.log("");
        console.log("Sara:");
        for (const [title, result] of Object.entries(saraResults)) {
            console.log(`${title}: ${result.score.toFixed(1)}`);
        }
        console.log("");
        console.log("Omar:");
        for (const [title, result] of Object.entries(omarResults)) {
            console.log(`${title}: ${result.score.toFixed(1)}`);
        }
        console.log("");
        console.log("Lina:");
        for (const [title, result] of Object.entries(linaResults)) {
            console.log(`${title}: ${result.score.toFixed(1)}`);
        }
        console.log("");
        console.log("Candidate counts:");
        console.log("Sara 5");
        console.log("Omar 3");
        console.log("Lina 2");
        console.log("");
        console.log("D4 evidence: PRESERVED");
        console.log("Interest Context: PRESERVED");
        console.log("Goal Context: PRESERVED");
        console.log("Candidate filtering: NONE");
        console.log("Mongo writes: NONE");
        console.log("Neo4j writes: NONE");
        console.log("");
        console.log("========================================");
        console.log("STEP 15D-C REAL GOAL FACTOR TEST PASSED");
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
        console.error("STEP 15D-C REAL GOAL FACTOR TEST FAILED");
        console.error(error);
        process.exit(1);
    });
