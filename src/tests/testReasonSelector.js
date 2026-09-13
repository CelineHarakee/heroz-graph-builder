const assert = require("assert");
const {
    selectExplanationReasons
} = require("../explanation/reasonSelector");

function snapshot(value) {
    return JSON.parse(JSON.stringify(value));
}

function factor(available, score, evidence = []) {
    return {
        available,
        score: available ? score : null,
        evidence
    };
}

function interestEvidence({
    resolved = true,
    supportType = "exact_subcategory_interest"
} = {}) {
    if (supportType === "category_fallback") {
        return [
            {
                type: "category_fallback",
                categoryId: "category_1",
                excludedSubcategoryId: "subcategory_1",
                siblingCount: 2,
                siblingScores: [0.6, 0.8],
                categoryScore: 0.7,
                category: {
                    categoryId: "category_1",
                    name: resolved ? "STEM" : null,
                    resolved
                },
                excludedSubcategory: {
                    subcategoryId: "subcategory_1",
                    name: "Robotics",
                    resolved: true
                }
            }
        ];
    }

    return [
        {
            type: "exact_subcategory_interest",
            subcategoryId: "subcategory_1",
            score: 0.8,
            confidence: 0.9,
            subcategory: {
                subcategoryId: "subcategory_1",
                name: resolved ? "Robotics" : null,
                resolved
            }
        }
    ];
}

function preferenceEvidence({
    baseMatch = 1,
    adjustedScore = baseMatch
} = {}) {
    return [
        {
            dimension: "environment",
            childValue: "Indoor",
            activityValue: "Indoor",
            confidence: 1,
            source: "Onboarding",
            baseMatch,
            adjustedScore
        }
    ];
}

function goalEvidence({
    type = "goal_coverage",
    coverage = 1,
    matched = true,
    goalResolved = true,
    outcomeResolved = true
} = {}) {
    if (type !== "goal_coverage") {
        return [
            {
                type,
                goalId: "goal_1",
                priority: "High",
                status: "Active",
                goal: {
                    goalId: "goal_1",
                    name: goalResolved ? "Improve Problem Solving" : null,
                    resolved: goalResolved
                }
            }
        ];
    }

    return [
        {
            type: "goal_coverage",
            goalId: "goal_1",
            priority: "High",
            status: "Active",
            goalOutcomeIds: ["outcome_1"],
            matchedOutcomeIds: matched ? ["outcome_1"] : [],
            coverage,
            goal: {
                goalId: "goal_1",
                name: goalResolved ? "Improve Problem Solving" : null,
                resolved: goalResolved
            },
            goalOutcomes: [
                {
                    outcomeId: "outcome_1",
                    name: outcomeResolved ? "Problem Solving" : null,
                    resolved: outcomeResolved
                }
            ],
            matchedOutcomes: matched
                ? [
                    {
                        outcomeId: "outcome_1",
                        name: outcomeResolved ? "Problem Solving" : null,
                        resolved: outcomeResolved
                    }
                ]
                : []
        }
    ];
}

function explorationEvidence(noveltyState = "new") {
    return [
        {
            type: "exact_activity_novelty",
            activityId: "activity_1",
            noveltyState,
            matchingBookingCount: noveltyState === "experienced" ? 1 : 0,
            displayedRecommendationCount: noveltyState === "exposed" ? 1 : 0,
            experiencedBookingCount: noveltyState === "experienced" ? 1 : 0
        }
    ];
}

function behaviorEvidence(actorType = "Child", interactionType = "Rate") {
    return [
        {
            type: "exact_activity_behavior",
            activityId: "activity_1",
            behaviorState: interactionType === "Rate" ? "rating" : "explicit_positive",
            selectedInteractionType: interactionType,
            selectedInteractionId: "interaction_1",
            selectedTimestamp: "2026-09-01T00:00:00.000Z",
            actorType,
            score: 0.75,
            matchingInteractionCount: 1,
            explicitInteractionCount: 1,
            passiveInteractionCount: 0,
            ratingValue: interactionType === "Rate" ? 4 : undefined
        }
    ];
}

