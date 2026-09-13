const { ObjectId } = require("mongodb");
const { getDatabase } = require("../config/mongodb");
const { toMongoId, toGraphId } = require("../utils/idUtils");
const { SCORING_FACTORS } = require("../recommendation/scoringContract");

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

function toIdKey(value) {
    if (value === null || value === undefined) {
        return null;
    }

    return String(value);
}

function addUniqueId(idsByKey, value) {
    const key = toIdKey(value);

    if (!key) {
        return;
    }

    if (!idsByKey.has(key)) {
        idsByKey.set(key, value);
    }
}

function validateRecommendationResult(recommendationResult) {
    if (!isPlainObject(recommendationResult)) {
        throw new Error("RecommendationResult is required");
    }

    if (
        typeof recommendationResult.activityId !== "string" ||
        recommendationResult.activityId.trim().length === 0
    ) {
        throw new Error("RecommendationResult activityId is required");
    }

    if (!isPlainObject(recommendationResult.factors)) {
        throw new Error("RecommendationResult factors are required");
    }

    if (!isPlainObject(recommendationResult.evidence)) {
        throw new Error("RecommendationResult evidence is required");
    }

    if (!isPlainObject(recommendationResult.evidence.factors)) {
        throw new Error("RecommendationResult factor evidence is required");
    }

    for (const factor of CANONICAL_FACTORS) {
        const factorState = recommendationResult.factors[factor];

        if (!isPlainObject(factorState)) {
            throw new Error(`RecommendationResult factor is required for ${factor}`);
        }

        if (typeof factorState.available !== "boolean") {
            throw new Error(`RecommendationResult factor availability is invalid for ${factor}`);
        }

        if (factorState.available) {
            if (
                typeof factorState.score !== "number" ||
                !Number.isFinite(factorState.score) ||
                factorState.score < 0 ||
                factorState.score > 1
            ) {
                throw new Error(`RecommendationResult factor score is invalid for ${factor}`);
            }
        } else if (factorState.score !== null) {
            throw new Error(`Unavailable factor score must be null for ${factor}`);
        }

        if (!Array.isArray(recommendationResult.evidence.factors[factor])) {
            throw new Error(`RecommendationResult evidence is invalid for ${factor}`);
        }
    }

    if (
        recommendationResult.eligibleSessionIds !== undefined &&
        !Array.isArray(recommendationResult.eligibleSessionIds)
    ) {
        throw new Error("RecommendationResult eligibleSessionIds must be an array");
    }
}

function getMongoId(value) {
    const mongoId = toMongoId(value);

    return mongoId instanceof ObjectId ? mongoId : null;
}

async function findOneById(db, collectionName, id, projection) {
    const mongoId = getMongoId(id);

    if (!(mongoId instanceof ObjectId)) {
        return null;
    }

    return await db.collection(collectionName).findOne(
        { _id: mongoId },
        { projection }
    );
}

async function findManyByIds(db, collectionName, idsByKey, projection) {
    const ids = Array.from(idsByKey.values())
        .map(getMongoId)
        .filter((id) => id instanceof ObjectId);

    if (ids.length === 0) {
        return new Map();
    }

    const documents = await db.collection(collectionName)
        .find({
            _id: {
                $in: ids
            }
        })
        .project(projection)
        .toArray();

    return new Map(documents.map((document) => [
        toIdKey(document._id),
        document
    ]));
}

function collectInterestReferenceIds(evidence) {
    const subcategoryIds = new Map();
    const categoryIds = new Map();

    for (const item of evidence) {
        if (!isPlainObject(item)) {
            continue;
        }

        if (item.type === "exact_subcategory_interest") {
            addUniqueId(subcategoryIds, item.subcategoryId);
        }

        if (item.type === "category_fallback") {
            addUniqueId(categoryIds, item.categoryId);
            addUniqueId(subcategoryIds, item.excludedSubcategoryId);
        }
    }

    return {
        subcategoryIds,
        categoryIds
    };
}

function collectGoalReferenceIds(evidence) {
    const goalIds = new Map();
    const outcomeIds = new Map();

    for (const item of evidence) {
        if (!isPlainObject(item)) {
            continue;
        }

        addUniqueId(goalIds, item.goalId);

        for (const outcomeId of item.goalOutcomeIds ?? []) {
            addUniqueId(outcomeIds, outcomeId);
        }

        for (const outcomeId of item.matchedOutcomeIds ?? []) {
            addUniqueId(outcomeIds, outcomeId);
        }
    }

    return {
        goalIds,
        outcomeIds
    };
}

function createResolvedReference(id, document, idFieldName) {
    return {
        [idFieldName]: toGraphId(id),
        name: document?.name ?? null,
        resolved: document?.name !== undefined && document?.name !== null
    };
}

