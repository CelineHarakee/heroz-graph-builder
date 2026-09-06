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
const {
    calculateExplorationFactor
} = require("../recommendation/explorationFactorService");

const COMPLETED_FACTORS = [
    SCORING_FACTORS.INTEREST,
    SCORING_FACTORS.PREFERENCE,
    SCORING_FACTORS.GOAL,
    SCORING_FACTORS.EXPLORATION
];

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

function recommendation({
    childId = "child_1",
    activityId = "activity_robotics",
    wasDisplayed = true,
    clickedActivityIds = [],
    savedActivityIds = [],
    dismissedActivityIds = []
} = {}) {
    return {
        _id: "recommendation_1",
        childId,
        recommendationContext: {
            requestedAt: new Date("2026-09-01T00:00:00.000Z")
        },
        recommendedItems: [
            {
                activityId
            }
        ],
        response: {
            wasDisplayed,
            displayedAt: new Date("2026-09-01T00:00:00.000Z"),
            clickedActivityIds,
            savedActivityIds,
            bookedSessionIds: [],
            dismissedActivityIds,
            lastResponseAt: new Date("2026-09-01T00:00:00.000Z")
        }
    };
}

function booking({
    childId = "child_1",
    activityId = "activity_robotics",
    attendanceStatus = null
} = {}) {
    const document = {
        _id: "booking_1",
        bookingDetails: {
            childId,
            activityId,
            sessionId: "session_1",
            status: "Confirmed",
            bookedAt: new Date("2026-09-01T00:00:00.000Z")
        },
        attendance: {}
    };

    if (attendanceStatus !== null) {
        document.attendance.status = attendanceStatus;
    }

    return document;
}

