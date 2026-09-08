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
const { selectTopN } = require("../recommendation/selectionService");

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

function session(activityId, startDateTime = "2026-09-07T10:00:00.000Z") {
    return {
        _id: `${activityId}_session`,
        activityId,
        schedule: {
            startDateTime: new Date(startDateTime),
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

function recommendation(activityId) {
    return {
        _id: `${activityId}_recommendation`,
        childId: "child_1",
        recommendedItems: [
            {
                activityId
            }
        ],
        response: {
            wasDisplayed: true,
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
                subcategoryId: "subcategory_robotics"
            },
            experience: {
                environment: "Indoor",
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
    parentGoals,
    goals,
    outcomes,
    recommendations,
    interactions,
    sources,
    preferredDays = ["Monday"],
    eligibleSessions
}) {
    const sessions = eligibleSessions ?? [
        session(activityId)
    ];
    const candidate = makeCandidate({
        activityId,
        title,
        outcomes,
        eligibleSessions: sessions
    });
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
            preferences: {
                environment: includePreference
                    ? preference("Indoor")
                    : preference(null),
                socialStyle: preference(null),
                difficulty: preference(null),
                experienceStyle: preference(null),
                commitmentPreference: preference(null)
            }
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

function calculateRecord(inputs) {
    const {
        context,
        candidate,
        eligibilityEvaluation
    } = inputs;
    const snapshots = {
        context: snapshot(context),
        child: snapshot(context.child),
        parent: snapshot(context.parent),
        candidates: snapshot(context.candidates),
        interestContext: snapshot(context.interestContext),
        goalContext: snapshot(context.goalContext),
        historyContext: snapshot(context.historyContext),
        candidate: snapshot(candidate),
        currentActivity: snapshot(candidate.currentActivity),
        currentSessions: snapshot(candidate.currentSessions),
        evidence: snapshot(candidate.evidence),
        eligibility: snapshot(eligibilityEvaluation)
    };
    const originalState = createCandidateScoringState(eligibilityEvaluation);
    const results = {
        interest: calculateInterestFactor(context, eligibilityEvaluation),
        preference: calculatePreferenceFactor(context, eligibilityEvaluation),
        goal: calculateGoalFactor(context, eligibilityEvaluation),
        exploration: calculateExplorationFactor(context, eligibilityEvaluation),
        behavior: calculateBehaviorFactor(context, eligibilityEvaluation),
        session: calculateSessionFactor(eligibilityEvaluation, context)
    };
    const scoringState = composeFactors(originalState, results);
    const scoringSnapshot = snapshot(scoringState);
    const finalScore = calculateFinalScore(scoringState);

    assert.deepStrictEqual(snapshot(context), snapshots.context);
    assert.deepStrictEqual(snapshot(context.child), snapshots.child);
    assert.deepStrictEqual(snapshot(context.parent), snapshots.parent);
    assert.deepStrictEqual(snapshot(context.candidates), snapshots.candidates);
    assert.deepStrictEqual(snapshot(context.interestContext), snapshots.interestContext);
    assert.deepStrictEqual(snapshot(context.goalContext), snapshots.goalContext);
    assert.deepStrictEqual(snapshot(context.historyContext), snapshots.historyContext);
    assert.deepStrictEqual(snapshot(candidate), snapshots.candidate);
    assert.deepStrictEqual(snapshot(candidate.currentActivity), snapshots.currentActivity);
    assert.deepStrictEqual(snapshot(candidate.currentSessions), snapshots.currentSessions);
    assert.deepStrictEqual(snapshot(candidate.evidence), snapshots.evidence);
    assert.deepStrictEqual(snapshot(eligibilityEvaluation), snapshots.eligibility);
    assert.deepStrictEqual(snapshot(scoringState), scoringSnapshot);

    for (const factor of FACTORS) {
        assert(scoringState.factors[factor], `${factor} result missing`);
    }

    return {
        candidate,
        eligibilityEvaluation,
        scoringState,
        finalScore
    };
}

function availableRecord(activityId, scoreConfig = {}) {
    return calculateRecord(makeInputs({
        activityId,
        title: activityId,
        ...scoreConfig
    }));
}

function interestOnlyRecord(activityId, score) {
    return calculateRecord(makeInputs({
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

function goalOnlyRecord(activityId, score) {
    return calculateRecord(makeInputs({
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

function zeroRecord(activityId) {
    return calculateRecord(makeInputs({
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

function unavailableRecord(activityId) {
    return calculateRecord(makeInputs({
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

function titleOf(record) {
    return record.candidate.activity.title;
}

function titles(records) {
    return records.map(titleOf);
}

function assertRanks(records) {
    assert.deepStrictEqual(
        records.map((record) => record.rank),
        records.map((_, index) => index + 1)
    );
}

function runSelection(records, n) {
    const postScoringSnapshot = snapshot(records);
    const finalSnapshots = records.map((record) => snapshot(record.finalScore));
    const factorSnapshots = records.map((record) => snapshot(record.scoringState.factors));
    const ranking = rankCandidates(records);
    const rankingSnapshot = snapshot(ranking);
    const selection = selectTopN(ranking, n);

    assert.deepStrictEqual(snapshot(records), postScoringSnapshot);
    assert.deepStrictEqual(snapshot(ranking), rankingSnapshot);
    assert.notStrictEqual(selection.selected, ranking.ranked);
    assert.notStrictEqual(selection.unselectedRanked, ranking.ranked);
    assert.notStrictEqual(selection.unranked, ranking.unranked);

    for (const record of [
        ...selection.selected,
        ...selection.unselectedRanked,
        ...selection.unranked
    ]) {
        const originalIndex = records.findIndex(
            (item) => item.candidate.currentActivity._id ===
                record.candidate.currentActivity._id
        );

        assert(originalIndex >= 0, `${titleOf(record)} original missing`);
        assert.deepStrictEqual(snapshot(record.finalScore), finalSnapshots[originalIndex]);
        assert.deepStrictEqual(
            snapshot(record.scoringState.factors),
            factorSnapshots[originalIndex]
        );
    }

    return {
        ranking,
        rankingSnapshot,
        selection
    };
}

function testCompleteControlledPipelineAndPrefix() {
    const records = [
        availableRecord("activity_low", { interestScore: 0.2 }),
        availableRecord("activity_high", { interestScore: 1 }),
        availableRecord("activity_middle", { interestScore: 0.6 }),
        interestOnlyRecord("activity_tie_b", 0.5),
        interestOnlyRecord("activity_tie_a", 0.5),
        zeroRecord("activity_zero"),
        unavailableRecord("activity_unavailable")
    ];
    const { ranking } = runSelection(records, 3);

    assert.strictEqual(ranking.ranked.length, 6);
    assert.strictEqual(ranking.unranked.length, 1);
    assert.deepStrictEqual(titles(ranking.ranked), [
        "activity_high",
        "activity_middle",
        "activity_low",
        "activity_tie_a",
        "activity_tie_b",
        "activity_zero"
    ]);
    assertRanks(ranking.ranked);
    assert.strictEqual(ranking.unranked[0].rank, null);

    for (const n of [1, 3, ranking.ranked.length, 100]) {
        const selection = selectTopN(ranking, n);
        const expectedSelected = ranking.ranked.slice(0, n);
        const expectedUnselected = ranking.ranked.slice(n);

        assert.deepStrictEqual(selection.selected, expectedSelected);
        assert.deepStrictEqual(selection.unselectedRanked, expectedUnselected);
        assert.deepStrictEqual(selection.unranked, ranking.unranked);
        assert.deepStrictEqual(snapshot(ranking), snapshot(ranking));
    }
}

function testChangingNPreservesRankingAndScores() {
    const records = [
        interestOnlyRecord("activity_a", 0.9),
        interestOnlyRecord("activity_b", 0.7),
        interestOnlyRecord("activity_c", 0.3),
        zeroRecord("activity_zero"),
        unavailableRecord("activity_unavailable")
    ];
    const ranking = rankCandidates(records);
    const rankingSnapshot = snapshot(ranking);
    const recordSnapshot = snapshot(records);

    for (const n of [1, 2, 3, 5, 100]) {
        selectTopN(ranking, n);
        assert.deepStrictEqual(snapshot(ranking), rankingSnapshot);
        assert.deepStrictEqual(snapshot(records), recordSnapshot);
    }
}

function testAvailableZeroSelectableAndUnselected() {
    const records = [
        interestOnlyRecord("activity_a", 0.8),
        zeroRecord("activity_zero")
    ];
    const ranking = rankCandidates(records);
    const includeZero = selectTopN(ranking, 2);
    const excludeZero = selectTopN(ranking, 1);

    assert.deepStrictEqual(titles(includeZero.selected), [
        "activity_a",
        "activity_zero"
    ]);
    assert.strictEqual(includeZero.selected[1].finalScore.score, 0);
    assert.strictEqual(includeZero.selected[1].rank, 2);
    assert.deepStrictEqual(titles(excludeZero.unselectedRanked), [
        "activity_zero"
    ]);
    assert.deepStrictEqual(excludeZero.unranked, []);
}

function testUnavailableAndShortfallNoFallback() {
    const records = [
        interestOnlyRecord("activity_a", 0.8),
        interestOnlyRecord("activity_b", 0.4),
        unavailableRecord("activity_c"),
        unavailableRecord("activity_d")
    ];
    const { ranking, selection } = runSelection(records, 5);

    assert.strictEqual(ranking.ranked.length, 2);
    assert.strictEqual(ranking.unranked.length, 2);
    assert.deepStrictEqual(titles(selection.selected), [
        "activity_a",
        "activity_b"
    ]);
    assert.deepStrictEqual(selection.unselectedRanked, []);
    assert.deepStrictEqual(titles(selection.unranked), [
        "activity_c",
        "activity_d"
    ]);
    assert(selection.unranked.every((record) => record.rank === null));
}

function testTieSelectionAndInputOrderIndependence() {
    const a = interestOnlyRecord("activity_a", 0.5);
    const b = interestOnlyRecord("activity_b", 0.5);
    const forward = runSelection([b, a], 1);
    const reverse = runSelection([a, b], 1);

    assert.deepStrictEqual(titles(forward.ranking.ranked), [
        "activity_a",
        "activity_b"
    ]);
    assert.deepStrictEqual(titles(reverse.ranking.ranked), [
        "activity_a",
        "activity_b"
    ]);
    assert.deepStrictEqual(titles(forward.selection.selected), ["activity_a"]);
    assert.deepStrictEqual(titles(forward.selection.unselectedRanked), ["activity_b"]);
    assert.strictEqual(forward.selection.unselectedRanked[0].rank, 2);
}

function testDifferentFactorMixTie() {
    const ranking = rankCandidates([
        goalOnlyRecord("activity_b", 0.5),
        interestOnlyRecord("activity_a", 0.5)
    ]);
    const selection = selectTopN(ranking, 1);

    assert.strictEqual(ranking.ranked[0].finalScore.score, ranking.ranked[1].finalScore.score);
    assert.notStrictEqual(
        ranking.ranked[0].finalScore.availableWeight,
        ranking.ranked[1].finalScore.availableWeight
    );
    assert.deepStrictEqual(titles(selection.selected), ["activity_a"]);
    assert.deepStrictEqual(titles(selection.unselectedRanked), ["activity_b"]);
}

function testNearScoreStrictOrderAndNoRounding() {
    const ranking = rankCandidates([
        interestOnlyRecord("activity_a", 0.9),
        interestOnlyRecord("activity_b", 0.9000000000000001)
    ]);
    const selection = selectTopN(ranking, 1);

    assert.deepStrictEqual(titles(ranking.ranked), [
        "activity_b",
        "activity_a"
    ]);
    assert.deepStrictEqual(titles(selection.selected), ["activity_b"]);
}

function testNoDiversityAndEmptyPipeline() {
    const records = Array.from({ length: 7 }, (_, index) =>
        interestOnlyRecord(`activity_${index}`, index / 10)
    );
    const selection = runSelection(records, 3).selection;

    assert.deepStrictEqual(titles(selection.selected), [
        "activity_6",
        "activity_5",
        "activity_4"
    ]);

    const emptyRanking = rankCandidates([]);
    assert.deepStrictEqual(emptyRanking, {
        ranked: [],
        unranked: []
    });
    assert.deepStrictEqual(selectTopN(emptyRanking, 5), {
        selected: [],
        unselectedRanked: [],
        unranked: []
    });
}

function testDeterminism() {
    const records = [
        interestOnlyRecord("activity_c", 0.6),
        interestOnlyRecord("activity_a", 0.6),
        zeroRecord("activity_b"),
        unavailableRecord("activity_d")
    ];
    const firstRanking = rankCandidates(records);
    const firstSelection = selectTopN(firstRanking, 2);

    for (let index = 0; index < 10; index += 1) {
        const ranking = rankCandidates(records);
        const selection = selectTopN(ranking, 2);

        assert.deepStrictEqual(ranking, firstRanking);
        assert.deepStrictEqual(selection, firstSelection);
    }
}

function main() {
    testCompleteControlledPipelineAndPrefix();
    testChangingNPreservesRankingAndScores();
    testAvailableZeroSelectableAndUnselected();
    testUnavailableAndShortfallNoFallback();
    testTieSelectionAndInputOrderIndependence();
    testDifferentFactorMixTie();
    testNearScoreStrictOrderAndNoRounding();
    testNoDiversityAndEmptyPipeline();
    testDeterminism();

    console.log("Full selection integration tests: PASSED");
}

main();
