require("dotenv").config();

const nodeAssert = require("assert");
const { ObjectId } = require("mongodb");
const { connectMongoDB, getDatabase } = require("../../config/mongodb");
const driver = require("../../config/neo4j");
const {
    SCORING_FACTORS,
    createCandidateScoringState
} = require("../../recommendation/scoringContract");
const {
    buildRecommendationContext
} = require("../../recommendation/recommendationContextService");
const {
    calculateInterestFactor
} = require("../../recommendation/interestFactorService");
const {
    calculatePreferenceFactor
} = require("../../recommendation/preferenceFactorService");
const {
    calculateGoalFactor
} = require("../../recommendation/goalFactorService");
const {
    calculateExplorationFactor
} = require("../../recommendation/explorationFactorService");
const {
    calculateBehaviorFactor
} = require("../../recommendation/behaviorFactorService");

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

function composeFactors(state, results) {
    return {
        ...state,
        factors: {
            ...state.factors,
            [SCORING_FACTORS.INTEREST]: results.interest,
            [SCORING_FACTORS.PREFERENCE]: results.preference,
            [SCORING_FACTORS.GOAL]: results.goal,
            [SCORING_FACTORS.EXPLORATION]: results.exploration,
            [SCORING_FACTORS.BEHAVIOR]: results.behavior
        }
    };
}

function assertFactorSlots(factors) {
    nodeAssert.deepStrictEqual(
        Object.keys(factors),
        Object.values(SCORING_FACTORS)
    );
    assert(!Object.prototype.hasOwnProperty.call(factors, "vendor"));
}

function assertNoFinalScoreLeakage(state, candidate) {
    for (const field of [
        "finalScore",
        "weightedScore",
        "normalizedScore",
        "rank"
    ]) {
        assert(!Object.prototype.hasOwnProperty.call(state, field));
        assert(!Object.prototype.hasOwnProperty.call(candidate, field));
    }
}

function assertFactorResult(result, factor) {
    nodeAssert.deepStrictEqual(Object.keys(result), [
        "factor",
        "available",
        "score",
        "evidence"
    ]);
    assertEqual(`${factor} factor`, result.factor, factor);
    assert(typeof result.available === "boolean");
    assert(Array.isArray(result.evidence));

    if (result.available) {
        assert(
            typeof result.score === "number" &&
            Number.isFinite(result.score) &&
            result.score >= 0 &&
            result.score <= 1
        );
    } else {
        assertEqual(`${factor} unavailable score`, result.score, null);
    }
}

function assertExpectedFactor(label, result, expected) {
    assertFactorResult(result, result.factor);
    assertEqual(`${label} available`, result.available, expected.available);

    if (expected.available) {
        assertClose(`${label} score`, result.score, expected.score);
    } else {
        assertEqual(`${label} score`, result.score, null);
    }
}

function calculateAndCompose(context, title, expected) {
    const candidate = requireCandidate(context, title);
    const contextSnapshot = snapshot(context);
    const candidateSnapshot = snapshot(candidate);
    const d4EvidenceSnapshot = snapshot(candidate.evidence);
    const interestContextSnapshot = snapshot(context.interestContext);
    const goalContextSnapshot = snapshot(context.goalContext);
    const historyContextSnapshot = snapshot(context.historyContext);
    const bookingsSnapshot = snapshot(context.historyContext.bookings);
    const recommendationsSnapshot =
        snapshot(context.historyContext.recommendations);
    const interactionsSnapshot = snapshot(context.historyContext.interactions);
    const eligibilityEvaluation = makeEligibleEvaluation(candidate);
    const eligibilitySnapshot = snapshot(eligibilityEvaluation);
    const originalState = createCandidateScoringState(eligibilityEvaluation);
    const originalStateSnapshot = snapshot(originalState);

    const interest = calculateInterestFactor(context, eligibilityEvaluation);
    const preference = calculatePreferenceFactor(context, eligibilityEvaluation);
    const goal = calculateGoalFactor(context, eligibilityEvaluation);
    const exploration =
        calculateExplorationFactor(context, eligibilityEvaluation);
    const behavior =
        calculateBehaviorFactor(context, eligibilityEvaluation);
    const integratedState = composeFactors(originalState, {
        interest,
        preference,
        goal,
        exploration,
        behavior
    });

    assertExpectedFactor(
        `${context.child.identity?.firstName} ${title} Interest`,
        interest,
        expected.interest
    );
    assertExpectedFactor(
        `${context.child.identity?.firstName} ${title} Preference`,
        preference,
        expected.preference
    );
    assertExpectedFactor(
        `${context.child.identity?.firstName} ${title} Goal`,
        goal,
        expected.goal
    );
    assertExpectedFactor(
        `${context.child.identity?.firstName} ${title} Exploration`,
        exploration,
        expected.exploration
    );
    assertExpectedFactor(
        `${context.child.identity?.firstName} ${title} Behavior`,
        behavior,
        expected.behavior
    );

    assertFactorSlots(integratedState.factors);
    nodeAssert.strictEqual(integratedState.factors.interest, interest);
    nodeAssert.strictEqual(integratedState.factors.preference, preference);
    nodeAssert.strictEqual(integratedState.factors.goal, goal);
    nodeAssert.strictEqual(integratedState.factors.exploration, exploration);
    nodeAssert.strictEqual(integratedState.factors.behavior, behavior);
    nodeAssert.strictEqual(integratedState.factors.session, null);
    nodeAssert.notStrictEqual(integratedState, originalState);
    nodeAssert.notStrictEqual(integratedState.factors, originalState.factors);
    assertEqual("Original state immutable", snapshot(originalState), originalStateSnapshot);
    assertEqual("Context immutable", snapshot(context), contextSnapshot);
    assertEqual("Candidate immutable", snapshot(candidate), candidateSnapshot);
    assertEqual("D4 evidence preserved", snapshot(candidate.evidence), d4EvidenceSnapshot);
    assertEqual("Eligibility immutable", snapshot(eligibilityEvaluation), eligibilitySnapshot);
    assertEqual("Interest Context preserved", snapshot(context.interestContext), interestContextSnapshot);
    assertEqual("Goal Context preserved", snapshot(context.goalContext), goalContextSnapshot);
    assertEqual("History Context preserved", snapshot(context.historyContext), historyContextSnapshot);
    assertEqual("Bookings preserved", snapshot(context.historyContext.bookings), bookingsSnapshot);
    assertEqual(
        "Recommendations preserved",
        snapshot(context.historyContext.recommendations),
        recommendationsSnapshot
    );
    assertEqual(
        "Interactions preserved",
        snapshot(context.historyContext.interactions),
        interactionsSnapshot
    );
    assertNoFinalScoreLeakage(integratedState, candidate);

    return {
        title,
        interest,
        preference,
        goal,
        exploration,
        behavior
    };
}

