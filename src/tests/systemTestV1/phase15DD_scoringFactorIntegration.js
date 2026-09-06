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

function composeFactors(state, {
    interest,
    preference,
    goal
}) {
    return {
        ...state,
        factors: {
            ...state.factors,
            [SCORING_FACTORS.INTEREST]: interest,
            [SCORING_FACTORS.PREFERENCE]: preference,
            [SCORING_FACTORS.GOAL]: goal
        }
    };
}

function assertFactorSlots(factors) {
    nodeAssert.deepStrictEqual(
        Object.keys(factors),
        Object.values(SCORING_FACTORS)
    );
    assert(
        !Object.prototype.hasOwnProperty.call(factors, "vendor"),
        "Vendor Reliability must not appear"
    );
}

function assertNoFinalScoreLeakage(state, candidate) {
    for (const field of [
        "finalScore",
        "weightedScore",
        "normalizedScore",
        "rank"
    ]) {
        assert(
            !Object.prototype.hasOwnProperty.call(state, field),
            `${field} must not be present on state`
        );
        assert(
            !Object.prototype.hasOwnProperty.call(candidate, field),
            `${field} must not be present on candidate`
        );
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
    assert(
        typeof result.available === "boolean",
        `${factor} available must be boolean`
    );
    assert(Array.isArray(result.evidence), `${factor} evidence must be Array`);

    if (result.available) {
        assert(
            typeof result.score === "number" &&
            Number.isFinite(result.score) &&
            result.score >= 0 &&
            result.score <= 1,
            `${factor} score must be finite 0..1`
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
    const interestContextSnapshot = snapshot(context.interestContext);
    const goalContextSnapshot = snapshot(context.goalContext);
    const eligibilityEvaluation = makeEligibleEvaluation(candidate);
    const eligibilitySnapshot = snapshot(eligibilityEvaluation);
    const originalState = createCandidateScoringState(eligibilityEvaluation);
    const originalStateSnapshot = snapshot(originalState);

    const interest = calculateInterestFactor(context, eligibilityEvaluation);
    const preference = calculatePreferenceFactor(context, eligibilityEvaluation);
    const goal = calculateGoalFactor(context, eligibilityEvaluation);
    const interestAfterGoal =
        calculateInterestFactor(context, eligibilityEvaluation);
    const preferenceAfterGoal =
        calculatePreferenceFactor(context, eligibilityEvaluation);
    const integratedState = composeFactors(originalState, {
        interest,
        preference,
        goal
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

    nodeAssert.deepStrictEqual(interestAfterGoal, interest);
    nodeAssert.deepStrictEqual(preferenceAfterGoal, preference);
    assertFactorSlots(integratedState.factors);
    nodeAssert.strictEqual(integratedState.factors.interest, interest);
    nodeAssert.strictEqual(integratedState.factors.preference, preference);
    nodeAssert.strictEqual(integratedState.factors.goal, goal);
    nodeAssert.strictEqual(integratedState.factors.exploration, null);
    nodeAssert.strictEqual(integratedState.factors.behavior, null);
    nodeAssert.strictEqual(integratedState.factors.session, null);
    nodeAssert.notStrictEqual(integratedState, originalState);
    nodeAssert.notStrictEqual(integratedState.factors, originalState.factors);
    assertEqual("Original state immutable", snapshot(originalState), originalStateSnapshot);
    assertEqual("Context immutable", snapshot(context), contextSnapshot);
    assertEqual("Candidate immutable", snapshot(candidate), candidateSnapshot);
    assertEqual(
        "Eligibility immutable",
        snapshot(eligibilityEvaluation),
        eligibilitySnapshot
    );
    assertEqual(
        "Interest Context preserved",
        snapshot(context.interestContext),
        interestContextSnapshot
    );
    assertEqual(
        "Goal Context preserved",
        snapshot(context.goalContext),
        goalContextSnapshot
    );
    assertNoFinalScoreLeakage(integratedState, candidate);

    return {
        title,
        interest,
        preference,
        goal,
        integratedState
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

        const expectedPreference = unavailable();

        const saraResults = [
            calculateAndCompose(saraContext, "Robotics Lab", {
                interest: available(0.88),
                preference: expectedPreference,
                goal: available(1)
            }),
            calculateAndCompose(saraContext, "Painting Studio", {
                interest: available(0.56),
                preference: expectedPreference,
                goal: available(0)
            }),
            calculateAndCompose(saraContext, "Football Team Camp", {
                interest: unavailable(),
                preference: expectedPreference,
                goal: available(0.5)
            }),
            calculateAndCompose(saraContext, "Strategy Escape Challenge", {
                interest: unavailable(),
                preference: expectedPreference,
                goal: available(1)
            }),
            calculateAndCompose(saraContext, "Creative Robotics", {
                interest: available(0.88),
                preference: expectedPreference,
                goal: available(0.5)
            })
        ];

        const omarResults = [
            calculateAndCompose(omarContext, "Robotics Lab", {
                interest: unavailable(),
                preference: expectedPreference,
                goal: available(1)
            }),
            calculateAndCompose(omarContext, "Football Team Camp", {
                interest: available(0.91),
                preference: expectedPreference,
                goal: available(1)
            }),
            calculateAndCompose(omarContext, "Strategy Escape Challenge", {
                interest: unavailable(),
                preference: expectedPreference,
                goal: available(1)
            })
        ];

        const linaResults = [
            calculateAndCompose(linaContext, "Painting Studio", {
                interest: unavailable(),
                preference: expectedPreference,
                goal: available(1)
            }),
            calculateAndCompose(linaContext, "Creative Robotics", {
                interest: unavailable(),
                preference: expectedPreference,
                goal: available(1)
            })
        ];

        console.log("========================================");
        console.log("STEP 15D-D - REAL THREE-FACTOR INTEGRATION");
        console.log("========================================");
        console.log("");
        console.log("Sara candidates: 5");
        for (const result of saraResults) {
            console.log(
                `${result.title}: Interest ${result.interest.score} / ` +
                `Preference ${result.preference.score} / ` +
                `Goal ${result.goal.score}`
            );
        }
        console.log("");
        console.log("Omar candidates: 3");
        for (const result of omarResults) {
            console.log(
                `${result.title}: Interest ${result.interest.score} / ` +
                `Preference ${result.preference.score} / ` +
                `Goal ${result.goal.score}`
            );
        }
        console.log("");
        console.log("Lina candidates: 2");
        for (const result of linaResults) {
            console.log(
                `${result.title}: Interest ${result.interest.score} / ` +
                `Preference ${result.preference.score} / ` +
                `Goal ${result.goal.score}`
            );
        }
        console.log("");
        console.log("D4 evidence preserved: PASS");
        console.log("Interest Context preserved: PASS");
        console.log("Goal Context preserved: PASS");
        console.log("Candidate filtering: NONE");
        console.log("Mongo writes: NONE");
        console.log("Neo4j writes: NONE");
        console.log("");
        console.log("========================================");
        console.log("STEP 15D-D REAL THREE-FACTOR INTEGRATION PASSED");
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
        console.error("STEP 15D-D REAL THREE-FACTOR INTEGRATION FAILED");
        console.error(error);
        process.exit(1);
    });
