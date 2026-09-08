const { ObjectId } = require("mongodb");
const {
    SCORING_FACTORS
} = require("./scoringContract");
const { toMongoId } = require("../utils/idUtils");

const RECOMMENDATION_ALGORITHM_VERSION = 1;
const METADATA_VERSION = 1;
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

function isValidDate(value) {
    return value instanceof Date &&
        !Number.isNaN(value.getTime());
}

function toRequiredObjectId(value, fieldPath) {
    const mongoId = toMongoId(value);

    if (!(mongoId instanceof ObjectId)) {
        throw new Error(`${fieldPath} must be a valid Mongo ObjectId`);
    }

    return mongoId;
}

function toOptionalObjectIds(values, fieldPath) {
    if (!Array.isArray(values)) {
        throw new Error(`${fieldPath} must be an array`);
    }

    return values.map((value, index) =>
        toRequiredObjectId(value, `${fieldPath}.${index}`)
    );
}

function validateAvailableScore(score, fieldPath) {
    if (
        typeof score !== "number" ||
        !Number.isFinite(score) ||
        score < 0 ||
        score > 1
    ) {
        throw new Error(`${fieldPath} must be finite from 0 to 1`);
    }
}

function validateFactor(factorResult, factorName) {
    if (!isPlainObject(factorResult)) {
        throw new Error(`recommendationResult.factors.${factorName} is required`);
    }

    if (typeof factorResult.available !== "boolean") {
        throw new Error(`recommendationResult.factors.${factorName}.available is invalid`);
    }

    if (factorResult.available) {
        validateAvailableScore(
            factorResult.score,
            `recommendationResult.factors.${factorName}.score`
        );
    } else if (factorResult.score !== null) {
        throw new Error(`Unavailable factor score must be null for ${factorName}`);
    }
}

function buildFactors(factors) {
    if (!isPlainObject(factors)) {
        throw new Error("recommendationResult.factors is required");
    }

    const factorKeys = Object.keys(factors);

    if (factorKeys.length !== CANONICAL_FACTORS.length) {
        throw new Error("RecommendationResult must contain exactly six factors");
    }

    for (const factor of CANONICAL_FACTORS) {
        if (!Object.prototype.hasOwnProperty.call(factors, factor)) {
            throw new Error(`RecommendationResult missing factor ${factor}`);
        }
    }

    for (const factor of factorKeys) {
        if (!CANONICAL_FACTORS.includes(factor)) {
            throw new Error(`RecommendationResult contains unknown factor ${factor}`);
        }
    }

    return CANONICAL_FACTORS.reduce((result, factor) => {
        validateFactor(factors[factor], factor);

        return {
            ...result,
            [factor]: {
                available: factors[factor].available,
                score: factors[factor].score
            }
        };
    }, {});
}

function buildScoring(scoring) {
    if (!isPlainObject(scoring)) {
        throw new Error("recommendationResult.scoring is required");
    }

    if (
        typeof scoring.availableWeight !== "number" ||
        !Number.isFinite(scoring.availableWeight) ||
        scoring.availableWeight <= 0
    ) {
        throw new Error("recommendationResult.scoring.availableWeight is invalid");
    }

    if (
        typeof scoring.availableFactorCount !== "number" ||
        !Number.isInteger(scoring.availableFactorCount) ||
        scoring.availableFactorCount <= 0
    ) {
        throw new Error("recommendationResult.scoring.availableFactorCount is invalid");
    }

    if (!Array.isArray(scoring.contributions)) {
        throw new Error("recommendationResult.scoring.contributions must be an array");
    }

    return {
        availableWeight: scoring.availableWeight,
        availableFactorCount: scoring.availableFactorCount,
        contributions: clone(scoring.contributions)
    };
}

function buildEvidence(evidence) {
    if (!isPlainObject(evidence)) {
        throw new Error("recommendationResult.evidence is required");
    }

    if (!isPlainObject(evidence.factors)) {
        throw new Error("recommendationResult.evidence.factors is required");
    }

    const factorKeys = Object.keys(evidence.factors);

    if (factorKeys.length !== CANONICAL_FACTORS.length) {
        throw new Error("RecommendationResult evidence must contain exactly six factors");
    }

    for (const factor of CANONICAL_FACTORS) {
        if (!Array.isArray(evidence.factors[factor])) {
            throw new Error(`RecommendationResult evidence missing factor ${factor}`);
        }
    }

    for (const factor of factorKeys) {
        if (!CANONICAL_FACTORS.includes(factor)) {
            throw new Error(`RecommendationResult evidence contains unknown factor ${factor}`);
        }
    }

    return {
        discovery: clone(evidence.discovery ?? {
            interests: [],
            goals: [],
            summary: []
        }),
        factors: CANONICAL_FACTORS.reduce((result, factor) => ({
            ...result,
            [factor]: clone(evidence.factors[factor])
        }), {})
    };
}

function buildRecommendedItem(recommendationResult) {
    if (!isPlainObject(recommendationResult)) {
        throw new Error("RecommendationResult must be an object");
    }

    const activityId = toRequiredObjectId(
        recommendationResult.activityId,
        "recommendationResult.activityId"
    );

    if (
        typeof recommendationResult.rank !== "number" ||
        !Number.isInteger(recommendationResult.rank) ||
        recommendationResult.rank <= 0
    ) {
        throw new Error("recommendationResult.rank must be a positive integer");
    }

    validateAvailableScore(
        recommendationResult.score,
        "recommendationResult.score"
    );

    return {
        activityId,
        eligibleSessionIds: toOptionalObjectIds(
            recommendationResult.eligibleSessionIds ?? [],
            "recommendationResult.eligibleSessionIds"
        ),
        rank: recommendationResult.rank,
        score: recommendationResult.score,
        factors: buildFactors(recommendationResult.factors),
        scoring: buildScoring(recommendationResult.scoring),
        evidence: buildEvidence(recommendationResult.evidence)
    };
}

function buildRecommendationSnapshot({
    parentId,
    childId,
    requestedAt,
    createdAt,
    recommendationResults
}) {
    if (!isValidDate(requestedAt)) {
        throw new Error("requestedAt must be a valid Date");
    }

    if (!isValidDate(createdAt)) {
        throw new Error("createdAt must be a valid Date");
    }

    if (!Array.isArray(recommendationResults)) {
        throw new Error("recommendationResults must be an array");
    }

    if (recommendationResults.length === 0) {
        throw new Error("recommendationResults must contain at least one result");
    }

    const createdAtSnapshot = new Date(createdAt.getTime());

    return {
        parentId: toRequiredObjectId(parentId, "parentId"),
        childId: toRequiredObjectId(childId, "childId"),
        recommendationContext: {
            requestedAt: new Date(requestedAt.getTime())
        },
        recommendedItems: recommendationResults.map(buildRecommendedItem),
        algorithmVersion: RECOMMENDATION_ALGORITHM_VERSION,
        response: {
            wasDisplayed: false,
            displayedAt: null,
            clickedActivityIds: [],
            savedActivityIds: [],
            bookedSessionIds: [],
            dismissedActivityIds: [],
            lastResponseAt: null
        },
        metadata: {
            version: METADATA_VERSION,
            createdAt: createdAtSnapshot,
            updatedAt: new Date(createdAtSnapshot.getTime())
        }
    };
}

module.exports = {
    RECOMMENDATION_ALGORITHM_VERSION,
    buildRecommendationSnapshot
};
