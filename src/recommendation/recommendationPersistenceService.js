const { getDatabase } = require("../config/mongodb");
const { ObjectId } = require("mongodb");
const { toMongoId, toGraphId } = require("../utils/idUtils");
const {
    buildRecommendationSnapshot
} = require("./recommendationSnapshotBuilder");

function isPlainObject(value) {
    return (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value)
    );
}

function toRequiredObjectId(value, fieldPath) {
    const mongoId = toMongoId(value);

    if (!(mongoId instanceof ObjectId)) {
        throw new Error(`${fieldPath} must be a valid Mongo ObjectId`);
    }

    return mongoId;
}

function buildPersistedExplanation(explanation) {
    if (!isPlainObject(explanation)) {
        throw new Error("explanation must be an object");
    }

    if (!Array.isArray(explanation.reasonTypes)) {
        throw new Error("explanation.reasonTypes must be an array");
    }

    if (explanation.language !== "en" && explanation.language !== "ar") {
        throw new Error("explanation.language must be en or ar");
    }

    if (
        typeof explanation.text !== "string" ||
        explanation.text.trim().length === 0
    ) {
        throw new Error("explanation.text must be a non-empty string");
    }

    if (
        explanation.source !== "generated" &&
        explanation.source !== "fallback"
    ) {
        throw new Error("explanation.source must be generated or fallback");
    }

    return {
        reasonTypes: [...explanation.reasonTypes],
        language: explanation.language,
        text: explanation.text,
        source: explanation.source
    };
}

async function persistRecommendationSnapshot({
    parentId,
    childId,
    requestedAt,
    recommendationResults
}) {
    const snapshot = buildRecommendationSnapshot({
        parentId,
        childId,
        requestedAt,
        createdAt: new Date(),
        recommendationResults
    });
    const db = getDatabase();

    try {
        const insertResult = await db.collection("recommendations")
            .insertOne(snapshot);

        return {
            recommendationId: toGraphId(insertResult.insertedId)
        };
    } catch (error) {
        throw new Error(
            `Recommendation persistence insert failed: ${error.message}`,
            { cause: error }
        );
    }
}

async function attachRecommendationItemExplanation({
    recommendationId,
    activityId,
    explanation
}) {
    const recommendationObjectId = toRequiredObjectId(
        recommendationId,
        "recommendationId"
    );
    const activityObjectId = toRequiredObjectId(activityId, "activityId");
    const persistedExplanation = buildPersistedExplanation(explanation);
    const db = getDatabase();

    try {
        const updateResult = await db.collection("recommendations")
            .updateOne(
                {
                    _id: recommendationObjectId,
                    "recommendedItems.activityId": activityObjectId
                },
                {
                    $set: {
                        "recommendedItems.$.explanation": persistedExplanation,
                        "metadata.updatedAt": new Date()
                    }
                }
            );

        if (updateResult.matchedCount !== 1) {
            throw new Error("matching recommended item was not found");
        }

        if (updateResult.modifiedCount !== 1) {
            throw new Error("matching recommended item was not updated");
        }

        return {
            recommendationId: toGraphId(recommendationObjectId),
            activityId: toGraphId(activityObjectId)
        };
    } catch (error) {
        throw new Error(
            `Recommendation explanation update failed: ${error.message}`,
            { cause: error }
        );
    }
}

module.exports = {
    persistRecommendationSnapshot,
    attachRecommendationItemExplanation
};
