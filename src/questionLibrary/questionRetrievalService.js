const {
    QUESTION_CATEGORY,
    QUESTION_DEFINITIONS,
    isOperationallyAvailable
} = require("./questionLibrary");

const QUESTION_SOURCE = Object.freeze({
    CHILD_KNOWLEDGE_GAP: "CHILD_KNOWLEDGE_GAP",
    PARENT_INTENT: "PARENT_INTENT"
});

function candidate(question, source) {
    return Object.freeze({
        question,
        questionId: question.questionId,
        category: question.category,
        target: question.target,
        source
    });
}

function uniqueCandidates(candidates) {
    const seen = new Set();
    const unique = [];

    for (const item of candidates) {
        if (seen.has(item.questionId)) continue;
        seen.add(item.questionId);
        unique.push(item);
    }

    return unique;
}

function preferenceDimensionFromNeed(need) {
    if (need?.targetType !== "ChildPreference") return null;
    if (typeof need?.evidence?.dimension === "string") return need.evidence.dimension;

    const match = typeof need?.key === "string"
        ? need.key.match(/^preference:[^:]+:([^:]+)$/)
        : null;
    return match ? match[1] : null;
}

function findPreferenceQuestions(need) {
    const dimension = preferenceDimensionFromNeed(need);
    if (!dimension) return [];

    return QUESTION_DEFINITIONS
        .filter((question) =>
            isOperationallyAvailable(question) &&
            question.category === QUESTION_CATEGORY.PREFERENCE &&
            question.target?.dimension === dimension)
        .map((question) => candidate(question, QUESTION_SOURCE.CHILD_KNOWLEDGE_GAP));
}

function isInterestNeed(need) {
    return need?.dimension === "interestCoverage" &&
        need?.targetType === "Subcategory";
}

function findGoalIntentQuestions() {
    return QUESTION_DEFINITIONS
        .filter((question) =>
            isOperationallyAvailable(question) &&
            question.category === QUESTION_CATEGORY.GOAL_INTENT)
        .map((question) => candidate(question, QUESTION_SOURCE.PARENT_INTENT));
}

function findQuestionsForKnowledgeNeed(need) {
    if (need?.source === QUESTION_SOURCE.PARENT_INTENT || need?.type === QUESTION_SOURCE.PARENT_INTENT) {
        return findGoalIntentQuestions();
    }

    const candidates = [
        ...findPreferenceQuestions(need)
    ];

    if (isInterestNeed(need)) {
        return [];
    }

    return uniqueCandidates(candidates);
}

module.exports = {
    QUESTION_SOURCE,
    findQuestionsForKnowledgeNeed,
    findGoalIntentQuestions
};
