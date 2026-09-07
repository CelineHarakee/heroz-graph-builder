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
const {
    calculateBehaviorFactor
} = require("../recommendation/behaviorFactorService");

const COMPLETED_FACTORS = [
    SCORING_FACTORS.INTEREST,
    SCORING_FACTORS.PREFERENCE,
    SCORING_FACTORS.GOAL,
    SCORING_FACTORS.EXPLORATION,
    SCORING_FACTORS.BEHAVIOR
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

function interaction({
    id = "interaction_1",
    childId = "child_1",
    activityId = "activity_robotics",
    entityType = "Activity",
    interactionType = "Rate",
    ratingValue = 4,
    timestamp = new Date("2026-09-02T00:00:00.000Z"),
    actorType = "Child"
} = {}) {
    return {
        _id: id,
        actor: {
            childId,
            actorType
        },
        targetEntity: {
            entityType,
            entityId: activityId
        },
        interactionDetails: {
            interactionType,
            ratingValue,
            durationSeconds: 30
        },
        context: {
            surface: "ActivityDetail",
            recommendationId: "recommendation_1",
            sessionId: "session_1"
        },
        timestamp
    };
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

function makeHistoryContext(overrides = {}) {
    return {
        bookings: [],
        recommendations: [
            recommendation()
        ],
        interactions: [
            interaction()
        ],
        sources: {
            bookings: "available",
            recommendations: "available",
            interactions: "available"
        },
        ...overrides,
        sources: {
            bookings: "available",
            recommendations: "available",
            interactions: "available",
            ...(overrides.sources ?? {})
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
        historyContext: historyContext ?? makeHistoryContext()
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

    if (factor === SCORING_FACTORS.BEHAVIOR) {
        return calculateBehaviorFactor(context, eligibilityEvaluation);
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
            [SCORING_FACTORS.EXPLORATION]: results.exploration,
            [SCORING_FACTORS.BEHAVIOR]: results.behavior
        }
    };
}

function integrate(inputs, order = COMPLETED_FACTORS) {
    const { context, candidate, eligibilityEvaluation } = inputs;
    const contextSnapshot = snapshot(context);
    const historyContextSnapshot = snapshot(context.historyContext);
    const bookingsSnapshot = snapshot(context.historyContext.bookings);
    const recommendationsSnapshot =
        snapshot(context.historyContext.recommendations);
    const interactionsSnapshot = snapshot(context.historyContext.interactions);
    const sourcesSnapshot = snapshot(context.historyContext.sources);
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
    assert.deepStrictEqual(snapshot(context.historyContext.bookings), bookingsSnapshot);
    assert.deepStrictEqual(
        snapshot(context.historyContext.recommendations),
        recommendationsSnapshot
    );
    assert.deepStrictEqual(
        snapshot(context.historyContext.interactions),
        interactionsSnapshot
    );
    assert.deepStrictEqual(snapshot(context.historyContext.sources), sourcesSnapshot);
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

function assertScoresEqual(after, before) {
    for (const factor of COMPLETED_FACTORS) {
        assert.strictEqual(after[factor].score, before[factor].score);
    }
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

function testBaselineFiveFactorState() {
    const result = integrate(makeInputs());
    const { integratedState, originalState, results } = result;

    assertFactorContract(results.interest, SCORING_FACTORS.INTEREST, 0.8);
    assertFactorContract(results.preference, SCORING_FACTORS.PREFERENCE, 0.9);
    assertFactorContract(results.goal, SCORING_FACTORS.GOAL, 0.75);
    assertFactorContract(results.exploration, SCORING_FACTORS.EXPLORATION, 0.5);
    assertFactorContract(results.behavior, SCORING_FACTORS.BEHAVIOR, 0.75);
    assert.strictEqual(integratedState.factors.interest, results.interest);
    assert.strictEqual(integratedState.factors.preference, results.preference);
    assert.strictEqual(integratedState.factors.goal, results.goal);
    assert.strictEqual(integratedState.factors.exploration, results.exploration);
    assert.strictEqual(integratedState.factors.behavior, results.behavior);
    assert.strictEqual(integratedState.factors.session, null);
    assert.strictEqual(
        integratedState.factors.session,
        originalState.factors.session
    );
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
    assert.deepStrictEqual(after.behavior, before.behavior);
}

function testPreferenceIsolation() {
    const before = integrate(makeInputs()).results;
    const after = integrate(makeInputs({ preferenceValue: "Outdoor" })).results;

    assertClose("Preference before", before.preference.score, 0.9);
    assertClose("Preference after", after.preference.score, 0.1);
    assert.deepStrictEqual(after.interest, before.interest);
    assert.deepStrictEqual(after.goal, before.goal);
    assert.deepStrictEqual(after.exploration, before.exploration);
    assert.deepStrictEqual(after.behavior, before.behavior);
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
    assert.deepStrictEqual(after.behavior, before.behavior);
}

function testExplorationIsolation() {
    const before = integrate(makeInputs()).results;
    const after = integrate(makeInputs({
        historyContext: makeHistoryContext({
            recommendations: []
        })
    })).results;

    assertClose("Exploration before", before.exploration.score, 0.5);
    assertClose("Exploration after", after.exploration.score, 1);
    assert.deepStrictEqual(after.interest, before.interest);
    assert.deepStrictEqual(after.preference, before.preference);
    assert.deepStrictEqual(after.goal, before.goal);
    assert.deepStrictEqual(after.behavior, before.behavior);
}

function testBehaviorIsolation() {
    const before = integrate(makeInputs()).results;
    const after = integrate(makeInputs({
        historyContext: makeHistoryContext({
            interactions: [
                interaction(),
                interaction({
                    id: "interaction_2",
                    interactionType: "Dismiss",
                    ratingValue: null,
                    timestamp: new Date("2026-09-03T00:00:00.000Z")
                })
            ]
        })
    })).results;

    assertClose("Behavior before", before.behavior.score, 0.75);
    assertClose("Behavior after", after.behavior.score, 0);
    assert.deepStrictEqual(after.interest, before.interest);
    assert.deepStrictEqual(after.preference, before.preference);
    assert.deepStrictEqual(after.goal, before.goal);
    assert.deepStrictEqual(after.exploration, before.exploration);
}

function testBehaviorSourceReadinessIsolation() {
    const before = integrate(makeInputs()).results;
    const after = integrate(makeInputs({
        historyContext: makeHistoryContext({
            sources: {
                interactions: "unavailable"
            }
        })
    })).results;

    assert.strictEqual(after.behavior.available, false);
    assert.strictEqual(after.behavior.score, null);
    assert.deepStrictEqual(after.interest, before.interest);
    assert.deepStrictEqual(after.preference, before.preference);
    assert.deepStrictEqual(after.goal, before.goal);
    assert.deepStrictEqual(after.exploration, before.exploration);
}

function testExplorationSourceReadinessIsolation() {
    const before = integrate(makeInputs()).results;
    const after = integrate(makeInputs({
        historyContext: makeHistoryContext({
            sources: {
                bookings: "unavailable"
            }
        })
    })).results;

    assert.strictEqual(after.exploration.available, false);
    assert.strictEqual(after.exploration.score, null);
    assert.deepStrictEqual(after.interest, before.interest);
    assert.deepStrictEqual(after.preference, before.preference);
    assert.deepStrictEqual(after.goal, before.goal);
    assert.deepStrictEqual(after.behavior, before.behavior);
}

function testHistorySourceResponsibilitySeparation() {
    const before = integrate(makeInputs()).results;
    const displayOff = integrate(makeInputs({
        historyContext: makeHistoryContext({
            recommendations: [
                recommendation({ wasDisplayed: false })
            ]
        })
    })).results;
    const behaviorSave = integrate(makeInputs({
        historyContext: makeHistoryContext({
            interactions: [
                interaction({
                    interactionType: "Save",
                    ratingValue: null
                })
            ]
        })
    })).results;
    const attended = integrate(makeInputs({
        historyContext: makeHistoryContext({
            bookings: [
                booking({ attendanceStatus: "Attended" })
            ]
        })
    })).results;

    assertClose("Display changes Exploration", displayOff.exploration.score, 1);
    assert.deepStrictEqual(displayOff.behavior, before.behavior);
    assertClose("Interaction changes Behavior", behaviorSave.behavior.score, 1);
    assert.deepStrictEqual(behaviorSave.exploration, before.exploration);
    assertClose("Attendance changes Exploration", attended.exploration.score, 0);
    assert.deepStrictEqual(attended.behavior, before.behavior);
}

function testResponseActionIndependence() {
    const before = integrate(makeInputs({
        historyContext: makeHistoryContext({
            recommendations: [
                recommendation({
                    clickedActivityIds: ["activity_robotics"],
                    savedActivityIds: ["activity_robotics"],
                    dismissedActivityIds: []
                })
            ]
        })
    })).results;
    const after = integrate(makeInputs({
        historyContext: makeHistoryContext({
            recommendations: [
                recommendation({
                    clickedActivityIds: [],
                    savedActivityIds: [],
                    dismissedActivityIds: ["activity_robotics"]
                })
            ]
        })
    })).results;

    assert.deepStrictEqual(after.interest, before.interest);
    assert.deepStrictEqual(after.preference, before.preference);
    assert.deepStrictEqual(after.goal, before.goal);
    assert.deepStrictEqual(after.behavior, before.behavior);
    assert.strictEqual(after.exploration.score, before.exploration.score);
}

function testBehaviorExplicitOverPassive() {
    const before = integrate(makeInputs()).results;
    const after = integrate(makeInputs({
        historyContext: makeHistoryContext({
            interactions: [
                interaction(),
                interaction({
                    id: "interaction_2",
                    interactionType: "View",
                    ratingValue: null,
                    timestamp: new Date("2026-09-03T00:00:00.000Z")
                })
            ]
        })
    })).results;

    assertClose("Behavior score", after.behavior.score, before.behavior.score);
    assert.strictEqual(
        after.behavior.evidence[0].selectedInteractionType,
        before.behavior.evidence[0].selectedInteractionType
    );
    assert.deepStrictEqual(after.interest, before.interest);
    assert.deepStrictEqual(after.preference, before.preference);
    assert.deepStrictEqual(after.goal, before.goal);
    assert.deepStrictEqual(after.exploration, before.exploration);
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
    assert.deepStrictEqual(after.behavior, before.behavior);
}

function testActorTypeIndependence() {
    const before = integrate(makeInputs()).results;
    const after = integrate(makeInputs({
        historyContext: makeHistoryContext({
            interactions: [
                interaction({ actorType: "Parent" })
            ]
        })
    })).results;

    assertClose("Behavior score", after.behavior.score, before.behavior.score);
    assert.deepStrictEqual(after.interest, before.interest);
    assert.deepStrictEqual(after.preference, before.preference);
    assert.deepStrictEqual(after.goal, before.goal);
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

    assertScoresEqual(after, before);
}

function testOrderIndependence() {
    const baseline = integrate(makeInputs()).results;
    const orders = permutations(COMPLETED_FACTORS);

    assert.strictEqual(orders.length, 120);

    for (const order of orders) {
        const result = integrate(makeInputs(), order).results;

        for (const factor of COMPLETED_FACTORS) {
            assert.deepStrictEqual(result[factor], baseline[factor]);
        }
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
        assert(!Object.prototype.hasOwnProperty.call(item, "dimension"));
        assert(!Object.prototype.hasOwnProperty.call(item, "coverage"));
        assert(!Object.prototype.hasOwnProperty.call(item, "noveltyState"));
        assert(!Object.prototype.hasOwnProperty.call(item, "behaviorState"));
    }

    for (const item of results.preference.evidence) {
        assert(!Object.prototype.hasOwnProperty.call(item, "categoryScore"));
        assert(!Object.prototype.hasOwnProperty.call(item, "coverage"));
        assert(!Object.prototype.hasOwnProperty.call(item, "noveltyState"));
        assert(!Object.prototype.hasOwnProperty.call(item, "behaviorState"));
    }

    for (const item of results.goal.evidence) {
        assert(!Object.prototype.hasOwnProperty.call(item, "categoryScore"));
        assert(!Object.prototype.hasOwnProperty.call(item, "adjustedScore"));
        assert(!Object.prototype.hasOwnProperty.call(item, "noveltyState"));
        assert(!Object.prototype.hasOwnProperty.call(item, "behaviorState"));
    }

    for (const item of results.exploration.evidence) {
        assert(!Object.prototype.hasOwnProperty.call(item, "behaviorState"));
        assert(!Object.prototype.hasOwnProperty.call(item, "ratingValue"));
        assert(!Object.prototype.hasOwnProperty.call(item, "coverage"));
        assert(!Object.prototype.hasOwnProperty.call(item, "dimension"));
        assert(!Object.prototype.hasOwnProperty.call(item, "categoryScore"));
    }

    for (const item of results.behavior.evidence) {
        assert(!Object.prototype.hasOwnProperty.call(item, "noveltyState"));
        assert(!Object.prototype.hasOwnProperty.call(item, "matchingBookingCount"));
        assert(!Object.prototype.hasOwnProperty.call(item, "displayedRecommendationCount"));
        assert(!Object.prototype.hasOwnProperty.call(item, "confidence"));
        assert(!Object.prototype.hasOwnProperty.call(item, "coverage"));
        assert(!Object.prototype.hasOwnProperty.call(item, "dimension"));
    }
}

function testAllFiveUnavailable() {
    const result = integrate(makeInputs({
        includeInterest: false,
        includePreference: false,
        parentGoals: [],
        historyContext: makeHistoryContext({
            recommendations: [],
            interactions: [],
            sources: {
                recommendations: "unavailable",
                interactions: "unavailable"
            }
        })
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
    assertUnavailableResult(
        result.integratedState.factors.behavior,
        SCORING_FACTORS.BEHAVIOR
    );
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
        historyContext: makeHistoryContext({
            recommendations: [],
            interactions: [],
            sources: {
                recommendations: "unavailable",
                interactions: "unavailable"
            }
        })
    })).results;
    assert.strictEqual(caseA.interest.available, true);
    assert.strictEqual(caseA.preference.available, false);
    assert.strictEqual(caseA.goal.available, true);
    assert.strictEqual(caseA.exploration.available, false);
    assert.strictEqual(caseA.behavior.available, false);

    const caseB = integrate(makeInputs({
        includeInterest: false,
        historyContext: makeHistoryContext({
            interactions: [],
            sources: {
                interactions: "unavailable"
            }
        })
    })).results;
    assert.strictEqual(caseB.interest.available, false);
    assert.strictEqual(caseB.preference.available, true);
    assert.strictEqual(caseB.goal.available, true);
    assert.strictEqual(caseB.exploration.available, true);
    assert.strictEqual(caseB.behavior.available, false);

    const caseC = integrate(makeInputs({
        parentGoals: []
    })).results;
    assert.strictEqual(caseC.interest.available, true);
    assert.strictEqual(caseC.preference.available, true);
    assert.strictEqual(caseC.goal.available, false);
    assert.strictEqual(caseC.exploration.available, true);
    assert.strictEqual(caseC.behavior.available, true);

    const caseD = integrate(makeInputs({
        includeInterest: false,
        includePreference: false
    })).results;
    assert.strictEqual(caseD.interest.available, false);
    assert.strictEqual(caseD.preference.available, false);
    assert.strictEqual(caseD.goal.available, true);
    assert.strictEqual(caseD.exploration.available, true);
    assert.strictEqual(caseD.behavior.available, true);

    const caseE = integrate(makeInputs({
        includePreference: false,
        parentGoals: [],
        historyContext: makeHistoryContext({
            recommendations: [],
            sources: {
                recommendations: "unavailable"
            }
        })
    })).results;
    assert.strictEqual(caseE.interest.available, true);
    assert.strictEqual(caseE.preference.available, false);
    assert.strictEqual(caseE.goal.available, false);
    assert.strictEqual(caseE.exploration.available, false);
    assert.strictEqual(caseE.behavior.available, true);
}

function testBehaviorStandaloneConsistency() {
    const inputs = makeInputs();
    const integrated = integrate(inputs).results.behavior;
    const standalone = calculateBehaviorFactor(
        inputs.context,
        inputs.eligibilityEvaluation
    );

    assert.deepStrictEqual(integrated, standalone);
}

function main() {
    testBaselineFiveFactorState();
    testInterestIsolation();
    testPreferenceIsolation();
    testGoalIsolation();
    testExplorationIsolation();
    testBehaviorIsolation();
    testBehaviorSourceReadinessIsolation();
    testExplorationSourceReadinessIsolation();
    testHistorySourceResponsibilitySeparation();
    testResponseActionIndependence();
    testBehaviorExplicitOverPassive();
    testGoalPriorityIndependence();
    testActorTypeIndependence();
    testD4EvidenceIndependence();
    testOrderIndependence();
    testEvidenceSeparation();
    testAllFiveUnavailable();
    testMixedAvailability();
    testBehaviorStandaloneConsistency();

    console.log("Five-factor controlled integration tests: PASSED");
}

main();
