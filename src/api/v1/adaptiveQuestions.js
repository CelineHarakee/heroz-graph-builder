const { ObjectId } = require("mongodb");
const { toMongoId } = require("../../utils/idUtils");
const { API_BASE_PATH } = require("./index");
const { ApiError } = require("../apiError");
const { requireIdentifier, requireType } = require("../requestValidation");
const { successResponse, errorResponse } = require("../apiResponse");
const { getNextQuestion } = require("../../services/adaptiveQuestionService");

const METHOD = "POST";
const PATH = `${API_BASE_PATH}/children/{childId}/questions/next`;

// options is server-owned dependency configuration, never the request body.
async function handleNextQuestion(childId, body, options = {}) {
    try {
        requireIdentifier(childId);
        requireType(body, "object");
        if (Object.keys(body).some(key => !["activityId", "sessionId"].includes(key))) {
            throw new ApiError(400, "BAD_REQUEST", "Unexpected request field.");
        }
        requireIdentifier(body.activityId);
        requireIdentifier(body.sessionId);
        if (!(toMongoId(childId) instanceof ObjectId) || !(toMongoId(body.activityId) instanceof ObjectId)) {
            throw new ApiError(400, "BAD_REQUEST", "Valid child and activity identifiers are required.");
        }
        const data = await getNextQuestion(childId, body.activityId, body.sessionId, options);
        return { status: 200, body: successResponse(data) };
    } catch (error) {
        return errorResponse(error);
    }
}

module.exports = { METHOD, PATH, handleNextQuestion };
