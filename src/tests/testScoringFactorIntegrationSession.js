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
const {
    calculateSessionFactor
} = require("../recommendation/sessionFactorService");

const COMPLETED_FACTORS = Object.values(SCORING_FACTORS);

function assertClose(label, actual, expected, tolerance = 1e-9) {
    assert(
        typeof actual === "number" &&
        Math.abs(actual - expected) <= tolerance,
        `${label}: expected ${expected}, found ${actual}`
    );
}

function snapshot(value) {
    if (value === undefined) {
        return undefined;
    }

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

function session({
    id = "session_1",
    startDateTime = new Date("2026-09-07T10:00:00.000Z"),
    timezone = "UTC",
    remainingCapacity = 4,
    bookingDeadline = new Date("2026-09-01T00:00:00.000Z")
} = {}) {
    return {
        _id: id,
        activityId: "activity_robotics",
        schedule: {
            startDateTime,
            timezone,
            bookingDeadline
        },
        capacity: {
            totalCapacity: 10,
            bookedCapacity: 6,
            remainingCapacity
        },
        availability: {
            status: "Available",
            registrationOpen: true
        }
    };
}

function makeCandidate({
    activityId = "activity_robotics",
    subcategoryId = "subcategory_robotics",
    categoryId = "category_stem",
    preferenceEnvironment = "Indoor",
    activityOutcomeIds = ["A", "B"],
    currentSessions,
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
        },
        currentSessions: currentSessions ?? [
            session()
        ]
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
    parentPreferredDays = ["Monday"],
    parentGoals,
    goals,
    activityOutcomeIds,
    historyContext,
    eligibleSessions,
    currentSessions,
    evidence
} = {}) {
    const sessions = eligibleSessions ?? [
        session()
    ];
    const candidate = makeCandidate({
        activityOutcomeIds,
        currentSessions: currentSessions ?? sessions,
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
            _id: "parent_1",
            recommendationPreferences: {
                preferredDays: parentPreferredDays
            }
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
        eligibleSessions: sessions,
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

    if (factor === SCORING_FACTORS.SESSION) {
        return calculateSessionFactor(eligibilityEvaluation, context);
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
            [SCORING_FACTORS.BEHAVIOR]: results.behavior,
            [SCORING_FACTORS.SESSION]: results.session
        }
    };
}

function integrate(inputs, order = COMPLETED_FACTORS) {
    const { context, candidate, eligibilityEvaluation } = inputs;
    const contextSnapshot = snapshot(context);
    const parentSnapshot = snapshot(context.parent);
    const historyContextSnapshot = snapshot(context.historyContext);
    const bookingsSnapshot = snapshot(context.historyContext.bookings);
    const recommendationsSnapshot =
        snapshot(context.historyContext.recommendations);
    const interactionsSnapshot = snapshot(context.historyContext.interactions);
    const sourcesSnapshot = snapshot(context.historyContext.sources);
    const candidateSnapshot = snapshot(candidate);
    const currentActivitySnapshot = snapshot(candidate.currentActivity);
    const currentSessionsSnapshot = snapshot(candidate.currentSessions);
    const d4EvidenceSnapshot = snapshot(candidate.evidence);
    const evaluationSnapshot = snapshot(eligibilityEvaluation);
    const failedConstraintsSnapshot =
        snapshot(eligibilityEvaluation.eligibility.failedConstraints);
    const eligibleSessionsSnapshot = snapshot(eligibilityEvaluation.eligibleSessions);
    const sessionEvaluationsSnapshot =
        snapshot(eligibilityEvaluation.sessionEvaluations);
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
    assert.deepStrictEqual(snapshot(context.parent), parentSnapshot);
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
    assert.deepStrictEqual(snapshot(candidate.currentSessions), currentSessionsSnapshot);
    assert.deepStrictEqual(snapshot(candidate.evidence), d4EvidenceSnapshot);
    assert.deepStrictEqual(snapshot(eligibilityEvaluation), evaluationSnapshot);
    assert.deepStrictEqual(
        snapshot(eligibilityEvaluation.eligibility.failedConstraints),
        failedConstraintsSnapshot
    );
    assert.deepStrictEqual(
        snapshot(eligibilityEvaluation.eligibleSessions),
        eligibleSessionsSnapshot
    );
    assert.deepStrictEqual(
        snapshot(eligibilityEvaluation.sessionEvaluations),
        sessionEvaluationsSnapshot
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
    assert(!Object.prototype.hasOwnProperty.call(factors, "vendorReliability"));
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

function testBaselineSixFactorState() {
    const result = integrate(makeInputs());
    const { integratedState, originalState, results } = result;

    assertFactorContract(results.interest, SCORING_FACTORS.INTEREST, 0.8);
    assertFactorContract(results.preference, SCORING_FACTORS.PREFERENCE, 0.9);
    assertFactorContract(results.goal, SCORING_FACTORS.GOAL, 0.75);
    assertFactorContract(results.exploration, SCORING_FACTORS.EXPLORATION, 0.5);
    assertFactorContract(results.behavior, SCORING_FACTORS.BEHAVIOR, 0.75);
    assertFactorContract(results.session, SCORING_FACTORS.SESSION, 1);

    for (const factor of COMPLETED_FACTORS) {
        assert.strictEqual(integratedState.factors[factor], results[factor]);
    }

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
    assert.deepStrictEqual(after.session, before.session);
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
    assert.deepStrictEqual(after.session, before.session);
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
    assert.deepStrictEqual(after.session, before.session);
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
    assert.deepStrictEqual(after.session, before.session);
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
    assert.deepStrictEqual(after.session, before.session);
}

function testSessionIsolation() {
    const before = integrate(makeInputs()).results;
    const after = integrate(makeInputs({
        eligibleSessions: [
            session({
                startDateTime: new Date("2026-09-08T10:00:00.000Z")
            })
        ]
    })).results;

    assertClose("Session before", before.session.score, 1);
    assertClose("Session after", after.session.score, 0);
    assert.deepStrictEqual(after.interest, before.interest);
    assert.deepStrictEqual(after.preference, before.preference);
    assert.deepStrictEqual(after.goal, before.goal);
    assert.deepStrictEqual(after.exploration, before.exploration);
    assert.deepStrictEqual(after.behavior, before.behavior);
}

function testPreferredDaysIsolation() {
    const before = integrate(makeInputs()).results;
    const after = integrate(makeInputs({
        parentPreferredDays: ["Tuesday"]
    })).results;

    assertClose("Session before", before.session.score, 1);
    assertClose("Session after", after.session.score, 0);
    assert.strictEqual(after.preference.score, before.preference.score);
    assert.deepStrictEqual(after.interest, before.interest);
    assert.deepStrictEqual(after.goal, before.goal);
    assert.deepStrictEqual(after.exploration, before.exploration);
    assert.deepStrictEqual(after.behavior, before.behavior);
}

function testSessionTimezoneIsolation() {
    const before = integrate(makeInputs({
        eligibleSessions: [
            session({
                startDateTime: new Date("2026-09-07T22:30:00.000Z"),
                timezone: "UTC"
            })
        ]
    })).results;
    const after = integrate(makeInputs({
        eligibleSessions: [
            session({
                startDateTime: new Date("2026-09-07T22:30:00.000Z"),
                timezone: "Asia/Riyadh"
            })
        ]
    })).results;

    assertClose("UTC Monday", before.session.score, 1);
    assertClose("Riyadh Tuesday", after.session.score, 0);
    assert.deepStrictEqual(after.interest, before.interest);
    assert.deepStrictEqual(after.preference, before.preference);
    assert.deepStrictEqual(after.goal, before.goal);
    assert.deepStrictEqual(after.exploration, before.exploration);
    assert.deepStrictEqual(after.behavior, before.behavior);
}

function testSessionHardFieldIndependence() {
    const before = integrate(makeInputs()).results;
    const after = integrate(makeInputs({
        eligibleSessions: [
            session({
                remainingCapacity: 99,
                bookingDeadline: new Date("2026-09-06T00:00:00.000Z")
            })
        ]
    })).results;

    assertClose("Session score", after.session.score, before.session.score);
    assert.deepStrictEqual(after.interest, before.interest);
    assert.deepStrictEqual(after.preference, before.preference);
    assert.deepStrictEqual(after.goal, before.goal);
    assert.deepStrictEqual(after.exploration, before.exploration);
    assert.deepStrictEqual(after.behavior, before.behavior);
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
    assert.deepStrictEqual(after.session, before.session);
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
    assert.deepStrictEqual(after.session, before.session);
}

function testSessionPreferenceAvailabilityIsolation() {
    const before = integrate(makeInputs()).results;
    const after = integrate(makeInputs({
        parentPreferredDays: []
    })).results;

    assert.strictEqual(after.session.available, false);
    assert.strictEqual(after.session.score, null);
    assert.deepStrictEqual(after.interest, before.interest);
    assert.deepStrictEqual(after.preference, before.preference);
    assert.deepStrictEqual(after.goal, before.goal);
    assert.deepStrictEqual(after.exploration, before.exploration);
    assert.deepStrictEqual(after.behavior, before.behavior);
}

function testZeroVsUnavailable() {
    const zero = integrate(makeInputs({
        parentPreferredDays: ["Tuesday"]
    })).results.session;
    const unavailable = integrate(makeInputs({
        parentPreferredDays: []
    })).results.session;

    assert.strictEqual(zero.available, true);
    assert.strictEqual(zero.score, 0);
    assert.strictEqual(unavailable.available, false);
    assert.strictEqual(unavailable.score, null);
}

function testSourceResponsibilitySeparation() {
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
    const nonmatchingSession = integrate(makeInputs({
        eligibleSessions: [
            session({
                startDateTime: new Date("2026-09-08T10:00:00.000Z")
            })
        ]
    })).results;

    assertClose("Recommendation changes Exploration", displayOff.exploration.score, 1);
    assert.deepStrictEqual(displayOff.behavior, before.behavior);
    assert.deepStrictEqual(displayOff.session, before.session);
    assertClose("Interaction changes Behavior", behaviorSave.behavior.score, 1);
    assert.deepStrictEqual(behaviorSave.exploration, before.exploration);
    assert.deepStrictEqual(behaviorSave.session, before.session);
    assertClose("Booking changes Exploration", attended.exploration.score, 0);
    assert.deepStrictEqual(attended.behavior, before.behavior);
    assert.deepStrictEqual(attended.session, before.session);
    assertClose("Session change", nonmatchingSession.session.score, 0);
    assert.deepStrictEqual(nonmatchingSession.exploration, before.exploration);
    assert.deepStrictEqual(nonmatchingSession.behavior, before.behavior);
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

    assert.deepStrictEqual(after, before);
}

function testPreferenceSessionBoundary() {
    const before = integrate(makeInputs()).results;
    const preferenceChanged = integrate(makeInputs({
        preferenceValue: "Outdoor"
    })).results;
    const sessionChanged = integrate(makeInputs({
        parentPreferredDays: ["Tuesday"]
    })).results;

    assertClose("Preference changed", preferenceChanged.preference.score, 0.1);
    assert.deepStrictEqual(preferenceChanged.session, before.session);
    assertClose("Session changed", sessionChanged.session.score, 0);
    assert.strictEqual(sessionChanged.preference.score, before.preference.score);
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
    assert.deepStrictEqual(after.session, before.session);
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
    assert.deepStrictEqual(after.session, before.session);
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

    assert.strictEqual(orders.length, 720);

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
        assert(!Object.prototype.hasOwnProperty.call(item, "matchingSessionIds"));
    }

    for (const item of results.preference.evidence) {
        assert(!Object.prototype.hasOwnProperty.call(item, "coverage"));
        assert(!Object.prototype.hasOwnProperty.call(item, "noveltyState"));
        assert(!Object.prototype.hasOwnProperty.call(item, "behaviorState"));
        assert(!Object.prototype.hasOwnProperty.call(item, "matchingWeekdays"));
    }

    for (const item of results.goal.evidence) {
        assert(!Object.prototype.hasOwnProperty.call(item, "adjustedScore"));
        assert(!Object.prototype.hasOwnProperty.call(item, "noveltyState"));
        assert(!Object.prototype.hasOwnProperty.call(item, "behaviorState"));
        assert(!Object.prototype.hasOwnProperty.call(item, "preferredDays"));
    }

    for (const item of results.exploration.evidence) {
        assert(!Object.prototype.hasOwnProperty.call(item, "behaviorState"));
        assert(!Object.prototype.hasOwnProperty.call(item, "selectedInteractionType"));
        assert(!Object.prototype.hasOwnProperty.call(item, "matchingSessionIds"));
        assert(!Object.prototype.hasOwnProperty.call(item, "coverage"));
        assert(!Object.prototype.hasOwnProperty.call(item, "dimension"));
    }

    for (const item of results.behavior.evidence) {
        assert(!Object.prototype.hasOwnProperty.call(item, "noveltyState"));
        assert(!Object.prototype.hasOwnProperty.call(item, "matchingBookingCount"));
        assert(!Object.prototype.hasOwnProperty.call(item, "displayedRecommendationCount"));
        assert(!Object.prototype.hasOwnProperty.call(item, "coverage"));
        assert(!Object.prototype.hasOwnProperty.call(item, "dimension"));
        assert(!Object.prototype.hasOwnProperty.call(item, "matchingSessionIds"));
    }

    for (const item of results.session.evidence) {
        assert(!Object.prototype.hasOwnProperty.call(item, "categoryScore"));
        assert(!Object.prototype.hasOwnProperty.call(item, "confidence"));
        assert(!Object.prototype.hasOwnProperty.call(item, "dimension"));
        assert(!Object.prototype.hasOwnProperty.call(item, "coverage"));
        assert(!Object.prototype.hasOwnProperty.call(item, "noveltyState"));
        assert(!Object.prototype.hasOwnProperty.call(item, "behaviorState"));
        assert(!Object.prototype.hasOwnProperty.call(item, "selectedInteractionType"));
        assert(Object.prototype.hasOwnProperty.call(item, "preferredDays"));
        assert(Object.prototype.hasOwnProperty.call(item, "eligibleSessionCount"));
        assert(Object.prototype.hasOwnProperty.call(item, "matchingSessionIds"));
        assert(Object.prototype.hasOwnProperty.call(item, "matchingWeekdays"));
    }
}

function testAllSixUnavailable() {
    const result = integrate(makeInputs({
        includeInterest: false,
        includePreference: false,
        parentPreferredDays: [],
        parentGoals: [],
        historyContext: makeHistoryContext({
            recommendations: [],
            interactions: [],
            sources: {
                recommendations: "unavailable",
                interactions: "unavailable"
            }
        }),
        eligibleSessions: []
    }));

    assertFactorSlots(result.integratedState.factors);
    for (const factor of COMPLETED_FACTORS) {
        assertUnavailableResult(
            result.integratedState.factors[factor],
            factor
        );
    }
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
    assert.strictEqual(caseA.session.available, true);

    const caseB = integrate(makeInputs({
        includeInterest: false,
        parentPreferredDays: [],
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
    assert.strictEqual(caseB.session.available, false);

    const caseC = integrate(makeInputs({
        parentGoals: []
    })).results;
    assert.strictEqual(caseC.interest.available, true);
    assert.strictEqual(caseC.preference.available, true);
    assert.strictEqual(caseC.goal.available, false);
    assert.strictEqual(caseC.exploration.available, true);
    assert.strictEqual(caseC.behavior.available, true);
    assert.strictEqual(caseC.session.available, true);

    const caseD = integrate(makeInputs({
        includeInterest: false,
        includePreference: false,
        parentPreferredDays: []
    })).results;
    assert.strictEqual(caseD.interest.available, false);
    assert.strictEqual(caseD.preference.available, false);
    assert.strictEqual(caseD.goal.available, true);
    assert.strictEqual(caseD.exploration.available, true);
    assert.strictEqual(caseD.behavior.available, true);
    assert.strictEqual(caseD.session.available, false);

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
    assert.strictEqual(caseE.session.available, true);
}

function testAvailableZeroScoresPreserved() {
    const result = integrate(makeInputs({
        goals: [
            {
                _id: "goal_a",
                name: "Goal A",
                relatedOutcomes: [
                    {
                        outcomeId: "Z"
                    }
                ]
            }
        ],
        activityOutcomeIds: ["A"],
        historyContext: makeHistoryContext({
            interactions: [
                interaction({
                    interactionType: "Dismiss",
                    ratingValue: null
                })
            ]
        }),
        parentPreferredDays: ["Tuesday"]
    })).results;

    assert.strictEqual(result.goal.available, true);
    assert.strictEqual(result.goal.score, 0);
    assert.strictEqual(result.behavior.available, true);
    assert.strictEqual(result.behavior.score, 0);
    assert.strictEqual(result.session.available, true);
    assert.strictEqual(result.session.score, 0);
}

function testSessionStandaloneConsistency() {
    const inputs = makeInputs();
    const integrated = integrate(inputs).results.session;
    const standalone = calculateSessionFactor(
        inputs.eligibilityEvaluation,
        inputs.context
    );

    assert.deepStrictEqual(integrated, standalone);
}

function main() {
    testBaselineSixFactorState();
    testInterestIsolation();
    testPreferenceIsolation();
    testGoalIsolation();
    testExplorationIsolation();
    testBehaviorIsolation();
    testSessionIsolation();
    testPreferredDaysIsolation();
    testSessionTimezoneIsolation();
    testSessionHardFieldIndependence();
    testBehaviorSourceReadinessIsolation();
    testExplorationSourceReadinessIsolation();
    testSessionPreferenceAvailabilityIsolation();
    testZeroVsUnavailable();
    testSourceResponsibilitySeparation();
    testResponseActionIndependence();
    testPreferenceSessionBoundary();
    testGoalPriorityIndependence();
    testActorTypeIndependence();
    testD4EvidenceIndependence();
    testOrderIndependence();
    testEvidenceSeparation();
    testAllSixUnavailable();
    testMixedAvailability();
    testAvailableZeroScoresPreserved();
    testSessionStandaloneConsistency();

    console.log("Six-factor controlled integration tests: PASSED");
}

main();
