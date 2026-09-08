const { ObjectId } = require("mongodb");
const { toMongoId, toGraphId } = require("../utils/idUtils");
const {
    SCORING_FACTORS,
    createCandidateScoringState
} = require("./scoringContract");
const {
    buildRecommendationContext
} = require("./recommendationContextService");
const {
    evaluateRecommendationEligibility
} = require("./recommendationEligibilityService");
const {
    calculateInterestFactor
} = require("./interestFactorService");
const {
    calculatePreferenceFactor
} = require("./preferenceFactorService");
const {
    calculateGoalFactor
} = require("./goalFactorService");
const {
    calculateExplorationFactor
} = require("./explorationFactorService");
const {
    calculateBehaviorFactor
} = require("./behaviorFactorService");
const {
    calculateSessionFactor
} = require("./sessionFactorService");
const {
    calculateFinalScore
} = require("./finalScoreService");
const { rankCandidates } = require("./rankingService");
const { selectTopN } = require("./selectionService");
const {
    buildRecommendationResults
} = require("./recommendationResultBuilder");
const {
    persistRecommendationSnapshot
} = require("./recommendationPersistenceService");

function isPlainObject(value) {
    return (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value)
    );
}

function validateTopN(topN) {
    if (
        typeof topN !== "number" ||
        !Number.isFinite(topN) ||
        !Number.isInteger(topN) ||
        topN <= 0
    ) {
        throw new Error("topN must be a positive integer number");
    }
}

function normalizeChildId(childId) {
    const mongoId = toMongoId(childId);
    const normalized = toGraphId(mongoId);

    if (
        !(mongoId instanceof ObjectId) ||
        typeof normalized !== "string" ||
        normalized.trim().length === 0 ||
        mongoId === null ||
        mongoId === undefined
    ) {
        throw new Error("childId must be a valid Mongo ObjectId");
    }

    return {
        mongoId,
        childId: normalized
    };
}

function validateContext(context) {
    if (!isPlainObject(context)) {
        throw new Error("Recommendation context could not be established");
    }

    if (!context.child) {
        throw new Error("Recommendation context child is required");
    }

    if (!context.parent) {
        throw new Error("Recommendation context parent is required");
    }

    if (!Array.isArray(context.candidates)) {
        throw new Error("Recommendation context candidates must be an array");
    }
}

function composeCompletedScoringState(state, results) {
    return {
        ...state,
        factors: {
            ...state.factors,
            [SCORING_FACTORS.INTEREST]: results.interest,
            [SCORING_FACTORS.PREFERENCE]: results.preference,
            [SCORING_FACTORS.GOAL]: results.goal,
            [SCORING_FACTORS.EXPLORATION]: results.exploration,
            [SCORING_FACTORS.BEHAVIOR]: results.behavior,
            [SCORING_FACTORS.SESSION]: results.session
        }
    };
}

function createRecommendationEngine(dependencies = {}) {
    const services = {
        buildRecommendationContext,
        evaluateRecommendationEligibility,
        createCandidateScoringState,
        calculateInterestFactor,
        calculatePreferenceFactor,
        calculateGoalFactor,
        calculateExplorationFactor,
        calculateBehaviorFactor,
        calculateSessionFactor,
        calculateFinalScore,
        rankCandidates,
        selectTopN,
        buildRecommendationResults,
        persistRecommendationSnapshot,
        now: () => new Date(),
        ...dependencies
    };

    async function generateRecommendations(childIdInput, topN) {
        validateTopN(topN);

        const normalizedChild = normalizeChildId(childIdInput);
        const requestedAt = services.now();

        if (
            !(requestedAt instanceof Date) ||
            Number.isNaN(requestedAt.getTime())
        ) {
            throw new Error("Recommendation engine clock returned invalid Date");
        }

        const context =
            await services.buildRecommendationContext(normalizedChild.mongoId);

        validateContext(context);

        const eligibilityResult =
            await services.evaluateRecommendationEligibility(context);
        const eligibleEvaluations =
            eligibilityResult?.eligibleCandidates;

        if (!Array.isArray(eligibleEvaluations)) {
            throw new Error("Eligibility result eligibleCandidates must be an array");
        }

        const scoredRecords = [];

        for (const eligibilityEvaluation of eligibleEvaluations) {
            const state =
                services.createCandidateScoringState(eligibilityEvaluation);
            const factorResults = {
                interest: services.calculateInterestFactor(
                    context,
                    eligibilityEvaluation
                ),
                preference: services.calculatePreferenceFactor(
                    context,
                    eligibilityEvaluation
                ),
                goal: services.calculateGoalFactor(
                    context,
                    eligibilityEvaluation
                ),
                exploration: services.calculateExplorationFactor(
                    context,
                    eligibilityEvaluation
                ),
                behavior: services.calculateBehaviorFactor(
                    context,
                    eligibilityEvaluation
                ),
                session: services.calculateSessionFactor(
                    eligibilityEvaluation,
                    context
                )
            };
            const scoringState =
                composeCompletedScoringState(state, factorResults);
            const finalScore = services.calculateFinalScore(scoringState);

            scoredRecords.push({
                candidate: eligibilityEvaluation.candidate,
                eligibilityEvaluation,
                scoringState,
                finalScore
            });
        }

        const rankingResult = services.rankCandidates(scoredRecords);
        const selectionResult = services.selectTopN(rankingResult, topN);
        const recommendationResults =
            services.buildRecommendationResults(selectionResult);

        if (recommendationResults.length === 0) {
            return {
                childId: normalizedChild.childId,
                requestedAt,
                recommendationId: null,
                recommendations: []
            };
        }

        const persistenceResult =
            await services.persistRecommendationSnapshot({
                parentId: context.parent._id,
                childId: context.child._id,
                requestedAt,
                recommendationResults
            });

        return {
            childId: normalizedChild.childId,
            requestedAt,
            recommendationId: persistenceResult.recommendationId,
            recommendations: recommendationResults
        };
    }

    return {
        generateRecommendations
    };
}

const defaultRecommendationEngine = createRecommendationEngine();

module.exports = {
    createRecommendationEngine,
    generateRecommendations: defaultRecommendationEngine.generateRecommendations
};
