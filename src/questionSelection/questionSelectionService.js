const { D1_SUFFICIENCY } = require("../knowledgeGap/knowledgeGapConstants");
const { QUESTION_SOURCE } = require("../questionLibrary/questionRetrievalService");

const QUESTION_SELECTION_REASON = Object.freeze({
    KNOWLEDGE_GAP_INSUFFICIENT: "KNOWLEDGE_GAP_INSUFFICIENT",
    KNOWLEDGE_GAP_UNCERTAIN: "KNOWLEDGE_GAP_UNCERTAIN",
    PARENT_INTENT: "PARENT_INTENT",
    NO_ELIGIBLE_QUESTIONS: "NO_ELIGIBLE_QUESTIONS"
});

function result(selectedQuestion, selectionReason) {
    return { selectedQuestion, selectionReason };
}

function candidateSource(candidate) {
    return candidate?.source ?? candidate?.questionCandidate?.source;
}

function candidateKnowledgeNeed(candidate) {
    return candidate?.knowledgeNeed ?? candidate?.questionCandidate?.knowledgeNeed;
}

function priorityTier(candidate) {
    const source = candidateSource(candidate);

    if (source === QUESTION_SOURCE.PARENT_INTENT) {
        return {
            order: 2,
            reason: QUESTION_SELECTION_REASON.PARENT_INTENT
        };
    }

    if (source !== QUESTION_SOURCE.CHILD_KNOWLEDGE_GAP) return null;

    const state = candidateKnowledgeNeed(candidate)?.sufficiencyState;
    if (state === D1_SUFFICIENCY.INSUFFICIENT) {
        return {
            order: 0,
            reason: QUESTION_SELECTION_REASON.KNOWLEDGE_GAP_INSUFFICIENT
        };
    }
    if (state === D1_SUFFICIENCY.UNCERTAIN) {
        return {
            order: 1,
            reason: QUESTION_SELECTION_REASON.KNOWLEDGE_GAP_UNCERTAIN
        };
    }

    return null;
}

function selectQuestion(eligibleCandidates = []) {
    if (!Array.isArray(eligibleCandidates)) throw new Error("ELIGIBLE_CANDIDATES_REQUIRED");

    let selected = null;
    let selectedTier = null;

    for (const candidate of eligibleCandidates) {
        const tier = priorityTier(candidate);
        if (!tier) continue;

        if (!selectedTier || tier.order < selectedTier.order) {
            selected = candidate;
            selectedTier = tier;
        }
    }

    if (!selected) {
        return result(null, QUESTION_SELECTION_REASON.NO_ELIGIBLE_QUESTIONS);
    }

    return result(selected, selectedTier.reason);
}

module.exports = {
    QUESTION_SELECTION_REASON,
    selectQuestion
};
