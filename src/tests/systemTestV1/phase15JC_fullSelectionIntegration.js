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
const { selectTopN } = require("../../recommendation/selectionService");

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

function assertRawFactor(record, factor, expectedScore) {
    const result = record.scoringState.factors[factor];

    assert.strictEqual(result.factor, factor);
    assert(Array.isArray(result.evidence));

    if (expectedScore === null) {
        assert.strictEqual(result.available, false, `${titleOf(record)} ${factor} available`);
        assert.strictEqual(result.score, null, `${titleOf(record)} ${factor} score`);
        return;
    }

    assert.strictEqual(result.available, true, `${titleOf(record)} ${factor} available`);
    assertClose(`${titleOf(record)} ${factor} score`, result.score, expectedScore);
}

function calculateRecord(context, candidate) {
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
    const scoringState = composeFactors(state, results);
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
    const snapshots = {
        context: snapshot(context),
        parent: snapshot(context.parent),
        interestContext: snapshot(context.interestContext),
        goalContext: snapshot(context.goalContext),
        historyContext: snapshot(context.historyContext),
        candidates: context.candidates.map(snapshot)
    };
    const records = context.candidates.map((candidate) =>
        calculateRecord(context, candidate)
    );

    assert.strictEqual(snapshot(context), snapshots.context);
    assert.strictEqual(snapshot(context.parent), snapshots.parent);
    assert.strictEqual(snapshot(context.interestContext), snapshots.interestContext);
    assert.strictEqual(snapshot(context.goalContext), snapshots.goalContext);
    assert.strictEqual(snapshot(context.historyContext), snapshots.historyContext);
    context.candidates.forEach((candidate, index) => {
        assert.strictEqual(snapshot(candidate), snapshots.candidates[index]);
    });

    return records;
}

function verifyScores(records, expectedByTitle) {
    for (const record of records) {
        const expected = expectedByTitle[titleOf(record)];

        assert(expected, `Unexpected candidate ${titleOf(record)}`);
        assertRawFactor(record, SCORING_FACTORS.INTEREST, expected.interest);
        assertRawFactor(record, SCORING_FACTORS.PREFERENCE, null);
        assertRawFactor(record, SCORING_FACTORS.GOAL, expected.goal);
        assertRawFactor(record, SCORING_FACTORS.EXPLORATION, null);
        assertRawFactor(record, SCORING_FACTORS.BEHAVIOR, null);
        assertRawFactor(record, SCORING_FACTORS.SESSION, null);
        assert.strictEqual(record.finalScore.available, true);
        assertClose(
            `${titleOf(record)} final score`,
            record.finalScore.score,
            expected.finalScore
        );
    }
}

function verifyRanking(ranking, expectedRanked, tiedTitles = []) {
    assert.deepStrictEqual(ranking.ranked.map(titleOf), expectedRanked);
    assert.deepStrictEqual(
        ranking.ranked.map((record) => record.rank),
        expectedRanked.map((_, index) => index + 1)
    );
    assert.strictEqual(ranking.unranked.length, 0);

    if (tiedTitles.length > 0) {
        const tiedRecords = ranking.ranked.filter(
            (record) => tiedTitles.includes(titleOf(record))
        );
        const scoreSet = new Set(tiedRecords.map((record) => record.finalScore.score));
        const sortedIds = tiedRecords.map(activityIdOf).slice().sort();

        assert.strictEqual(scoreSet.size, 1);
        assert.deepStrictEqual(tiedRecords.map(activityIdOf), sortedIds);
    }
}

function verifySelection({
    ranking,
    rankingSnapshot,
    records,
    recordSnapshot,
    context,
    contextSnapshot,
    n,
    expectedSelected
}) {
    const selection = selectTopN(ranking, n);
    const expectedUnselected = ranking.ranked.slice(expectedSelected.length);

    assert.strictEqual(snapshot(ranking), rankingSnapshot);
    assert.strictEqual(snapshot(records), recordSnapshot);
    assert.strictEqual(snapshot(context), contextSnapshot);
    assert.deepStrictEqual(selection.selected.map(titleOf), expectedSelected);
    assert.deepStrictEqual(selection.selected, ranking.ranked.slice(0, n));
    assert.deepStrictEqual(selection.unselectedRanked, expectedUnselected);
    assert.deepStrictEqual(selection.unranked, ranking.unranked);
    assert.deepStrictEqual(
        selection.selected.map((record) => record.rank),
        expectedSelected.map((_, index) => index + 1)
    );

    for (const record of [
        ...selection.selected,
        ...selection.unselectedRanked
    ]) {
        const source = ranking.ranked.find(
            (item) => activityIdOf(item) === activityIdOf(record)
        );

        assert.strictEqual(record, source);
        assert.deepStrictEqual(record.finalScore, source.finalScore);
        for (const factor of FACTORS) {
            assert.deepStrictEqual(
                record.scoringState.factors[factor],
                source.scoringState.factors[factor]
            );
        }
    }

    return selection;
}

