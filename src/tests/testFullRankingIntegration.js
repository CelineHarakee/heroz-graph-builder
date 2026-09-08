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
const {
    calculateFinalScore
} = require("../recommendation/finalScoreService");
const { rankCandidates } = require("../recommendation/rankingService");

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

function makePreferences(value = "Indoor") {
    return {
        environment: preference(value, 0.8),
        socialStyle: preference(null),
        difficulty: preference(null),
        experienceStyle: preference(null),
        commitmentPreference: preference(null)
    };
}

function session(activityId, weekdayDate = "2026-09-07T10:00:00.000Z") {
    return {
        _id: `${activityId}_session`,
        activityId,
        schedule: {
            startDateTime: new Date(weekdayDate),
            timezone: "UTC",
            bookingDeadline: new Date("2026-09-01T00:00:00.000Z")
        },
        capacity: {
            totalCapacity: 10,
            bookedCapacity: 2,
            remainingCapacity: 8
        },
        availability: {
            status: "Available",
            registrationOpen: true
        }
    };
}

function recommendation(activityId, wasDisplayed = true) {
    return {
        _id: `${activityId}_recommendation`,
        childId: "child_1",
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

function interaction(activityId, {
    interactionType = "Rate",
    ratingValue = 4,
    timestamp = new Date("2026-09-02T00:00:00.000Z")
} = {}) {
    return {
        _id: `${activityId}_${interactionType}`,
        actor: {
            childId: "child_1",
            actorType: "Child"
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
            recommendationId: `${activityId}_recommendation`,
            sessionId: `${activityId}_session`
        },
        timestamp
    };
}

function makeCandidate({
    activityId,
    title = activityId,
    subcategoryId = "subcategory_robotics",
    environment = "Indoor",
    outcomes = ["A", "B"],
    eligibleSessions
}) {
    return {
        activity: {
            activityId,
            title
        },
        evidence: {
            interests: [],
            goals: [],
            summary: []
        },
        currentActivity: {
            _id: activityId,
            classification: {
                categoryId: "category_stem",
                subcategoryId
            },
            experience: {
                environment,
                socialStyle: null,
                difficulty: null,
                experienceStyles: [],
                commitmentType: null,
                intensityLevel: "Low",
                durationMinutes: 90
            },
            learningOutcomes: outcomes.map((outcomeId) => ({
                outcomeId,
                evidenceGuidance: []
            }))
        },
        currentSessions: eligibleSessions ?? [
            session(activityId)
        ]
    };
}

function makeInputs({
    activityId,
    title,
    interestScore = 0.8,
    includeInterest = true,
    includePreference = true,
    preferenceValue = "Indoor",
    parentGoals,
    goals,
    outcomes,
    recommendations,
    interactions,
    sources,
    preferredDays = ["Monday"],
    eligibleSessions,
    candidateOverrides = {}
}) {
    const candidateSessions = eligibleSessions ?? [
        session(activityId)
    ];
    const candidate = {
        ...makeCandidate({
            activityId,
            title,
            outcomes,
            eligibleSessions: candidateSessions
        }),
        ...candidateOverrides
    };
    const context = {
        child: {
            _id: "child_1",
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
            preferences: includePreference
                ? makePreferences(preferenceValue)
                : makePreferences(null)
        },
        parent: {
            _id: "parent_1",
            recommendationPreferences: {
                preferredDays
            }
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
        historyContext: {
            bookings: [],
            recommendations: recommendations ?? [
                recommendation(activityId)
            ],
            interactions: interactions ?? [
                interaction(activityId)
            ],
            sources: {
                bookings: "available",
                recommendations: "available",
                interactions: "available",
                ...(sources ?? {})
            }
        }
    };
    const eligibilityEvaluation = {
        candidate,
        eligibility: {
            eligible: true,
            failedConstraints: []
        },
        eligibleSessions: candidateSessions,
        sessionEvaluations: [],
        missingInformation: []
    };

    return {
        context,
        candidate,
        eligibilityEvaluation
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

function scoreRecord(inputs) {
    const { context, candidate, eligibilityEvaluation } = inputs;
    const contextSnapshot = snapshot(context);
    const candidateSnapshot = snapshot(candidate);
    const currentActivitySnapshot = snapshot(candidate.currentActivity);
    const currentSessionsSnapshot = snapshot(candidate.currentSessions);
    const evidenceSnapshot = snapshot(candidate.evidence);
    const eligibilitySnapshot = snapshot(eligibilityEvaluation);
    const state = createCandidateScoringState(eligibilityEvaluation);
    const results = {
        interest: calculateInterestFactor(context, eligibilityEvaluation),
        preference: calculatePreferenceFactor(context, eligibilityEvaluation),
        goal: calculateGoalFactor(context, eligibilityEvaluation),
        exploration: calculateExplorationFactor(context, eligibilityEvaluation),
        behavior: calculateBehaviorFactor(context, eligibilityEvaluation),
        session: calculateSessionFactor(eligibilityEvaluation, context)
    };
    const completedState = composeFactors(state, results);
    const completedSnapshot = snapshot(completedState);
    const aggregate = calculateFinalScore(completedState);

    assert.deepStrictEqual(snapshot(context), contextSnapshot);
    assert.deepStrictEqual(snapshot(context.child), contextSnapshot.child);
    assert.deepStrictEqual(snapshot(candidate), candidateSnapshot);
    assert.deepStrictEqual(snapshot(candidate.currentActivity), currentActivitySnapshot);
    assert.deepStrictEqual(snapshot(candidate.currentSessions), currentSessionsSnapshot);
    assert.deepStrictEqual(snapshot(candidate.evidence), evidenceSnapshot);
    assert.deepStrictEqual(snapshot(eligibilityEvaluation), eligibilitySnapshot);
    assert.deepStrictEqual(snapshot(completedState), completedSnapshot);

    return {
        candidate,
        eligibilityEvaluation,
        scoringState: completedState,
        finalScore: aggregate
    };
}

function activityIds(records) {
    return records.map((record) => record.candidate.currentActivity._id);
}

function titles(records) {
    return records.map((record) => record.candidate.activity.title);
}

function assertRanks(records) {
    assert.deepStrictEqual(
        records.map((record) => record.rank),
        records.map((_, index) => index + 1)
    );
}

function rankAndAssert(records) {
    const inputSnapshot = snapshot(records);
    const orderSnapshot = activityIds(records);
    const finalSnapshots = records.map((record) => snapshot(record.finalScore));
    const factorSnapshots = records.map((record) => snapshot(record.scoringState.factors));
    const ranking = rankCandidates(records);

    assert.deepStrictEqual(snapshot(records), inputSnapshot);
    assert.deepStrictEqual(activityIds(records), orderSnapshot);

    for (const record of [...ranking.ranked, ...ranking.unranked]) {
        const originalIndex = records.findIndex(
            (item) => item.candidate.currentActivity._id ===
                record.candidate.currentActivity._id
        );

        assert.notStrictEqual(record, records[originalIndex]);
        assert.deepStrictEqual(snapshot(record.finalScore), finalSnapshots[originalIndex]);
        assert.deepStrictEqual(
            snapshot(record.scoringState.factors),
            factorSnapshots[originalIndex]
        );
        assert(!Object.prototype.hasOwnProperty.call(
            records[originalIndex],
            "rank"
        ));
        assert(!Object.prototype.hasOwnProperty.call(
            record.scoringState,
            "rank"
        ));
        assert(!Object.prototype.hasOwnProperty.call(
            record.scoringState,
            "sortOrder"
        ));
    }

    return ranking;
}

function availableRecord(activityId, scoreConfig = {}) {
    return scoreRecord(makeInputs({
        activityId,
        title: activityId,
        ...scoreConfig
    }));
}

function unavailableRecord(activityId) {
    return scoreRecord(makeInputs({
        activityId,
        title: activityId,
        includeInterest: false,
        includePreference: false,
        parentGoals: [],
        recommendations: [],
        interactions: [],
        sources: {
            recommendations: "unavailable",
            interactions: "unavailable"
        },
        preferredDays: [],
        eligibleSessions: []
    }));
}

function zeroRecord(activityId) {
    return scoreRecord(makeInputs({
        activityId,
        title: activityId,
        includeInterest: false,
        includePreference: false,
        parentGoals: [],
        recommendations: [],
        sources: {
            recommendations: "unavailable"
        },
        interactions: [
            interaction(activityId, {
                interactionType: "Dismiss",
                ratingValue: null
            })
        ],
        preferredDays: [],
        eligibleSessions: []
    }));
}

function goalOnlyRecord(activityId, score) {
    return scoreRecord(makeInputs({
        activityId,
        title: activityId,
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
                relatedOutcomes: score === 1
                    ? [{ outcomeId: "A" }]
                    : [{ outcomeId: "A" }, { outcomeId: "Z" }]
            }
        ],
        outcomes: ["A"],
        recommendations: [],
        interactions: [],
        sources: {
            recommendations: "unavailable",
            interactions: "unavailable"
        },
        preferredDays: [],
        eligibleSessions: []
    }));
}

function interestOnlyRecord(activityId, score) {
    return scoreRecord(makeInputs({
        activityId,
        title: activityId,
        interestScore: score,
        includePreference: false,
        parentGoals: [],
        recommendations: [],
        interactions: [],
        sources: {
            recommendations: "unavailable",
            interactions: "unavailable"
        },
        preferredDays: [],
        eligibleSessions: []
    }));
}

function testBasicEndToEndOrder() {
    const records = [
        availableRecord("activity_low", { interestScore: 0.2 }),
        availableRecord("activity_high", { interestScore: 1 }),
        availableRecord("activity_middle", { interestScore: 0.6 })
    ];
    const ranking = rankAndAssert(records);

    assert.deepStrictEqual(titles(ranking.ranked), [
        "activity_high",
        "activity_middle",
        "activity_low"
    ]);
    assertRanks(ranking.ranked);
}

function testAvailableZeroAndUnavailable() {
    const records = [
        interestOnlyRecord("activity_a", 0.8),
        unavailableRecord("activity_b"),
        zeroRecord("activity_c")
    ];
    const ranking = rankAndAssert(records);

    assert.deepStrictEqual(titles(ranking.ranked), [
        "activity_a",
        "activity_c"
    ]);
    assert.strictEqual(ranking.ranked[1].finalScore.score, 0);
    assert.strictEqual(ranking.ranked[1].rank, 2);
    assert.deepStrictEqual(titles(ranking.unranked), ["activity_b"]);
    assert.strictEqual(ranking.unranked[0].rank, null);
    assert.strictEqual(ranking.unranked[0].finalScore.score, null);
}

function testAllUnavailable() {
    const ranking = rankAndAssert([
        unavailableRecord("activity_a"),
        unavailableRecord("activity_b")
    ]);

    assert.deepStrictEqual(ranking.ranked, []);
    assert.deepStrictEqual(titles(ranking.unranked), [
        "activity_a",
        "activity_b"
    ]);
    assert(ranking.unranked.every((record) => record.rank === null));
}

function testExactTieActivityIdFallback() {
    const records = [
        interestOnlyRecord("activity_b", 0.5),
        interestOnlyRecord("activity_a", 0.5)
    ];
    const ranking = rankAndAssert(records);

    assert.deepStrictEqual(titles(ranking.ranked), [
        "activity_a",
        "activity_b"
    ]);
    assertRanks(ranking.ranked);
}

function testDifferentFactorMixTieAndCoverageIndependence() {
    const records = [
        goalOnlyRecord("activity_b", 0.5),
        interestOnlyRecord("activity_a", 0.5)
    ];
    const ranking = rankAndAssert(records);

    assert.strictEqual(records[0].finalScore.score, records[1].finalScore.score);
    assert.notStrictEqual(
        records[0].finalScore.availableWeight,
        records[1].finalScore.availableWeight
    );
    assert.deepStrictEqual(titles(ranking.ranked), [
        "activity_a",
        "activity_b"
    ]);
}

function testTieInputOrderReversal() {
    const a = interestOnlyRecord("activity_a", 0.5);
    const b = interestOnlyRecord("activity_b", 0.5);

    assert.deepStrictEqual(
        titles(rankAndAssert([a, b]).ranked),
        titles(rankAndAssert([b, a]).ranked)
    );
}

function testNearButUnequalAndNoRounding() {
    const records = [
        interestOnlyRecord("activity_a", 0.9),
        interestOnlyRecord("activity_b", 0.9000000000000001)
    ];
    const ranking = rankAndAssert(records);

    assert.deepStrictEqual(titles(ranking.ranked), [
        "activity_b",
        "activity_a"
    ]);
}

function testScoreChangePropagatesToRank() {
    const low = interestOnlyRecord("activity_a", 0.3);
    const high = interestOnlyRecord("activity_b", 0.8);
    const before = rankAndAssert([low, high]);
    const changed = interestOnlyRecord("activity_a", 1);
    const after = rankAndAssert([changed, high]);

    assert.deepStrictEqual(titles(before.ranked), [
        "activity_b",
        "activity_a"
    ]);
    assert.deepStrictEqual(titles(after.ranked), [
        "activity_a",
        "activity_b"
    ]);
    assert.deepStrictEqual(snapshot(high), snapshot(high));
}

function testAvailableUnavailablePropagation() {
    const available = interestOnlyRecord("activity_a", 0.8);
    const unavailable = unavailableRecord("activity_a");
    const other = interestOnlyRecord("activity_b", 0.5);
    const before = rankAndAssert([available, other]);
    const after = rankAndAssert([unavailable, other]);

    assert.deepStrictEqual(titles(before.ranked), [
        "activity_a",
        "activity_b"
    ]);
    assert.deepStrictEqual(titles(after.ranked), ["activity_b"]);
    assert.deepStrictEqual(titles(after.unranked), ["activity_a"]);
}

function testNoTopNAndNoDiversity() {
    const records = Array.from({ length: 7 }, (_, index) =>
        interestOnlyRecord(`activity_${index}`, index / 10)
    );
    const ranking = rankAndAssert(records);

    assert.strictEqual(ranking.ranked.length, 7);
    assertRanks(ranking.ranked);
    assert.deepStrictEqual(titles(ranking.ranked), [
        "activity_6",
        "activity_5",
        "activity_4",
        "activity_3",
        "activity_2",
        "activity_1",
        "activity_0"
    ]);
}

function testDeterminism() {
    const records = [
        interestOnlyRecord("activity_c", 0.6),
        interestOnlyRecord("activity_a", 0.6),
        zeroRecord("activity_b"),
        unavailableRecord("activity_d")
    ];
    const first = rankAndAssert(records);

    for (let index = 0; index < 10; index += 1) {
        assert.deepStrictEqual(rankAndAssert(records), first);
    }
}

function testEmptyCandidateSet() {
    assert.deepStrictEqual(rankAndAssert([]), {
        ranked: [],
        unranked: []
    });
}

function main() {
    testBasicEndToEndOrder();
    testAvailableZeroAndUnavailable();
    testAllUnavailable();
    testExactTieActivityIdFallback();
    testDifferentFactorMixTieAndCoverageIndependence();
    testTieInputOrderReversal();
    testNearButUnequalAndNoRounding();
    testScoreChangePropagatesToRank();
    testAvailableUnavailablePropagation();
    testNoTopNAndNoDiversity();
    testDeterminism();
    testEmptyCandidateSet();

    console.log("Full ranking integration tests: PASSED");
}

main();
