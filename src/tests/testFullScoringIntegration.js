const assert = require("assert");
const {
    SCORING_FACTORS,
    SCORING_WEIGHTS,
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
const {
    calculateFinalScore
} = require("../recommendation/finalScoreService");

const FACTORS = Object.values(SCORING_FACTORS);

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
    wasDisplayed = true
} = {}) {
    return {
        _id: "recommendation_1",
        childId,
        recommendedItems: [
            {
                activityId
            }
        ],
        response: {
            wasDisplayed,
            clickedActivityIds: [],
            savedActivityIds: [],
            bookedSessionIds: [],
            dismissedActivityIds: []
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
            status: "Confirmed"
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
            entityType: "Activity",
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
    timezone = "UTC"
} = {}) {
    return {
        _id: id,
        activityId: "activity_robotics",
        schedule: {
            startDateTime,
            timezone,
            bookingDeadline: new Date("2026-09-01T00:00:00.000Z")
        },
        capacity: {
            totalCapacity: 10,
            bookedCapacity: 6,
            remainingCapacity: 4
        },
        availability: {
            status: "Available",
            registrationOpen: true
        }
    };
}

function makeCandidate({
    activityId = "activity_robotics",
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
                categoryId: "category_stem",
                subcategoryId: "subcategory_robotics"
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

function runPipeline(inputs, order = FACTORS) {
    const { context, candidate, eligibilityEvaluation } = inputs;
    const contextSnapshot = snapshot(context);
    const candidateSnapshot = snapshot(candidate);
    const eligibilitySnapshot = snapshot(eligibilityEvaluation);
    const originalState = createCandidateScoringState(eligibilityEvaluation);
    const originalStateSnapshot = snapshot(originalState);
    const results = {};

    for (const factor of order) {
        results[factor] = calculateByName(factor, context, eligibilityEvaluation);
    }

    const rawSnapshots = {};

    for (const factor of FACTORS) {
        rawSnapshots[factor] = snapshot(results[factor]);
    }

    const completedState = composeFactors(originalState, results);
    const completedStateSnapshot = snapshot(completedState);
    const aggregate = calculateFinalScore(completedState);

    assert.deepStrictEqual(snapshot(originalState), originalStateSnapshot);
    assert.deepStrictEqual(snapshot(completedState), completedStateSnapshot);
    assert.deepStrictEqual(snapshot(context), contextSnapshot);
    assert.deepStrictEqual(snapshot(candidate), candidateSnapshot);
    assert.deepStrictEqual(snapshot(eligibilityEvaluation), eligibilitySnapshot);

    for (const factor of FACTORS) {
        assert.deepStrictEqual(snapshot(results[factor]), rawSnapshots[factor]);
        assert(!Object.prototype.hasOwnProperty.call(results[factor], "canonicalWeight"));
        assert(!Object.prototype.hasOwnProperty.call(results[factor], "normalizedWeight"));
        assert(!Object.prototype.hasOwnProperty.call(results[factor], "contribution"));
        assert(!Object.prototype.hasOwnProperty.call(results[factor], "finalScore"));
    }

    assert.notStrictEqual(aggregate, completedState);

    return {
        context,
        candidate,
        eligibilityEvaluation,
        originalState,
        completedState,
        results,
        aggregate
    };
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

function assertContributionMath(aggregate) {
    if (!aggregate.available) {
        assert.strictEqual(aggregate.score, null);
        assert.strictEqual(aggregate.availableWeight, 0);
        assert.strictEqual(aggregate.availableFactorCount, 0);
        assert.deepStrictEqual(aggregate.contributions, []);
        return;
    }

    const normalizedWeightTotal = aggregate.contributions.reduce(
        (total, item) => total + item.normalizedWeight,
        0
    );
    const contributionTotal = aggregate.contributions.reduce(
        (total, item) => total + item.contribution,
        0
    );

    assertClose("normalized weights sum", normalizedWeightTotal, 1);
    assertClose("contributions sum", contributionTotal, aggregate.score);
    assert(aggregate.score >= 0 && aggregate.score <= 1);

    for (const item of aggregate.contributions) {
        assertClose(
            `${item.factor} normalized`,
            item.normalizedWeight,
            SCORING_WEIGHTS[item.factor] / aggregate.availableWeight
        );
        assertClose(
            `${item.factor} contribution`,
            item.contribution,
            item.normalizedWeight * item.score
        );
    }
}

function assertAggregate(aggregate, {
    available = true,
    score,
    availableWeight,
    availableFactorCount
}) {
    assert.strictEqual(aggregate.available, available);

    if (available) {
        assertClose("final score", aggregate.score, score);
        assertClose("availableWeight", aggregate.availableWeight, availableWeight);
        assert.strictEqual(aggregate.availableFactorCount, availableFactorCount);
    } else {
        assert.strictEqual(aggregate.score, null);
        assert.strictEqual(aggregate.availableWeight, 0);
        assert.strictEqual(aggregate.availableFactorCount, 0);
    }

    assertContributionMath(aggregate);
}

function testFullControlledPipeline() {
    const result = runPipeline(makeInputs());

    assertClose("Interest", result.results.interest.score, 0.8);
    assertClose("Preference", result.results.preference.score, 0.9);
    assertClose("Goal", result.results.goal.score, 0.75);
    assertClose("Exploration", result.results.exploration.score, 0.5);
    assertClose("Behavior", result.results.behavior.score, 0.75);
    assertClose("Session", result.results.session.score, 1);
    assertAggregate(result.aggregate, {
        score: 0.7805,
        availableWeight: 1,
        availableFactorCount: 6
    });
    assert.strictEqual(result.aggregate.contributions.length, 6);
}

function testAvailableWeightNormalization() {
    const result = runPipeline(makeInputs({
        interestScore: 0.88,
        includePreference: false,
        parentGoals: [
            {
                goalId: "goal_a",
                priority: 1,
                status: "Active"
            }
        ],
        historyContext: makeHistoryContext({
            recommendations: [],
            interactions: [],
            sources: {
                recommendations: "unavailable",
                interactions: "unavailable"
            }
        }),
        parentPreferredDays: []
    }));

    assert.strictEqual(result.results.interest.available, true);
    assert.strictEqual(result.results.goal.available, true);
    assert.strictEqual(result.results.preference.available, false);
    assert.strictEqual(result.results.exploration.available, false);
    assert.strictEqual(result.results.behavior.available, false);
    assert.strictEqual(result.results.session.available, false);
    assertAggregate(result.aggregate, {
        score: 0.9191836734693878,
        availableWeight: 0.49,
        availableFactorCount: 2
    });
}

function testAvailableZeroIntegration() {
    const result = runPipeline(makeInputs({
        interestScore: 0.88,
        includePreference: false,
        parentGoals: [
            {
                goalId: "goal_a",
                priority: 1,
                status: "Active"
            }
        ],
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
            recommendations: [],
            interactions: [],
            sources: {
                recommendations: "unavailable",
                interactions: "unavailable"
            }
        }),
        parentPreferredDays: []
    }));

    assert.strictEqual(result.results.goal.available, true);
    assert.strictEqual(result.results.goal.score, 0);
    assertAggregate(result.aggregate, {
        score: 0.5926530612244898,
        availableWeight: 0.49,
        availableFactorCount: 2
    });
    assert.notStrictEqual(result.aggregate.score, 0.88);
}

function testSingleAvailableFactor() {
    const result = runPipeline(makeInputs({
        includeInterest: false,
        includePreference: false,
        parentGoals: [
            {
                goalId: "goal_a",
                priority: 1,
                status: "Active"
            }
        ],
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
            }
        ],
        activityOutcomeIds: ["A"],
        historyContext: makeHistoryContext({
            recommendations: [],
            interactions: [],
            sources: {
                recommendations: "unavailable",
                interactions: "unavailable"
            }
        }),
        parentPreferredDays: []
    }));

    assertAggregate(result.aggregate, {
        score: 0.5,
        availableWeight: 0.16,
        availableFactorCount: 1
    });
    assert.deepStrictEqual(
        result.aggregate.contributions.map((item) => item.factor),
        [SCORING_FACTORS.GOAL]
    );
    assertClose("Goal normalized", result.aggregate.contributions[0].normalizedWeight, 1);
}

