const { ObjectId } = require("mongodb");
const {
    ANSWER_FORMAT,
    OPTION_SOURCE_TYPE,
    QUESTION_CATEGORY,
    QUESTION_DEFINITIONS,
    isOperationallyAvailable
} = require("../questionLibrary/questionLibrary");

const ANSWER_INTERPRETATION_STATUS = Object.freeze({
    VALID: "VALID",
    INVALID: "INVALID"
});

const ANSWER_INTERPRETATION_REASON = Object.freeze({
    ANSWER_REQUIRED: "ANSWER_REQUIRED",
    INVALID_ANSWER_FORMAT: "INVALID_ANSWER_FORMAT",
    ANSWER_NOT_ALLOWED: "ANSWER_NOT_ALLOWED",
    QUESTION_NOT_OPERATIONAL: "QUESTION_NOT_OPERATIONAL",
    QUESTION_NOT_FOUND: "QUESTION_NOT_FOUND",
    OPTION_NOT_FOUND: "OPTION_NOT_FOUND"
});

const ANSWER_EVIDENCE_TYPE = Object.freeze({
    PREFERENCE: "PREFERENCE",
    GOAL_INTENT: "GOAL_INTENT"
});

const ANSWER_EVIDENCE_SOURCE = "QUESTION_ANSWER";

function valid(evidence) {
    return {
        status: ANSWER_INTERPRETATION_STATUS.VALID,
        reason: null,
        evidence
    };
}

function invalid(reason) {
    return {
        status: ANSWER_INTERPRETATION_STATUS.INVALID,
        reason,
        evidence: null
    };
}

function approvedQuestion(questionOrId) {
    const questionId = typeof questionOrId === "string"
        ? questionOrId
        : questionOrId?.questionId;
    if (!questionId) return null;
    return QUESTION_DEFINITIONS.find((question) => question.questionId === questionId) ?? null;
}

function baseEvidence({ question, childId, parentId, questionHistoryId }) {
    return {
        childId,
        parentId,
        sourceQuestionId: question.questionId,
        ...(questionHistoryId === undefined || questionHistoryId === null ? {} : { questionHistoryId }),
        source: ANSWER_EVIDENCE_SOURCE
    };
}

function isBlankScalar(answer) {
    return answer === null ||
        answer === undefined ||
        (typeof answer === "string" && answer.trim().length === 0);
}

function isScalar(answer) {
    return answer === null ||
        answer === undefined ||
        ["string", "number", "boolean"].includes(typeof answer) ||
        answer instanceof ObjectId;
}

function canonicalId(value) {
    if (value instanceof ObjectId) return value.toHexString();
    if (typeof value === "string" && /^[a-fA-F0-9]{24}$/.test(value)) {
        return new ObjectId(value).toHexString();
    }
    return null;
}

function mongoId(value) {
    const canonical = canonicalId(value);
    return canonical ? new ObjectId(canonical) : null;
}

async function goalExists(db, goalId) {
    if (!db?.collection) throw new Error("DATABASE_REQUIRED");
    const _id = mongoId(goalId);
    if (!_id) return false;
    const goal = await db.collection("goal_library").findOne({ _id, isActive: true });
    return Boolean(goal);
}

function interpretSingleChoice({ question, answer, childId, parentId, questionHistoryId }) {
    if (isBlankScalar(answer)) return invalid(ANSWER_INTERPRETATION_REASON.ANSWER_REQUIRED);
    if (!isScalar(answer) || answer instanceof ObjectId) {
        return invalid(ANSWER_INTERPRETATION_REASON.INVALID_ANSWER_FORMAT);
    }
    if (!Array.isArray(question.allowedValues) || !question.allowedValues.includes(answer)) {
        return invalid(ANSWER_INTERPRETATION_REASON.ANSWER_NOT_ALLOWED);
    }

    if (question.category !== QUESTION_CATEGORY.PREFERENCE) {
        return invalid(ANSWER_INTERPRETATION_REASON.QUESTION_NOT_OPERATIONAL);
    }

    return valid({
        ...baseEvidence({ question, childId, parentId, questionHistoryId }),
        evidenceType: ANSWER_EVIDENCE_TYPE.PREFERENCE,
        target: {
            type: question.target.type,
            dimension: question.target.dimension
        },
        value: answer
    });
}

async function interpretMultiChoice({ db, question, answer, childId, parentId, questionHistoryId }) {
    if (!Array.isArray(answer)) return invalid(ANSWER_INTERPRETATION_REASON.INVALID_ANSWER_FORMAT);
    if (answer.length === 0) return invalid(ANSWER_INTERPRETATION_REASON.ANSWER_REQUIRED);

    const ids = [];
    const seen = new Set();
    for (const value of answer) {
        const canonical = canonicalId(value);
        if (!canonical) return invalid(ANSWER_INTERPRETATION_REASON.INVALID_ANSWER_FORMAT);
        if (seen.has(canonical)) return invalid(ANSWER_INTERPRETATION_REASON.ANSWER_NOT_ALLOWED);
        seen.add(canonical);
        ids.push(canonical);
    }

    if (
        question.category !== QUESTION_CATEGORY.GOAL_INTENT ||
        question.optionSource?.type !== OPTION_SOURCE_TYPE.GOAL_LIBRARY
    ) {
        return invalid(ANSWER_INTERPRETATION_REASON.QUESTION_NOT_OPERATIONAL);
    }

    for (const value of answer) {
        if (!await goalExists(db, value)) return invalid(ANSWER_INTERPRETATION_REASON.OPTION_NOT_FOUND);
    }

    return valid({
        ...baseEvidence({ question, childId, parentId, questionHistoryId }),
        evidenceType: ANSWER_EVIDENCE_TYPE.GOAL_INTENT,
        values: ids
    });
}

async function interpretQuestionAnswer({
    db,
    question,
    questionId,
    answer,
    childId,
    parentId,
    questionHistoryId
} = {}) {
    if (question && !isOperationallyAvailable(question)) {
        return invalid(ANSWER_INTERPRETATION_REASON.QUESTION_NOT_OPERATIONAL);
    }
    const definition = approvedQuestion(questionId ?? question);
    if (!definition) return invalid(ANSWER_INTERPRETATION_REASON.QUESTION_NOT_FOUND);
    if (!isOperationallyAvailable(definition)) {
        return invalid(ANSWER_INTERPRETATION_REASON.QUESTION_NOT_OPERATIONAL);
    }

    if (definition.answerFormat === ANSWER_FORMAT.SINGLE_CHOICE) {
        return interpretSingleChoice({ question: definition, answer, childId, parentId, questionHistoryId });
    }

    if (definition.answerFormat === ANSWER_FORMAT.MULTI_CHOICE) {
        return await interpretMultiChoice({ db, question: definition, answer, childId, parentId, questionHistoryId });
    }

    return invalid(ANSWER_INTERPRETATION_REASON.INVALID_ANSWER_FORMAT);
}

module.exports = {
    ANSWER_EVIDENCE_SOURCE,
    ANSWER_EVIDENCE_TYPE,
    ANSWER_INTERPRETATION_REASON,
    ANSWER_INTERPRETATION_STATUS,
    interpretQuestionAnswer
};
