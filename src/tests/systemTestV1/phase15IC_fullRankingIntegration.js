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
const { rankCandidates } = require("../../recommendation/rankingService");

const DATASET = "SYSTEM_TEST_V1";
const FACTORS = Object.values(SCORING_FACTORS);

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

function titleOf(record) {
    return record.candidate.activity?.title;
}

function activityIdOf(record) {
    return String(
        record.candidate.currentActivity?._id ??
        record.candidate.activity?.activityId
    );
}

function calculateRecord(context, candidate) {
    const eligibilityEvaluation = makeEligibleEvaluation(candidate);
    const eligibilitySnapshot = snapshot(eligibilityEvaluation);
    const originalState = createCandidateScoringState(eligibilityEvaluation);
    const results = {
        interest: calculateInterestFactor(context, eligibilityEvaluation),
        preference: calculatePreferenceFactor(context, eligibilityEvaluation),
        goal: calculateGoalFactor(context, eligibilityEvaluation),
        exploration: calculateExplorationFactor(context, eligibilityEvaluation),
        behavior: calculateBehaviorFactor(context, eligibilityEvaluation),
        session: calculateSessionFactor(eligibilityEvaluation, context)
    };
    const scoringState = composeFactors(originalState, results);
    const scoringSnapshot = snapshot(scoringState);
    const finalScore = calculateFinalScore(scoringState);

    assert.strictEqual(snapshot(eligibilityEvaluation), eligibilitySnapshot);
    assert.strictEqual(snapshot(scoringState), scoringSnapshot);

    return {
        candidate,
        eligibilityEvaluation,
        scoringState,
        finalScore
    };
}

function calculateRecords(context) {
    const contextSnapshot = snapshot(context);
    const parentSnapshot = snapshot(context.parent);
    const historySnapshot = snapshot(context.historyContext);
    const interestSnapshot = snapshot(context.interestContext);
    const goalSnapshot = snapshot(context.goalContext);
    const candidateSnapshots = context.candidates.map(snapshot);
    const records = context.candidates.map((candidate) =>
        calculateRecord(context, candidate)
    );

    assert.strictEqual(snapshot(context), contextSnapshot);
    assert.strictEqual(snapshot(context.parent), parentSnapshot);
    assert.strictEqual(snapshot(context.historyContext), historySnapshot);
    assert.strictEqual(snapshot(context.interestContext), interestSnapshot);
    assert.strictEqual(snapshot(context.goalContext), goalSnapshot);
    context.candidates.forEach((candidate, index) => {
        assert.strictEqual(snapshot(candidate), candidateSnapshots[index]);
    });

    return records;
}

function assertRawFactor(result, factor, expectedScore) {
    assert.strictEqual(result.factor, factor);
    assert(Array.isArray(result.evidence));

    if (expectedScore === null) {
        assert.strictEqual(result.available, false);
        assert.strictEqual(result.score, null);
        return;
    }

    assert.strictEqual(result.available, true);
    assertClose(`${factor} score`, result.score, expectedScore);
}

function assertRecordScores(records, expectedByTitle) {
    for (const record of records) {
        const expected = expectedByTitle[titleOf(record)];

        assert(expected, `Unexpected candidate ${titleOf(record)}`);
        assertRawFactor(
            record.scoringState.factors.interest,
            SCORING_FACTORS.INTEREST,
            expected.interest
        );
        assertRawFactor(
            record.scoringState.factors.preference,
            SCORING_FACTORS.PREFERENCE,
            null
        );
        assertRawFactor(
            record.scoringState.factors.goal,
            SCORING_FACTORS.GOAL,
            expected.goal
        );
        assertRawFactor(
            record.scoringState.factors.exploration,
            SCORING_FACTORS.EXPLORATION,
            null
        );
        assertRawFactor(
            record.scoringState.factors.behavior,
            SCORING_FACTORS.BEHAVIOR,
            null
        );
        assertRawFactor(
            record.scoringState.factors.session,
            SCORING_FACTORS.SESSION,
            null
        );
        assert.strictEqual(record.finalScore.available, true);
        assertClose(
            `${titleOf(record)} final score`,
            record.finalScore.score,
            expected.finalScore
        );
    }
}

