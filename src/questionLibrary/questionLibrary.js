const { PREFERENCE_VALUES } = require("../learning/parentDecisionContract");

const QUESTION_CATEGORY = Object.freeze({
    PREFERENCE: "PREFERENCE",
    GOAL_INTENT: "GOAL_INTENT",
    INTEREST: "INTEREST"
});

const ANSWER_FORMAT = Object.freeze({
    SINGLE_CHOICE: "SINGLE_CHOICE",
    MULTI_CHOICE: "MULTI_CHOICE"
});

const RESPONDENT = Object.freeze({
    PARENT: "PARENT"
});

const LEARNING_INTEGRATION = Object.freeze({
    AVAILABLE: "AVAILABLE",
    NOT_IMPLEMENTED: "NOT_IMPLEMENTED"
});

const QUESTION_STATUS = Object.freeze({
    DRAFT: "DRAFT",
    ACTIVE: "ACTIVE",
    INACTIVE: "INACTIVE"
});

const OPTION_SOURCE_TYPE = Object.freeze({
    GOAL_LIBRARY: "GOAL_LIBRARY"
});

const PREFERENCE_QUESTION_CONFIG = Object.freeze([
    Object.freeze({
        questionId: "Q_PREF_ENVIRONMENT_001",
        dimension: "environment",
        questionIntent: "Learn which activity environment the Child generally prefers.",
        fallbackTemplate: "Does {childName} generally prefer indoor, outdoor, or mixed activities?"
    }),
    Object.freeze({
        questionId: "Q_PREF_SOCIAL_001",
        dimension: "socialStyle",
        questionIntent: "Learn the Child's preferred social setting when participating in activities.",
        fallbackTemplate: "Does {childName} generally prefer team, individual, or mixed activities?"
    }),
    Object.freeze({
        questionId: "Q_PREF_DIFFICULTY_001",
        dimension: "difficulty",
        questionIntent: "Learn the level of challenge the Child generally prefers in activities.",
        fallbackTemplate: "What level of challenge does {childName} generally prefer in activities?"
    }),
    Object.freeze({
        questionId: "Q_PREF_EXPERIENCE_001",
        dimension: "experienceStyle",
        questionIntent: "Learn the style of activity experience the Child generally prefers.",
        fallbackTemplate: "What style of activity experience does {childName} generally prefer?"
    }),
    Object.freeze({
        questionId: "Q_PREF_COMMITMENT_001",
        dimension: "commitmentPreference",
        questionIntent: "Learn whether the Parent generally prefers one-time or recurring activity experiences for the Child.",
        fallbackTemplate: "Do you generally prefer one-time or weekly activities for {childName}?"
    })
]);

function freezeQuestion(question) {
    const frozen = { ...question };
    if (question.target) frozen.target = Object.freeze({ ...question.target });
    if (question.allowedValues) frozen.allowedValues = Object.freeze([...question.allowedValues]);
    if (question.optionSource) frozen.optionSource = Object.freeze({ ...question.optionSource });
    return Object.freeze(frozen);
}

function preferenceQuestion(config) {
    return freezeQuestion({
        questionId: config.questionId,
        category: QUESTION_CATEGORY.PREFERENCE,
        target: {
            type: "ChildPreference",
            dimension: config.dimension
        },
        questionIntent: config.questionIntent,
        fallbackTemplate: config.fallbackTemplate,
        answerFormat: ANSWER_FORMAT.SINGLE_CHOICE,
        allowedValues: PREFERENCE_VALUES[config.dimension],
        respondent: RESPONDENT.PARENT,
        learningIntegration: LEARNING_INTEGRATION.AVAILABLE,
        status: QUESTION_STATUS.ACTIVE
    });
}

const QUESTION_DEFINITIONS = Object.freeze([
    ...PREFERENCE_QUESTION_CONFIG.map(preferenceQuestion),
    freezeQuestion({
        questionId: "Q_GOAL_INTENT_001",
        category: QUESTION_CATEGORY.GOAL_INTENT,
        target: {
            type: "ParentGoals"
        },
        questionIntent: "Learn which developmental goals the Parent would like Heroz activities to support for the Child.",
        fallbackTemplate: "What would you most like {childName}'s activities to help them develop?",
        answerFormat: ANSWER_FORMAT.MULTI_CHOICE,
        optionSource: {
            type: OPTION_SOURCE_TYPE.GOAL_LIBRARY
        },
        respondent: RESPONDENT.PARENT,
        learningIntegration: LEARNING_INTEGRATION.AVAILABLE,
        status: QUESTION_STATUS.ACTIVE
    }),
    freezeQuestion({
        questionId: "Q_INTEREST_SUBCATEGORY_001",
        category: QUESTION_CATEGORY.INTEREST,
        target: {
            type: "Subcategory",
            dynamic: true
        },
        questionIntent: "Clarify the Parent's observation of the Child's interest in the target Subcategory.",
        fallbackTemplate: "How interested does {childName} seem in {subcategoryName} activities?",
        answerFormat: ANSWER_FORMAT.SINGLE_CHOICE,
        respondent: RESPONDENT.PARENT,
        learningIntegration: LEARNING_INTEGRATION.NOT_IMPLEMENTED,
        status: QUESTION_STATUS.ACTIVE
    })
]);

