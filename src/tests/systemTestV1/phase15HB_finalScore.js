require("dotenv").config();

const assert = require("assert");
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
const {
    calculateSessionFactor
} = require("../../recommendation/sessionFactorService");
const {
    calculateFinalScore
} = require("../../recommendation/finalScoreService");

const DATASET = "SYSTEM_TEST_V1";

function assertClose(label, actual, expected, tolerance = 0.000001) {
    assert(
        typeof actual === "number" &&
        Math.abs(actual - expected) <= tolerance,
        `${label}: expected ${expected}, found ${actual}`
    );
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

    assert.strictEqual(matches.length, 1, `${title} candidate count`);

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
            [SCORING_FACTORS.BEHAVIOR]: results.behavior,
            [SCORING_FACTORS.SESSION]: results.session
        }
    };
}

function assertRawFactor(result, factor, expectedScore) {
    assert.strictEqual(result.factor, factor);
    assert(Array.isArray(result.evidence));

    if (expectedScore === null) {
        assert.strictEqual(result.available, false, `${factor} available`);
        assert.strictEqual(result.score, null, `${factor} score`);
        return;
    }

    assert.strictEqual(result.available, true, `${factor} available`);
    assertClose(`${factor} score`, result.score, expectedScore);
}

function assertNoRankingFields(state, candidate) {
    for (const field of [
        "rank",
        "topN"
    ]) {
        assert(!Object.prototype.hasOwnProperty.call(state, field));
        assert(!Object.prototype.hasOwnProperty.call(candidate, field));
    }
}

function calculateCandidate(context, title, expected) {
    const candidate = requireCandidate(context, title);
    const contextSnapshot = snapshot(context);
    const candidateSnapshot = snapshot(candidate);
    const orderSnapshot = snapshot(context.candidates.map(
        (item) => item.activity?.title
    ));
    const eligibilityEvaluation = makeEligibleEvaluation(candidate);
    const eligibilitySnapshot = snapshot(eligibilityEvaluation);
    const state = createCandidateScoringState(eligibilityEvaluation);
    const results = {
        interest: calculateInterestFactor(context, eligibilityEvaluation),
        preference: calculatePreferenceFactor(context, eligibilityEvaluation),
        goal: calculateGoalFactor(context, eligibilityEvaluation),
        exploration: calculateExplorationFactor(context, eligibilityEvaluation),
        behavior: calculateBehaviorFactor(context, eligibilityEvaluation),
        session: calculateSessionFactor(eligibilityEvaluation, context)
    };
    const completedState = composeFactors(state, results);
    const aggregate = calculateFinalScore(completedState);

    assertRawFactor(results.interest, SCORING_FACTORS.INTEREST, expected.interest);
    assertRawFactor(results.preference, SCORING_FACTORS.PREFERENCE, null);
    assertRawFactor(results.goal, SCORING_FACTORS.GOAL, expected.goal);
    assertRawFactor(results.exploration, SCORING_FACTORS.EXPLORATION, null);
    assertRawFactor(results.behavior, SCORING_FACTORS.BEHAVIOR, null);
    assertRawFactor(results.session, SCORING_FACTORS.SESSION, null);

    assert.strictEqual(aggregate.available, true, `${title} aggregate available`);
    assertClose(`${title} final score`, aggregate.score, expected.finalScore);
    assertClose(`${title} available weight`, aggregate.availableWeight, expected.availableWeight);
    assert.strictEqual(
        aggregate.availableFactorCount,
        expected.availableFactorCount,
        `${title} available factor count`
    );
    assert.strictEqual(
        aggregate.contributions.length,
        expected.availableFactorCount,
        `${title} contribution count`
    );
    assert(
        aggregate.contributions.every(
            (item) => item.factor !== SCORING_FACTORS.PREFERENCE &&
                item.factor !== SCORING_FACTORS.EXPLORATION &&
                item.factor !== SCORING_FACTORS.BEHAVIOR &&
                item.factor !== SCORING_FACTORS.SESSION
        ),
        `${title} unavailable factors must not contribute`
    );

    assert.strictEqual(snapshot(context), contextSnapshot, `${title} context immutable`);
    assert.strictEqual(snapshot(candidate), candidateSnapshot, `${title} candidate immutable`);
    assert.strictEqual(snapshot(eligibilityEvaluation), eligibilitySnapshot, `${title} eligibility immutable`);
    assert.strictEqual(
        snapshot(context.candidates.map((item) => item.activity?.title)),
        orderSnapshot,
        `${title} candidate order preserved`
    );
    assertNoRankingFields(completedState, candidate);

    return {
        title,
        results,
        aggregate
    };
}

