const assert = require("assert");
const {
    generateExplanation
} = require("../explanation/languageGenerator");
const {
    finalizeExplanation
} = require("../explanation/explanationFinalizer");
const {
    validateExplanationGrounding
} = require("../explanation/groundingValidator");
const {
    attachRecommendationExplanations
} = require("../explanation/explanationOrchestrator");

function snapshot(value) {
    return JSON.parse(JSON.stringify(value));
}

function parent(language) {
    return {
        account: {
            preferredLanguage: language
        }
    };
}

function basePlan(overrides = {}) {
    return {
        activity: {
            activityId: "activity_a",
            nameAr: "مختبر الروبوتات",
            nameEn: "Robotics Lab",
            resolved: true
        },
        reasonTypes: [],
        reasons: [],
        practicalSupport: {
            hasEligibleSession: false
        },
        neutralFallbackRequired: false,
        ...overrides
    };
}

function interestReason() {
    return {
        type: "interest",
        supportType: "exact_subcategory_interest",
        subcategory: {
            subcategoryId: "subcategory_robotics",
            name: "Robotics",
            resolved: true
        }
    };
}

function goalReason() {
    return {
        type: "goal",
        goalId: "goal_problem_solving",
        goal: {
            goalId: "goal_problem_solving",
            name: "Improve Problem Solving",
            resolved: true
        },
        matchedOutcomes: [
            {
                outcomeId: "outcome_problem_solving",
                name: "Problem Solving",
                resolved: true
            }
        ]
    };
}

function preferenceReason() {
    return {
        type: "preference",
        dimension: "environment",
        childValue: "Indoor",
        activityValue: "Outdoor",
        source: "Onboarding",
        sourceEvidence: {
            baseMatch: 0,
            adjustedScore: 0.45
        }
    };
}

function explorationReason() {
    return {
        type: "exploration",
        activityId: "activity_a",
        noveltyState: "new",
        matchingBookingCount: 0,
        displayedRecommendationCount: 0,
        experiencedBookingCount: 0
    };
}

function behaviorReason(actorAttribution, selectedInteractionType) {
    return {
        type: "behavior",
        activityId: "activity_a",
        behaviorState: selectedInteractionType === "Rate" ? "rating" : "explicit_positive",
        selectedInteractionType,
        selectedInteractionId: "interaction_1",
        selectedTimestamp: "2026-09-01T00:00:00.000Z",
        actorType: actorAttribution === "child" ? "Child" : "Parent",
        actorAttribution,
        matchingInteractionCount: 1,
        explicitInteractionCount: 1,
        passiveInteractionCount: 0,
        ratingValue: selectedInteractionType === "Rate" ? 4 : undefined
    };
}

function sessionReason() {
    return {
        type: "session",
        preferredDays: ["Monday"],
        eligibleSessionCount: 1,
        matchingSessionIds: ["session_1"],
        matchingWeekdays: ["Monday"]
    };
}

async function finalized(plan, language, options = {}) {
    let generatedExplanation = null;
    let generationError = null;

    try {
        generatedExplanation = await generateExplanation(plan, {
            parent: parent(language),
            provider: options.provider
        });
    } catch (error) {
        generationError = error;
    }

    return finalizeExplanation({
        explanationPlan: plan,
        generatedExplanation,
        language,
        generationError
    });
}

function assertNoScoringText(text) {
    assert(!text.includes("0.8"));
    assert(!text.includes("33%"));
    assert(!/score/i.test(text));
    assert(!/weight/i.test(text));
    assert(!/contribution/i.test(text));
}

async function testInterestGoal() {
    const plan = basePlan({
        reasonTypes: ["interest", "goal"],
        reasons: [interestReason(), goalReason()],
        practicalSupport: { hasEligibleSession: true }
    });
    const result = await finalized(plan, "en");

    assert.strictEqual(result.source, "generated");
    assert.deepStrictEqual(result.reasonTypes, ["interest", "goal"]);
    assert(result.text.includes("interest"));
    assert(result.text.includes("goal"));
    assert(!result.text.includes("preference"));
    assertNoScoringText(result.text);

    return result;
}