function assertRanking({
    name,
    context,
    records,
    expectedOrder,
    tiedTitles = []
}) {
    const contextSnapshot = snapshot(context);
    const inputSnapshot = snapshot(records);
    const originalOrder = snapshot(records.map(activityIdOf));
    const finalSnapshots = records.map((record) => snapshot(record.finalScore));
    const factorSnapshots = records.map((record) =>
        snapshot(record.scoringState.factors)
    );
    const ranking = rankCandidates(records);

    assert.strictEqual(snapshot(context), contextSnapshot);
    assert.strictEqual(snapshot(records), inputSnapshot);
    assert.strictEqual(snapshot(records.map(activityIdOf)), originalOrder);
    assert.deepStrictEqual(ranking.ranked.map(titleOf), expectedOrder);
    assert.strictEqual(ranking.unranked.length, 0, `${name} unranked count`);
    assert.deepStrictEqual(
        ranking.ranked.map((record) => record.rank),
        expectedOrder.map((_, index) => index + 1)
    );
    assert.strictEqual(ranking.ranked.length, expectedOrder.length);

    for (const rankedRecord of ranking.ranked) {
        const originalIndex = records.findIndex(
            (record) => activityIdOf(record) === activityIdOf(rankedRecord)
        );

        assert(originalIndex >= 0, `${titleOf(rankedRecord)} original missing`);
        assert.notStrictEqual(rankedRecord, records[originalIndex]);
        assert.deepStrictEqual(
            snapshot(rankedRecord.finalScore),
            finalSnapshots[originalIndex]
        );
        assert.deepStrictEqual(
            snapshot(rankedRecord.scoringState.factors),
            factorSnapshots[originalIndex]
        );
        assert(!Object.prototype.hasOwnProperty.call(
            records[originalIndex],
            "rank"
        ));
    }

    if (tiedTitles.length > 0) {
        const tiedRecords = ranking.ranked.filter(
            (record) => tiedTitles.includes(titleOf(record))
        );
        const sortedIds = tiedRecords.map(activityIdOf).slice().sort();
        const tiedScores = new Set(tiedRecords.map(
            (record) => record.finalScore.score
        ));

        assert.strictEqual(tiedScores.size, 1, `${name} exact tie preserved`);
        assert.deepStrictEqual(tiedRecords.map(activityIdOf), sortedIds);
    }

    return ranking;
}

async function verifyChild({
    db,
    name,
    expectedCount,
    expectedByTitle,
    expectedOrder,
    tiedTitles = []
}) {
    const child = await loadChildByName(db, name);
    const context = await buildRecommendationContext(child._id);
    const contextSnapshot = snapshot(context);

    assert.strictEqual(context.candidates.length, expectedCount);

    const records = calculateRecords(context);

    assertRecordScores(records, expectedByTitle);

    const ranking = assertRanking({
        name,
        context,
        records,
        expectedOrder,
        tiedTitles
    });

    assert.strictEqual(snapshot(context), contextSnapshot);
    assert.strictEqual(ranking.ranked.length, expectedCount);
    assert.strictEqual(ranking.unranked.length, 0);

    return ranking;
}

function printRanking(label, ranking) {
    console.log(`${label}:`);

    for (const record of ranking.ranked) {
        console.log(`${record.rank} ${titleOf(record)} ${record.finalScore.score}`);
    }
}

async function main() {
    await connectMongoDB();
    const db = getDatabase();

    try {
        const saraRanking = await verifyChild({
            db,
            name: "Sara",
            expectedCount: 5,
            expectedByTitle: {
                "Robotics Lab": {
                    interest: 0.88,
                    goal: 1,
                    finalScore: 0.9191836734693878
                },
                "Painting Studio": {
                    interest: 0.56,
                    goal: 0,
                    finalScore: 0.37714285714285717
                },
                "Football Team Camp": {
                    interest: null,
                    goal: 0.5,
                    finalScore: 0.5
                },
                "Strategy Escape Challenge": {
                    interest: null,
                    goal: 1,
                    finalScore: 1
                },
                "Creative Robotics": {
                    interest: 0.88,
                    goal: 0.5,
                    finalScore: 0.7559183673469388
                }
            },
            expectedOrder: [
                "Strategy Escape Challenge",
                "Robotics Lab",
                "Creative Robotics",
                "Football Team Camp",
                "Painting Studio"
            ]
        });
        const omarRanking = await verifyChild({
            db,
            name: "Omar",
            expectedCount: 3,
            expectedByTitle: {
                "Robotics Lab": {
                    interest: null,
                    goal: 1,
                    finalScore: 1
                },
                "Football Team Camp": {
                    interest: 0.91,
                    goal: 1,
                    finalScore: 0.9393877551020409
                },
                "Strategy Escape Challenge": {
                    interest: null,
                    goal: 1,
                    finalScore: 1
                }
            },
            expectedOrder: [
                "Robotics Lab",
                "Strategy Escape Challenge",
                "Football Team Camp"
            ],
            tiedTitles: [
                "Robotics Lab",
                "Strategy Escape Challenge"
            ]
        });
        const linaRanking = await verifyChild({
            db,
            name: "Lina",
            expectedCount: 2,
            expectedByTitle: {
                "Painting Studio": {
                    interest: null,
                    goal: 1,
                    finalScore: 1
                },
                "Creative Robotics": {
                    interest: null,
                    goal: 1,
                    finalScore: 1
                }
            },
            expectedOrder: [
                "Painting Studio",
                "Creative Robotics"
            ],
            tiedTitles: [
                "Painting Studio",
                "Creative Robotics"
            ]
        });

        console.log("========================================");
        console.log("STEP 15I-C - REAL FULL RANKING INTEGRATION");
        console.log("========================================");
        console.log("");
        printRanking("Sara", saraRanking);
        console.log("");
        printRanking("Omar", omarRanking);
        console.log("");
        printRanking("Lina", linaRanking);
        console.log("");
        console.log("Scores preserved: PASS");
        console.log("Raw factors preserved: PASS");
        console.log("Context preserved: PASS");
        console.log("Original order preserved: PASS");
        console.log("No Top-N: PASS");
        console.log("");
        console.log("STEP 15I-C REAL FULL RANKING INTEGRATION PASSED");
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
