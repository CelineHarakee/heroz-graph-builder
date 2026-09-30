const { D1_SUFFICIENCY } = require("../knowledgeGap/knowledgeGapConstants");
const {
    QUESTION_HISTORY_COLLECTION,
    QUESTION_HISTORY_OUTCOME
} = require("./questionHistoryService");

const QUESTION_ELIGIBILITY_STATUS = Object.freeze({
    ELIGIBLE: "ELIGIBLE",
    INELIGIBLE: "INELIGIBLE"
});

const QUESTION_INELIGIBILITY_REASON = Object.freeze({
    KNOWLEDGE_NO_LONGER_NEEDED: "KNOWLEDGE_NO_LONGER_NEEDED",
    QUESTION_COOLDOWN: "QUESTION_COOLDOWN",
    SESSION_LIMIT_REACHED: "SESSION_LIMIT_REACHED"
});

const ACTIVE_KNOWLEDGE_STATES = new Set([
    D1_SUFFICIENCY.UNCERTAIN,
    D1_SUFFICIENCY.INSUFFICIENT,
    D1_SUFFICIENCY.BLOCKED
]);

const PRESENTATION_OUTCOMES = Object.values(QUESTION_HISTORY_OUTCOME);
const QUESTION_COOLDOWN_MS = 28 * 24 * 60 * 60 * 1000;

function result(status, reason = null) {
    return { status, reason };
}

function eligible() {
    return result(QUESTION_ELIGIBILITY_STATUS.ELIGIBLE);
}

function ineligible(reason) {
    return result(QUESTION_ELIGIBILITY_STATUS.INELIGIBLE, reason);
}

function normalizeDate(value) {
    if (value instanceof Date) return new Date(value);
    if (value === undefined || value === null) return new Date();
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) throw new Error("INVALID_CURRENT_TIME");
    return parsed;
}

function questionIdFromCandidate(questionCandidate) {
    return questionCandidate?.questionId ?? questionCandidate?.question?.questionId;
}

function assertRequired(value, reason) {
    if (value === undefined || value === null || value === "") throw new Error(reason);
}

function isKnowledgeStillNeeded(knowledgeNeed) {
    return ACTIVE_KNOWLEDGE_STATES.has(knowledgeNeed?.sufficiencyState);
}

function historyCollection(db) {
    if (!db?.collection) throw new Error("DATABASE_REQUIRED");
    return db.collection(QUESTION_HISTORY_COLLECTION);
}

async function mostRecentQuestionHistory(db, childId, questionId) {
    return await historyCollection(db).findOne(
        { childId, questionId, outcome: { $in: PRESENTATION_OUTCOMES } },
        { sort: { askedAt: -1 } }
    );
}

async function sessionPresentation(db, sessionId) {
    return await historyCollection(db).findOne(
        { sessionId, outcome: { $in: PRESENTATION_OUTCOMES } }
    );
}

async function evaluateQuestionEligibility({
    db,
    childId,
    parentId,
    sessionId,
    questionCandidate,
    knowledgeNeed,
    currentTime
}) {
    void parentId;
    const evaluatedAt = normalizeDate(currentTime);
    const questionId = questionIdFromCandidate(questionCandidate);
    assertRequired(childId, "CHILD_ID_REQUIRED");
    assertRequired(sessionId, "SESSION_ID_REQUIRED");
    if (!questionId) throw new Error("QUESTION_ID_REQUIRED");

    if (!isKnowledgeStillNeeded(knowledgeNeed)) {
        return ineligible(QUESTION_INELIGIBILITY_REASON.KNOWLEDGE_NO_LONGER_NEEDED);
    }

    const recentHistory = await mostRecentQuestionHistory(db, childId, questionId);
    if (recentHistory?.askedAt) {
        const askedAt = normalizeDate(recentHistory.askedAt);
        if (evaluatedAt.getTime() - askedAt.getTime() < QUESTION_COOLDOWN_MS) {
            return ineligible(QUESTION_INELIGIBILITY_REASON.QUESTION_COOLDOWN);
        }
    }

    const presentedThisSession = await sessionPresentation(db, sessionId);
    if (presentedThisSession) {
        return ineligible(QUESTION_INELIGIBILITY_REASON.SESSION_LIMIT_REACHED);
    }

    return eligible();
}

module.exports = {
    QUESTION_ELIGIBILITY_STATUS,
    QUESTION_INELIGIBILITY_REASON,
    QUESTION_COOLDOWN_MS,
    evaluateQuestionEligibility,
    isKnowledgeStillNeeded
};
