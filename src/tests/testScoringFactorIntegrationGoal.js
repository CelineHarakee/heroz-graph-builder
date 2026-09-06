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
const {
    calculateGoalFactor
} = require("../recommendation/goalFactorService");

function assertClose(label, actual, expected, tolerance = 1e-9) {
    assert(
        typeof actual === "number" &&
        Math.abs(actual - expected) <= tolerance,
        `${label}: expected ${expected}, found ${actual}`
    );
}

function snapshot(value) {
    return JSON.parse(JSON.stringify(value));
}

function preference(value, confidenceScore = 0.8) {
    return {
        value,
        confidenceScore,
        source: "Onboarding",
        updatedAt: new Date("2026-09-01T00:00:00.000Z")
    };
}

function makePreferences(overrides = {}) {
    return {
        environment: preference("Indoor", 0.8),
        socialStyle: preference(null),
        difficulty: preference(null),
        experienceStyle: preference(null),
        commitmentPreference: preference(null),
        ...overrides
    };
}

function makeCandidate({
    interestSubcategoryId = "subcategory_robotics",
    interestCategoryId = "category_stem",
    preferenceEnvironment = "Indoor",
    activityOutcomeIds = ["A", "B"],
    d4Goals = []
} = {}) {
    return {
        activity: {
            activityId: "activity_robotics",
            title: "Robotics Lab"
        },
        evidence: {
            interests: [],
            goals: d4Goals,
            summary: []
        },
        currentActivity: {
            classification: {
                categoryId: interestCategoryId,
                subcategoryId: interestSubcategoryId
            },
            experience: {
                environment: preferenceEnvironment,
                socialStyle: null,
                difficulty: null,
                experienceStyles: [],
                commitmentType: null,
                intensityLevel: "Low",
                durationMinutes: 90
            },
            learningOutcomes: activityOutcomeIds.map((outcomeId) => ({
                outcomeId,
                evidenceGuidance: []
            }))
        }
    };
}

function makeInputs({
    interestScore = 0.8,
    includeInterest = true,
    preferenceValue = "Indoor",
    includePreference = true,
    parentGoals,
    goals,
    activityOutcomeIds,
    d4Goals,
    developmentProfile = []
} = {}) {
    const candidate = makeCandidate({
        activityOutcomeIds,
        d4Goals
    });
    const resolvedParentGoals = parentGoals ?? [
        {
            goalId: "goal_a",
            priority: 1,
            status: "Active"
        },
        {
            goalId: "goal_b",
            priority: 2,
            status: "Active"
        }
    ];
    const resolvedGoals = goals ?? [
        {
            _id: "goal_a",
            name: "Goal A",
            isActive: true,
            relatedOutcomes: [
                {
                    outcomeId: "A"
                }
            ]
        },
        {
            _id: "goal_b",
            name: "Goal B",
            isActive: true,
            relatedOutcomes: [
                {
                    outcomeId: "B"
                },
                {
                    outcomeId: "C"
                }
            ]
        }
    ];

    const context = {
        child: {
            parentGoals: resolvedParentGoals,
            developmentProfile,
            preferences: makePreferences(
                includePreference
                    ? {
                        environment: preference(preferenceValue, 0.8)
                    }
                    : {
                        environment: preference(null, 0.8)
                    }
            )
        },
        candidates: [
            candidate
        ],
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
        },
        goalContext: {
            goals: resolvedGoals
        }
    };
    const eligibilityEvaluation = {
        candidate,
        eligibility: {
            eligible: true,
            failedConstraints: []
        },
        eligibleSessions: [],
        sessionEvaluations: [],
        missingInformation: []
    };

    return {
        context,
        candidate,
        eligibilityEvaluation
    };
}

function calculateByName(name, context, eligibilityEvaluation) {
    if (name === SCORING_FACTORS.INTEREST) {
        return calculateInterestFactor(context, eligibilityEvaluation);
    }

    if (name === SCORING_FACTORS.PREFERENCE) {
        return calculatePreferenceFactor(context, eligibilityEvaluation);
    }

    if (name === SCORING_FACTORS.GOAL) {
        return calculateGoalFactor(context, eligibilityEvaluation);
    }

    throw new Error(`Unknown factor: ${name}`);
}

function composeFactors(state, results) {
    return {
        ...state,
        factors: {
            ...state.factors,
            [SCORING_FACTORS.INTEREST]: results[SCORING_FACTORS.INTEREST],
            [SCORING_FACTORS.PREFERENCE]: results[SCORING_FACTORS.PREFERENCE],
            [SCORING_FACTORS.GOAL]: results[SCORING_FACTORS.GOAL]
        }
    };
}

