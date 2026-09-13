const assert = require("assert");
const {
    buildExplanationPlan
} = require("../explanation/explanationPlanBuilder");

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

function makeEvidence(overrides = {}) {
    const base = {
        activity: {
            activityId: "activity_1",
            nameAr: "نشاط",
            nameEn: "Activity",
            resolved: true
        },
        factors: {
            interest: factor(true, 0.8, [
                {
                    type: "exact_subcategory_interest",
                    subcategoryId: "subcategory_1",
                    score: 0.8,
                    confidence: 0.9,
                    subcategory: {
                        subcategoryId: "subcategory_1",
                        name: "Robotics",
                        resolved: true
                    }
                }
            ]),
            preference: factor(true, 1, [
                {
                    dimension: "environment",
                    childValue: "Indoor",
                    activityValue: "Indoor",
                    confidence: 1,
                    source: "Onboarding",
                    baseMatch: 1,
                    adjustedScore: 1
                }
            ]),
            goal: factor(true, 1, [
                {
                    type: "goal_coverage",
                    goalId: "goal_1",
                    priority: "High",
                    status: "Active",
                    goalOutcomeIds: ["outcome_1"],
                    matchedOutcomeIds: ["outcome_1"],
                    coverage: 1,
                    goal: {
                        goalId: "goal_1",
                        name: "Improve Problem Solving",
                        resolved: true
                    },
                    matchedOutcomes: [
                        {
                            outcomeId: "outcome_1",
                            name: "Problem Solving",
                            resolved: true
                        }
                    ]
                }
            ]),
            exploration: factor(true, 1, [
                {
                    type: "exact_activity_novelty",
                    activityId: "activity_1",
                    noveltyState: "new",
                    matchingBookingCount: 0,
                    displayedRecommendationCount: 0,
                    experiencedBookingCount: 0
                }
            ]),
            behavior: factor(true, 0.5, [
                {
                    type: "exact_activity_behavior",
                    activityId: "activity_1",
                    behaviorState: "passive",
                    selectedInteractionType: "Click",
                    selectedInteractionId: "interaction_1",
                    selectedTimestamp: "2026-09-01T00:00:00.000Z",
                    actorType: "Parent",
                    score: 0.5,
                    matchingInteractionCount: 1,
                    explicitInteractionCount: 0,
                    passiveInteractionCount: 1
                }
            ]),
            session: factor(false, null, [
                {
                    type: "no_preferred_days"
                }
            ])
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

function testBuildsPlanWithoutTextOrTimeOfDay() {
    const evidence = makeEvidence();
    const before = snapshot(evidence);
    const plan = buildExplanationPlan(evidence);
    const serialized = JSON.stringify(plan);

    assert.deepStrictEqual(snapshot(evidence), before);
    assert.deepStrictEqual(plan.activity, evidence.activity);
    assert.notStrictEqual(plan.activity, evidence.activity);
    assert.deepStrictEqual(plan.reasonTypes, ["interest", "preference", "goal"]);
    assert.deepStrictEqual(
        plan.reasons.map((reason) => reason.type),
        plan.reasonTypes
    );
    assert.strictEqual(plan.reasons.length, 3);
    assert.strictEqual(new Set(plan.reasonTypes).size, plan.reasonTypes.length);
    assert.deepStrictEqual(plan.practicalSupport, {
        hasEligibleSession: true
    });
    assert.strictEqual(plan.neutralFallbackRequired, false);
    assert(!Object.prototype.hasOwnProperty.call(plan, "text"));
    assert(!serialized.includes("timeOfDay"));
    assert(!serialized.includes("preferredTime"));
}

function testNeutralFallbackRequired() {
    const plan = buildExplanationPlan(makeEvidence({
        factors: {
            interest: factor(false, null, []),
            preference: factor(false, null, []),
            goal: factor(false, null, []),
            exploration: factor(false, null, []),
            behavior: factor(false, null, []),
            session: factor(false, null, [])
        },
        practicalEligibility: {
            hasEligibleSession: false
        },
        eligibleSessionIds: []
    }));

    assert.deepStrictEqual(plan.reasonTypes, []);
    assert.deepStrictEqual(plan.reasons, []);
    assert.strictEqual(plan.neutralFallbackRequired, true);
    assert.deepStrictEqual(plan.practicalSupport, {
        hasEligibleSession: false
    });
}

function testPracticalSupportSeparateFromReasons() {
    const plan = buildExplanationPlan(makeEvidence({
        factors: {
            session: factor(false, null, [
                {
                    type: "no_preferred_days"
                }
            ])
        },
        practicalEligibility: {
            hasEligibleSession: true
        }
    }));

    assert(!plan.reasonTypes.includes("session"));
    assert.strictEqual(plan.practicalSupport.hasEligibleSession, true);
}

function main() {
    testBuildsPlanWithoutTextOrTimeOfDay();
    testNeutralFallbackRequired();
    testPracticalSupportSeparateFromReasons();

    console.log("Explanation plan builder unit tests: PASSED");
}

main();
