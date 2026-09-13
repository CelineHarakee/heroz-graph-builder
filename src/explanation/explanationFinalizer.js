const {
    validateExplanationGrounding
} = require("./groundingValidator");
const {
    buildFallbackExplanation
} = require("./fallbackExplanationBuilder");

function clone(value) {
    if (value === undefined) {
        return undefined;
    }

    return JSON.parse(JSON.stringify(value));
}

function finalizeExplanation({
    explanationPlan,
    generatedExplanation,
    language,
    generationError = null
}) {
    if (explanationPlan?.neutralFallbackRequired === true || generationError) {
        const fallback = buildFallbackExplanation(explanationPlan, language);

        return {
            reasonTypes: clone(fallback.reasonTypes),
            language: fallback.language,
            text: fallback.text,
            source: "fallback",
            validation: generationError
                ? {
                    valid: false,
                    errors: [
                        {
                            code: "GENERATION_FAILED",
                            message: generationError.message
                        }
                    ]
                }
                : {
                    valid: false,
                    errors: [
                        {
                            code: "NEUTRAL_FALLBACK_REQUIRED",
                            message: "Neutral fallback required"
                        }
                    ]
                }
        };
    }

    const validation = validateExplanationGrounding(
        explanationPlan,
        generatedExplanation,
        language
    );

    if (validation.valid) {
        return {
            reasonTypes: clone(generatedExplanation.reasonTypes),
            language: generatedExplanation.language,
            text: generatedExplanation.text,
            source: "generated",
            validation
        };
    }

    const fallback = buildFallbackExplanation(explanationPlan, language);

    return {
        reasonTypes: clone(fallback.reasonTypes),
        language: fallback.language,
        text: fallback.text,
        source: "fallback",
        validation
    };
}

module.exports = {
    finalizeExplanation
};