function sessionEvidence(match = true) {
    return [
        {
            type: "preferred_day_match",
            preferredDays: ["Monday"],
            eligibleSessionCount: 1,
            checkedSessions: [
                {
                    sessionId: "session_1",
                    weekday: "Monday"
                }
            ],
            matchingSessionIds: match ? ["session_1"] : [],
            matchingWeekdays: match ? ["Monday"] : [],
            score: match ? 1 : 0
        }
    ];
}

function makeEvidence(overrides = {}) {
    const base = {
        activity: {
            activityId: "activity_1",
            nameAr: "نشاط",
            nameEn: "Activity",
            resolved: true
        },
        factors: {
            interest: factor(true, 0.8, interestEvidence()),
            preference: factor(true, 1, preferenceEvidence()),
            goal: factor(true, 1, goalEvidence()),
            exploration: factor(true, 1, explorationEvidence()),
            behavior: factor(true, 0.75, behaviorEvidence()),
            session: factor(true, 1, sessionEvidence())
        },
        eligibleSessionIds: ["session_1"],
        practicalEligibility: {
            hasEligibleSession: true
        }
    };

    return {
        ...base,
        ...overrides,
        factors: {
            ...base.factors,
            ...(overrides.factors ?? {})
        }
    };
}

function types(reasons) {
    return reasons.map((reason) => reason.type);
}

function testAllSixPositiveSelectFirstThree() {
    const reasons = selectExplanationReasons(makeEvidence());

    assert.deepStrictEqual(types(reasons), ["interest", "preference", "goal"]);
    assert.strictEqual(reasons.length, 3);
}

function testInterestUnavailableSelectsNextCanonical() {
    const reasons = selectExplanationReasons(makeEvidence({
        factors: {
            interest: factor(false, null, [])
        }
    }));

    assert.deepStrictEqual(types(reasons), ["preference", "goal", "exploration"]);
}

function testInterestKnownZeroSkipped() {
    const reasons = selectExplanationReasons(makeEvidence({
        factors: {
            interest: factor(true, 0, interestEvidence())
        }
    }));

    assert.deepStrictEqual(types(reasons), ["preference", "goal", "exploration"]);
}

function testOnlyOnePositiveSupportedFactor() {
    const reasons = selectExplanationReasons(makeEvidence({
        factors: {
            interest: factor(false, null, []),
            preference: factor(false, null, []),
            goal: factor(false, null, []),
            exploration: factor(false, null, []),
            session: factor(false, null, [])
        }
    }));

    assert.deepStrictEqual(types(reasons), ["behavior"]);
}

function testInsufficientEvidenceSkipped() {
    const reasons = selectExplanationReasons(makeEvidence({
        factors: {
            interest: factor(true, 0.8, interestEvidence({ resolved: false })),
            preference: factor(true, 0.9, preferenceEvidence({
                baseMatch: 0,
                adjustedScore: 0
            })),
            goal: factor(true, 0.9, goalEvidence({ matched: false })),
            exploration: factor(true, 0.5, explorationEvidence("experienced")),
            behavior: factor(true, 0.5, [{ type: "exact_activity_behavior" }]),
            session: factor(true, 1, sessionEvidence(false))
        }
    }));

    assert.deepStrictEqual(reasons, []);
}

