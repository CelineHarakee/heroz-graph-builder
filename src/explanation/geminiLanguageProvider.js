const {
    GEMINI_GENERATION_CONFIG,
    GEMINI_MODEL,
    getGeminiApiKey
} = require("../config/gemini");

const SYSTEM_INSTRUCTION = [
    "You are a language realization component for Heroz.",
    "You are not deciding why an Activity was recommended.",
    "The recommendation and its reasons have already been decided.",
    "Your only job is to explain the supplied approved reasons naturally to a Parent.",
    "Use only the supplied facts.",
    "Do not infer or add any fact, benefit, prediction, reason, quality, preference, interest, goal, behavior, or session information.",
    "Do not mention scores, percentages, weights, algorithms, factors, recommendation systems, AI, evidence objects, or internal technical terminology.",
    "Do not provide advice.",
    "Do not persuade or market the Activity.",
    "Do not say the Activity will definitely improve, develop, or be mastered by the Child.",
    "Return only the parent-facing explanation text. Do not return headings, bullets, JSON, or labels."
].join(" ");

function clone(value) {
    if (value === undefined) {
        return undefined;
    }

    return JSON.parse(JSON.stringify(value));
}

function buildUserPrompt({ language, explanationPlan }) {
    const languageInstruction = language === "ar"
        ? "Write the explanation fully in Arabic."
        : "Write the explanation fully in English.";

    return [
        languageInstruction,
        "Answer the parent's question: Why was this Activity suggested for my child?",
        "Preferred style: concise, warm, natural, simple, non-technical, and parent-facing.",
        "Naturally combine the approved reasons when that reads better.",
        "Do not add practical session availability unless session is one of the approved reasons.",
        "Approved Explanation Plan:",
        JSON.stringify(explanationPlan)
    ].join("\n");
}

function responseText(response) {
    if (typeof response?.text === "string") {
        return response.text.trim();
    }

    return "";
}

async function defaultSdkLoader() {
    return import("@google/genai");
}

function createGeminiLanguageProvider(options = {}) {
    const apiKey = options.apiKey ?? getGeminiApiKey();

    if (!apiKey) {
        return null;
    }

    const model = options.model ?? GEMINI_MODEL;
    const generationConfig = {
        ...GEMINI_GENERATION_CONFIG,
        ...(options.generationConfig ?? {})
    };
    const sdkLoader = options.sdkLoader ?? defaultSdkLoader;
    let client = options.client ?? null;

    return {
        model,
        generationConfig: clone(generationConfig),

        async generate({ language, explanationPlan }) {
            if (!client) {
                const { GoogleGenAI } = await sdkLoader();
                client = new GoogleGenAI({ apiKey });
            }

            const response = await client.models.generateContent({
                model,
                contents: buildUserPrompt({ language, explanationPlan }),
                config: {
                    ...generationConfig,
                    systemInstruction: SYSTEM_INSTRUCTION
                }
            });
            const text = responseText(response);

            if (text.length === 0) {
                return { text: "" };
            }

            return { text };
        }
    };
}

module.exports = {
    SYSTEM_INSTRUCTION,
    buildUserPrompt,
    createGeminiLanguageProvider
};