async function testPreferenceExploration() {
    const plan = basePlan({
        reasonTypes: ["preference", "exploration"],
        reasons: [preferenceReason(), explorationReason()]
    });
    const result = await finalized(plan, "en");

    assert.deepStrictEqual(result.reasonTypes, ["preference", "exploration"]);
    assert(result.text.includes("preference"));
    assert(result.text.includes("new"));
    assert(!/exact match|perfect match/i.test(result.text));
    assert(!/popular|trending|best/i.test(result.text));

    return result;
}

async function testBehaviorAttribution() {
    const parentPlan = basePlan({
        reasonTypes: ["behavior"],
        reasons: [behaviorReason("parent", "Save")]
    });
    const childPlan = basePlan({
        reasonTypes: ["behavior"],
        reasons: [behaviorReason("child", "Rate")]
    });
    const parentResult = await finalized(parentPlan, "en");
    const childResult = await finalized(childPlan, "en");

    assert(parentResult.text.includes("parent engagement"));
    assert(!parentResult.text.includes("your child previously saved"));
    assert(childResult.text.includes("your child previously rated"));

    return parentResult;
}

async function testSession() {
    const plan = basePlan({
        reasonTypes: ["session"],
        reasons: [sessionReason()]
    });
    const result = await finalized(plan, "en");

    assert(result.text.includes("preferred day"));
    assert(result.text.includes("Monday"));
    assert(!/time of day|morning|evening/i.test(result.text));

    return result;
}

async function testPracticalWithoutSession() {
    const plan = basePlan({
        reasonTypes: ["interest"],
        reasons: [interestReason()],
        practicalSupport: { hasEligibleSession: true }
    });
    const result = await finalized(plan, "en");

    assert(!result.reasonTypes.includes("session"));
    assert(!result.text.includes("currently available"));
    assert(!result.text.includes("preferred day"));

    return result;
}

async function testArabicAndEnglish() {
    const plan = basePlan({
        reasonTypes: ["interest", "goal"],
        reasons: [interestReason(), goalReason()],
        practicalSupport: { hasEligibleSession: true }
    });
    const ar = await finalized(plan, "ar");
    const en = await finalized(plan, "en");

    assert.strictEqual(ar.language, "ar");
    assert.strictEqual(en.language, "en");
    assert(ar.text.includes("اقترحنا"));
    assert(!ar.text.includes("We recommend"));
    assert(en.text.includes("We suggested"));
    assert(!en.text.includes("نوصي"));
    assert.deepStrictEqual(ar.reasonTypes, en.reasonTypes);

    return { ar, en };
}

async function testForcedGenerationFailure() {
    const plan = basePlan({
        reasonTypes: ["interest", "goal"],
        reasons: [interestReason(), goalReason()]
    });
    const result = await finalized(plan, "en", {
        provider: {
            async generate() {
                throw new Error("forced failure");
            }
        }
    });

    assert.strictEqual(result.source, "fallback");
    assert.deepStrictEqual(result.reasonTypes, ["interest", "goal"]);
    assert(result.text.includes("Robotics Lab"));

    return result;
}

async function testUnsupportedClaimFallback() {
    const plan = basePlan({
        reasonTypes: ["goal"],
        reasons: [goalReason()]
    });
    const generatedExplanation = {
        reasonTypes: ["goal"],
        language: "en",
        status: "generated",
        text: "This activity will develop mastery and make your child more intelligent."
    };
    const validation = validateExplanationGrounding(
        plan,
        generatedExplanation,
        "en"
    );
    const result = finalizeExplanation({
        explanationPlan: plan,
        generatedExplanation,
        language: "en"
    });

    assert.strictEqual(validation.valid, false);
    assert.strictEqual(result.source, "fallback");
    assert(!result.text.includes("intelligent"));
    assert(!result.text.includes("mastery"));
}

async function testNeutralFallback() {
    const plan = basePlan({
        reasonTypes: [],
        reasons: [],
        neutralFallbackRequired: true
    });
    const result = await finalized(plan, "en");

    assert.strictEqual(result.source, "fallback");
    assert.deepStrictEqual(result.reasonTypes, []);
    assert(result.text.includes("currently eligible options"));
    assert(!result.text.includes("interest"));
    assert(!result.text.includes("preference"));
    assert(!result.text.includes("goal"));

    return result;
}