function testPreferencePositiveSupportSemantics() {
    const exact = selectExplanationReasons(makeEvidence({
        factors: {
            interest: factor(false, null, []),
            preference: factor(true, 1, preferenceEvidence({
                baseMatch: 1,
                adjustedScore: 1
            })),
            goal: factor(false, null, []),
            exploration: factor(false, null, []),
            behavior: factor(false, null, []),
            session: factor(false, null, [])
        }
    }));
    const partialBelowHalf = selectExplanationReasons(makeEvidence({
        factors: {
            interest: factor(false, null, []),
            preference: factor(true, 0.45, preferenceEvidence({
                baseMatch: 0,
                adjustedScore: 0.45
            })),
            goal: factor(false, null, []),
            exploration: factor(false, null, []),
            behavior: factor(false, null, []),
            session: factor(false, null, [])
        }
    }));
    const zeroSupport = selectExplanationReasons(makeEvidence({
        factors: {
            interest: factor(false, null, []),
            preference: factor(true, 0.1, preferenceEvidence({
                baseMatch: 0,
                adjustedScore: 0
            })),
            goal: factor(false, null, []),
            exploration: factor(false, null, []),
            behavior: factor(false, null, []),
            session: factor(false, null, [])
        }
    }));
    const unavailable = selectExplanationReasons(makeEvidence({
        factors: {
            interest: factor(false, null, []),
            preference: factor(false, null, preferenceEvidence({
                baseMatch: 1,
                adjustedScore: 1
            })),
            goal: factor(false, null, []),
            exploration: factor(false, null, []),
            behavior: factor(false, null, []),
            session: factor(false, null, [])
        }
    }));
    const factorZero = selectExplanationReasons(makeEvidence({
        factors: {
            interest: factor(false, null, []),
            preference: factor(true, 0, preferenceEvidence({
                baseMatch: 1,
                adjustedScore: 1
            })),
            goal: factor(false, null, []),
            exploration: factor(false, null, []),
            behavior: factor(false, null, []),
            session: factor(false, null, [])
        }
    }));
    const noEvidence = selectExplanationReasons(makeEvidence({
        factors: {
            interest: factor(false, null, []),
            preference: factor(true, 1, []),
            goal: factor(false, null, []),
            exploration: factor(false, null, []),
            behavior: factor(false, null, []),
            session: factor(false, null, [])
        }
    }));

    assert.deepStrictEqual(types(exact), ["preference"]);
    assert.deepStrictEqual(types(partialBelowHalf), ["preference"]);
    assert.strictEqual(partialBelowHalf[0].sourceEvidence.baseMatch, 0);
    assert.strictEqual(partialBelowHalf[0].sourceEvidence.adjustedScore, 0.45);
    assert.deepStrictEqual(zeroSupport, []);
    assert.deepStrictEqual(unavailable, []);
    assert.deepStrictEqual(factorZero, []);
    assert.deepStrictEqual(noEvidence, []);
}

function testInterestSupportTypes() {
    const exact = selectExplanationReasons(makeEvidence({
        factors: {
            preference: factor(false, null, []),
            goal: factor(false, null, []),
            exploration: factor(false, null, []),
            behavior: factor(false, null, []),
            session: factor(false, null, [])
        }
    }));
    const category = selectExplanationReasons(makeEvidence({
        factors: {
            interest: factor(true, 0.7, interestEvidence({
                supportType: "category_fallback"
            })),
            preference: factor(false, null, []),
            goal: factor(false, null, []),
            exploration: factor(false, null, []),
            behavior: factor(false, null, []),
            session: factor(false, null, [])
        }
    }));

    assert.strictEqual(exact[0].supportType, "exact_subcategory_interest");
    assert.strictEqual(exact[0].subcategory.name, "Robotics");
    assert.strictEqual(category[0].supportType, "category_fallback");
    assert.strictEqual(category[0].category.name, "STEM");
}

function testGoalSelectableWithResolvedOutcomeAndUnresolvedGoalSafe() {
    const reasons = selectExplanationReasons(makeEvidence({
        factors: {
            interest: factor(false, null, []),
            preference: factor(false, null, []),
            goal: factor(true, 1, goalEvidence({
                goalResolved: false,
                outcomeResolved: true
            })),
            exploration: factor(false, null, []),
            behavior: factor(false, null, []),
            session: factor(false, null, [])
        }
    }));

    assert.deepStrictEqual(types(reasons), ["goal"]);
    assert.strictEqual(reasons[0].goal.name, null);
    assert.strictEqual(reasons[0].goal.resolved, false);
    assert.strictEqual(reasons[0].matchedOutcomes[0].name, "Problem Solving");
}

function testMissingGoalDocumentOnlySkipped() {
    const reasons = selectExplanationReasons(makeEvidence({
        factors: {
            interest: factor(false, null, []),
            preference: factor(false, null, []),
            goal: factor(true, 1, goalEvidence({ type: "missing_goal_document" })),
            exploration: factor(false, null, []),
            behavior: factor(false, null, []),
            session: factor(false, null, [])
        }
    }));

    assert.deepStrictEqual(reasons, []);
}

