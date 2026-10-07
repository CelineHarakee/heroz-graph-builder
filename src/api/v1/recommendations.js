const { ObjectId } = require("mongodb");
const { toMongoId } = require("../../utils/idUtils");
const { API_BASE_PATH } = require("./index");
const { requireIdentifier, requireType } = require("../requestValidation");
const { ApiError } = require("../apiError");
const { successResponse, errorResponse } = require("../apiResponse");

const METHOD = "GET";
const PATH = `${API_BASE_PATH}/children/{childId}/recommendations`;

// Callable mounting contract, not a server. options contains internal test
// dependencies only; the product request supplies childId and required limit.
async function handleRecommendations(childId, limit, options = {}) {
    try {
        requireIdentifier(childId);
        const mongoId = toMongoId(childId);
        if (!(mongoId instanceof ObjectId)) {
            throw new ApiError(400, "BAD_REQUEST", "A valid child identifier is required.");
        }
        // Query strings are parsed without permissive coercion of other types.
        const topN = typeof limit === "string" && /^[0-9]+$/.test(limit)
            ? Number(limit) : limit;
        requireType(topN, "number");
        if (!Number.isInteger(topN) || topN <= 0) {
            throw new ApiError(400, "BAD_REQUEST", "Limit must be a positive integer.");
        }

        const db = options.db || require("../../config/mongodb").getDatabase();
        const child = await db.collection("children").findOne(
            { _id: mongoId }, { projection: { _id: 1 } }
        );
        if (!child) throw new ApiError(404, "CHILD_NOT_FOUND", "Child not found.");

        const generateRecommendations = options.generateRecommendations ||
            require("../../recommendation/recommendationEngineService").generateRecommendations;
        const result = await generateRecommendations(childId, topN);
        return {
            status: 200,
            body: successResponse({
                childId: result.childId,
                recommendations: result.recommendations.map(item => ({
                    activityId: item.activityId,
                    score: item.score,
                    rank: item.rank,
                    factors: item.factors,
                    evidence: item.evidence
                }))
            })
        };
    } catch (error) {
        return errorResponse(error);
    }
}

module.exports = { METHOD, PATH, handleRecommendations };
