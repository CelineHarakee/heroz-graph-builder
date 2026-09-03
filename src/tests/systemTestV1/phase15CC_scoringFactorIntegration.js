require("dotenv").config();

const { ObjectId } = require("mongodb");
const { connectMongoDB, getDatabase } = require("../../config/mongodb");
const driver = require("../../config/neo4j");
const {
    buildRecommendationContext
} = require("../../recommendation/recommendationContextService");
const {
    SCORING_FACTORS,
    createCandidateScoringState
} = require("../../recommendation/scoringContract");
const {
    calculateInterestFactor
} = require("../../recommendation/interestFactorService");
const {
    calculatePreferenceFactor
} = require("../../recommendation/preferenceFactorService");

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

function integrateRealCandidate(context, candidate) {
    const evidenceSnapshot = JSON.stringify(candidate.evidence);
    const evaluation = makeEligibleEvaluation(candidate);
    const state = createCandidateScoringState(evaluation);
    const interestResult = calculateInterestFactor(context, evaluation);
    const preferenceResult = calculatePreferenceFactor(context, evaluation);
    const integratedState = {
        ...state,
        factors: {
            ...state.factors,
            [SCORING_FACTORS.INTEREST]: interestResult,
            [SCORING_FACTORS.PREFERENCE]: preferenceResult
        }
    };

    assertEqual(
        `${candidate.activity?.title} D4 evidence preserved`,
        JSON.stringify(candidate.evidence),
        evidenceSnapshot
    );
    assertEqual(
        `${candidate.activity?.title} eligibility preserved`,
        evaluation.eligibility.eligible,
        true
    );
    assertEqual(
        `${candidate.activity?.title} failures preserved`,
        evaluation.eligibility.failedConstraints.length,
        0
    );
    assertEqual(
        `${candidate.activity?.title} goal untouched`,
        integratedState.factors.goal,
        null
    );
    assertEqual(
        `${candidate.activity?.title} exploration untouched`,
        integratedState.factors.exploration,
        null
    );
    assertEqual(
        `${candidate.activity?.title} behavior untouched`,
        integratedState.factors.behavior,
        null
    );
    assertEqual(
        `${candidate.activity?.title} session untouched`,
        integratedState.factors.session,
        null
    );

    return {
        integratedState,
        interestResult,
        preferenceResult
    };
}