function makeCandidate({
    activityId = "activity_robotics",
    subcategoryId = "subcategory_robotics",
    categoryId = "category_stem",
    preferenceEnvironment = "Indoor",
    activityOutcomeIds = ["A", "B"],
    evidence = {
        interests: [],
        goals: [],
        summary: []
    }
} = {}) {
    return {
        activity: {
            activityId,
            title: "Robotics Lab"
        },
        evidence,
        currentActivity: {
            _id: activityId,
            classification: {
                categoryId,
                subcategoryId
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
    childId = "child_1",
    interestScore = 0.8,
    includeInterest = true,
    preferenceValue = "Indoor",
    includePreference = true,
    parentGoals,
    goals,
    activityOutcomeIds,
    historyContext,
    evidence
} = {}) {
    const candidate = makeCandidate({
        activityOutcomeIds,
        evidence
    });
    const context = {
        child: {
            _id: childId,
            parentGoals: parentGoals ?? [
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
            ],
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
        parent: {
            _id: "parent_1"
        },
        candidates: [
            candidate
        ],
        interestContext: {
            childInterests: includeInterest
                ? [
                    {
                        childId,
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
            goals: goals ?? [
                {
                    _id: "goal_a",
                    name: "Goal A",
                    relatedOutcomes: [
                        {
                            outcomeId: "A"
                        }
                    ]
                },
                {
                    _id: "goal_b",
                    name: "Goal B",
                    relatedOutcomes: [
                        {
                            outcomeId: "B"
                        },
                        {
                            outcomeId: "C"
                        }
                    ]
                }
            ]
        },
        historyContext: historyContext ?? {
            bookings: [],
            recommendations: [
                recommendation()
            ],
            sources: {
                bookings: "available",
                recommendations: "available"
            }
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

function calculateByName(factor, context, eligibilityEvaluation) {
    if (factor === SCORING_FACTORS.INTEREST) {
        return calculateInterestFactor(context, eligibilityEvaluation);
    }

    if (factor === SCORING_FACTORS.PREFERENCE) {
        return calculatePreferenceFactor(context, eligibilityEvaluation);
    }

    if (factor === SCORING_FACTORS.GOAL) {
        return calculateGoalFactor(context, eligibilityEvaluation);
    }

    if (factor === SCORING_FACTORS.EXPLORATION) {
        return calculateExplorationFactor(context, eligibilityEvaluation);
    }

    throw new Error(`Unknown factor: ${factor}`);
}

function composeFactors(state, results) {
    return {
        ...state,
        factors: {
            ...state.factors,
            [SCORING_FACTORS.INTEREST]: results.interest,
            [SCORING_FACTORS.PREFERENCE]: results.preference,
            [SCORING_FACTORS.GOAL]: results.goal,
            [SCORING_FACTORS.EXPLORATION]: results.exploration
        }
    };
}

function integrate(inputs, order = COMPLETED_FACTORS) {
    const { context, candidate, eligibilityEvaluation } = inputs;
    const contextSnapshot = snapshot(context);
    const historyContextSnapshot = snapshot(context.historyContext);
    const candidateSnapshot = snapshot(candidate);
    const currentActivitySnapshot = snapshot(candidate.currentActivity);
    const d4EvidenceSnapshot = snapshot(candidate.evidence);
    const evaluationSnapshot = snapshot(eligibilityEvaluation);
    const failedConstraintsSnapshot =
        snapshot(eligibilityEvaluation.eligibility.failedConstraints);
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
    assert.deepStrictEqual(snapshot(context.historyContext), historyContextSnapshot);
    assert.deepStrictEqual(snapshot(candidate), candidateSnapshot);
    assert.deepStrictEqual(
        snapshot(candidate.currentActivity),
        currentActivitySnapshot
    );
    assert.deepStrictEqual(snapshot(candidate.evidence), d4EvidenceSnapshot);
    assert.deepStrictEqual(snapshot(eligibilityEvaluation), evaluationSnapshot);
    assert.deepStrictEqual(
        snapshot(eligibilityEvaluation.eligibility.failedConstraints),
        failedConstraintsSnapshot
    );

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
    assert(!Object.prototype.hasOwnProperty.call(factors, "vendor"));
}

function assertNoFinalScoreLeakage(state) {
    for (const field of [
        "finalScore",
        "weightedScore",
        "normalizedScore",
        "rank"
    ]) {
        assert(!Object.prototype.hasOwnProperty.call(state, field));
        assert(
            !Object.prototype.hasOwnProperty.call(
                state.eligibilityEvaluation.candidate,
                field
            )
        );
    }
}

function assertFactorContract(result, factor, expectedScore) {
    assert.deepStrictEqual(Object.keys(result), [
        "factor",
        "available",
        "score",
        "evidence"
    ]);
    assert.strictEqual(result.factor, factor);
    assert.strictEqual(result.available, true);
    assertClose(factor, result.score, expectedScore);
    assert(Array.isArray(result.evidence));
}

function assertUnavailableResult(result, factor) {
    assert.deepStrictEqual(Object.keys(result), [
        "factor",
        "available",
        "score",
        "evidence"
    ]);
    assert.strictEqual(result.factor, factor);
    assert.strictEqual(result.available, false);
    assert.strictEqual(result.score, null);
    assert(Array.isArray(result.evidence));
}

function permutations(items) {
    if (items.length === 0) {
        return [[]];
    }

    return items.flatMap((item, index) =>
        permutations([
            ...items.slice(0, index),
            ...items.slice(index + 1)
        ]).map((tail) => [
            item,
            ...tail
        ])
    );
}

function testBaselineFourFactorState() {
    const result = integrate(makeInputs());
    const { integratedState, originalState, results } = result;

    assertFactorContract(results.interest, SCORING_FACTORS.INTEREST, 0.8);
    assertFactorContract(results.preference, SCORING_FACTORS.PREFERENCE, 0.9);
    assertFactorContract(results.goal, SCORING_FACTORS.GOAL, 0.75);
    assertFactorContract(
        results.exploration,
        SCORING_FACTORS.EXPLORATION,
        0.5
    );
    assert.strictEqual(integratedState.factors.interest, results.interest);
    assert.strictEqual(integratedState.factors.preference, results.preference);
    assert.strictEqual(integratedState.factors.goal, results.goal);
    assert.strictEqual(
        integratedState.factors.exploration,
        results.exploration
    );
    assert.strictEqual(integratedState.factors.behavior, null);
    assert.strictEqual(integratedState.factors.session, null);
    assert.notStrictEqual(integratedState, originalState);
    assert.notStrictEqual(integratedState.factors, originalState.factors);
    assert.deepStrictEqual(snapshot(originalState), result.originalStateSnapshot);
    assertFactorSlots(integratedState.factors);
    assertNoFinalScoreLeakage(integratedState);
}

function testInterestIsolation() {
    const before = integrate(makeInputs()).results;
    const after = integrate(makeInputs({ interestScore: 0.4 })).results;

    assertClose("Interest before", before.interest.score, 0.8);
    assertClose("Interest after", after.interest.score, 0.4);
    assert.deepStrictEqual(after.preference, before.preference);
    assert.deepStrictEqual(after.goal, before.goal);
    assert.deepStrictEqual(after.exploration, before.exploration);
}

function testPreferenceIsolation() {
    const before = integrate(makeInputs()).results;
    const after = integrate(makeInputs({ preferenceValue: "Outdoor" })).results;

    assertClose("Preference before", before.preference.score, 0.9);
    assertClose("Preference after", after.preference.score, 0.1);
    assert.deepStrictEqual(after.interest, before.interest);
    assert.deepStrictEqual(after.goal, before.goal);
    assert.deepStrictEqual(after.exploration, before.exploration);
}

function testGoalIsolation() {
    const before = integrate(makeInputs()).results;
    const after = integrate(makeInputs({
        goals: [
            {
                _id: "goal_a",
                name: "Goal A",
                relatedOutcomes: [
                    {
                        outcomeId: "A"
                    },
                    {
                        outcomeId: "Z"
                    }
                ]
            },
            {
                _id: "goal_b",
                name: "Goal B",
                relatedOutcomes: [
                    {
                        outcomeId: "B"
                    },
                    {
                        outcomeId: "C"
                    }
                ]
            }
        ]
    })).results;

    assertClose("Goal before", before.goal.score, 0.75);
    assertClose("Goal after", after.goal.score, 0.5);
    assert.deepStrictEqual(after.interest, before.interest);
    assert.deepStrictEqual(after.preference, before.preference);
    assert.deepStrictEqual(after.exploration, before.exploration);
}

function testExplorationIsolation() {
    const before = integrate(makeInputs()).results;
    const after = integrate(makeInputs({
        historyContext: {
            bookings: [],
            recommendations: [],
            sources: {
                bookings: "available",
                recommendations: "available"
            }
        }
    })).results;

    assertClose("Exploration before", before.exploration.score, 0.5);
    assertClose("Exploration after", after.exploration.score, 1);
    assert.deepStrictEqual(after.interest, before.interest);
    assert.deepStrictEqual(after.preference, before.preference);
    assert.deepStrictEqual(after.goal, before.goal);
}

function testExplorationSourceReadinessIsolation() {
    const before = integrate(makeInputs()).results;
    const after = integrate(makeInputs({
        historyContext: {
            bookings: [],
            recommendations: [
                recommendation()
            ],
            sources: {
                bookings: "unavailable",
                recommendations: "available"
            }
        }
    })).results;

    assert.strictEqual(before.exploration.available, true);
    assert.strictEqual(after.exploration.available, false);
    assert.strictEqual(after.exploration.score, null);
    assert.deepStrictEqual(after.interest, before.interest);
    assert.deepStrictEqual(after.preference, before.preference);
    assert.deepStrictEqual(after.goal, before.goal);
}

function testResponseBehaviorIndependence() {
    const before = integrate(makeInputs({
        historyContext: {
            bookings: [],
            recommendations: [
                recommendation({
                    clickedActivityIds: ["activity_robotics"],
                    savedActivityIds: ["activity_robotics"],
                    dismissedActivityIds: []
                })
            ],
            sources: {
                bookings: "available",
                recommendations: "available"
            }
        }
    })).results;
    const after = integrate(makeInputs({
        historyContext: {
            bookings: [],
            recommendations: [
                recommendation({
                    clickedActivityIds: [],
                    savedActivityIds: [],
                    dismissedActivityIds: ["activity_robotics"]
                })
            ],
            sources: {
                bookings: "available",
                recommendations: "available"
            }
        }
    })).results;

    assert.deepStrictEqual(after.interest, before.interest);
    assert.deepStrictEqual(after.preference, before.preference);
    assert.deepStrictEqual(after.goal, before.goal);
    assert.strictEqual(after.exploration.score, before.exploration.score);
    assert.strictEqual(
        after.exploration.evidence[0].noveltyState,
        before.exploration.evidence[0].noveltyState
    );
}

function testGoalPriorityIndependence() {
    const before = integrate(makeInputs()).results;
    const after = integrate(makeInputs({
        parentGoals: [
            {
                goalId: "goal_a",
                priority: 9,
                status: "Active"
            },
            {
                goalId: "goal_b",
                priority: 10,
                status: "Active"
            }
        ]
    })).results;

    assertClose("Goal score", after.goal.score, before.goal.score);
    assert.deepStrictEqual(
        after.goal.evidence.map((item) => item.coverage),
        before.goal.evidence.map((item) => item.coverage)
    );
    assert.deepStrictEqual(after.interest, before.interest);
    assert.deepStrictEqual(after.preference, before.preference);
    assert.deepStrictEqual(after.exploration, before.exploration);
}

function testD4EvidenceIndependence() {
    const before = integrate(makeInputs()).results;
    const after = integrate(makeInputs({
        evidence: {
            interests: [
                {
                    name: "Changed"
                }
            ],
            goals: [
                {
                    name: "Changed"
                }
            ],
            summary: [
                "Changed"
            ]
        }
    })).results;

    assert.strictEqual(after.interest.score, before.interest.score);
    assert.strictEqual(after.preference.score, before.preference.score);
    assert.strictEqual(after.goal.score, before.goal.score);
    assert.strictEqual(after.exploration.score, before.exploration.score);
}

function testOrderIndependence() {
    const baseline = integrate(makeInputs()).results;
    const orders = permutations(COMPLETED_FACTORS);

    assert.strictEqual(orders.length, 24);

    for (const order of orders) {
        const result = integrate(makeInputs(), order).results;

        assert.deepStrictEqual(result.interest, baseline.interest);
        assert.deepStrictEqual(result.preference, baseline.preference);
        assert.deepStrictEqual(result.goal, baseline.goal);
        assert.deepStrictEqual(result.exploration, baseline.exploration);
    }
}

function testEvidenceSeparation() {
    const { results } = integrate(makeInputs());
    const evidenceArrays = COMPLETED_FACTORS.map(
        (factor) => results[factor].evidence
    );

    for (let left = 0; left < evidenceArrays.length; left += 1) {
        for (let right = left + 1; right < evidenceArrays.length; right += 1) {
            assert.notStrictEqual(evidenceArrays[left], evidenceArrays[right]);
        }
    }

    for (const item of results.interest.evidence) {
        assert(!Object.prototype.hasOwnProperty.call(item, "coverage"));
        assert(!Object.prototype.hasOwnProperty.call(item, "noveltyState"));
    }

    for (const item of results.preference.evidence) {
        assert(!Object.prototype.hasOwnProperty.call(item, "categoryScore"));
        assert(!Object.prototype.hasOwnProperty.call(item, "noveltyState"));
    }

    for (const item of results.goal.evidence) {
        assert(!Object.prototype.hasOwnProperty.call(item, "dimension"));
        assert(!Object.prototype.hasOwnProperty.call(item, "noveltyState"));
    }

    for (const item of results.exploration.evidence) {
        assert(!Object.prototype.hasOwnProperty.call(item, "confidence"));
        assert(!Object.prototype.hasOwnProperty.call(item, "dimension"));
        assert(!Object.prototype.hasOwnProperty.call(item, "coverage"));
        assert(!Object.prototype.hasOwnProperty.call(item, "goalOutcomeIds"));
    }
}

function testAllFourUnavailable() {
    const result = integrate(makeInputs({
        includeInterest: false,
        includePreference: false,
        parentGoals: [],
        historyContext: {
            bookings: [],
            recommendations: [],
            sources: {
                bookings: "available",
                recommendations: "unavailable"
            }
        }
    }));

    assertFactorSlots(result.integratedState.factors);
    assertUnavailableResult(
        result.integratedState.factors.interest,
        SCORING_FACTORS.INTEREST
    );
    assertUnavailableResult(
        result.integratedState.factors.preference,
        SCORING_FACTORS.PREFERENCE
    );
    assertUnavailableResult(
        result.integratedState.factors.goal,
        SCORING_FACTORS.GOAL
    );
    assertUnavailableResult(
        result.integratedState.factors.exploration,
        SCORING_FACTORS.EXPLORATION
    );
    assert.strictEqual(result.integratedState.factors.behavior, null);
    assert.strictEqual(result.integratedState.factors.session, null);
    assert.strictEqual(result.eligibilityEvaluation.eligibility.eligible, true);
    assert.deepStrictEqual(
        result.eligibilityEvaluation.eligibility.failedConstraints,
        []
    );
    assert(result.integratedState.eligibilityEvaluation.candidate);
    assertNoFinalScoreLeakage(result.integratedState);
}

function testMixedAvailability() {
    const caseA = integrate(makeInputs({
        includePreference: false,
        historyContext: {
            bookings: [],
            recommendations: [],
            sources: {
                bookings: "available",
                recommendations: "unavailable"
            }
        }
    })).results;
    assert.strictEqual(caseA.interest.available, true);
    assert.strictEqual(caseA.preference.available, false);
    assert.strictEqual(caseA.preference.score, null);
    assert.strictEqual(caseA.goal.available, true);
    assert.strictEqual(caseA.exploration.available, false);
    assert.strictEqual(caseA.exploration.score, null);

    const caseB = integrate(makeInputs({
        includeInterest: false
    })).results;
    assert.strictEqual(caseB.interest.available, false);
    assert.strictEqual(caseB.interest.score, null);
    assert.strictEqual(caseB.preference.available, true);
    assert.strictEqual(caseB.goal.available, true);
    assert.strictEqual(caseB.exploration.available, true);

    const caseC = integrate(makeInputs({
        parentGoals: []
    })).results;
    assert.strictEqual(caseC.interest.available, true);
    assert.strictEqual(caseC.preference.available, true);
    assert.strictEqual(caseC.goal.available, false);
    assert.strictEqual(caseC.goal.score, null);
    assert.strictEqual(caseC.exploration.available, true);

    const caseD = integrate(makeInputs({
        includeInterest: false,
        includePreference: false
    })).results;
    assert.strictEqual(caseD.interest.available, false);
    assert.strictEqual(caseD.interest.score, null);
    assert.strictEqual(caseD.preference.available, false);
    assert.strictEqual(caseD.preference.score, null);
    assert.strictEqual(caseD.goal.available, true);
    assert.strictEqual(caseD.exploration.available, true);
}

function testExperiencedExplorationIsolation() {
    const before = integrate(makeInputs()).results;
    const after = integrate(makeInputs({
        historyContext: {
            bookings: [
                booking({ attendanceStatus: "Attended" })
            ],
            recommendations: [
                recommendation()
            ],
            sources: {
                bookings: "available",
                recommendations: "available"
            }
        }
    })).results;

    assertClose("Exploration after", after.exploration.score, 0);
    assert.deepStrictEqual(after.interest, before.interest);
    assert.deepStrictEqual(after.preference, before.preference);
    assert.deepStrictEqual(after.goal, before.goal);
}

function main() {
    testBaselineFourFactorState();
    testInterestIsolation();
    testPreferenceIsolation();
    testGoalIsolation();
    testExplorationIsolation();
    testExperiencedExplorationIsolation();
    testExplorationSourceReadinessIsolation();
    testResponseBehaviorIndependence();
    testGoalPriorityIndependence();
    testD4EvidenceIndependence();
    testOrderIndependence();
    testEvidenceSeparation();
    testAllFourUnavailable();
    testMixedAvailability();

    console.log("Four-factor controlled integration tests: PASSED");
}

main();
