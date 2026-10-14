const { instrumentApi } = require("../../observability/structuredLogger");
const { captureFailure } = require("../../observability/traceContext");
const { ObjectId } = require("mongodb");
const { toMongoId } = require("../../utils/idUtils");
const { API_BASE_PATH } = require("./index");
const { ApiError } = require("../apiError");
const { requireIdentifier, requireType } = require("../requestValidation");
const { successResponse, errorResponse } = require("../apiResponse");
const { submitInteraction } = require("../../services/interactionSubmissionService");

const METHOD = "POST";
const PATH = `${API_BASE_PATH}/children/{childId}/interactions`;
// Product scope only. D7 owns source normalization and all learning rules.
const DIRECT_TYPES = new Set(["View", "Click", "Save", "Unsave", "Dismiss", "Rate"]);

async function handleInteraction(childId, body, options = {}) {
    try {
        requireIdentifier(childId);
        requireType(body, "object");
        requireIdentifier(body.activityId);
        requireType(body.interactionType, "string");
        if (!(toMongoId(childId) instanceof ObjectId) || !(toMongoId(body.activityId) instanceof ObjectId)) {
            throw new ApiError(400, "BAD_REQUEST", "Valid child and activity identifiers are required.");
        }
        if (!DIRECT_TYPES.has(body.interactionType)) {
            throw new ApiError(400, "BAD_REQUEST", "Interaction type is not supported.");
        }
        const fields = body.interactionType === "Rate"
            ? ["activityId", "interactionType", "ratingValue"] : ["activityId", "interactionType"];
        if (Object.keys(body).some(key => !fields.includes(key))) {
            throw new ApiError(400, "BAD_REQUEST", "Unexpected request field.");
        }
        // Missing/invalid Rate values deliberately remain owned by D7 validation.
        const data = await submitInteraction(childId, body, options);
        return { status: 200, body: successResponse(data) };
    } catch (error) {
        captureFailure(error);
        return errorResponse(error);
    }
}

module.exports = { METHOD, PATH, handleInteraction: instrumentApi(handleInteraction, "handleInteraction", 2) };
