const crypto = require("crypto");
const { ObjectId } = require("mongodb");
const { processContinuousLearningSource } = require("../learning/continuousLearningService");
const { canonicalParentDecisionId } = require("../learning/parentDecisionContract");
const {
    QUESTION_HISTORY_OUTCOME,
    updateQuestionHistoryOutcome
} = require("../questionEligibility/questionHistoryService");

const QUESTION_LEARNING_STATUS = Object.freeze({
    APPLIED: "APPLIED",
    INVALID: "INVALID",
    FAILED: "FAILED"
});

const QUESTION_LEARNING_REASON = Object.freeze({
    QUESTION_EVIDENCE_INTEGRATED: "QUESTION_EVIDENCE_INTEGRATED",
    UNSUPPORTED_EVIDENCE_TYPE: "UNSUPPORTED_EVIDENCE_TYPE",
    INVALID_EVIDENCE: "INVALID_EVIDENCE",
    SOURCE_CONFLICT: "SOURCE_CONFLICT",
    DATABASE_ERROR: "DATABASE_ERROR",
    LEARNING_NOT_APPLIED: "LEARNING_NOT_APPLIED"
});

const SUPPORTED_SUCCESS_STATUSES = new Set(["APPLIED", "IGNORED"]);
const SUPPORTED_SUCCESS_REASONS = new Set([
    "PARENT_DECISION_PERSISTED",
    "DUPLICATE_EVENT",
    "DUPLICATE_GOAL_SELECTION",
    "GOAL_NOT_SELECTED",
    "NO_GOAL_CHANGE"
]);

function result(status, reason, extra = {}) {
    return { status, reason, ...extra };
}

function stableObjectId(parts) {
    return new ObjectId(crypto
        .createHash("md5")
        .update(parts.map((part) => String(part ?? "")).join(":"))
        .digest("hex")
        .slice(0, 24));
}

function canonicalId(value) {
    return canonicalParentDecisionId(value);
}

function mongoId(value) {
    const id = canonicalId(value);
    return id ? new ObjectId(id) : null;
}

function evidenceQuestionHistoryId(evidence, questionHistoryId) {
    return questionHistoryId ?? evidence?.questionHistoryId;
}

function occurredDate(value) {
    if (value instanceof Date) return new Date(value);
    if (value === undefined || value === null) return new Date();
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) throw new Error("INVALID_OCCURRED_AT");
    return parsed;
}

function sourceId(historyId, decisionType, targetKey) {
    return stableObjectId(["questionAnswer", canonicalId(historyId) ?? historyId, decisionType, canonicalId(targetKey) ?? targetKey]);
}

function sourceDocument({ evidence, decisionType, decisionData, questionHistoryId, occurredAt, sessionId, recommendationId }) {
    return {
        _id: sourceId(questionHistoryId, decisionType, decisionData.dimension ?? decisionData.goalId),
        parentId: mongoId(evidence.parentId),
        childId: mongoId(evidence.childId),
        decisionType,
        decisionData: {
            ...decisionData,
            ...(decisionData.goalId ? { goalId: mongoId(decisionData.goalId) } : {})
        },
        occurredAt: occurredDate(occurredAt),
        context: {
            source: "QuestionAnswer",
            recommendationId: recommendationId ?? null,
            sessionId: sessionId ?? null
        }
    };
}

function comparableSource(document) {
    return JSON.stringify({
        _id: canonicalId(document._id),
        parentId: canonicalId(document.parentId),
        childId: canonicalId(document.childId),
        decisionType: document.decisionType,
        decisionData: {
            ...document.decisionData,
            ...(document.decisionData?.goalId ? { goalId: canonicalId(document.decisionData.goalId) } : {})
        },
        occurredAt: document.occurredAt instanceof Date ? document.occurredAt.toISOString() : document.occurredAt,
        context: {
            source: document.context?.source ?? null,
            recommendationId: document.context?.recommendationId == null ? null : canonicalId(document.context.recommendationId),
            sessionId: document.context?.sessionId == null ? null : canonicalId(document.context.sessionId)
        }
    });
}

async function ensureSourceRecord(db, document) {
    const existing = await db.collection("parent_decisions").findOne({ _id: document._id });
    if (existing) {
        if (comparableSource(existing) !== comparableSource(document)) {
            return result(QUESTION_LEARNING_STATUS.FAILED, QUESTION_LEARNING_REASON.SOURCE_CONFLICT, { source: existing });
        }
        return result(QUESTION_LEARNING_STATUS.APPLIED, "SOURCE_REUSED", { source: existing });
    }

    await db.collection("parent_decisions").insertOne(document);
    return result(QUESTION_LEARNING_STATUS.APPLIED, "SOURCE_CREATED", { source: document });
}

function learningSucceeded(item) {
    return SUPPORTED_SUCCESS_STATUSES.has(item?.status) &&
        SUPPORTED_SUCCESS_REASONS.has(item?.reasonCode);
}