async function verifyChild({
    db,
    name,
    expectedCount,
    expectedByTitle,
    expectedRanked,
    selections,
    tiedTitles = []
}) {
    const child = await loadChildByName(db, name);
    const context = await buildRecommendationContext(child._id);
    const contextSnapshot = snapshot(context);
    const originalCandidateOrder = snapshot(context.candidates.map(
        (candidate) => candidate.activity?.activityId
    ));

    assert.strictEqual(context.candidates.length, expectedCount);

    const records = calculateRecords(context);
    const recordSnapshot = snapshot(records);

    verifyScores(records, expectedByTitle);

    const ranking = rankCandidates(records);
    const rankingSnapshot = snapshot(ranking);

    verifyRanking(ranking, expectedRanked, tiedTitles);

    const outputs = {};

    for (const [nText, expectedSelected] of Object.entries(selections)) {
        outputs[nText] = verifySelection({
            ranking,
            rankingSnapshot,
            records,
            recordSnapshot,
            context,
            contextSnapshot,
            n: Number(nText),
            expectedSelected
        });
    }

    assert.strictEqual(
        snapshot(context.candidates.map((candidate) => candidate.activity?.activityId)),
        originalCandidateOrder
    );

    return {
        ranking,
        outputs
    };
}

function printSelections(label, outputs) {
    console.log(`${label}:`);

    for (const [n, selection] of Object.entries(outputs)) {
        console.log(
            `N=${n}: ${selection.selected.map(titleOf).join(", ") || "[]"}`
        );
    }
}

async function main() {
    await connectMongoDB();
    const db = getDatabase();

    try {
        const sara = await verifyChild({
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
            expectedRanked: [
                "Strategy Escape Challenge",
                "Robotics Lab",
                "Creative Robotics",
                "Football Team Camp",
                "Painting Studio"
            ],
            selections: {
                1: ["Strategy Escape Challenge"],
                3: [
                    "Strategy Escape Challenge",
                    "Robotics Lab",
                    "Creative Robotics"
                ],
                5: [
                    "Strategy Escape Challenge",
                    "Robotics Lab",
                    "Creative Robotics",
                    "Football Team Camp",
                    "Painting Studio"
                ],
                10: [
                    "Strategy Escape Challenge",
                    "Robotics Lab",
                    "Creative Robotics",
                    "Football Team Camp",
                    "Painting Studio"
                ]
            }
        });
        const omar = await verifyChild({
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
            expectedRanked: [
                "Robotics Lab",
                "Strategy Escape Challenge",
                "Football Team Camp"
            ],
            tiedTitles: [
                "Robotics Lab",
                "Strategy Escape Challenge"
            ],
            selections: {
                1: ["Robotics Lab"],
                2: [
                    "Robotics Lab",
                    "Strategy Escape Challenge"
                ],
                3: [
                    "Robotics Lab",
                    "Strategy Escape Challenge",
                    "Football Team Camp"
                ],
                5: [
                    "Robotics Lab",
                    "Strategy Escape Challenge",
                    "Football Team Camp"
                ]
            }
        });
        const lina = await verifyChild({
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
            expectedRanked: [
                "Painting Studio",
                "Creative Robotics"
            ],
            tiedTitles: [
                "Painting Studio",
                "Creative Robotics"
            ],
            selections: {
                1: ["Painting Studio"],
                2: [
                    "Painting Studio",
                    "Creative Robotics"
                ],
                5: [
                    "Painting Studio",
                    "Creative Robotics"
                ]
            }
        });

        console.log("========================================");
        console.log("STEP 15J-C - REAL FULL TOP-N PIPELINE");
        console.log("========================================");
        console.log("");
        printSelections("Sara", sara.outputs);
        console.log("");
        printSelections("Omar", omar.outputs);
        console.log("");
        printSelections("Lina", lina.outputs);
        console.log("");
        console.log("Raw factors verified: PASS");
        console.log("Final scores verified: PASS");
        console.log("Ranking verified: PASS");
        console.log("Selection verified: PASS");
        console.log("Ranks preserved: PASS");
        console.log("Scores preserved: PASS");
        console.log("Context preserved: PASS");
        console.log("Ranking result preserved across N: PASS");
        console.log("");
        console.log("STEP 15J-C REAL FULL TOP-N PIPELINE PASSED");
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