function assertContext(context, expectedCount) {
    assert.strictEqual(context.candidates.length, expectedCount);
    assert.strictEqual(context.historyContext.sources.bookings, "unavailable");
    assert.strictEqual(context.historyContext.sources.recommendations, "unavailable");
    assert.strictEqual(context.historyContext.sources.interactions, "unavailable");
    assert.deepStrictEqual(
        context.parent?.recommendationPreferences?.preferredDays,
        []
    );
}

function printResults(label, results) {
    console.log(`${label}:`);

    for (const result of results) {
        console.log(
            `${result.title}: final ${result.aggregate.score} / ` +
            `availableWeight ${result.aggregate.availableWeight} / ` +
            `availableFactors ${result.aggregate.availableFactorCount}`
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

        assertContext(saraContext, 5);
        assertContext(omarContext, 3);
        assertContext(linaContext, 2);

        const saraOrder = snapshot(saraContext.candidates.map(
            (candidate) => candidate.activity?.title
        ));
        const omarOrder = snapshot(omarContext.candidates.map(
            (candidate) => candidate.activity?.title
        ));
        const linaOrder = snapshot(linaContext.candidates.map(
            (candidate) => candidate.activity?.title
        ));

        const saraResults = [
            calculateCandidate(saraContext, "Robotics Lab", {
                interest: 0.88,
                goal: 1,
                finalScore: 0.9191836734693878,
                availableWeight: 0.49,
                availableFactorCount: 2
            }),
            calculateCandidate(saraContext, "Painting Studio", {
                interest: 0.56,
                goal: 0,
                finalScore: 0.37714285714285717,
                availableWeight: 0.49,
                availableFactorCount: 2
            }),
            calculateCandidate(saraContext, "Football Team Camp", {
                interest: null,
                goal: 0.5,
                finalScore: 0.5,
                availableWeight: 0.16,
                availableFactorCount: 1
            }),
            calculateCandidate(saraContext, "Strategy Escape Challenge", {
                interest: null,
                goal: 1,
                finalScore: 1,
                availableWeight: 0.16,
                availableFactorCount: 1
            }),
            calculateCandidate(saraContext, "Creative Robotics", {
                interest: 0.88,
                goal: 0.5,
                finalScore: 0.7559183673469388,
                availableWeight: 0.49,
                availableFactorCount: 2
            })
        ];
        const omarResults = [
            calculateCandidate(omarContext, "Robotics Lab", {
                interest: null,
                goal: 1,
                finalScore: 1,
                availableWeight: 0.16,
                availableFactorCount: 1
            }),
            calculateCandidate(omarContext, "Football Team Camp", {
                interest: 0.91,
                goal: 1,
                finalScore: 0.9393877551020409,
                availableWeight: 0.49,
                availableFactorCount: 2
            }),
            calculateCandidate(omarContext, "Strategy Escape Challenge", {
                interest: null,
                goal: 1,
                finalScore: 1,
                availableWeight: 0.16,
                availableFactorCount: 1
            })
        ];
        const linaResults = [
            calculateCandidate(linaContext, "Painting Studio", {
                interest: null,
                goal: 1,
                finalScore: 1,
                availableWeight: 0.16,
                availableFactorCount: 1
            }),
            calculateCandidate(linaContext, "Creative Robotics", {
                interest: null,
                goal: 1,
                finalScore: 1,
                availableWeight: 0.16,
                availableFactorCount: 1
            })
        ];

        assert.strictEqual(saraContext.candidates.length, 5);
        assert.strictEqual(omarContext.candidates.length, 3);
        assert.strictEqual(linaContext.candidates.length, 2);
        assert.strictEqual(
            snapshot(saraContext.candidates.map((candidate) => candidate.activity?.title)),
            saraOrder
        );
        assert.strictEqual(
            snapshot(omarContext.candidates.map((candidate) => candidate.activity?.title)),
            omarOrder
        );
        assert.strictEqual(
            snapshot(linaContext.candidates.map((candidate) => candidate.activity?.title)),
            linaOrder
        );
        assertClose(
            "Sara Painting available-zero denominator",
            saraResults[1].aggregate.score,
            0.37714285714285717
        );

        console.log("========================================");
        console.log("STEP 15H-B - REAL FINAL SCORE");
        console.log("========================================");
        console.log("");
        printResults("Sara", saraResults);
        console.log("");
        printResults("Omar", omarResults);
        console.log("");
        printResults("Lina", linaResults);
        console.log("");
        console.log("Available-zero denominator: PASS");
        console.log("Unavailable weights excluded: PASS");
        console.log("Candidate counts preserved: PASS");
        console.log("Candidate order preserved: PASS");
        console.log("Ranking: NONE");
        console.log("Mongo writes: NONE");
        console.log("Neo4j writes: NONE");
        console.log("");
        console.log("========================================");
        console.log("STEP 15H-B REAL FINAL SCORE PASSED");
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
        console.error("STEP 15H-B REAL FINAL SCORE FAILED");
        console.error(error);
        process.exit(1);
    });
