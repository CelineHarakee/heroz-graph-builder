const { ObjectId } = require("mongodb");

const QUESTION_HISTORY_COLLECTION = "question_history";

const QUESTION_HISTORY_OUTCOME = Object.freeze({
    PRESENTED: "PRESENTED",
    ANSWERED: "ANSWERED",
    SKIPPED: "SKIPPED"
});

const FINAL_OUTCOMES = new Set([
    QUESTION_HISTORY_OUTCOME.ANSWERED,
    QUESTION_HISTORY_OUTCOME.SKIPPED
]);

function collection(db) {
    if (!db?.collection) throw new Error("DATABASE_REQUIRED");
    return db.collection(QUESTION_HISTORY_COLLECTION);
}

function normalizeDate(value, fallback = new Date()) {
    if (value instanceof Date) return new Date(value);
    if (value === undefined || value === null) return new Date(fallback);
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) throw new Error("INVALID_DATE");
    return parsed;
}

function assertRequired(value, reason) {
    if (value === undefined || value === null || value === "") throw new Error(reason);
}

async function recordQuestionPresentation({
    db,
    questionId,
    childId,
    parentId,
    sessionId,
    askedAt
}) {
    assertRequired(questionId, "QUESTION_ID_REQUIRED");
    assertRequired(childId, "CHILD_ID_REQUIRED");
    assertRequired(parentId, "PARENT_ID_REQUIRED");
    assertRequired(sessionId, "SESSION_ID_REQUIRED");

    const document = {
        _id: new ObjectId(),
        questionId,
        childId,
        parentId,
        askedAt: normalizeDate(askedAt),
        outcome: QUESTION_HISTORY_OUTCOME.PRESENTED,
        sessionId
    };

    await collection(db).insertOne(document);
    return document;
}

async function updateQuestionHistoryOutcome({
    db,
    questionHistoryId,
    outcome
}) {
    assertRequired(questionHistoryId, "QUESTION_HISTORY_ID_REQUIRED");
    if (!FINAL_OUTCOMES.has(outcome)) throw new Error("UNSUPPORTED_QUESTION_HISTORY_OUTCOME");

    const _id = typeof questionHistoryId === "string"
        ? new ObjectId(questionHistoryId)
        : questionHistoryId;

    const result = await collection(db).updateOne(
        { _id, outcome: QUESTION_HISTORY_OUTCOME.PRESENTED },
        { $set: { outcome } }
    );

    return {
        status: result.matchedCount === 1 ? "UPDATED" : "NOT_UPDATED"
    };
}

module.exports = {
    QUESTION_HISTORY_COLLECTION,
    QUESTION_HISTORY_OUTCOME,
    recordQuestionPresentation,
    updateQuestionHistoryOutcome
};