function testSingleAvailableZero() {
    const result = runPipeline(makeInputs({
        includeInterest: false,
        includePreference: false,
        parentGoals: [],
        historyContext: makeHistoryContext({
            recommendations: [],
            interactions: [
                interaction({
                    interactionType: "Dismiss",
                    ratingValue: null
                })
            ],
            sources: {
                recommendations: "unavailable"
            }
        }),
        parentPreferredDays: []
    }));

    assert.strictEqual(result.results.behavior.available, true);
    assert.strictEqual(result.results.behavior.score, 0);
    assertAggregate(result.aggregate, {
        score: 0,
        availableWeight: 0.13,
        availableFactorCount: 1
    });
}

function testAllSixUnavailable() {
    const result = runPipeline(makeInputs({
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
        }),
        parentPreferredDays: []
    }));

    for (const factor of FACTORS) {
        assert.strictEqual(result.results[factor].available, false);
        assert.strictEqual(result.results[factor].score, null);
    }

    assertAggregate(result.aggregate, {
        available: false
    });
    assert(result.candidate);
}

function testOrderIndependence() {
    const baseline = runPipeline(makeInputs());
    const orders = permutations(FACTORS);

    assert.strictEqual(orders.length, 720);

    for (const order of orders) {
        const result = runPipeline(makeInputs(), order);

        for (const factor of FACTORS) {
            assert.deepStrictEqual(result.results[factor], baseline.results[factor]);
        }

        assert.deepStrictEqual(result.aggregate, baseline.aggregate);
        assert.deepStrictEqual(
            result.aggregate.contributions.map((item) => item.factor),
            FACTORS
        );
    }
}