function available(score) {
    return {
        available: true,
        score
    };
}

function unavailable() {
    return {
        available: false,
        score: null
    };
}

function printResults(label, results) {
    console.log(`${label}:`);

    for (const result of results) {
        console.log(
            `${result.title}: Interest ${result.interest.score} / ` +
            `Preference ${result.preference.score} / ` +
            `Goal ${result.goal.score} / ` +
            `Exploration ${result.exploration.score} / ` +
            `Behavior ${result.behavior.score}`
        );
    }
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

        for (const context of [saraContext, omarContext, linaContext]) {
            assertEqual(
                `${context.child.identity?.firstName} bookings source`,
                context.historyContext.sources.bookings,
                "unavailable"
            );
            assertEqual(
                `${context.child.identity?.firstName} recommendations source`,
                context.historyContext.sources.recommendations,
                "unavailable"
            );
            assertEqual(
                `${context.child.identity?.firstName} interactions source`,
                context.historyContext.sources.interactions,
                "unavailable"
            );
        }

        const preference = unavailable();
        const exploration = unavailable();
        const behavior = unavailable();
        const saraResults = [
            calculateAndCompose(saraContext, "Robotics Lab", {
                interest: available(0.88),
                preference,
                goal: available(1),
                exploration,
                behavior
            }),
            calculateAndCompose(saraContext, "Painting Studio", {
                interest: available(0.56),
                preference,
                goal: available(0),
                exploration,
                behavior
            }),
            calculateAndCompose(saraContext, "Football Team Camp", {
                interest: unavailable(),
                preference,
                goal: available(0.5),
                exploration,
                behavior
            }),
            calculateAndCompose(saraContext, "Strategy Escape Challenge", {
                interest: unavailable(),
                preference,
                goal: available(1),
                exploration,
                behavior
            }),
            calculateAndCompose(saraContext, "Creative Robotics", {
                interest: available(0.88),
                preference,
                goal: available(0.5),
                exploration,
                behavior
            })
        ];
        const omarResults = [
            calculateAndCompose(omarContext, "Robotics Lab", {
                interest: unavailable(),
                preference,
                goal: available(1),
                exploration,
                behavior
            }),
            calculateAndCompose(omarContext, "Football Team Camp", {
                interest: available(0.91),
                preference,
                goal: available(1),
                exploration,
                behavior
            }),
            calculateAndCompose(omarContext, "Strategy Escape Challenge", {
                interest: unavailable(),
                preference,
                goal: available(1),
                exploration,
                behavior
            })
        ];
        const linaResults = [
            calculateAndCompose(linaContext, "Painting Studio", {
                interest: unavailable(),
                preference,
                goal: available(1),
                exploration,
                behavior
            }),
            calculateAndCompose(linaContext, "Creative Robotics", {
                interest: unavailable(),
                preference,
                goal: available(1),
                exploration,
                behavior
            })
        ];

        assertEqual("Sara candidates remain", saraContext.candidates.length, 5);
        assertEqual("Omar candidates remain", omarContext.candidates.length, 3);
        assertEqual("Lina candidates remain", linaContext.candidates.length, 2);

        console.log("========================================");
        console.log("STEP 15F-D - REAL FIVE-FACTOR INTEGRATION");
        console.log("========================================");
        console.log("");
        console.log("Sara candidates: 5");
        printResults("Sara", saraResults);
        console.log("");
        console.log("Omar candidates: 3");
        printResults("Omar", omarResults);
        console.log("");
        console.log("Lina candidates: 2");
        printResults("Lina", linaResults);
        console.log("");
        console.log("History sources:");
        console.log("bookings unavailable");
        console.log("recommendations unavailable");
        console.log("interactions unavailable");
        console.log("");
        console.log("Exploration unavailable does not filter: PASS");
        console.log("Behavior unavailable does not filter: PASS");
        console.log("D4 evidence preserved: PASS");
        console.log("Interest Context preserved: PASS");
        console.log("Goal Context preserved: PASS");
        console.log("History Context preserved: PASS");
        console.log("Candidate filtering: NONE");
        console.log("Mongo writes: NONE");
        console.log("Neo4j writes: NONE");
        console.log("");
        console.log("========================================");
        console.log("STEP 15F-D REAL FIVE-FACTOR INTEGRATION PASSED");
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
        console.error("STEP 15F-D REAL FIVE-FACTOR INTEGRATION FAILED");
        console.error(error);
        process.exit(1);
    });