async function testMultipleRecommendationMappingAndImmutability() {
    const recommendationResults = [
        makeRecommendationResult("activity_a", 1),
        makeRecommendationResult("activity_b", 2)
    ];
    const before = snapshot(recommendationResults);
    const attached = [];
    const result = await attachRecommendationExplanations({
        recommendationId: "recommendation_1",
        recommendationResults,
        parent: parent("en"),
        dependencies: {
            async buildExplanationEvidence(recommendationResult) {
                return makeExplanationEvidence(recommendationResult);
            },
            buildExplanationPlan(explanationEvidence) {
                return basePlan({
                    activity: explanationEvidence.activity,
                    reasonTypes: ["interest"],
                    reasons: [interestReason()],
                    practicalSupport: { hasEligibleSession: true }
                });
            },
            async attachRecommendationItemExplanation(payload) {
                attached.push(snapshot(payload));
            }
        }
    });

    assert.deepStrictEqual(snapshot(recommendationResults), before);
    assert.deepStrictEqual(attached.map((item) => item.activityId), [
        "activity_a",
        "activity_b"
    ]);
    assert(result.recommendations[0].explanation.text.includes("Activity A"));
    assert(result.recommendations[1].explanation.text.includes("Activity B"));
    assert.strictEqual(result.recommendations[0].rank, 1);
    assert.strictEqual(result.recommendations[1].rank, 2);
    assert.strictEqual(result.recommendations[0].score, 0.9);
    assert.strictEqual(result.recommendations[1].score, 0.7);
}

function makeRecommendationResult(activityId, rank) {
    return {
        activityId,
        rank,
        score: rank === 1 ? 0.9 : 0.7,
        factors: {
            interest: { available: true, score: 0.8 },
            preference: { available: false, score: null },
            goal: { available: false, score: null },
            exploration: { available: false, score: null },
            behavior: { available: false, score: null },
            session: { available: false, score: null }
        },
        scoring: {
            availableWeight: 0.33,
            availableFactorCount: 1,
            contributions: [{ factor: "interest" }]
        },
        eligibleSessionIds: ["session_1"],
        evidence: {
            discovery: { interests: [], goals: [], summary: [] },
            factors: {
                interest: [],
                preference: [],
                goal: [],
                exploration: [],
                behavior: [],
                session: []
            }
        }
    };
}

function makeExplanationEvidence(recommendationResult) {
    return {
        activity: {
            activityId: recommendationResult.activityId,
            nameAr: recommendationResult.activityId === "activity_a" ? "نشاط أ" : "نشاط ب",
            nameEn: recommendationResult.activityId === "activity_a" ? "Activity A" : "Activity B",
            resolved: true
        },
        factors: {},
        eligibleSessionIds: recommendationResult.eligibleSessionIds,
        practicalEligibility: {
            hasEligibleSession: true
        }
    };
}

function printExample(label, result) {
    console.log(`\n${label}`);
    console.log(`reasonTypes: ${JSON.stringify(result.reasonTypes)}`);
    console.log(`text: ${result.text}`);
}

async function main() {
    const english = await testInterestGoal();
    await testPreferenceExploration();
    const behavior = await testBehaviorAttribution();
    const session = await testSession();
    await testPracticalWithoutSession();
    const language = await testArabicAndEnglish();
    const fallback = await testForcedGenerationFailure();
    await testUnsupportedClaimFallback();
    const neutral = await testNeutralFallback();
    await testMultipleRecommendationMappingAndImmutability();

    console.log("========================================");
    console.log("D6 FINAL CONTROLLED OUTPUTS");
    console.log("========================================");
    printExample("English", english);
    printExample("Arabic", language.ar);
    printExample("Behavior", behavior);
    printExample("Session", session);
    printExample("Fallback", fallback);
    printExample("Neutral fallback", neutral);

    console.log("\nD6 final end-to-end verification scenarios: PASSED");
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