function assertNoFinalFields(state) {
    for (const key of [
        "finalScore",
        "weightedScore",
        "normalizedScore",
        "rank"
    ]) {
        assert(
            !Object.prototype.hasOwnProperty.call(state, key),
            `${key} must not be present`
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
        const saraContextSnapshot = JSON.stringify(saraContext);
        const omarContextSnapshot = JSON.stringify(omarContext);
        const linaContextSnapshot = JSON.stringify(linaContext);

        assertEqual("Sara candidate count", saraContext.candidates.length, 5);
        assertEqual("Omar candidate count", omarContext.candidates.length, 3);
        assertEqual("Lina candidate count", linaContext.candidates.length, 2);

        const roboticsLab = integrateRealCandidate(
            saraContext,
            requireCandidate(saraContext, "Robotics Lab")
        );
        const creativeRobotics = integrateRealCandidate(
            saraContext,
            requireCandidate(saraContext, "Creative Robotics")
        );
        const paintingStudio = integrateRealCandidate(
            saraContext,
            requireCandidate(saraContext, "Painting Studio")
        );
        const omarFootball = integrateRealCandidate(
            omarContext,
            requireCandidate(omarContext, "Football Team Camp")
        );
        const linaCandidate = integrateRealCandidate(
            linaContext,
            requireCandidate(linaContext, "Painting Studio")
        );

        assertClose("Robotics Lab Interest", roboticsLab.interestResult.score, 0.88);
        assertClose(
            "Creative Robotics Interest",
            creativeRobotics.interestResult.score,
            0.88
        );
        assertClose(
            "Painting Studio Interest",
            paintingStudio.interestResult.score,
            0.56
        );
        assertClose("Omar Football Interest", omarFootball.interestResult.score, 0.91);

        for (const result of [
            roboticsLab,
            creativeRobotics,
            paintingStudio,
            omarFootball
        ]) {
            assertEqual("Interest available", result.interestResult.available, true);
            assertEqual("Preference unavailable", result.preferenceResult.available, false);
            assertEqual("Preference score", result.preferenceResult.score, null);
            assertNoFinalFields(result.integratedState);
        }

        assertEqual(
            "Same Robotics Interest signal",
            roboticsLab.interestResult.score,
            creativeRobotics.interestResult.score
        );
        assertEqual("Lina Interest available", linaCandidate.interestResult.available, false);
        assertEqual("Lina Interest score", linaCandidate.interestResult.score, null);
        assertEqual(
            "Lina Preference available",
            linaCandidate.preferenceResult.available,
            false
        );
        assertEqual("Lina Preference score", linaCandidate.preferenceResult.score, null);
        assertNoFinalFields(linaCandidate.integratedState);

        assertEqual("Sara context mutation", JSON.stringify(saraContext), saraContextSnapshot);
        assertEqual("Omar context mutation", JSON.stringify(omarContext), omarContextSnapshot);
        assertEqual("Lina context mutation", JSON.stringify(linaContext), linaContextSnapshot);

        console.log("========================================");
        console.log("STEP 15C-C - REAL SCORING INTEGRATION");
        console.log("========================================");
        console.log("");
        console.log("Sara candidates:                         5 / 5");
        console.log("");
        console.log("Robotics Lab:");
        console.log("  Interest available:                    YES");
        console.log("  Interest score:                        0.88");
        console.log("  Preference available:                  NO");
        console.log("  Preference score:                      null");
        console.log("");
        console.log("Creative Robotics:");
        console.log("  Interest available:                    YES");
        console.log("  Interest score:                        0.88");
        console.log("  Preference available:                  NO");
        console.log("  Preference score:                      null");
        console.log("");
        console.log("Painting Studio:");
        console.log("  Interest available:                    YES");
        console.log("  Interest score:                        0.56");
        console.log("  Preference available:                  NO");
        console.log("  Preference score:                      null");
        console.log("");
        console.log("Same Robotics Interest signal:           PASSED");
        console.log("");
        console.log("Omar Football:");
        console.log("  Interest score:                        0.91");
        console.log("  Preference available:                  NO");
        console.log("");
        console.log("Lina:");
        console.log("  Interest available:                    NO");
        console.log("  Preference available:                  NO");
        console.log("");
        console.log("Interest survives missing Preference:    PASSED");
        console.log("Both unavailable state valid:            PASSED");
        console.log("");
        console.log("Candidate counts:");
        console.log("Sara                                      5");
        console.log("Omar                                      3");
        console.log("Lina                                      2");
        console.log("");
        console.log("Candidate filtering:                     NONE");
        console.log("D4 evidence:                             PRESERVED");
        console.log("Context mutation:                        NONE");
        console.log("");
        console.log("Goal factor:                             UNTOUCHED");
        console.log("Exploration factor:                      UNTOUCHED");
        console.log("Behavior factor:                         UNTOUCHED");
        console.log("Session factor:                          UNTOUCHED");
        console.log("");
        console.log("Final weighted score:                    NONE");
        console.log("Weight normalization:                    NONE");
        console.log("Ranking:                                 NONE");
        console.log("");
        console.log("Mongo writes:                            NONE");
        console.log("Neo4j writes:                            NONE");
        console.log("");
        console.log("========================================");
        console.log("STEP 15C-C REAL SCORING INTEGRATION PASSED");
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
        console.error("STEP 15C-C REAL SCORING INTEGRATION FAILED");
        console.error(error);
        process.exit(1);
    });
