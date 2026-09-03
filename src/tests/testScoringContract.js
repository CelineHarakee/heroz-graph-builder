const assert = require("assert");

const {
    SCORING_FACTORS,
    SCORING_WEIGHTS,
    createFactorResult,
    createEmptyFactorMap,
    createCandidateScoringState
} = require("../recommendation/scoringContract");

const FACTOR_VALUES = [
    "interest",
    "preference",
    "goal",
    "exploration",
    "behavior",
    "session"
];

function assertApproxEqual(actual, expected, tolerance = 1e-9) {
    assert(
        Math.abs(actual - expected) <= tolerance,
        `expected ${expected}, found ${actual}`
    );
}

function assertThrows(label, fn) {
    assert.throws(fn, Error, label);
}

function assertCanonicalFactorMap(map) {
    assert.deepStrictEqual(Object.keys(map), FACTOR_VALUES);
    assert.deepStrictEqual(map, {
        interest: null,
        preference: null,
        goal: null,
        exploration: null,
        behavior: null,
        session: null
    });
}

function testFactorsExactlySix() {
    assert.deepStrictEqual(Object.values(SCORING_FACTORS), FACTOR_VALUES);
    assert.deepStrictEqual(Object.keys(SCORING_FACTORS), [
        "INTEREST",
        "PREFERENCE",
        "GOAL",
        "EXPLORATION",
        "BEHAVIOR",
        "SESSION"
    ]);

    for (const forbiddenFactor of [
        "vendor",
        "vendorReliability",
        "reliability"
    ]) {
        assert(
            !Object.values(SCORING_FACTORS).includes(forbiddenFactor),
            `${forbiddenFactor} must not be a scoring factor`
        );
        assert(
            !Object.keys(SCORING_FACTORS).includes(forbiddenFactor),
            `${forbiddenFactor} must not be a scoring factor key`
        );
    }
}

function testWeightsExact() {
    assert.strictEqual(SCORING_WEIGHTS.interest, 0.33);
    assert.strictEqual(SCORING_WEIGHTS.preference, 0.16);
    assert.strictEqual(SCORING_WEIGHTS.goal, 0.16);
    assert.strictEqual(SCORING_WEIGHTS.exploration, 0.13);
    assert.strictEqual(SCORING_WEIGHTS.behavior, 0.13);
    assert.strictEqual(SCORING_WEIGHTS.session, 0.09);
    assert.deepStrictEqual(Object.keys(SCORING_WEIGHTS), FACTOR_VALUES);
}

function testWeightsTotalOne() {
    const total = Object.values(SCORING_WEIGHTS).reduce(
        (sum, weight) => sum + weight,
        0
    );

    assertApproxEqual(total, 1);
}

function testAvailableFactor() {
    const result = createFactorResult({
        factor: "interest",
        available: true,
        score: 0.8,
        evidence: [{ source: "test" }]
    });

    assert.deepStrictEqual(result, {
        factor: "interest",
        available: true,
        score: 0.8,
        evidence: [{ source: "test" }]
    });
}

function testBoundaries() {
    assert.strictEqual(
        createFactorResult({
            factor: "interest",
            available: true,
            score: 0
        }).score,
        0
    );
    assert.strictEqual(
        createFactorResult({
            factor: "interest",
            available: true,
            score: 1
        }).score,
        1
    );
}

function testInvalidAvailableScores() {
    for (const score of [
        null,
        undefined,
        NaN,
        Infinity,
        -0.01,
        1.01,
        "0.8"
    ]) {
        assertThrows(`score ${score} should throw`, () => {
            createFactorResult({
                factor: "interest",
                available: true,
                score
            });
        });
    }
}

function testUnavailableFactor() {
    const result = createFactorResult({
        factor: "behavior",
        available: false
    });

    assert.deepStrictEqual(result, {
        factor: "behavior",
        available: false,
        score: null,
        evidence: []
    });
}

function testUnavailableWithNull() {
    const result = createFactorResult({
        factor: "behavior",
        available: false,
        score: null
    });

    assert.strictEqual(result.score, null);
}

function testUnavailableWithNumericScore() {
    for (const score of [0, 0.8]) {
        assertThrows(`unavailable score ${score} should throw`, () => {
            createFactorResult({
                factor: "behavior",
                available: false,
                score
            });
        });
    }
}

function testUnknownFactor() {
    for (const factor of ["vendor", "random"]) {
        assertThrows(`${factor} should throw`, () => {
            createFactorResult({
                factor,
                available: true,
                score: 0.8
            });
        });
    }
}

function testAvailableMustBeBoolean() {
    for (const available of [1, "true", null]) {
        assertThrows(`${available} should throw`, () => {
            createFactorResult({
                factor: "interest",
                available,
                score: 0.8
            });
        });
    }
}

