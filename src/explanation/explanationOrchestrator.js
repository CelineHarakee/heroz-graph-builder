const {
    buildExplanationEvidence
} = require("./explanationEvidenceBuilder");
const {
    buildExplanationPlan
} = require("./explanationPlanBuilder");
const {
    generateExplanation
} = require("./languageGenerator");
const {
    resolveStoredLanguage
} = require("./languageResolver");
const {
    finalizeExplanation
} = require("./explanationFinalizer");
const {
    attachRecommendationItemExplanation
} = require("../recommendation/recommendationPersistenceService");

function clone(value) {
    if (value === undefined) {
        return undefined;
    }

    return JSON.parse(JSON.stringify(value));
}

function buildResponseExplanation(finalizedExplanation) {
    return {
        reasonTypes: [...finalizedExplanation.reasonTypes],
        language: finalizedExplanation.language,
        text: finalizedExplanation.text,
        source: finalizedExplanation.source
    };
}

async function buildFinalizedExplanation({
    recommendationResult,
    parent,
    languageProvider,
    dependencies = {}
}) {
    const explanationEvidence =
        await (dependencies.buildExplanationEvidence ?? buildExplanationEvidence)(
            recommendationResult
        );
    const explanationPlan =
        (dependencies.buildExplanationPlan ?? buildExplanationPlan)(
            explanationEvidence
        );
    const language =
        (dependencies.resolveStoredLanguage ?? resolveStoredLanguage)({
            parent
        });
    let generatedExplanation = null;
    let generationError = null;

    try {
        generatedExplanation =
            await (dependencies.generateExplanation ?? generateExplanation)(
                explanationPlan,
                {
                    parent,
                    provider: languageProvider
                }
            );
    } catch (error) {
        generationError = error;
    }

    return (dependencies.finalizeExplanation ?? finalizeExplanation)({
        explanationPlan,
        generatedExplanation,
        language,
        generationError
    });
}

async function attachRecommendationExplanations({
    recommendationId,
    recommendationResults,
    parent,
    languageProvider,
    dependencies = {}
}) {
    const explainedRecommendations = [];
    const attachExplanation =
        dependencies.attachRecommendationItemExplanation ??
        attachRecommendationItemExplanation;

    for (const recommendationResult of recommendationResults) {
        const finalizedExplanation = await buildFinalizedExplanation({
            recommendationResult,
            parent,
            languageProvider,
            dependencies
        });
        const explanation = buildResponseExplanation(finalizedExplanation);

        await attachExplanation({
            recommendationId,
            activityId: recommendationResult.activityId,
            explanation
        });

        explainedRecommendations.push({
            ...clone(recommendationResult),
            explanation
        });
    }

    return {
        recommendationId,
        recommendations: explainedRecommendations
    };
}

module.exports = {
    attachRecommendationExplanations
};
