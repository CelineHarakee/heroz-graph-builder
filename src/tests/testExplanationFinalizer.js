const assert = require("assert");
const {
    finalizeExplanation
} = require("../explanation/explanationFinalizer");
const { GENERATION_STATUS } = require("../explanation/languageGenerator");

function snapshot(value) {
    return JSON.parse(JSON.stringify(value));
}

function plan(overrides = {}) {
    const base = {
        activity: {
            activityId: "activity_1",
            nameAr: "مختبر الروبوتات",
            nameEn: "Robotics Lab",
            resolved: true
        },
        reasonTypes: ["interest"],
        reasons: [
            {
                type: "interest",
                supportType: "exact_subcategory_interest",
                subcategory: { name: "Robotics", resolved: true }
            }
        ],
        practicalSupport: {
            hasEligibleSession: true
        },
        neutralFallbackRequired: false
    };

    return {
        ...base,
        ...overrides
    };
}

function generated(overrides = {}) {
    return {
        reasonTypes: ["interest"],
        language: "en",
        status: GENERATION_STATUS.GENERATED,
        text: "We recommend Robotics Lab for these reasons. It connects with a demonstrated interest in Robotics. An eligible session is also currently available.",
        ...overrides
    };
}

function testValidGeneratedAccepted() {
    const result = finalizeExplanation({
        explanationPlan: plan(),
        generatedExplanation: generated(),
        language: "en"
    });

    assert.strictEqual(result.source, "generated");
    assert.strictEqual(result.language, "en");
    assert.strictEqual(result.validation.valid, true);
}

function testFallbackTriggers() {
    const failure = finalizeExplanation({
        explanationPlan: plan(),
        language: "en",
        generationError: new Error("timeout")
    });
    const malformed = finalizeExplanation({
        explanationPlan: plan(),
        generatedExplanation: generated({ text: "" }),
        language: "en"
    });
    const invalid = finalizeExplanation({
        explanationPlan: plan(),
        generatedExplanation: generated({ reasonTypes: ["goal"] }),
        language: "en"
    });
    const neutral = finalizeExplanation({
        explanationPlan: plan({
            reasonTypes: [],
            reasons: [],
            neutralFallbackRequired: true
        }),
        generatedExplanation: generated({ reasonTypes: [] }),
        language: "en"
    });

    assert.strictEqual(failure.source, "fallback");
    assert.strictEqual(malformed.source, "fallback");
    assert.strictEqual(invalid.source, "fallback");
    assert.strictEqual(neutral.source, "fallback");
    assert(neutral.text.includes("currently eligible options"));
}

function testLanguageAndImmutability() {
    const p = plan({
        activity: {
            activityId: "activity_1",
            nameAr: "مختبر الروبوتات",
            nameEn: "Robotics Lab",
            resolved: true
        }
    });
    const g = generated();
    const beforePlan = snapshot(p);
    const beforeGenerated = snapshot(g);
    const result = finalizeExplanation({
        explanationPlan: p,
        generatedExplanation: g,
        language: "ar"
    });

    assert.strictEqual(result.source, "fallback");
    assert.strictEqual(result.language, "ar");
    assert.deepStrictEqual(snapshot(p), beforePlan);
    assert.deepStrictEqual(snapshot(g), beforeGenerated);
}

function main() {
    testValidGeneratedAccepted();
    testFallbackTriggers();
    testLanguageAndImmutability();

    console.log("Explanation finalizer unit tests: PASSED");
}

main();