async function processDecision({ db, client, document, dependencies }) {
    const source = await ensureSourceRecord(db, document);
    if (source.status !== QUESTION_LEARNING_STATUS.APPLIED) return source;

    const response = await processContinuousLearningSource("ParentDecision", source.source, {
        db,
        client: client ?? db.client,
        ...(dependencies ? { dependencies } : {})
    });
    const learning = response?.results?.[0];
    if (!learningSucceeded(learning)) {
        return result(QUESTION_LEARNING_STATUS.FAILED, QUESTION_LEARNING_REASON.LEARNING_NOT_APPLIED, {
            source: source.source,
            learning
        });
    }

    return result(QUESTION_LEARNING_STATUS.APPLIED, learning.reasonCode, {
        source: source.source,
        learning
    });
}

function activeGoalIds(parentGoals = []) {
    if (!Array.isArray(parentGoals)) return [];
    return parentGoals
        .filter((goal) => goal?.status === "Active" && canonicalId(goal.goalId))
        .map((goal) => canonicalId(goal.goalId));
}

async function preferenceDecisions(input) {
    const { evidence, questionHistoryId, occurredAt, sessionId, recommendationId } = input;
    const dimension = evidence?.target?.dimension;
    if (!dimension || evidence?.value === undefined) return null;
    return [sourceDocument({
        evidence,
        questionHistoryId,
        decisionType: "PreferenceUpdated",
        decisionData: { dimension, value: evidence.value },
        occurredAt,
        sessionId,
        recommendationId
    })];
}

async function goalDecisions({ db, evidence, questionHistoryId, occurredAt, sessionId, recommendationId }) {
    if (!Array.isArray(evidence?.values)) return null;
    const childId = mongoId(evidence.childId);
    const child = await db.collection("children").findOne({ _id: childId });
    if (!child) return null;

    const current = activeGoalIds(child.parentGoals);
    const selected = evidence.values.map(canonicalId).filter(Boolean);
    if (selected.length !== evidence.values.length) return null;
    const selectedSet = new Set(selected);
    const currentSet = new Set(current);
    const documents = [];

    for (const goalId of selected) {
        if (currentSet.has(goalId)) continue;
        documents.push(sourceDocument({
            evidence,
            questionHistoryId,
            decisionType: "GoalSelected",
            decisionData: { goalId, priority: 2 },
            occurredAt,
            sessionId,
            recommendationId
        }));
    }

    for (const goalId of current) {
        if (selectedSet.has(goalId)) continue;
        documents.push(sourceDocument({
            evidence,
            questionHistoryId,
            decisionType: "GoalRemoved",
            decisionData: { goalId },
            occurredAt,
            sessionId,
            recommendationId
        }));
    }

    return documents;
}

async function markAnswered(db, questionHistoryId) {
    if (!questionHistoryId) return null;
    return await updateQuestionHistoryOutcome({
        db,
        questionHistoryId,
        outcome: QUESTION_HISTORY_OUTCOME.ANSWERED
    });
}

async function integrateQuestionEvidence({
    db,
    client,
    evidence,
    questionHistoryId,
    occurredAt,
    sessionId,
    recommendationId,
    dependencies
} = {}) {
    if (!db?.collection) throw new Error("DATABASE_REQUIRED");
    const historyId = evidenceQuestionHistoryId(evidence, questionHistoryId);
    const common = { db, evidence, questionHistoryId: historyId, occurredAt, sessionId, recommendationId };

    let documents;
    if (evidence?.evidenceType === "PREFERENCE") {
        documents = await preferenceDecisions(common);
    } else if (evidence?.evidenceType === "GOAL_INTENT") {
        documents = await goalDecisions(common);
    } else {
        return result(QUESTION_LEARNING_STATUS.INVALID, QUESTION_LEARNING_REASON.UNSUPPORTED_EVIDENCE_TYPE, {
            operations: [],
            questionHistory: null
        });
    }

    if (!documents) {
        return result(QUESTION_LEARNING_STATUS.INVALID, QUESTION_LEARNING_REASON.INVALID_EVIDENCE, {
            operations: [],
            questionHistory: null
        });
    }

    const operations = [];
    for (const document of documents) {
        const operation = await processDecision({ db, client, document, dependencies });
        operations.push(operation);
        if (operation.status !== QUESTION_LEARNING_STATUS.APPLIED) {
            return result(operation.status, operation.reason, {
                operations,
                questionHistory: null
            });
        }
    }

    const questionHistory = await markAnswered(db, historyId);
    return result(QUESTION_LEARNING_STATUS.APPLIED, QUESTION_LEARNING_REASON.QUESTION_EVIDENCE_INTEGRATED, {
        operations,
        questionHistory
    });
}

module.exports = {
    QUESTION_LEARNING_REASON,
    QUESTION_LEARNING_STATUS,
    integrateQuestionEvidence
};
