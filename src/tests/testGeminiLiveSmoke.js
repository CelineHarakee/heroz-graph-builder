require("dotenv").config();

const assert = require("assert");
const {
    createGeminiLanguageProvider
} = require("../explanation/geminiLanguageProvider");
const {
    generateExplanation
} = require("../explanation/languageGenerator");
const {
    finalizeExplanation
} = require("../explanation/explanationFinalizer");

function parent(language) {
    return {
        account: {
            preferredLanguage: language
        }
    };
}

function plan(language) {
    return {
        activity: {
            activityId: "synthetic_activity_robotics_lab",
            nameEn: "Robotics Lab",
            nameAr: "مختبر الروبوتات",
            resolved: true
        },
        reasonTypes: ["interest", "goal"],
        reasons: [
            {
                type: "interest",
                supportType: "exact_subcategory_interest",
                subcategory: {
                    subcategoryId: "synthetic_subcategory_robotics",
                    name: "Robotics",
                    resolved: true
                }
            },
            {
                type: "goal",
                goalId: "synthetic_goal_problem_solving",
                goal: {
                    goalId: "synthetic_goal_problem_solving",
                    name: "Improve Problem Solving",
                    resolved: true
                },
                matchedOutcomes: [
                    {
                        outcomeId: "synthetic_outcome_problem_solving",
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
}

async function run(language, provider) {
    const explanationPlan = plan(language);
    let generatedExplanation = null;
    let generationError = null;

    try {
        generatedExplanation = await generateExplanation(explanationPlan, {
            parent: parent(language),
            provider
        });
    } catch (error) {
        generationError = error;
    }

    return finalizeExplanation({
        explanationPlan,
        generatedExplanation,
        language,
        generationError
    });
}

async function main() {
    const provider = createGeminiLanguageProvider();

    if (!provider) {
        console.log("Gemini live smoke test: NOT CONFIGURED");
        return;
    }

    const en = await run("en", provider);
    const ar = await run("ar", provider);

    assert.strictEqual(en.source, "generated");
    assert.strictEqual(ar.source, "generated");

    console.log("Gemini live smoke test: PASS");
    console.log(`English: ${en.text}`);
    console.log(`Arabic: ${ar.text}`);
}

main().catch((error) => {
    console.error("Gemini live smoke test: FAIL");
    console.error(error.message);
    process.exit(1);
});
