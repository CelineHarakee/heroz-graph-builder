const assert = require("assert");
const {
    GEMINI_GENERATION_CONFIG,
    GEMINI_MODEL
} = require("../config/gemini");
const {
    SYSTEM_INSTRUCTION,
    buildUserPrompt,
    createGeminiLanguageProvider
} = require("../explanation/geminiLanguageProvider");

function minimalPlan(language = "en") {
    return {
        language,
        activity: {
            displayName: language === "ar" ? "مختبر الروبوتات" : "Robotics Lab"
        },
        reasonTypes: ["interest", "goal"],
        reasons: [
            {
                type: "interest",
                supportType: "exact_subcategory_interest",
                subject: language === "ar" ? "الروبوتات" : "Robotics"
            },
            {
                type: "goal",
                goal: language === "ar" ? "تحسين حل المشكلات" : "Improve Problem Solving",
                outcome: language === "ar" ? "حل المشكلات" : "Problem Solving"
            }
        ]
    };
}

async function testAdapterCallsGeminiWithConfiguredModelAndPrompt() {
    const requests = [];
    const provider = createGeminiLanguageProvider({
        apiKey: "test-key",
        client: {
            models: {
                async generateContent(request) {
                    requests.push(request);

                    return {
                        text: "We suggested Robotics Lab because your child has shown interest in Robotics before, and it aligns with the goal you selected."
                    };
                }
            }
        }
    });
    const result = await provider.generate({
        language: "en",
        explanationPlan: minimalPlan("en")
    });

    assert.strictEqual(result.text.includes("We suggested Robotics Lab"), true);
    assert.strictEqual(requests.length, 1);
    assert.strictEqual(requests[0].model, GEMINI_MODEL);
    assert.strictEqual(requests[0].config.temperature, GEMINI_GENERATION_CONFIG.temperature);
    assert.strictEqual(requests[0].config.maxOutputTokens, GEMINI_GENERATION_CONFIG.maxOutputTokens);
    assert.strictEqual(requests[0].config.systemInstruction, SYSTEM_INSTRUCTION);
    assert(requests[0].contents.includes("Write the explanation fully in English."));
    assert(requests[0].contents.includes("Robotics Lab"));
    assert(!requests[0].contents.includes("sourceEvidence"));
    assert(!requests[0].contents.includes("adjustedScore"));
    assert(!requests[0].contents.includes("weight"));
    assert(!requests[0].contents.includes("contribution"));
}

function testArabicPrompt() {
    const prompt = buildUserPrompt({
        language: "ar",
        explanationPlan: minimalPlan("ar")
    });

    assert(prompt.includes("Write the explanation fully in Arabic."));
    assert(prompt.includes("مختبر الروبوتات"));
    assert(!prompt.includes("Write the explanation fully in English."));
}

async function testMissingApiKeyReturnsNullProvider() {
    const provider = createGeminiLanguageProvider({
        apiKey: ""
    });

    assert.strictEqual(provider, null);
}

async function testEmptyGeminiTextReturnedAsMalformedSignal() {
    const provider = createGeminiLanguageProvider({
        apiKey: "test-key",
        client: {
            models: {
                async generateContent() {
                    return { text: "   " };
                }
            }
        }
    });
    const result = await provider.generate({
        language: "en",
        explanationPlan: minimalPlan("en")
    });

    assert.deepStrictEqual(result, { text: "" });
}

async function main() {
    await testAdapterCallsGeminiWithConfiguredModelAndPrompt();
    testArabicPrompt();
    await testMissingApiKeyReturnsNullProvider();
    await testEmptyGeminiTextReturnedAsMalformedSignal();

    console.log("Gemini language provider unit tests: PASSED");
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
