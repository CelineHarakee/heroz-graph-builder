const assert = require("assert");
const {
    GENERATION_STATUS,
    generateExplanation
} = require("../explanation/languageGenerator");

function snapshot(value) {
    return JSON.parse(JSON.stringify(value));
}

function parent(language = "en") {
    return {
        account: {
            preferredLanguage: language
        }
    };
}

function basePlan(overrides = {}) {
    const plan = {
        activity: {
            activityId: "activity_1",
            nameAr: "مختبر الروبوتات",
            nameEn: "Robotics Lab",
            resolved: true
        },
        reasonTypes: ["interest", "preference", "goal"],
        reasons: [
            {
                type: "interest",
                supportType: "exact_subcategory_interest",
                subcategory: {
                    subcategoryId: "subcategory_1",
                    name: "Robotics",
                    resolved: true
                }
            },
            {
                type: "preference",
                dimension: "environment",
                childValue: "Indoor",
                activityValue: "Indoor",
                source: "Onboarding",
                sourceEvidence: {
                    baseMatch: 1,
                    adjustedScore: 1
                }
            },
            {
                type: "goal",
                goalId: "goal_1",
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
        ],
        practicalSupport: {
            hasEligibleSession: true
        },
        neutralFallbackRequired: false
    };

    return {
        ...plan,
        ...overrides
    };
}

async function testEnglishAndArabicStoredLanguage() {
    const en = await generateExplanation(basePlan(), {
        parent: parent("en")
    });
    const ar = await generateExplanation(basePlan(), {
        parent: parent("ar")
    });

    assert.strictEqual(en.language, "en");
    assert.strictEqual(ar.language, "ar");
    assert.strictEqual(en.status, GENERATION_STATUS.GENERATED);
    assert.strictEqual(ar.status, GENERATION_STATUS.GENERATED);
    assert(en.text.includes("We suggested Robotics Lab"));
    assert(ar.text.includes("اقترحنا مختبر الروبوتات"));
    assert(!en.text.includes("مختبر"));
    assert(!ar.text.includes("We recommend"));
    assert(!ar.text.includes("Robotics"));
}

async function testNoExplicitLanguageInputRequired() {
    const result = await generateExplanation(basePlan(), {
        parent: parent("en")
    });

    assert.strictEqual(result.language, "en");
}

async function testReasonTypesPreservedExactly() {
    const plan = basePlan();
    const result = await generateExplanation(plan, {
        parent: parent("en")
    });

    assert.deepStrictEqual(result.reasonTypes, plan.reasonTypes);
    assert.notStrictEqual(result.reasonTypes, plan.reasonTypes);
}

async function testInterestSafety() {
    const categoryPlan = basePlan({
        reasonTypes: ["interest"],
        reasons: [
            {
                type: "interest",
                supportType: "category_fallback",
                category: {
                    categoryId: "category_1",
                    name: "STEM",
                    resolved: true
                },
                excludedSubcategory: {
                    subcategoryId: "subcategory_1",
                    name: "Robotics",
                    resolved: true
                }
            }
        ],
        practicalSupport: {
            hasEligibleSession: false
        }
    });
    const result = await generateExplanation(categoryPlan, {
        parent: parent("en")
    });

    assert(result.text.includes("broader opportunity"));
    assert(result.text.includes("STEM"));
    assert(!result.text.includes("demonstrated interest in Robotics"));
}

async function testPreferencePartialSupportSafety() {
    const plan = basePlan({
        reasonTypes: ["preference"],
        reasons: [
            {
                type: "preference",
                dimension: "environment",
                childValue: "Indoor",
                activityValue: "Outdoor",
                source: "Onboarding",
                sourceEvidence: {
                    baseMatch: 0,
                    adjustedScore: 0.45
                }
            }
        ],
        practicalSupport: {
            hasEligibleSession: false
        }
    });
    const result = await generateExplanation(plan, {
        parent: parent("en")
    });

    assert(result.text.includes("known environment preference"));
    assert(!result.text.includes("exact match"));
    assert(!result.text.includes("0.45"));
}

async function testGoalAndExplorationSafety() {
    const plan = basePlan({
        reasonTypes: ["goal", "exploration"],
        reasons: [
            basePlan().reasons[2],
            {
                type: "exploration",
                activityId: "activity_1",
                noveltyState: "new",
                matchingBookingCount: 0,
                displayedRecommendationCount: 0,
                experiencedBookingCount: 0
            }
        ],
        practicalSupport: {
            hasEligibleSession: false
        }
    });
    const result = await generateExplanation(plan, {
        parent: parent("en")
    });

    assert(result.text.includes("aligns with the goal"));
    assert(result.text.includes("something new"));
    assert(!result.text.includes("guaranteed"));
    assert(!result.text.includes("mastery"));
    assert(!result.text.includes("popular"));
    assert(!result.text.includes("trending"));
    assert(!result.text.includes("best"));
}

async function testBehaviorAttributionSafety() {
    const childPlan = behaviorPlan("Child", "Rate");
    const parentPlan = behaviorPlan("Parent", "Save");
    const neutralPlan = behaviorPlan(null, "Click");
    const child = await generateExplanation(childPlan, {
        parent: parent("en")
    });
    const parentResult = await generateExplanation(parentPlan, {
        parent: parent("en")
    });
    const neutral = await generateExplanation(neutralPlan, {
        parent: parent("en")
    });

    assert(child.text.includes("your child previously rated"));
    assert(parentResult.text.includes("previous parent engagement"));
    assert(!parentResult.text.includes("your child previously saved"));
    assert(neutral.text.includes("previous engagement"));
    assert(!neutral.text.includes("your child previously clicked"));
}

function behaviorPlan(actorAttribution, interactionType) {
    return basePlan({
        reasonTypes: ["behavior"],
        reasons: [
            {
                type: "behavior",
                activityId: "activity_1",
                behaviorState: "explicit_positive",
                selectedInteractionType: interactionType,
                selectedInteractionId: "interaction_1",
                selectedTimestamp: "2026-09-01T00:00:00.000Z",
                actorType: actorAttribution,
                actorAttribution: actorAttribution === "Child"
                    ? "child"
                    : actorAttribution === "Parent" ? "parent" : "neutral",
                matchingInteractionCount: 1,
                explicitInteractionCount: 1,
                passiveInteractionCount: 0,
                ratingValue: interactionType === "Rate" ? 4 : undefined
            }
        ],
        practicalSupport: {
            hasEligibleSession: false
        }
    });
}

async function testSessionDayOnlyAndPracticalSupport() {
    const plan = basePlan({
        reasonTypes: ["session"],
        reasons: [
            {
                type: "session",
                preferredDays: ["Monday"],
                eligibleSessionCount: 1,
                matchingSessionIds: ["session_1"],
                matchingWeekdays: ["Monday"]
            }
        ],
        practicalSupport: {
            hasEligibleSession: true
        }
    });
    const result = await generateExplanation(plan, {
        parent: parent("en")
    });

    assert(result.text.includes("preferred day"));
    assert(result.text.includes("Monday"));
    assert(!result.text.includes("time"));
    assert(!result.text.includes("morning"));
    assert(!result.text.includes("evening"));
}

async function testNoScoreWeightLeakage() {
    const result = await generateExplanation(basePlan(), {
        parent: parent("en")
    });

    assert(!result.text.includes("0.8"));
    assert(!result.text.includes("33%"));
    assert(!result.text.includes("weight"));
    assert(!result.text.includes("contribution"));
    assert(!result.text.includes("normalized"));
}

async function testSingleLanguageCanonicalLabelsRendered() {
    const result = await generateExplanation(basePlan(), {
        parent: parent("ar")
    });

    assert(result.text.includes("حل المشكلات"));
    assert(result.text.includes("داخلي"));
    assert(!result.text.includes("Problem Solving"));
    assert(!result.text.includes("Indoor"));
}

async function testImmutability() {
    const plan = basePlan();
    const before = snapshot(plan);

    await generateExplanation(plan, {
        parent: parent("ar")
    });

    assert.deepStrictEqual(snapshot(plan), before);
}

async function testNeutralFallbackRequired() {
    const result = await generateExplanation(basePlan({
        reasonTypes: [],
        reasons: [],
        neutralFallbackRequired: true
    }), {
        parent: parent("en")
    });

    assert.deepStrictEqual(result.reasonTypes, []);
    assert.strictEqual(result.language, "en");
    assert.strictEqual(result.status, GENERATION_STATUS.NEUTRAL_FALLBACK_REQUIRED);
    assert.strictEqual(result.text, null);
}

async function testProviderReceivesOnlyApprovedPlanInformation() {
    const plan = basePlan({
        reasonTypes: ["interest", "goal"],
        reasons: [
            basePlan().reasons[0],
            basePlan().reasons[2]
        ],
        practicalSupport: {
            hasEligibleSession: true
        }
    });
    let payload = null;
    const result = await generateExplanation(plan, {
        parent: parent("en"),
        provider: {
            async generate(input) {
                payload = input;

                return {
                    text: "We suggested Robotics Lab because your child has shown interest in Robotics before, and it aligns with the goal you selected."
                };
            }
        }
    });
    const serialized = JSON.stringify(payload);

    assert.strictEqual(payload.language, "en");
    assert.deepStrictEqual(payload.explanationPlan.reasonTypes, ["interest", "goal"]);
    assert.deepStrictEqual(
        payload.explanationPlan.reasons.map((reason) => reason.type),
        ["interest", "goal"]
    );
    assert(!serialized.includes("preference"));
    assert(!serialized.includes("sourceEvidence"));
    assert(!serialized.includes("adjustedScore"));
    assert(!serialized.includes("baseMatch"));
    assert(!serialized.includes("score"));
    assert(!serialized.includes("weight"));
    assert(!serialized.includes("contribution"));
    assert(!serialized.includes("eligibleSessionIds"));
    assert(!serialized.includes("practicalSupport"));
    assert.deepStrictEqual(result.reasonTypes, ["interest", "goal"]);
}

async function testProviderReasonTypesIgnored() {
    const result = await generateExplanation(basePlan({
        reasonTypes: ["interest"],
        reasons: [basePlan().reasons[0]]
    }), {
        parent: parent("en"),
        provider: {
            async generate() {
                return {
                    reasonTypes: ["goal", "session"],
                    text: "We suggested Robotics Lab because your child has shown interest in Robotics before."
                };
            }
        }
    });

    assert.deepStrictEqual(result.reasonTypes, ["interest"]);
}

async function testProviderArabicRequest() {
    let payload = null;
    const result = await generateExplanation(basePlan({
        reasonTypes: ["interest"],
        reasons: [basePlan().reasons[0]]
    }), {
        parent: parent("ar"),
        provider: {
            async generate(input) {
                payload = input;

                return {
                    text: "اقترحنا مختبر الروبوتات لأن طفلك أظهر اهتماما بالروبوتات من قبل."
                };
            }
        }
    });

    assert.strictEqual(payload.language, "ar");
    assert.strictEqual(payload.explanationPlan.language, "ar");
    assert.strictEqual(result.language, "ar");
}

async function testProviderFailureAndMalformedResponse() {
    await assert.rejects(
        () => generateExplanation(basePlan(), {
            parent: parent("en"),
            provider: {
                async generate() {
                    throw new Error("timeout");
                }
            }
        }),
        /provider failed/
    );

    await assert.rejects(
        () => generateExplanation(basePlan(), {
            parent: parent("en"),
            provider: {
                async generate() {
                    return {
                        text: ""
                    };
                }
            }
        }),
        /malformed output/
    );
}

async function testMissingMalformedLanguage() {
    await assert.rejects(
        () => generateExplanation(basePlan(), {
            parent: {
                account: {}
            }
        }),
        /preferredLanguage must be en or ar/
    );

    await assert.rejects(
        () => generateExplanation(basePlan(), {
            parent: parent("fr")
        }),
        /preferredLanguage must be en or ar/
    );
}

async function main() {
    await testEnglishAndArabicStoredLanguage();
    await testNoExplicitLanguageInputRequired();
    await testReasonTypesPreservedExactly();
    await testInterestSafety();
    await testPreferencePartialSupportSafety();
    await testGoalAndExplorationSafety();
    await testBehaviorAttributionSafety();
    await testSessionDayOnlyAndPracticalSupport();
    await testNoScoreWeightLeakage();
    await testSingleLanguageCanonicalLabelsRendered();
    await testImmutability();
    await testNeutralFallbackRequired();
    await testProviderReceivesOnlyApprovedPlanInformation();
    await testProviderReasonTypesIgnored();
    await testProviderArabicRequest();
    await testProviderFailureAndMalformedResponse();
    await testMissingMalformedLanguage();

    console.log("Language generator unit tests: PASSED");
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
