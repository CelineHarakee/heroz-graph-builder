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

function activityIdOf(record) {
    return String(
        record.candidate.currentActivity?._id ??
        record.candidate.activity?.activityId
    );
}

function titleOf(record) {
    return record.candidate.activity?.title;
}

function calculateScoredRecords(context) {
    const contextSnapshot = snapshot(context);
    const candidateSnapshots = context.candidates.map(snapshot);
    const records = context.candidates.map((candidate) => {
        const eligibilityEvaluation = makeEligibleEvaluation(candidate);
        const eligibilitySnapshot = snapshot(eligibilityEvaluation);
        const scoringState = createCandidateScoringState(eligibilityEvaluation);
        const results = {
            interest: calculateInterestFactor(context, eligibilityEvaluation),
            preference: calculatePreferenceFactor(context, eligibilityEvaluation),
            goal: calculateGoalFactor(context, eligibilityEvaluation),
            exploration: calculateExplorationFactor(context, eligibilityEvaluation),
            behavior: calculateBehaviorFactor(context, eligibilityEvaluation),
            session: calculateSessionFactor(eligibilityEvaluation, context)
        };
        const completedState = composeFactors(scoringState, results);
        const finalScore = calculateFinalScore(completedState);

        assert.strictEqual(snapshot(eligibilityEvaluation), eligibilitySnapshot);

        return {
            candidate,
            eligibilityEvaluation,
            scoringState: completedState,
            finalScore
        };
    });

    assert.strictEqual(snapshot(context), contextSnapshot);
    context.candidates.forEach((candidate, index) => {
        assert.strictEqual(snapshot(candidate), candidateSnapshots[index]);
    });

    return records;
}

function assertScores(records, expectedByTitle) {
    for (const record of records) {
        const expected = expectedByTitle[titleOf(record)];

        assert(expected !== undefined, `Unexpected candidate ${titleOf(record)}`);
        assert.strictEqual(record.finalScore.available, true);
        assertClose(`${titleOf(record)} final score`, record.finalScore.score, expected);
    }
}

function assertRankingResult(label, input, ranking, expectedTitles) {
    assert.strictEqual(ranking.ranked.length, expectedTitles.length);
    assert.strictEqual(ranking.unranked.length, 0, `${label} unranked count`);
    assert.deepStrictEqual(ranking.ranked.map(titleOf), expectedTitles);
    assert.deepStrictEqual(
        ranking.ranked.map((record) => record.rank),
        expectedTitles.map((_, index) => index + 1)
    );
    assert.strictEqual(input.every((record) => !Object.prototype.hasOwnProperty.call(
        record,
        "rank"
    )), true);
}

function assertTieResolvedByActivityId(ranking, tiedTitles) {
    const tiedRecords = ranking.ranked.filter(
        (record) => tiedTitles.includes(titleOf(record))
    );
    const sortedIds = tiedRecords.map(activityIdOf).slice().sort();

    assert.deepStrictEqual(tiedRecords.map(activityIdOf), sortedIds);
}

function assertPreserved(input, snapshots, ranking) {
    input.forEach((record, index) => {
        assert.strictEqual(snapshot(record), snapshots[index]);
    });

    for (const rankedRecord of ranking.ranked) {
        const original = input.find(
            (record) => activityIdOf(record) === activityIdOf(rankedRecord)
        );

        assert(original, `${titleOf(rankedRecord)} original record missing`);
        assert.notStrictEqual(rankedRecord, original);
        assert.strictEqual(rankedRecord.candidate, original.candidate);
        assert.deepStrictEqual(rankedRecord.finalScore, original.finalScore);
        assert.deepStrictEqual(
            rankedRecord.scoringState.factors,
            original.scoringState.factors
        );

        for (const factor of FACTORS) {
            assert.deepStrictEqual(
                rankedRecord.scoringState.factors[factor],
                original.scoringState.factors[factor]
            );
        }
    }
}

async function verifyChild({ db, name, expectedCount, expectedScores, expectedOrder, tiedTitles = [] }) {
    const child = await loadChildByName(db, name);
    const context = await buildRecommendationContext(child._id);
    const contextSnapshot = snapshot(context);
    const inputOrder = snapshot(context.candidates.map(
        (candidate) => candidate.activity?.activityId
    ));

    assert.strictEqual(context.candidates.length, expectedCount);

    const records = calculateScoredRecords(context);
    const recordSnapshots = records.map(snapshot);

    assertScores(records, expectedScores);

    const ranking = rankCandidates(records);

    assertRankingResult(name, records, ranking, expectedOrder);
    assertPreserved(records, recordSnapshots, ranking);
    assert.strictEqual(snapshot(context), contextSnapshot);
    assert.strictEqual(
        snapshot(context.candidates.map((candidate) => candidate.activity?.activityId)),
        inputOrder
    );

    if (tiedTitles.length > 0) {
        assertTieResolvedByActivityId(ranking, tiedTitles);
    }

    return ranking;
}

function printRanking(label, ranking) {
    console.log(`${label}:`);

    for (const record of ranking.ranked) {
        console.log(
            `${record.rank} -> ${titleOf(record)} -> ${record.finalScore.score}`
        );
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
            expectedScores: {
                "Robotics Lab": 0.9191836734693878,
                "Painting Studio": 0.37714285714285717,
                "Football Team Camp": 0.5,
                "Strategy Escape Challenge": 1,
                "Creative Robotics": 0.7559183673469388
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
            expectedScores: {
                "Robotics Lab": 1,
                "Football Team Camp": 0.9393877551020409,
                "Strategy Escape Challenge": 1
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
            expectedScores: {
                "Painting Studio": 1,
                "Creative Robotics": 1
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
        console.log("STEP 15I-B - REAL V1 RANKING");
        console.log("========================================");
        console.log("");
        printRanking("Sara", saraRanking);
        console.log("");
        printRanking("Omar", omarRanking);
        console.log("");
        printRanking("Lina", linaRanking);
        console.log("");
        console.log("Omar tie resolved by Activity ID: PASS");
        console.log("Lina tie resolved by Activity ID: PASS");
        console.log("Original scoring input order preserved: PASS");
        console.log("Scores preserved: PASS");
        console.log("Raw factors preserved: PASS");
        console.log("Top-N: NONE");
        console.log("");
        console.log("STEP 15I-B REAL V1 RANKING PASSED");
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
