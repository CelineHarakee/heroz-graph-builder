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

function calculateRecords(context) {
    const contextSnapshot = snapshot(context);
    const records = context.candidates.map((candidate) => {
        const eligibilityEvaluation = makeEligibleEvaluation(candidate);
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

        return {
            candidate,
            eligibilityEvaluation,
            scoringState,
            finalScore: calculateFinalScore(scoringState)
        };
    });

    assert.strictEqual(snapshot(context), contextSnapshot);

    return records;
}

function assertSelection(selection, expectedSelected, expectedUnselected) {
    assert.deepStrictEqual(selection.selected.map(titleOf), expectedSelected);
    assert.deepStrictEqual(
        selection.unselectedRanked.map(titleOf),
        expectedUnselected
    );
    assert.deepStrictEqual(
        selection.selected.map((record) => record.rank),
        expectedSelected.map((_, index) => index + 1)
    );
    assert.deepStrictEqual(
        selection.unselectedRanked.map((record) => record.rank),
        expectedUnselected.map((_, index) => expectedSelected.length + index + 1)
    );
    assert.deepStrictEqual(selection.unranked, []);
}

function assertPreserved(ranking, rankingSnapshot, context, contextSnapshot) {
    assert.strictEqual(snapshot(ranking), rankingSnapshot);
    assert.strictEqual(snapshot(context), contextSnapshot);

    for (const record of ranking.ranked) {
        for (const factor of FACTORS) {
            assert(record.scoringState.factors[factor]);
        }
    }
}

async function verifyChild({
    db,
    name,
    expectedRanked,
    selections
}) {
    const child = await loadChildByName(db, name);
    const context = await buildRecommendationContext(child._id);
    const contextSnapshot = snapshot(context);
    const records = calculateRecords(context);
    const ranking = rankCandidates(records);
    const rankingSnapshot = snapshot(ranking);
    const outputs = {};

    assert.deepStrictEqual(ranking.ranked.map(titleOf), expectedRanked);
    assert.strictEqual(ranking.unranked.length, 0);

    for (const [nText, expectedSelected] of Object.entries(selections)) {
        const n = Number(nText);
        const selection = selectTopN(ranking, n);
        const expectedUnselected = expectedRanked.slice(expectedSelected.length);

        assertSelection(selection, expectedSelected, expectedUnselected);
        assertPreserved(ranking, rankingSnapshot, context, contextSnapshot);

        for (const record of [
            ...selection.selected,
            ...selection.unselectedRanked
        ]) {
            const original = ranking.ranked.find(
                (item) => titleOf(item) === titleOf(record)
            );

            assert(original, `${titleOf(record)} missing from ranking`);
            assert.strictEqual(record, original);
            assert.deepStrictEqual(record.finalScore, original.finalScore);
            assert.deepStrictEqual(
                record.scoringState.factors,
                original.scoringState.factors
            );
        }

        outputs[nText] = selection;
    }

    return {
        ranking,
        outputs
    };
}

function printSelection(label, outputs) {
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
            expectedRanked: [
                "Robotics Lab",
                "Strategy Escape Challenge",
                "Football Team Camp"
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
            expectedRanked: [
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
        console.log("STEP 15J-B - REAL TOP-N SELECTION");
        console.log("========================================");
        console.log("");
        printSelection("Sara", sara.outputs);
        console.log("");
        printSelection("Omar", omar.outputs);
        console.log("");
        printSelection("Lina", lina.outputs);
        console.log("");
        console.log("Ranking result preserved: PASS");
        console.log("Ranks preserved: PASS");
        console.log("Scores preserved: PASS");
        console.log("Raw factors preserved: PASS");
        console.log("Context preserved: PASS");
        console.log("");
        console.log("STEP 15J-B REAL TOP-N SELECTION PASSED");
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
