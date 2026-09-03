const assert = require("assert");
const {
    SCORING_FACTORS,
    createCandidateScoringState
} = require("../recommendation/scoringContract");
const {
    calculateInterestFactor
} = require("../recommendation/interestFactorService");
const {
    calculatePreferenceFactor
} = require("../recommendation/preferenceFactorService");

function assertClose(label, actual, expected, tolerance = 1e-9) {
    assert(
        typeof actual === "number" &&
        Math.abs(actual - expected) <= tolerance,
        `${label}: expected ${expected}, found ${actual}`
    );
}

function preference(value, confidenceScore = 0.8, source = "Onboarding") {
    return {
        value,
        confidenceScore,
        source,
        updatedAt: new Date("2026-09-01T00:00:00.000Z")
    };
}

function makeContext({
    interestScore = 0.8,
    includeInterest = true,
    preferenceValue = "Indoor",
    includePreference = true
} = {}) {
    return {
        child: {
            preferences: {
                environment: includePreference
                    ? preference(preferenceValue, 0.8)
                    : preference(null, 0.8),
                socialStyle: preference(null),
                difficulty: preference(null),
                experienceStyle: preference(null),
                commitmentPreference: preference(null)
            }
        },
        interestContext: {
            childInterests: includeInterest
                ? [
                    {
                        childId: "child_1",
                        subcategoryId: "subcategory_robotics",
                        interestScore: {
                            currentScore: interestScore
                        },
                        confidence: {
                            currentScore: 0.75
                        }
                    }
                ]
                : [],
            subcategories: includeInterest
                ? [
                    {
                        _id: "subcategory_robotics",
                        categoryId: "category_stem"
                    }
                ]
                : []
        }
    };
}

function makeEvaluation({
    experience = {
        environment: "Indoor",
        socialStyle: "Team",
        difficulty: "Intermediate",
        experienceStyles: ["Structured"],
        commitmentType: "OneTime"
    }
} = {}) {
    return {
        candidate: {
            activity: {
                activityId: "activity_robotics",
                title: "Robotics Lab"
            },
            evidence: {
                interests: [],
                goals: [],
                summary: []
            },
            currentActivity: {
                classification: {
                    categoryId: "category_stem",
                    subcategoryId: "subcategory_robotics"
                },
                experience
            }
        },
        eligibility: {
            eligible: true,
            failedConstraints: []
        },
        eligibleSessions: [],
        sessionEvaluations: [],
        missingInformation: []
    };
}

function integrateFactors(context, evaluation, reverseOrder = false) {
    const state = createCandidateScoringState(evaluation);
    const first = reverseOrder
        ? calculatePreferenceFactor(context, evaluation)
        : calculateInterestFactor(context, evaluation);
    const second = reverseOrder
        ? calculateInterestFactor(context, evaluation)
        : calculatePreferenceFactor(context, evaluation);
    const interestResult = reverseOrder ? second : first;
    const preferenceResult = reverseOrder ? first : second;

    return {
        state,
        integratedState: {
            ...state,
            factors: {
                ...state.factors,
                [SCORING_FACTORS.INTEREST]: interestResult,
                [SCORING_FACTORS.PREFERENCE]: preferenceResult
            }
        },
        interestResult,
        preferenceResult
    };
}

function assertFactorResultShape(result) {
    assert.deepStrictEqual(Object.keys(result), [
        "factor",
        "available",
        "score",
        "evidence"
    ]);
}