function integrate(inputs, order = [
    SCORING_FACTORS.INTEREST,
    SCORING_FACTORS.PREFERENCE,
    SCORING_FACTORS.GOAL
]) {
    const { context, candidate, eligibilityEvaluation } = inputs;
    const contextSnapshot = snapshot(context);
    const candidateSnapshot = snapshot(candidate);
    const evaluationSnapshot = snapshot(eligibilityEvaluation);
    const originalState =
        createCandidateScoringState(eligibilityEvaluation);
    const originalStateSnapshot = snapshot(originalState);
    const results = {};

    for (const factor of order) {
        results[factor] = calculateByName(
            factor,
            context,
            eligibilityEvaluation
        );
    }

    const integratedState = composeFactors(originalState, results);

    assert.deepStrictEqual(snapshot(originalState), originalStateSnapshot);
    assert.deepStrictEqual(snapshot(context), contextSnapshot);
    assert.deepStrictEqual(snapshot(candidate), candidateSnapshot);
    assert.deepStrictEqual(snapshot(eligibilityEvaluation), evaluationSnapshot);

    return {
        originalState,
        originalStateSnapshot,
        integratedState,
        results,
        context,
        candidate,
        eligibilityEvaluation
    };
}

function assertFactorSlots(factors) {
    assert.deepStrictEqual(
        Object.keys(factors),
        Object.values(SCORING_FACTORS)
    );
    assert(
        !Object.prototype.hasOwnProperty.call(factors, "vendor"),
        "Vendor Reliability must not appear"
    );
}

function assertNoFinalScoreLeakage(state) {
    for (const field of [
        "finalScore",
        "weightedScore",
        "normalizedScore",
        "rank"
    ]) {
        assert(
            !Object.prototype.hasOwnProperty.call(state, field),
            `${field} must not be present`
        );
    }
}

function assertBaselineThreeFactorComposition() {
    const result = integrate(makeInputs());
    const { integratedState, originalState, results } = result;

    assert.strictEqual(results.interest.available, true);
    assertClose("Interest", results.interest.score, 0.8);
    assert.strictEqual(results.preference.available, true);
    assertClose("Preference", results.preference.score, 0.9);
    assert.strictEqual(results.goal.available, true);
    assertClose("Goal", results.goal.score, 0.75);
    assert.strictEqual(integratedState.factors.interest, results.interest);
    assert.strictEqual(integratedState.factors.preference, results.preference);
    assert.strictEqual(integratedState.factors.goal, results.goal);
    assert.strictEqual(integratedState.factors.exploration, null);
    assert.strictEqual(integratedState.factors.behavior, null);
    assert.strictEqual(integratedState.factors.session, null);
    assert.notStrictEqual(integratedState, originalState);
    assert.notStrictEqual(integratedState.factors, originalState.factors);
    assert.deepStrictEqual(snapshot(originalState), result.originalStateSnapshot);
    assertFactorSlots(integratedState.factors);
    assertNoFinalScoreLeakage(integratedState);
}

function assertPreferenceIsolation() {
    const before = integrate(makeInputs()).results;
    const after = integrate(makeInputs({
        preferenceValue: "Outdoor"
    })).results;

    assertClose("Preference before", before.preference.score, 0.9);
    assertClose("Preference after", after.preference.score, 0.1);
    assert.deepStrictEqual(after.interest, before.interest);
    assert.deepStrictEqual(after.goal, before.goal);
}

function assertInterestIsolation() {
    const before = integrate(makeInputs()).results;
    const after = integrate(makeInputs({
        interestScore: 0.4
    })).results;

    assertClose("Interest before", before.interest.score, 0.8);
    assertClose("Interest after", after.interest.score, 0.4);
    assert.deepStrictEqual(after.preference, before.preference);
    assert.deepStrictEqual(after.goal, before.goal);
}

function assertGoalIsolation() {
    const before = integrate(makeInputs()).results;
    const after = integrate(makeInputs({
        activityOutcomeIds: ["A"]
    })).results;

    assertClose("Goal before", before.goal.score, 0.75);
    assertClose("Goal after", after.goal.score, 0.5);
    assert.deepStrictEqual(after.interest, before.interest);
    assert.deepStrictEqual(after.preference, before.preference);
}

function assertPriorityNumericIndependence() {
    const before = integrate(makeInputs()).results;
    const after = integrate(makeInputs({
        parentGoals: [
            {
                goalId: "goal_a",
                priority: 99,
                status: "Active"
            },
            {
                goalId: "goal_b",
                priority: 100,
                status: "Active"
            }
        ]
    })).results;

    assert.strictEqual(after.goal.available, before.goal.available);
    assertClose("Goal score", after.goal.score, before.goal.score);
    assert.deepStrictEqual(
        after.goal.evidence.map((item) => item.coverage),
        before.goal.evidence.map((item) => item.coverage)
    );
    assert.deepStrictEqual(
        after.goal.evidence.map((item) => item.priority),
        [99, 100]
    );
    assert.deepStrictEqual(after.interest, before.interest);
    assert.deepStrictEqual(after.preference, before.preference);
}

