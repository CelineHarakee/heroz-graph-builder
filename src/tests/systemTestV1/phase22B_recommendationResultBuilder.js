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
const {
    buildRecommendationResults
} = require("../../recommendation/recommendationResultBuilder");

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

function assertNoInternalLeak(result) {
    const forbiddenFields = [
        "candidate",
        "eligibilityEvaluation",
        "scoringState",
        "currentActivity",
        "currentVendor",
        "currentSessions",
        "sessionEvaluations",
        "failedConstraints",
        "historyContext",
        "interestContext",
        "goalContext",
        "parent",
        "child",
        "unselectedRanked",
        "unranked",
        "reason",
        "reasonText",
        "explanation",
        "whyRecommended",
        "message"
    ];

    for (const field of forbiddenFields) {
        assert(
            !Object.prototype.hasOwnProperty.call(result, field),
            `${field} leaked into result`
        );
    }

    assert(!Object.prototype.hasOwnProperty.call(result.factors, "vendor"));
}

function assertResultMatchesRecord(result, record) {
    assert.strictEqual(
        result.activityId,
        String(record.candidate.currentActivity?._id ?? record.candidate.activity.activityId)
    );
    assert.strictEqual(result.rank, record.rank);
    assert.strictEqual(result.score, record.finalScore.score);
    assert.strictEqual(result.scoring.availableWeight, record.finalScore.availableWeight);
    assert.strictEqual(
        result.scoring.availableFactorCount,
        record.finalScore.availableFactorCount
    );
    assert.deepStrictEqual(
        result.scoring.contributions,
        record.finalScore.contributions
    );
    assert.notStrictEqual(
        result.scoring.contributions,
        record.finalScore.contributions
    );
    assert.deepStrictEqual(result.eligibleSessionIds, []);
    assert.strictEqual(
        snapshot(result.evidence.discovery),
        snapshot(record.candidate.evidence)
    );
    assert.notStrictEqual(result.evidence.discovery, record.candidate.evidence);
    assert.deepStrictEqual(Object.keys(result.factors), FACTORS);
    assert.deepStrictEqual(Object.keys(result.evidence.factors), FACTORS);

    for (const factor of FACTORS) {
        const factorResult = record.scoringState.factors[factor];

        assert.deepStrictEqual(result.factors[factor], {
            available: factorResult.available,
            score: factorResult.score
        });
        assert.strictEqual(
            snapshot(result.evidence.factors[factor]),
            snapshot(factorResult.evidence)
        );
        assert.notStrictEqual(
            result.evidence.factors[factor],
            factorResult.evidence
        );
    }

    assertNoInternalLeak(result);
}

async function verifyChild({
    db,
    name,
    n,
    expectedSelected
}) {
    const child = await loadChildByName(db, name);
    const context = await buildRecommendationContext(child._id);
    const contextSnapshot = snapshot(context);
    const records = calculateRecords(context);
    const ranking = rankCandidates(records);
    const rankingSnapshot = snapshot(ranking);
    const selection = selectTopN(ranking, n);
    const selectionSnapshot = snapshot(selection);
    const results = buildRecommendationResults(selection);

    assert.deepStrictEqual(selection.selected.map(titleOf), expectedSelected);
    assert.deepStrictEqual(
        results.map((result) => result.rank),
        selection.selected.map((record) => record.rank)
    );
    assert.deepStrictEqual(
        results.map((result) => result.score),
        selection.selected.map((record) => record.finalScore.score)
    );
    assert.strictEqual(results.length, expectedSelected.length);

    for (let index = 0; index < results.length; index += 1) {
        assertResultMatchesRecord(results[index], selection.selected[index]);
    }

    assert.strictEqual(snapshot(context), contextSnapshot);
    assert.strictEqual(snapshot(ranking), rankingSnapshot);
    assert.strictEqual(snapshot(selection), selectionSnapshot);

    return results;
}

function printResults(label, results) {
    console.log(`${label}:`);

    for (const result of results) {
        console.log(`${result.rank} ${result.activityId} ${result.score}`);
    }
}

async function main() {
    await connectMongoDB();
    const db = getDatabase();

    try {
        const sara = await verifyChild({
            db,
            name: "Sara",
            n: 3,
            expectedSelected: [
                "Strategy Escape Challenge",
                "Robotics Lab",
                "Creative Robotics"
            ]
        });
        const omar = await verifyChild({
            db,
            name: "Omar",
            n: 2,
            expectedSelected: [
                "Robotics Lab",
                "Strategy Escape Challenge"
            ]
        });
        const lina = await verifyChild({
            db,
            name: "Lina",
            n: 2,
            expectedSelected: [
                "Painting Studio",
                "Creative Robotics"
            ]
        });

        console.log("========================================");
        console.log("STEP 22B - REAL RECOMMENDATION RESULT BUILDER");
        console.log("========================================");
        console.log("");
        printResults("Sara N=3", sara);
        console.log("");
        printResults("Omar N=2", omar);
        console.log("");
        printResults("Lina N=2", lina);
        console.log("");
        console.log("Scores preserved: PASS");
        console.log("Ranks preserved: PASS");
        console.log("Evidence preserved: PASS");
        console.log("Context preserved: PASS");
        console.log("Internal data leakage: NONE");
        console.log("");
        console.log("STEP 22B REAL RECOMMENDATION RESULT BUILDER PASSED");
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