function assertNoFinalScore(state) {
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

function assertSixFactorContract(factors) {
    assert.deepStrictEqual(Object.keys(factors), Object.values(SCORING_FACTORS));
    assert(
        !Object.prototype.hasOwnProperty.call(factors, "vendor"),
        "Vendor Reliability must not appear"
    );
}

function testBothFactorsAvailable() {
    const result = integrateFactors(makeContext(), makeEvaluation());

    assert.strictEqual(result.interestResult.available, true);
    assert.strictEqual(result.preferenceResult.available, true);
    assertClose("Interest", result.interestResult.score, 0.8);
    assertClose("Preference", result.preferenceResult.score, 0.9);
    assert.strictEqual(
        result.integratedState.factors.interest,
        result.interestResult
    );
    assert.strictEqual(
        result.integratedState.factors.preference,
        result.preferenceResult
    );
}

function testContractFactorSlots() {
    const { integratedState } = integrateFactors(makeContext(), makeEvaluation());

    assertSixFactorContract(integratedState.factors);
    assert.strictEqual(integratedState.factors.goal, null);
    assert.strictEqual(integratedState.factors.exploration, null);
    assert.strictEqual(integratedState.factors.behavior, null);
    assert.strictEqual(integratedState.factors.session, null);
}

function testNoFinalScore() {
    const { integratedState } = integrateFactors(makeContext(), makeEvaluation());

    assertNoFinalScore(integratedState);
}

function testPreferenceChangeDoesNotChangeInterest() {
    const first = integrateFactors(makeContext(), makeEvaluation());
    const second = integrateFactors(
        makeContext({ preferenceValue: "Outdoor" }),
        makeEvaluation()
    );

    assertClose("first Preference", first.preferenceResult.score, 0.9);
    assertClose("second Preference", second.preferenceResult.score, 0.1);
    assertClose("first Interest", first.interestResult.score, 0.8);
    assertClose("second Interest", second.interestResult.score, 0.8);
    assert.deepStrictEqual(second.interestResult, first.interestResult);
    assert.deepStrictEqual(
        first.interestResult.evidence,
        second.interestResult.evidence
    );
}

function testInterestChangeDoesNotChangePreference() {
    const first = integrateFactors(makeContext(), makeEvaluation());
    const second = integrateFactors(
        makeContext({ interestScore: 0.4 }),
        makeEvaluation()
    );

    assertClose("first Interest", first.interestResult.score, 0.8);
    assertClose("second Interest", second.interestResult.score, 0.4);
    assertClose("first Preference", first.preferenceResult.score, 0.9);
    assertClose("second Preference", second.preferenceResult.score, 0.9);
    assert.deepStrictEqual(second.preferenceResult, first.preferenceResult);
    assert.deepStrictEqual(
        first.preferenceResult.evidence,
        second.preferenceResult.evidence
    );
}

function testPreferenceUnavailableInterestAvailable() {
    const result = integrateFactors(
        makeContext({ includePreference: false }),
        makeEvaluation()
    );

    assert.strictEqual(result.interestResult.available, true);
    assertClose("Interest", result.interestResult.score, 0.8);
    assert.strictEqual(result.preferenceResult.available, false);
    assert.strictEqual(result.preferenceResult.score, null);
    assert.strictEqual(result.integratedState.eligibilityEvaluation, result.state.eligibilityEvaluation);
}

function testInterestUnavailablePreferenceAvailable() {
    const result = integrateFactors(
        makeContext({ includeInterest: false }),
        makeEvaluation()
    );

    assert.strictEqual(result.interestResult.available, false);
    assert.strictEqual(result.interestResult.score, null);
    assert.strictEqual(result.preferenceResult.available, true);
    assertClose("Preference", result.preferenceResult.score, 0.9);
}

function testBothUnavailable() {
    const context = makeContext({
        includeInterest: false,
        includePreference: false
    });
    const evaluation = makeEvaluation();
    const originalCandidate = evaluation.candidate;
    const candidateSnapshot = JSON.stringify(originalCandidate);
    const failedConstraintsSnapshot = JSON.parse(
        JSON.stringify(evaluation.eligibility.failedConstraints)
    );
    const result = integrateFactors(
        context,
        evaluation
    );

    assert(result.integratedState, "integrated scoring state is required");
    assertSixFactorContract(result.integratedState.factors);
    assert.strictEqual(result.interestResult.available, false);
    assert.strictEqual(result.preferenceResult.available, false);
    assert.strictEqual(result.interestResult.score, null);
    assert.strictEqual(result.preferenceResult.score, null);
    assert.deepStrictEqual(
        result.integratedState.factors[SCORING_FACTORS.INTEREST],
        result.interestResult
    );
    assert.deepStrictEqual(
        result.integratedState.factors[SCORING_FACTORS.PREFERENCE],
        result.preferenceResult
    );
    assert.deepStrictEqual(
        result.integratedState.factors[SCORING_FACTORS.GOAL],
        result.state.factors[SCORING_FACTORS.GOAL]
    );
    assert.deepStrictEqual(
        result.integratedState.factors[SCORING_FACTORS.EXPLORATION],
        result.state.factors[SCORING_FACTORS.EXPLORATION]
    );
    assert.deepStrictEqual(
        result.integratedState.factors[SCORING_FACTORS.BEHAVIOR],
        result.state.factors[SCORING_FACTORS.BEHAVIOR]
    );
    assert.deepStrictEqual(
        result.integratedState.factors[SCORING_FACTORS.SESSION],
        result.state.factors[SCORING_FACTORS.SESSION]
    );
    assert.strictEqual(result.integratedState.eligibilityEvaluation.eligibility.eligible, true);
    assert.deepStrictEqual(
        result.integratedState.eligibilityEvaluation.eligibility.failedConstraints,
        failedConstraintsSnapshot
    );
    assert(result.integratedState.eligibilityEvaluation.candidate);
    assert.strictEqual(
        result.integratedState.eligibilityEvaluation.candidate,
        originalCandidate
    );
    assert.strictEqual(JSON.stringify(originalCandidate), candidateSnapshot);
}

function testFactorOrderIndependence() {
    const first = integrateFactors(makeContext(), makeEvaluation());
    const second = integrateFactors(makeContext(), makeEvaluation(), true);

    assert.deepStrictEqual(first.interestResult, second.interestResult);
    assert.deepStrictEqual(first.preferenceResult, second.preferenceResult);
}

function testFactorEvidenceSeparation() {
    const { interestResult, preferenceResult } =
        integrateFactors(makeContext(), makeEvaluation());

    assert.notStrictEqual(interestResult.evidence, preferenceResult.evidence);
    assert(
        interestResult.evidence.every((item) => !("dimension" in item)),
        "Interest evidence must not contain Preference dimensions"
    );
    assert(
        preferenceResult.evidence.every((item) => !("categoryScore" in item)),
        "Preference evidence must not contain category fallback"
    );
    assert(
        preferenceResult.evidence.every((item) => !("subcategoryId" in item)),
        "Preference evidence must not contain exact Interest fields"
    );
}

function testEligibilityCandidateContextStatePreserved() {
    const context = makeContext();
    const evaluation = makeEvaluation();
    const failedConstraints = evaluation.eligibility.failedConstraints;
    const candidateSnapshot = JSON.stringify(evaluation.candidate);
    const contextSnapshot = JSON.stringify(context);
    const state = createCandidateScoringState(evaluation);
    const originalStateSnapshot = JSON.parse(JSON.stringify(state));
    const integratedState = {
        ...state,
        factors: {
            ...state.factors,
            [SCORING_FACTORS.INTEREST]:
                calculateInterestFactor(context, evaluation),
            [SCORING_FACTORS.PREFERENCE]:
                calculatePreferenceFactor(context, evaluation)
        }
    };

    assert.strictEqual(evaluation.eligibility.eligible, true);
    assert.strictEqual(evaluation.eligibility.failedConstraints, failedConstraints);
    assert.deepStrictEqual(evaluation.eligibility.failedConstraints, []);
    assert.strictEqual(JSON.stringify(evaluation.candidate), candidateSnapshot);
    assert.strictEqual(JSON.stringify(context), contextSnapshot);
    assert.deepStrictEqual(state, originalStateSnapshot);
    assert.strictEqual(state.factors.interest, null);
    assert.strictEqual(state.factors.preference, null);
    assert.notStrictEqual(integratedState, state);
    assert.notStrictEqual(integratedState.factors, state.factors);
}

function testResultContract() {
    const { interestResult, preferenceResult } =
        integrateFactors(makeContext(), makeEvaluation());

    assertFactorResultShape(interestResult);
    assertFactorResultShape(preferenceResult);
}

function main() {
    testBothFactorsAvailable();
    testContractFactorSlots();
    testNoFinalScore();
    testPreferenceChangeDoesNotChangeInterest();
    testInterestChangeDoesNotChangePreference();
    testPreferenceUnavailableInterestAvailable();
    testInterestUnavailablePreferenceAvailable();
    testBothUnavailable();
    testFactorOrderIndependence();
    testFactorEvidenceSeparation();
    testEligibilityCandidateContextStatePreserved();
    testResultContract();

    console.log("========================================");
    console.log("STEP 15C-C - SCORING INTEGRATION");
    console.log("========================================");
    console.log("");
    console.log("Interest available:                       YES");
    console.log("Interest score:                           0.80");
    console.log("");
    console.log("Preference available:                     YES");
    console.log("Preference score:                         0.90");
    console.log("");
    console.log("Same scoring state:                       PASSED");
    console.log("");
    console.log("Preference change isolation:              PASSED");
    console.log("Interest change isolation:                PASSED");
    console.log("");
    console.log("Preference unavailable + Interest valid:  PASSED");
    console.log("Interest unavailable + Preference valid:  PASSED");
    console.log("Both unavailable:                         PASSED");
    console.log("");
    console.log("Factor order independence:                PASSED");
    console.log("Evidence isolation:                       PASSED");
    console.log("");
    console.log("Eligibility mutation:                     NONE");
    console.log("Candidate mutation:                       NONE");
    console.log("Context mutation:                         NONE");
    console.log("Original state mutation:                  NONE");
    console.log("");
    console.log("Six-factor contract:                      PRESERVED");
    console.log("Vendor Reliability:                       ABSENT");
    console.log("");
    console.log("Final weighted score:                     NONE");
    console.log("Weight normalization:                     NONE");
    console.log("Ranking:                                  NONE");
    console.log("");
    console.log("========================================");
    console.log("STEP 15C-C SCORING INTEGRATION PASSED");
    console.log("========================================");
}

main();