function assertD4EvidenceIndependence() {
    const before = integrate(makeInputs({
        d4Goals: [
            {
                name: "D4 Goal"
            }
        ]
    })).results;
    const after = integrate(makeInputs({
        d4Goals: []
    })).results;

    assertClose("Interest before", before.interest.score, 0.8);
    assertClose("Preference before", before.preference.score, 0.9);
    assertClose("Goal before", before.goal.score, 0.75);
    assert.deepStrictEqual(after.interest, before.interest);
    assert.deepStrictEqual(after.preference, before.preference);
    assert.deepStrictEqual(after.goal, before.goal);
}

function assertEvidenceSeparation() {
    const { results } = integrate(makeInputs());

    assert.notStrictEqual(results.interest.evidence, results.preference.evidence);
    assert.notStrictEqual(results.interest.evidence, results.goal.evidence);
    assert.notStrictEqual(results.preference.evidence, results.goal.evidence);

    for (const item of results.interest.evidence) {
        assert(
            !Object.prototype.hasOwnProperty.call(item, "coverage"),
            "Interest evidence must not contain Goal coverage"
        );
        assert(
            !Object.prototype.hasOwnProperty.call(item, "matchedOutcomeIds"),
            "Interest evidence must not contain Goal matchedOutcomeIds"
        );
    }

    for (const item of results.preference.evidence) {
        assert(
            !Object.prototype.hasOwnProperty.call(item, "coverage"),
            "Preference evidence must not contain Goal coverage"
        );
        assert(
            !Object.prototype.hasOwnProperty.call(item, "goalOutcomeIds"),
            "Preference evidence must not contain Goal Outcome IDs"
        );
    }

    for (const item of results.goal.evidence) {
        for (const field of [
            "dimension",
            "baseMatch",
            "adjustedScore",
            "categoryScore",
            "siblingScores"
        ]) {
            assert(
                !Object.prototype.hasOwnProperty.call(item, field),
                `Goal evidence must not contain ${field}`
            );
        }
    }
}

function assertOrderIndependence() {
    const orders = [
        ["interest", "preference", "goal"],
        ["interest", "goal", "preference"],
        ["preference", "interest", "goal"],
        ["preference", "goal", "interest"],
        ["goal", "interest", "preference"],
        ["goal", "preference", "interest"]
    ];
    const results = orders.map((order) =>
        integrate(makeInputs(), order).results
    );
    const baseline = results[0];

    for (const result of results.slice(1)) {
        assert.deepStrictEqual(result.interest, baseline.interest);
        assert.deepStrictEqual(result.preference, baseline.preference);
        assert.deepStrictEqual(result.goal, baseline.goal);
    }
}

function assertAllUnavailableStateValid() {
    const { integratedState, eligibilityEvaluation } = integrate(makeInputs({
        includeInterest: false,
        includePreference: false,
        parentGoals: []
    }));

    assertFactorSlots(integratedState.factors);
    assert.strictEqual(integratedState.factors.interest.available, false);
    assert.strictEqual(integratedState.factors.interest.score, null);
    assert.strictEqual(integratedState.factors.preference.available, false);
    assert.strictEqual(integratedState.factors.preference.score, null);
    assert.strictEqual(integratedState.factors.goal.available, false);
    assert.strictEqual(integratedState.factors.goal.score, null);
    assert.strictEqual(integratedState.factors.exploration, null);
    assert.strictEqual(integratedState.factors.behavior, null);
    assert.strictEqual(integratedState.factors.session, null);
    assert.strictEqual(eligibilityEvaluation.eligibility.eligible, true);
    assert.deepStrictEqual(
        eligibilityEvaluation.eligibility.failedConstraints,
        []
    );
    assert(integratedState.eligibilityEvaluation.candidate);
}

function assertMixedAvailability() {
    const interestPreferenceGoal = integrate(makeInputs({
        includePreference: false
    })).results;
    assert.strictEqual(interestPreferenceGoal.interest.available, true);
    assert.strictEqual(interestPreferenceGoal.preference.available, false);
    assert.strictEqual(interestPreferenceGoal.preference.score, null);
    assert.strictEqual(interestPreferenceGoal.goal.available, true);

    const preferenceGoal = integrate(makeInputs({
        includeInterest: false
    })).results;
    assert.strictEqual(preferenceGoal.interest.available, false);
    assert.strictEqual(preferenceGoal.interest.score, null);
    assert.strictEqual(preferenceGoal.preference.available, true);
    assert.strictEqual(preferenceGoal.goal.available, true);

    const interestPreference = integrate(makeInputs({
        parentGoals: []
    })).results;
    assert.strictEqual(interestPreference.interest.available, true);
    assert.strictEqual(interestPreference.preference.available, true);
    assert.strictEqual(interestPreference.goal.available, false);
    assert.strictEqual(interestPreference.goal.score, null);
}

function main() {
    assertBaselineThreeFactorComposition();
    assertPreferenceIsolation();
    assertInterestIsolation();
    assertGoalIsolation();
    assertPriorityNumericIndependence();
    assertD4EvidenceIndependence();
    assertEvidenceSeparation();
    assertOrderIndependence();
    assertAllUnavailableStateValid();
    assertMixedAvailability();

    console.log("Three-factor controlled integration tests: PASSED");
}

main();
