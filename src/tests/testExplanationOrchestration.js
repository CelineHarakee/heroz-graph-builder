const assert = require("assert");
const {
    attachRecommendationExplanations
} = require("../explanation/explanationOrchestrator");

function snapshot(value) {
    return JSON.parse(JSON.stringify(value));
}

function makeRecommendationResult(activityId, rank, score = rank === 1 ? 0.9 : 0.7) {
    return {
        activityId,
        rank,
        score,
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
            contributions: [
                {
                    factor: "interest",
                    score: 0.8,
                    canonicalWeight: 0.33,
                    normalizedWeight: 1,
                    contribution: 0.8
                }
            ]
        },
        eligibleSessionIds: [`session_${rank}`],
        evidence: {
            discovery: {
                interests: [],
                goals: [],
                summary: []
            },
            factors: {
                interest: [
                    {
                        type: "exact_subcategory_interest",
                        subcategoryId: "subcategory_1",
                        score: 0.8,
                        confidence: 0.9
                    }
                ],
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
            nameAr: recommendationResult.activityId === "activity_a"
                ? "نشاط أ"
                : "نشاط ب",
            nameEn: recommendationResult.activityId === "activity_a"
                ? "Activity A"
                : "Activity B",
            resolved: true
        },
        factors: {
            interest: {
                available: true,
                score: 0.8,
                evidence: [
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
                ]
            },
            preference: { available: false, score: null, evidence: [] },
            goal: { available: false, score: null, evidence: [] },
            exploration: { available: false, score: null, evidence: [] },
            behavior: { available: false, score: null, evidence: [] },
            session: { available: false, score: null, evidence: [] }
        },
        eligibleSessionIds: recommendationResult.eligibleSessionIds,
        practicalEligibility: {
            hasEligibleSession: true
        }
    };
}

function makeDependencies({ neutral = false } = {}) {
    const attached = [];

    return {
        attached,
        dependencies: {
            async buildExplanationEvidence(recommendationResult) {
                return makeExplanationEvidence(recommendationResult);
            },
            buildExplanationPlan(explanationEvidence) {
                if (neutral) {
                    return {
                        activity: explanationEvidence.activity,
                        reasonTypes: [],
                        reasons: [],
                        practicalSupport: {
                            hasEligibleSession: false
                        },
                        neutralFallbackRequired: true
                    };
                }

                return {
                    activity: explanationEvidence.activity,
                    reasonTypes: ["interest"],
                    reasons: [
                        {
                            type: "interest",
                            supportType: "exact_subcategory_interest",
                            subcategory: {
                                subcategoryId: "subcategory_1",
                                name: "Robotics",
                                resolved: true
                            }
                        }
                    ],
                    practicalSupport: {
                        hasEligibleSession: true
                    },
                    neutralFallbackRequired: false
                };
            },
            async attachRecommendationItemExplanation(payload) {
                attached.push(snapshot(payload));
            }
        }
    };
}

function d5Fields(item) {
    const copy = snapshot(item);

    delete copy.explanation;

    return copy;
}

async function testEnglishTwoItemMappingAndD5Preservation() {
    const recommendationResults = [
        makeRecommendationResult("activity_a", 1),
        makeRecommendationResult("activity_b", 2)
    ];
    const before = snapshot(recommendationResults);
    const { attached, dependencies } = makeDependencies();
    const result = await attachRecommendationExplanations({
        recommendationId: "recommendation_1",
        recommendationResults,
        parent: {
            account: {
                preferredLanguage: "en"
            }
        },
        dependencies
    });

    assert.deepStrictEqual(snapshot(recommendationResults), before);
    assert.deepStrictEqual(result.recommendations.map((item) => item.activityId), [
        "activity_a",
        "activity_b"
    ]);
    assert.deepStrictEqual(attached.map((item) => item.activityId), [
        "activity_a",
        "activity_b"
    ]);
    assert.strictEqual(result.recommendations[0].explanation.language, "en");
    assert.strictEqual(result.recommendations[1].explanation.language, "en");
    assert(result.recommendations[0].explanation.text.includes("Activity A"));
    assert(result.recommendations[1].explanation.text.includes("Activity B"));
    assert.strictEqual(result.recommendations[0].explanation.source, "generated");
    assert.deepStrictEqual(d5Fields(result.recommendations[0]), recommendationResults[0]);
    assert.deepStrictEqual(d5Fields(result.recommendations[1]), recommendationResults[1]);
}

async function testArabicFlow() {
    const { dependencies } = makeDependencies();
    const result = await attachRecommendationExplanations({
        recommendationId: "recommendation_1",
        recommendationResults: [makeRecommendationResult("activity_a", 1)],
        parent: {
            account: {
                preferredLanguage: "ar"
            }
        },
        dependencies
    });

    assert.strictEqual(result.recommendations[0].explanation.language, "ar");
    assert(result.recommendations[0].explanation.text.includes("اقترحنا نشاط أ"));
    assert(!result.recommendations[0].explanation.text.includes("We recommend"));
}

async function testForcedGenerationFailureFallback() {
    const { attached, dependencies } = makeDependencies();
    const result = await attachRecommendationExplanations({
        recommendationId: "recommendation_1",
        recommendationResults: [makeRecommendationResult("activity_a", 1)],
        parent: {
            account: {
                preferredLanguage: "en"
            }
        },
        languageProvider: {
            async generate() {
                throw new Error("forced failure");
            }
        },
        dependencies
    });

    assert.strictEqual(result.recommendations[0].explanation.source, "fallback");
    assert(result.recommendations[0].explanation.text.includes("Activity A"));
    assert.strictEqual(attached[0].explanation.source, "fallback");
}

async function testNeutralFallback() {
    const { dependencies } = makeDependencies({ neutral: true });
    const result = await attachRecommendationExplanations({
        recommendationId: "recommendation_1",
        recommendationResults: [makeRecommendationResult("activity_a", 1)],
        parent: {
            account: {
                preferredLanguage: "en"
            }
        },
        dependencies
    });

    assert.deepStrictEqual(result.recommendations[0].explanation.reasonTypes, []);
    assert.strictEqual(result.recommendations[0].explanation.source, "fallback");
    assert(result.recommendations[0].explanation.text.includes("currently eligible options"));
    assert(!result.recommendations[0].explanation.text.includes("interest"));
}

async function main() {
    await testEnglishTwoItemMappingAndD5Preservation();
    await testArabicFlow();
    await testForcedGenerationFailureFallback();
    await testNeutralFallback();

    console.log("Explanation orchestration integration tests: PASSED");
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
