const { ObjectId } = require("mongodb");
const { toMongoId } = require("../utils/idUtils");
const { ApiError } = require("../api/apiError");
const { D1_EVALUATION_STATUS } = require("../knowledgeGap/knowledgeGapConstants");
const { evaluateKnowledgeGaps } = require("../knowledgeGap/knowledgeGapEngineService");
const { findQuestionsForKnowledgeNeed } = require("../questionLibrary/questionRetrievalService");
const { QUESTION_CATEGORY, isOperationallyAvailable } = require("../questionLibrary/questionLibrary");
const { evaluateQuestionEligibility, QUESTION_ELIGIBILITY_STATUS } = require("../questionEligibility/questionEligibilityService");
const { selectQuestion } = require("../questionSelection/questionSelectionService");
const { recordQuestionPresentation } = require("../questionEligibility/questionHistoryService");

async function getNextQuestion(childId, activityId, sessionId, options = {}) {
    const db = options.db || require("../config/mongodb").getDatabase();
    if (!db) throw new Error("Database unavailable");
    const services = {
        evaluateKnowledgeGaps, findQuestionsForKnowledgeNeed,
        evaluateQuestionEligibility, selectQuestion, recordQuestionPresentation,
        ...options.services
    };
    const child = await db.collection("children").findOne({ _id: toMongoId(childId) });
    if (!child) throw new ApiError(404, "CHILD_NOT_FOUND", "Child not found.");
    const parentId = toMongoId(child.parentId);
    if (!(parentId instanceof ObjectId)) throw new Error("Parent context unavailable");
    const currentTime = new Date();
    const evaluation = await services.evaluateKnowledgeGaps(child._id, toMongoId(activityId), { db, evaluatedAt: currentTime });
    if (evaluation?.evaluation?.status !== D1_EVALUATION_STATUS.RESOLVED) {
        const reason = evaluation?.evaluation?.reason;
        if (reason === "CHILD_NOT_FOUND") throw new ApiError(404, "CHILD_NOT_FOUND", "Child not found.");
        if (reason === "ACTIVITY_NOT_FOUND") throw new ApiError(404, "ACTIVITY_NOT_FOUND", "Activity not found.");
        throw new Error("Knowledge context unavailable");
    }
    const eligibleCandidates = [];
    for (const knowledgeNeed of evaluation.knowledgeGaps) {
        const candidates = services.findQuestionsForKnowledgeNeed(knowledgeNeed);
        for (const candidate of candidates) {
            if (candidate.question?.category !== QUESTION_CATEGORY.PREFERENCE ||
                !isOperationallyAvailable(candidate.question)) continue;
            const attached = { ...candidate, knowledgeNeed };
            const eligibility = await services.evaluateQuestionEligibility({
                db, childId: child._id, parentId, sessionId,
                questionCandidate: attached, knowledgeNeed, currentTime
            });
            if (eligibility.status === QUESTION_ELIGIBILITY_STATUS.ELIGIBLE) eligibleCandidates.push(attached);
        }
    }
    const selection = services.selectQuestion(eligibleCandidates);
    if (selection.selectedQuestion === null) return { childId: String(child._id), question: null };
    const question = selection.selectedQuestion.question;
    // V1 accepts the existing race: eligibility and insertion are separate.
    // Sequential retries use existing history rules; no locking is added here.
    const history = await services.recordQuestionPresentation({
        db, questionId: question.questionId, childId: child._id, parentId, sessionId,
        askedAt: currentTime
    });
    return {
        childId: String(child._id),
        question: {
            questionId: question.questionId,
            fallbackTemplate: question.fallbackTemplate,
            answerFormat: question.answerFormat,
            allowedValues: question.allowedValues
        },
        questionHistoryId: String(history._id)
    };
}

module.exports = { getNextQuestion };