function testFactorAvailabilityIsolation() {
    const baseline = runPipeline(makeInputs());
    const cases = [
        {
            factor: SCORING_FACTORS.INTEREST,
            inputs: makeInputs({ includeInterest: false })
        },
        {
            factor: SCORING_FACTORS.EXPLORATION,
            inputs: makeInputs({
                historyContext: makeHistoryContext({
                    sources: {
                        bookings: "unavailable"
                    }
                })
            })
        },
        {
            factor: SCORING_FACTORS.BEHAVIOR,
            inputs: makeInputs({
                historyContext: makeHistoryContext({
                    sources: {
                        interactions: "unavailable"
                    }
                })
            })
        },
        {
            factor: SCORING_FACTORS.SESSION,
            inputs: makeInputs({ parentPreferredDays: [] })
        }
    ];

    for (const item of cases) {
        const result = runPipeline(item.inputs);

        assert.strictEqual(result.results[item.factor].available, false);
        assertClose(
            `${item.factor} availableWeight`,
            result.aggregate.availableWeight,
            baseline.aggregate.availableWeight - SCORING_WEIGHTS[item.factor]
        );
        assert.strictEqual(
            result.aggregate.availableFactorCount,
            baseline.aggregate.availableFactorCount - 1
        );

        for (const factor of FACTORS) {
            if (factor !== item.factor) {
                assert.deepStrictEqual(result.results[factor], baseline.results[factor]);
            }
        }
    }
}

function testFactorScoreIsolation() {
    const baseline = runPipeline(makeInputs());
    const cases = [
        {
            factor: SCORING_FACTORS.INTEREST,
            inputs: makeInputs({ interestScore: 0.4 })
        },
        {
            factor: SCORING_FACTORS.GOAL,
            inputs: makeInputs({
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
            })
        },
        {
            factor: SCORING_FACTORS.BEHAVIOR,
            inputs: makeInputs({
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
            })
        },
        {
            factor: SCORING_FACTORS.SESSION,
            inputs: makeInputs({
                eligibleSessions: [
                    session({
                        startDateTime: new Date("2026-09-08T10:00:00.000Z")
                    })
                ]
            })
        }
    ];

    for (const item of cases) {
        const result = runPipeline(item.inputs);

        assert.notStrictEqual(
            result.results[item.factor].score,
            baseline.results[item.factor].score
        );
        assertClose(
            `${item.factor} availableWeight`,
            result.aggregate.availableWeight,
            baseline.aggregate.availableWeight
        );
        assert.strictEqual(
            result.aggregate.availableFactorCount,
            baseline.aggregate.availableFactorCount
        );

        for (const factor of FACTORS) {
            if (factor !== item.factor) {
                assert.deepStrictEqual(result.results[factor], baseline.results[factor]);
            }
        }
    }
}

function testZeroToNonzero() {
    const zero = runPipeline(makeInputs({
        historyContext: makeHistoryContext({
            interactions: [
                interaction({
                    interactionType: "Dismiss",
                    ratingValue: null
                })
            ]
        })
    }));
    const nonzero = runPipeline(makeInputs({
        historyContext: makeHistoryContext({
            interactions: [
                interaction({
                    interactionType: "Save",
                    ratingValue: null
                })
            ]
        })
    }));

    assert.strictEqual(zero.results.behavior.available, true);
    assert.strictEqual(zero.results.behavior.score, 0);
    assert.strictEqual(nonzero.results.behavior.available, true);
    assert.strictEqual(nonzero.results.behavior.score, 1);
    assertClose("availableWeight", nonzero.aggregate.availableWeight, zero.aggregate.availableWeight);
    assert.strictEqual(
        nonzero.aggregate.availableFactorCount,
        zero.aggregate.availableFactorCount
    );
    assert.notStrictEqual(nonzero.aggregate.score, zero.aggregate.score);
}