function testEvidenceDefault() {
    const result = createFactorResult({
        factor: "interest",
        available: true,
        score: 0.8
    });

    assert.deepStrictEqual(result.evidence, []);
}

function testEvidenceMustBeArray() {
    for (const evidence of [{}, "evidence", null]) {
        assertThrows("invalid evidence should throw", () => {
            createFactorResult({
                factor: "interest",
                available: true,
                score: 0.8,
                evidence
            });
        });
    }
}

function testEvidenceArrayNotMutated() {
    const evidence = [{ id: 1 }];
    const result = createFactorResult({
        factor: "interest",
        available: true,
        score: 0.8,
        evidence
    });

    assert.notStrictEqual(result.evidence, evidence);
    assert.deepStrictEqual(result.evidence, evidence);
}

function testEmptyFactorMap() {
    assertCanonicalFactorMap(createEmptyFactorMap());
}

function testCandidateScoringState() {
    const evaluation = {
        candidate: { id: "A" },
        eligibility: {
            eligible: true,
            failedConstraints: []
        },
        eligibleSessions: [],
        sessionEvaluations: [],
        missingInformation: []
    };

    const state = createCandidateScoringState(evaluation);

    assert.strictEqual(state.eligibilityEvaluation, evaluation);
    assertCanonicalFactorMap(state.factors);
}

function testIneligibleCandidateRejected() {
    assertThrows("ineligible candidate should throw", () => {
        createCandidateScoringState({
            eligibility: {
                eligible: false,
                failedConstraints: []
            }
        });
    });
}

function testMissingEligibilityResult() {
    assertThrows("missing eligibility should throw", () => {
        createCandidateScoringState({});
    });
}

function testNoFinalScoreOrRank() {
    const state = createCandidateScoringState({
        candidate: { id: "A" },
        eligibility: {
            eligible: true,
            failedConstraints: []
        },
        eligibleSessions: [],
        sessionEvaluations: [],
        missingInformation: []
    });

    for (const key of [
        "finalScore",
        "score",
        "rank",
        "weightedScore",
        "normalizedScore"
    ]) {
        assert(
            !Object.prototype.hasOwnProperty.call(state, key),
            `${key} must not be included`
        );
    }
}

function testImmutableConfig() {
    assert(Object.isFrozen(SCORING_FACTORS));
    assert(Object.isFrozen(SCORING_WEIGHTS));
}

function main() {
    testFactorsExactlySix();
    testWeightsExact();
    testWeightsTotalOne();
    testAvailableFactor();
    testBoundaries();
    testInvalidAvailableScores();
    testUnavailableFactor();
    testUnavailableWithNull();
    testUnavailableWithNumericScore();
    testUnknownFactor();
    testAvailableMustBeBoolean();
    testEvidenceDefault();
    testEvidenceMustBeArray();
    testEvidenceArrayNotMutated();
    testEmptyFactorMap();
    testCandidateScoringState();
    testIneligibleCandidateRejected();
    testMissingEligibilityResult();
    testNoFinalScoreOrRank();
    testImmutableConfig();

    const total = Object.values(SCORING_WEIGHTS).reduce(
        (sum, weight) => sum + weight,
        0
    );

    console.log("========================================");
    console.log("STEP 15A - SCORING CONTRACT");
    console.log("========================================");
    console.log("Factor set:                         PASSED");
    console.log("Vendor Reliability excluded:        PASSED");
    console.log("");
    console.log("Weights:");
    console.log(`Interest:                           ${SCORING_WEIGHTS.interest.toFixed(2)}`);
    console.log(`Preference:                         ${SCORING_WEIGHTS.preference.toFixed(2)}`);
    console.log(`Goal:                               ${SCORING_WEIGHTS.goal.toFixed(2)}`);
    console.log(`Exploration:                        ${SCORING_WEIGHTS.exploration.toFixed(2)}`);
    console.log(`Behavior:                           ${SCORING_WEIGHTS.behavior.toFixed(2)}`);
    console.log(`Session:                            ${SCORING_WEIGHTS.session.toFixed(2)}`);
    console.log(`Total:                              ${total.toFixed(2)}`);
    console.log("");
    console.log("Available FactorResult:             PASSED");
    console.log("Unavailable FactorResult:           PASSED");
    console.log("0-1 score validation:               PASSED");
    console.log("Missing != zero:                    PASSED");
    console.log("Evidence contract:                  PASSED");
    console.log("");
    console.log("Eligible candidate state:           PASSED");
    console.log("Ineligible candidate rejected:      PASSED");
    console.log("");
    console.log("Final scoring:                      NONE");
    console.log("Normalization:                      NONE");
    console.log("Ranking:                            NONE");
    console.log("");
    console.log("========================================");
    console.log("STEP 15A SCORING CONTRACT PASSED");
    console.log("========================================");
}

main();
