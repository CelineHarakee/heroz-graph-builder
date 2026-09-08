const { getDatabase } = require("../config/mongodb");
const { toGraphId } = require("../utils/idUtils");
const {
    buildRecommendationSnapshot
} = require("./recommendationSnapshotBuilder");

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

module.exports = {
    persistRecommendationSnapshot
};