const VALID_PREFERENCE_DIMENSIONS = Object.freeze(Object.keys(PREFERENCE_VALUES));

function record(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonblank(value) {
    return typeof value === "string" && value.trim().length > 0;
}

function sameArray(left, right) {
    return Array.isArray(left) && Array.isArray(right) &&
        left.length === right.length &&
        left.every((value, index) => value === right[index]);
}

function validateQuestionDefinitions(definitions = QUESTION_DEFINITIONS) {
    const errors = [];
    const ids = new Set();

    if (!Array.isArray(definitions)) {
        return { valid: false, errors: ["QUESTION_DEFINITIONS_INVALID"] };
    }

    for (const question of definitions) {
        const questionId = question?.questionId;

        if (!nonblank(questionId)) errors.push("QUESTION_ID_REQUIRED");
        else if (ids.has(questionId)) errors.push(`DUPLICATE_QUESTION_ID:${questionId}`);
        else ids.add(questionId);

        if (!Object.values(QUESTION_CATEGORY).includes(question?.category)) errors.push(`INVALID_CATEGORY:${questionId ?? "unknown"}`);
        if (!Object.values(RESPONDENT).includes(question?.respondent)) errors.push(`INVALID_RESPONDENT:${questionId ?? "unknown"}`);
        if (!Object.values(ANSWER_FORMAT).includes(question?.answerFormat)) errors.push(`INVALID_ANSWER_FORMAT:${questionId ?? "unknown"}`);
        if (!Object.values(LEARNING_INTEGRATION).includes(question?.learningIntegration)) errors.push(`INVALID_LEARNING_INTEGRATION:${questionId ?? "unknown"}`);
        if (!Object.values(QUESTION_STATUS).includes(question?.status)) errors.push(`INVALID_STATUS:${questionId ?? "unknown"}`);
        if (!nonblank(question?.questionIntent)) errors.push(`QUESTION_INTENT_REQUIRED:${questionId ?? "unknown"}`);
        if (!nonblank(question?.fallbackTemplate)) errors.push(`FALLBACK_TEMPLATE_REQUIRED:${questionId ?? "unknown"}`);
        if (!record(question?.target)) errors.push(`TARGET_REQUIRED:${questionId ?? "unknown"}`);

        if (question?.category === QUESTION_CATEGORY.PREFERENCE) {
            const dimension = question?.target?.dimension;
            if (!VALID_PREFERENCE_DIMENSIONS.includes(dimension)) errors.push(`INVALID_PREFERENCE_TARGET:${questionId}`);
            if (!sameArray(question?.allowedValues, PREFERENCE_VALUES[dimension])) errors.push(`INVALID_PREFERENCE_ALLOWED_VALUES:${questionId}`);
            if (question?.optionSource !== undefined) errors.push(`PREFERENCE_OPTION_SOURCE_NOT_ALLOWED:${questionId}`);
        }

        if (question?.category === QUESTION_CATEGORY.GOAL_INTENT) {
            if (question?.optionSource?.type !== OPTION_SOURCE_TYPE.GOAL_LIBRARY) errors.push(`INVALID_GOAL_OPTION_SOURCE:${questionId}`);
            if (question?.allowedValues !== undefined) errors.push(`GOAL_VALUES_MUST_NOT_BE_HARDCODED:${questionId}`);
        }

        if (question?.category === QUESTION_CATEGORY.INTEREST) {
            if (question.learningIntegration !== LEARNING_INTEGRATION.NOT_IMPLEMENTED) errors.push(`INTEREST_LEARNING_MUST_BE_NOT_IMPLEMENTED:${questionId}`);
            if (question?.target?.type !== "Subcategory" || question?.target?.dynamic !== true) errors.push(`INVALID_INTEREST_TARGET:${questionId}`);
            if (question?.allowedValues !== undefined) errors.push(`INTEREST_ALLOWED_VALUES_NOT_DEFINED:${questionId}`);
        }
    }

    return { valid: errors.length === 0, errors };
}

function isOperationallyAvailable(question) {
    return question?.status === QUESTION_STATUS.ACTIVE &&
        question?.learningIntegration === LEARNING_INTEGRATION.AVAILABLE;
}

function getQuestionDefinitions() {
    return QUESTION_DEFINITIONS;
}

function getOperationalQuestionDefinitions() {
    return QUESTION_DEFINITIONS.filter(isOperationallyAvailable);
}

module.exports = {
    QUESTION_CATEGORY,
    ANSWER_FORMAT,
    RESPONDENT,
    LEARNING_INTEGRATION,
    QUESTION_STATUS,
    OPTION_SOURCE_TYPE,
    QUESTION_DEFINITIONS,
    VALID_PREFERENCE_DIMENSIONS,
    getQuestionDefinitions,
    getOperationalQuestionDefinitions,
    isOperationallyAvailable,
    validateQuestionDefinitions
};
