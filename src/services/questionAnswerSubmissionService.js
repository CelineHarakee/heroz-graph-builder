const { toMongoId } = require("../utils/idUtils");
const { ApiError } = require("../api/apiError");
const { QUESTION_DEFINITIONS, QUESTION_CATEGORY, isOperationallyAvailable } = require("../questionLibrary/questionLibrary");
const { QUESTION_HISTORY_OUTCOME } = require("../questionEligibility/questionHistoryService");
const { interpretQuestionAnswer, ANSWER_INTERPRETATION_STATUS } = require("../questionAnswer/answerInterpretationService");
const { integrateQuestionEvidence, QUESTION_LEARNING_STATUS } = require("../questionLearning/questionLearningIntegrationService");

async function submitQuestionAnswer(questionHistoryId, answer, options = {}) {
    const db = options.db || require("../config/mongodb").getDatabase();
    const services = { interpretQuestionAnswer, integrateQuestionEvidence, ...options.services };
    const _id = toMongoId(questionHistoryId);
    const history = await db.collection("question_history").findOne({ _id });
    if (!history) throw new ApiError(404, "QUESTION_HISTORY_NOT_FOUND", "Question presentation not found.");
    const success = { questionHistoryId: String(history._id), status: QUESTION_HISTORY_OUTCOME.ANSWERED };
    if (history.outcome === QUESTION_HISTORY_OUTCOME.ANSWERED) return success;
    if (history.outcome !== QUESTION_HISTORY_OUTCOME.PRESENTED) {
        throw new ApiError(409, "QUESTION_STATE_CONFLICT", "Question presentation cannot be answered.");
    }
    const question = QUESTION_DEFINITIONS.find(item => item.questionId === history.questionId);
    if (question?.category !== QUESTION_CATEGORY.PREFERENCE || !isOperationallyAvailable(question)) {
        throw new ApiError(409, "QUESTION_NOT_SUPPORTED", "Question presentation is not supported.");
    }
    const interpreted = await services.interpretQuestionAnswer({
        db, questionId: history.questionId, childId: history.childId,
        parentId: history.parentId, questionHistoryId: history._id, answer
    });
    if (interpreted?.status === ANSWER_INTERPRETATION_STATUS.INVALID) {
        const error = new ApiError(400, "INVALID_ANSWER", "Answer is not valid for this question.");
        error.interpretationReason = interpreted.reason;
        throw error;
    }
    if (interpreted?.status !== ANSWER_INTERPRETATION_STATUS.VALID) throw new Error("Unexpected interpretation result");
    // V1: source insertion, D7 transaction and history completion are separate.
    // Partial persistence can survive failure. Concurrent initial source inserts
    // can race. Only completed ANSWERED sequential retries bypass learning.
    const integrated = await services.integrateQuestionEvidence({
        db, client: options.client ?? db.client, evidence: interpreted.evidence,
        questionHistoryId: history._id, occurredAt: new Date()
        // D4 session strings are deliberately not forwarded to D7 context.
    });
    if (integrated?.status !== QUESTION_LEARNING_STATUS.APPLIED) throw new Error("Question learning did not succeed");
    const completed = await db.collection("question_history").findOne({ _id });
    if (completed?.outcome !== QUESTION_HISTORY_OUTCOME.ANSWERED) throw new Error("Question history completion not confirmed");
    return success;
}

module.exports = { submitQuestionAnswer };
