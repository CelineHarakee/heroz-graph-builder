require("dotenv").config();

const GEMINI_API_KEY_ENV = "GEMINI_API_KEY";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";

const GEMINI_GENERATION_CONFIG = Object.freeze({
    candidateCount: 1,
    maxOutputTokens: 160,
    thinkingConfig: {
        thinkingLevel: "MINIMAL"
    }
});

function getGeminiApiKey() {
    const key = process.env[GEMINI_API_KEY_ENV];

    return typeof key === "string" && key.trim().length > 0
        ? key
        : null;
}

module.exports = {
    GEMINI_API_KEY_ENV,
    GEMINI_MODEL,
    GEMINI_GENERATION_CONFIG,
    getGeminiApiKey
};