function enrichInterestEvidence(evidence, references) {
    return evidence.map((item) => {
        const enriched = clone(item);

        if (!isPlainObject(item)) {
            return enriched;
        }

        if (item.type === "exact_subcategory_interest") {
            enriched.subcategory = createResolvedReference(
                item.subcategoryId,
                references.subcategories.get(toIdKey(item.subcategoryId)),
                "subcategoryId"
            );
        }

        if (item.type === "category_fallback") {
            enriched.category = createResolvedReference(
                item.categoryId,
                references.categories.get(toIdKey(item.categoryId)),
                "categoryId"
            );
            enriched.excludedSubcategory = createResolvedReference(
                item.excludedSubcategoryId,
                references.subcategories.get(toIdKey(item.excludedSubcategoryId)),
                "subcategoryId"
            );
        }

        return enriched;
    });
}

function enrichGoalEvidence(evidence, references) {
    return evidence.map((item) => {
        const enriched = clone(item);

        if (!isPlainObject(item)) {
            return enriched;
        }

        if (item.goalId !== undefined && item.goalId !== null) {
            enriched.goal = createResolvedReference(
                item.goalId,
                references.goals.get(toIdKey(item.goalId)),
                "goalId"
            );
        }

        if (Array.isArray(item.goalOutcomeIds)) {
            enriched.goalOutcomes = item.goalOutcomeIds.map((outcomeId) =>
                createResolvedReference(
                    outcomeId,
                    references.outcomes.get(toIdKey(outcomeId)),
                    "outcomeId"
                )
            );
        }

        if (Array.isArray(item.matchedOutcomeIds)) {
            enriched.matchedOutcomes = item.matchedOutcomeIds.map((outcomeId) =>
                createResolvedReference(
                    outcomeId,
                    references.outcomes.get(toIdKey(outcomeId)),
                    "outcomeId"
                )
            );
        }

        return enriched;
    });
}

function buildFactorStates(recommendationResult, enrichedEvidence) {
    return CANONICAL_FACTORS.reduce((result, factor) => ({
        ...result,
        [factor]: {
            available: recommendationResult.factors[factor].available,
            score: recommendationResult.factors[factor].score,
            evidence: enrichedEvidence[factor]
        }
    }), {});
}

async function buildExplanationEvidence(
    recommendationResult,
    dependencies = {}
) {
    validateRecommendationResult(recommendationResult);

    const db = dependencies.db ?? getDatabase();

    if (!db) {
        throw new Error("Mongo database is required");
    }

    const factorEvidence = recommendationResult.evidence.factors;
    const interestReferenceIds =
        collectInterestReferenceIds(factorEvidence.interest);
    const goalReferenceIds = collectGoalReferenceIds(factorEvidence.goal);
    const activity = await findOneById(
        db,
        "activities",
        recommendationResult.activityId,
        {
            "basicInformation.nameAr": 1,
            "basicInformation.nameEn": 1
        }
    );
    const [
        subcategories,
        categories,
        goals,
        outcomes
    ] = await Promise.all([
        findManyByIds(
            db,
            "subcategories",
            interestReferenceIds.subcategoryIds,
            { name: 1 }
        ),
        findManyByIds(
            db,
            "categories",
            interestReferenceIds.categoryIds,
            { name: 1 }
        ),
        findManyByIds(
            db,
            "goal_library",
            goalReferenceIds.goalIds,
            { name: 1 }
        ),
        findManyByIds(
            db,
            "learning_outcomes",
            goalReferenceIds.outcomeIds,
            { name: 1 }
        )
    ]);
    const enrichedEvidence = {
        interest: enrichInterestEvidence(factorEvidence.interest, {
            subcategories,
            categories
        }),
        preference: clone(factorEvidence.preference),
        goal: enrichGoalEvidence(factorEvidence.goal, {
            goals,
            outcomes
        }),
        exploration: clone(factorEvidence.exploration),
        behavior: clone(factorEvidence.behavior),
        session: clone(factorEvidence.session)
    };
    const eligibleSessionIds = clone(
        recommendationResult.eligibleSessionIds ?? []
    );

    return {
        activity: {
            activityId: recommendationResult.activityId,
            nameAr: activity?.basicInformation?.nameAr ?? null,
            nameEn: activity?.basicInformation?.nameEn ?? null,
            resolved: activity !== null
        },
        factors: buildFactorStates(recommendationResult, enrichedEvidence),
        eligibleSessionIds,
        practicalEligibility: {
            hasEligibleSession: eligibleSessionIds.length > 0
        }
    };
}

module.exports = {
    buildExplanationEvidence
};
