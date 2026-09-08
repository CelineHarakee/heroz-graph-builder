const {
    SCORING_FACTORS
} = require("./scoringContract");
const { toGraphId } = require("../utils/idUtils");

const CANONICAL_FACTORS = Object.values(SCORING_FACTORS);

function isPlainObject(value) {
    return (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value)
    );
}

function clone(value) {
    if (value === undefined) {
        return undefined;
    }

    return JSON.parse(JSON.stringify(value));
}

function getActivityId(record) {
    const activityId =
        record.candidate?.currentActivity?._id ??
        record.candidate?.activity?.activityId ??
        null;
    const normalized = toGraphId(activityId);

    return typeof normalized === "string" && normalized.trim().length > 0
        ? normalized
        : null;
}

function validateSelectedFinalScore(finalScore) {
    if (!isPlainObject(finalScore)) {
        throw new Error("Selected record finalScore is required");
    }

    if (finalScore.available !== true) {
        throw new Error("Selected record finalScore must be available");
    }

    if (
        typeof finalScore.score !== "number" ||
        !Number.isFinite(finalScore.score) ||
        finalScore.score < 0 ||
        finalScore.score > 1
    ) {
        throw new Error("Selected record finalScore score must be finite from 0 to 1");
    }

    if (
        typeof finalScore.availableWeight !== "number" ||
        !Number.isFinite(finalScore.availableWeight) ||
        finalScore.availableWeight <= 0
    ) {
        throw new Error("Selected record finalScore availableWeight is invalid");
    }

    if (
        typeof finalScore.availableFactorCount !== "number" ||
        !Number.isInteger(finalScore.availableFactorCount) ||
        finalScore.availableFactorCount <= 0
    ) {
        throw new Error("Selected record finalScore availableFactorCount is invalid");
    }

    if (!Array.isArray(finalScore.contributions)) {
        throw new Error("Selected record finalScore contributions must be an array");
    }
}

function validateFactorResult(result, factor) {
    if (!isPlainObject(result)) {
        throw new Error(`Selected record factor result is required for ${factor}`);
    }

    if (result.factor !== factor) {
        throw new Error(`Selected record factor result does not match ${factor}`);
    }

    if (typeof result.available !== "boolean") {
        throw new Error(`Selected record factor availability is invalid for ${factor}`);
    }

    if (!Array.isArray(result.evidence)) {
        throw new Error(`Selected record factor evidence is invalid for ${factor}`);
    }

    if (result.available) {
        if (
            typeof result.score !== "number" ||
            !Number.isFinite(result.score) ||
            result.score < 0 ||
            result.score > 1
        ) {
            throw new Error(`Selected record factor score is invalid for ${factor}`);
        }
    } else if (result.score !== null) {
        throw new Error(`Unavailable selected factor score must be null for ${factor}`);
    }
}

function validateScoringState(scoringState) {
    if (!isPlainObject(scoringState)) {
        throw new Error("Selected record scoringState is required");
    }

    if (!isPlainObject(scoringState.factors)) {
        throw new Error("Selected record scoringState factors are required");
    }

    const factorKeys = Object.keys(scoringState.factors);

    if (factorKeys.length !== CANONICAL_FACTORS.length) {
        throw new Error("Selected record scoringState must contain exactly six factors");
    }

    for (const factor of CANONICAL_FACTORS) {
        if (!Object.prototype.hasOwnProperty.call(scoringState.factors, factor)) {
            throw new Error(`Selected record missing factor: ${factor}`);
        }

        validateFactorResult(scoringState.factors[factor], factor);
    }

    for (const factor of factorKeys) {
        if (!CANONICAL_FACTORS.includes(factor)) {
            throw new Error(`Selected record unknown factor: ${factor}`);
        }
    }
}

function getEligibleSessionIds(eligibilityEvaluation) {
    const eligibleSessions = eligibilityEvaluation?.eligibleSessions;

    if (!Array.isArray(eligibleSessions)) {
        return [];
    }

    return eligibleSessions
        .map((session) => toGraphId(session?._id))
        .filter((sessionId) =>
            typeof sessionId === "string" && sessionId.trim().length > 0
        );
}

function buildDiscoveryEvidence(candidate) {
    if (candidate?.evidence !== undefined && candidate.evidence !== null) {
        return clone(candidate.evidence);
    }

    return {
        interests: [],
        goals: [],
        summary: []
    };
}

function buildFactors(factors) {
    return CANONICAL_FACTORS.reduce((result, factor) => ({
        ...result,
        [factor]: {
            available: factors[factor].available,
            score: factors[factor].score
        }
    }), {});
}

function buildFactorEvidence(factors) {
    return CANONICAL_FACTORS.reduce((result, factor) => ({
        ...result,
        [factor]: clone(factors[factor].evidence)
    }), {});
}

function buildRecommendationResult(record) {
    if (!isPlainObject(record)) {
        throw new Error("Selected record must be an object");
    }

    const activityId = getActivityId(record);

    if (activityId === null) {
        throw new Error("Selected record requires a canonical Activity ID");
    }

    if (
        typeof record.rank !== "number" ||
        !Number.isInteger(record.rank) ||
        record.rank <= 0
    ) {
        throw new Error("Selected record rank must be a positive integer");
    }

    validateSelectedFinalScore(record.finalScore);
    validateScoringState(record.scoringState);

    return {
        activityId,
        rank: record.rank,
        score: record.finalScore.score,
        factors: buildFactors(record.scoringState.factors),
        scoring: {
            availableWeight: record.finalScore.availableWeight,
            availableFactorCount: record.finalScore.availableFactorCount,
            contributions: clone(record.finalScore.contributions)
        },
        eligibleSessionIds: getEligibleSessionIds(record.eligibilityEvaluation),
        evidence: {
            discovery: buildDiscoveryEvidence(record.candidate),
            factors: buildFactorEvidence(record.scoringState.factors)
        }
    };
}

function buildRecommendationResults(selectionResult) {
    if (!isPlainObject(selectionResult)) {
        throw new Error("Selection result is required");
    }

    if (!Array.isArray(selectionResult.selected)) {
        throw new Error("Selection result selected must be an array");
    }

    return selectionResult.selected.map(buildRecommendationResult);
}

module.exports = {
    buildRecommendationResults
};