function testUnavailableVsAvailableZero() {
    const goalUnavailable = runPipeline(makeInputs({
        interestScore: 0.88,
        includePreference: false,
        parentGoals: [],
        historyContext: makeHistoryContext({
            recommendations: [],
            interactions: [],
            sources: {
                recommendations: "unavailable",
                interactions: "unavailable"
            }
        }),
        parentPreferredDays: []
    }));
    const goalZero = runPipeline(makeInputs({
        interestScore: 0.88,
        includePreference: false,
        parentGoals: [
            {
                goalId: "goal_a",
                priority: 1,
                status: "Active"
            }
        ],
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
            recommendations: [],
            interactions: [],
            sources: {
                recommendations: "unavailable",
                interactions: "unavailable"
            }
        }),
        parentPreferredDays: []
    }));

    assert.strictEqual(goalUnavailable.results.goal.available, false);
    assert.strictEqual(goalZero.results.goal.available, true);
    assert.strictEqual(goalZero.results.goal.score, 0);
    assertClose("unavailable availableWeight", goalUnavailable.aggregate.availableWeight, 0.33);
    assertClose("zero availableWeight", goalZero.aggregate.availableWeight, 0.49);
    assert.notStrictEqual(goalUnavailable.aggregate.score, goalZero.aggregate.score);
}

function testNoCoveragePenalty() {
    const goalOnly = runPipeline(makeInputs({
        includeInterest: false,
        includePreference: false,
        parentGoals: [
            {
                goalId: "goal_a",
                priority: 1,
                status: "Active"
            }
        ],
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
            }
        ],
        activityOutcomeIds: ["A"],
        historyContext: makeHistoryContext({
            recommendations: [],
            interactions: [],
            sources: {
                recommendations: "unavailable",
                interactions: "unavailable"
            }
        }),
        parentPreferredDays: []
    }));

    assertClose("No coverage penalty", goalOnly.aggregate.score, 0.5);
    assertClose("Coverage metadata", goalOnly.aggregate.availableWeight, 0.16);
}

function makeManualState(scores) {
    const base = createCandidateScoringState({
        candidate: {
            activity: {
                activityId: "activity_1"
            }
        },
        eligibility: {
            eligible: true,
            failedConstraints: []
        },
        eligibleSessions: [],
        sessionEvaluations: [],
        missingInformation: []
    });

    for (const factor of FACTORS) {
        const score = scores[factor];
        base.factors[factor] = {
            factor,
            available: score !== null,
            score,
            evidence: []
        };
    }

    return base;
}

function testAllOnesAndAllZerosProperties() {
    for (const subset of [
        [SCORING_FACTORS.GOAL],
        [SCORING_FACTORS.INTEREST, SCORING_FACTORS.GOAL],
        [SCORING_FACTORS.PREFERENCE, SCORING_FACTORS.SESSION],
        FACTORS
    ]) {
        const ones = {};
        const zeros = {};

        for (const factor of FACTORS) {
            ones[factor] = subset.includes(factor) ? 1 : null;
            zeros[factor] = subset.includes(factor) ? 0 : null;
        }

        assertAggregate(calculateFinalScore(makeManualState(ones)), {
            score: 1,
            availableWeight: subset.reduce(
                (total, factor) => total + SCORING_WEIGHTS[factor],
                0
            ),
            availableFactorCount: subset.length
        });
        assertAggregate(calculateFinalScore(makeManualState(zeros)), {
            score: 0,
            availableWeight: subset.reduce(
                (total, factor) => total + SCORING_WEIGHTS[factor],
                0
            ),
            availableFactorCount: subset.length
        });
    }
}

function testNoRankingLeakage() {
    const result = runPipeline(makeInputs());

    for (const object of [
        result.originalState,
        result.completedState,
        result.aggregate,
        result.candidate
    ]) {
        for (const field of [
            "rank",
            "position",
            "sortOrder",
            "tieBreaker"
        ]) {
            assert(!Object.prototype.hasOwnProperty.call(object, field));
        }
    }
}

function main() {
    testFullControlledPipeline();
    testAvailableWeightNormalization();
    testAvailableZeroIntegration();
    testSingleAvailableFactor();
    testSingleAvailableZero();
    testAllSixUnavailable();
    testOrderIndependence();
    testFactorAvailabilityIsolation();
    testFactorScoreIsolation();
    testZeroToNonzero();
    testUnavailableVsAvailableZero();
    testNoCoveragePenalty();
    testAllOnesAndAllZerosProperties();
    testNoRankingLeakage();

    console.log("Full scoring integration tests: PASSED");
}

main();
