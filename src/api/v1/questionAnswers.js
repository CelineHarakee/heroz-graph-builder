const { ObjectId } = require("mongodb");
const { toMongoId } = require("../../utils/idUtils");
const { API_BASE_PATH } = require("./index");
const { ApiError } = require("../apiError");
const { requireIdentifier, requireType } = require("../requestValidation");
const { successResponse, errorResponse } = require("../apiResponse");
const { submitQuestionAnswer } = require("../../services/questionAnswerSubmissionService");

const METHOD = "POST";
const PATH = `${API_BASE_PATH}/question-presentations/{questionHistoryId}/answer`;

// options is server-owned configuration, never request input.
async function handleQuestionAnswer(questionHistoryId, body, options = {}) {
    try {
        requireIdentifier(questionHistoryId);
        if (!(toMongoId(questionHistoryId) instanceof ObjectId)) {
            throw new ApiError(400, "BAD_REQUEST", "A valid question presentation identifier is required.");
        }
        requireType(body, "object");
        if (!Object.hasOwn(body, "answer") || Object.keys(body).some(key => key !== "answer")) {
            throw new ApiError(400, "BAD_REQUEST", "Request must contain only an answer.");
        }
        const data = await submitQuestionAnswer(questionHistoryId, body.answer, options);
        return { status: 200, body: successResponse(data) };
    } catch (error) {
        return errorResponse(error);
    }
}

module.exports = { METHOD, PATH, handleQuestionAnswer };