function testExplorationStates() {
    const make = (noveltyState, score) => selectExplanationReasons(makeEvidence({
        factors: {
            interest: factor(false, null, []),
            preference: factor(false, null, []),
            goal: factor(false, null, []),
            exploration: factor(true, score, explorationEvidence(noveltyState)),
            behavior: factor(false, null, []),
            session: factor(false, null, [])
        }
    }));

    assert.deepStrictEqual(types(make("new", 1)), ["exploration"]);
    assert.deepStrictEqual(types(make("exposed", 0.5)), ["exploration"]);
    assert.deepStrictEqual(types(make("experienced", 0)), []);
}

function testBehaviorActorAttribution() {
    const child = selectExplanationReasons(makeEvidence({
        factors: {
            interest: factor(false, null, []),
            preference: factor(false, null, []),
            goal: factor(false, null, []),
            exploration: factor(false, null, []),
            behavior: factor(true, 0.75, behaviorEvidence("Child", "Rate")),
            session: factor(false, null, [])
        }
    }))[0];
    const parent = selectExplanationReasons(makeEvidence({
        factors: {
            interest: factor(false, null, []),
            preference: factor(false, null, []),
            goal: factor(false, null, []),
            exploration: factor(false, null, []),
            behavior: factor(true, 1, behaviorEvidence("Parent", "Save")),
            session: factor(false, null, [])
        }
    }))[0];
    const neutral = selectExplanationReasons(makeEvidence({
        factors: {
            interest: factor(false, null, []),
            preference: factor(false, null, []),
            goal: factor(false, null, []),
            exploration: factor(false, null, []),
            behavior: factor(true, 1, behaviorEvidence(null, "Click")),
            session: factor(false, null, [])
        }
    }))[0];

    assert.strictEqual(child.selectedInteractionType, "Rate");
    assert.strictEqual(child.actorType, "Child");
    assert.strictEqual(child.actorAttribution, "child");
    assert.strictEqual(child.ratingValue, 4);
    assert.strictEqual(parent.actorAttribution, "parent");
    assert.strictEqual(neutral.actorAttribution, "neutral");
}

function testSessionPositiveAndUnavailable() {
    const positive = selectExplanationReasons(makeEvidence({
        factors: {
            interest: factor(false, null, []),
            preference: factor(false, null, []),
            goal: factor(false, null, []),
            exploration: factor(false, null, []),
            behavior: factor(false, null, []),
            session: factor(true, 1, sessionEvidence(true))
        }
    }));
    const unavailable = selectExplanationReasons(makeEvidence({
        factors: {
            interest: factor(false, null, []),
            preference: factor(false, null, []),
            goal: factor(false, null, []),
            exploration: factor(false, null, []),
            behavior: factor(false, null, []),
            session: factor(false, null, [{ type: "no_preferred_days" }])
        }
    }));

    assert.deepStrictEqual(types(positive), ["session"]);
    assert.deepStrictEqual(positive[0].matchingWeekdays, ["Monday"]);
    assert.deepStrictEqual(unavailable, []);
}

function testCanonicalTieOrderAndNoDuplicates() {
    const reasons = selectExplanationReasons(makeEvidence({
        factors: {
            interest: factor(false, null, [])
        }
    }));

    assert.deepStrictEqual(types(reasons), ["preference", "goal", "exploration"]);
    assert.strictEqual(new Set(types(reasons)).size, reasons.length);
}

function testInputNotMutated() {
    const evidence = makeEvidence();
    const before = snapshot(evidence);
    const reasons = selectExplanationReasons(evidence);

    reasons[0].sourceEvidence.score = 0;
    assert.deepStrictEqual(snapshot(evidence), before);
}

function main() {
    testAllSixPositiveSelectFirstThree();
    testInterestUnavailableSelectsNextCanonical();
    testInterestKnownZeroSkipped();
    testOnlyOnePositiveSupportedFactor();
    testInsufficientEvidenceSkipped();
    testPreferencePositiveSupportSemantics();
    testInterestSupportTypes();
    testGoalSelectableWithResolvedOutcomeAndUnresolvedGoalSafe();
    testMissingGoalDocumentOnlySkipped();
    testExplorationStates();
    testBehaviorActorAttribution();
    testSessionPositiveAndUnavailable();
    testCanonicalTieOrderAndNoDuplicates();
    testInputNotMutated();

    console.log("Reason selector unit tests: PASSED");
}

main();
