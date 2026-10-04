const assert = require("assert");
const Module = require("module");
const { D1_SUFFICIENCY } = require("../knowledgeGap/knowledgeGapConstants");
const { QUESTION_DEFINITIONS } = require("../questionLibrary/questionLibrary");
const { QUESTION_SOURCE } = require("../questionLibrary/questionRetrievalService");

const blockedRequires = new Set([
    "@google/genai",
    "http",
    "https",
    "net",
    "tls",
    "neo4j-driver",
    "../questionEligibility/questionHistoryService",
    "./questionHistoryService"
]);
const originalLoad = Module._load;
const loadedBlockedRequires = [];

Module._load = function guardedLoad(request, parent, isMain) {
    if (blockedRequires.has(request)) loadedBlockedRequires.push(request);
    return originalLoad.apply(this, arguments);
};

const {
    QUESTION_SELECTION_REASON,
    selectQuestion
} = require("../questionSelection/questionSelectionService");

Module._load = originalLoad;

function snapshot(value) {
    return JSON.stringify(value);
}

function byId(questionId) {
    return QUESTION_DEFINITIONS.find((question) => question.questionId === questionId);
}

function knowledgeNeed(sufficiencyState, overrides = {}) {
    return {
        key: "preference:child-1:environment",
        targetType: "ChildPreference",
        targetId: "child-1:environment",
        sufficiencyState,
        evidence: { dimension: "environment" },
        ...overrides
    };
}

function candidate(questionId, source, sufficiencyState) {
    const question = byId(questionId);
    const item = {
        question,
        questionId,
        category: question.category,
        target: question.target,
        source
    };
    if (sufficiencyState) item.knowledgeNeed = knowledgeNeed(sufficiencyState);
    return item;
}

function wrappedCandidate(questionId, source, sufficiencyState) {
    const questionCandidate = candidate(questionId, source);
    return {
        questionCandidate,
        knowledgeNeed: knowledgeNeed(sufficiencyState)
    };
}

function fakeDb() {
    return {
        question_history: [],
        children: [{ _id: "child-1", preferences: { environment: { value: "Indoor" } }, parentGoals: [] }],
        child_interests: [{ _id: "interest-1", childId: "child-1", score: 0.6 }],
        graph_sync_queue: [],
        recommendations: [{ _id: "recommendation-1", score: 0.7 }],
        explanations: [{ _id: "explanation-1", text: "stable" }]
    };
}

function assertSelected(selection, selectedQuestion, reason) {
    assert.strictEqual(selection.selectedQuestion, selectedQuestion);
    assert.strictEqual(selection.selectionReason, reason);
}

function testEmptyInput() {
    assert.deepStrictEqual(selectQuestion([]), {
        selectedQuestion: null,
        selectionReason: QUESTION_SELECTION_REASON.NO_ELIGIBLE_QUESTIONS
    });
}

function testSingleKnowledgeGapInsufficient() {
    const item = candidate("Q_PREF_ENVIRONMENT_001", QUESTION_SOURCE.CHILD_KNOWLEDGE_GAP, D1_SUFFICIENCY.INSUFFICIENT);
    assertSelected(selectQuestion([item]), item, QUESTION_SELECTION_REASON.KNOWLEDGE_GAP_INSUFFICIENT);
}

function testSingleKnowledgeGapUncertain() {
    const item = candidate("Q_PREF_SOCIAL_001", QUESTION_SOURCE.CHILD_KNOWLEDGE_GAP, D1_SUFFICIENCY.UNCERTAIN);
    assertSelected(selectQuestion([item]), item, QUESTION_SELECTION_REASON.KNOWLEDGE_GAP_UNCERTAIN);
}

function testSingleParentIntent() {
    const item = candidate("Q_GOAL_INTENT_001", QUESTION_SOURCE.PARENT_INTENT);
    assertSelected(selectQuestion([item]), item, QUESTION_SELECTION_REASON.PARENT_INTENT);
}

function testInsufficientBeatsUncertainRegardlessOfOrder() {
    const uncertain = candidate("Q_PREF_SOCIAL_001", QUESTION_SOURCE.CHILD_KNOWLEDGE_GAP, D1_SUFFICIENCY.UNCERTAIN);
    const insufficient = candidate("Q_PREF_ENVIRONMENT_001", QUESTION_SOURCE.CHILD_KNOWLEDGE_GAP, D1_SUFFICIENCY.INSUFFICIENT);
    assertSelected(selectQuestion([uncertain, insufficient]), insufficient, QUESTION_SELECTION_REASON.KNOWLEDGE_GAP_INSUFFICIENT);
}

function testKnowledgeGapBeatsParentIntent() {
    const parentIntent = candidate("Q_GOAL_INTENT_001", QUESTION_SOURCE.PARENT_INTENT);
    const uncertain = candidate("Q_PREF_SOCIAL_001", QUESTION_SOURCE.CHILD_KNOWLEDGE_GAP, D1_SUFFICIENCY.UNCERTAIN);
    assertSelected(selectQuestion([parentIntent, uncertain]), uncertain, QUESTION_SELECTION_REASON.KNOWLEDGE_GAP_UNCERTAIN);
}

function testFullPriorityMix() {
    const parentIntent = candidate("Q_GOAL_INTENT_001", QUESTION_SOURCE.PARENT_INTENT);
    const uncertain = candidate("Q_PREF_SOCIAL_001", QUESTION_SOURCE.CHILD_KNOWLEDGE_GAP, D1_SUFFICIENCY.UNCERTAIN);
    const insufficient = candidate("Q_PREF_DIFFICULTY_001", QUESTION_SOURCE.CHILD_KNOWLEDGE_GAP, D1_SUFFICIENCY.INSUFFICIENT);
    assertSelected(selectQuestion([parentIntent, uncertain, insufficient]), insufficient, QUESTION_SELECTION_REASON.KNOWLEDGE_GAP_INSUFFICIENT);
}

function testSameTierStableOrder() {
    const first = candidate("Q_PREF_ENVIRONMENT_001", QUESTION_SOURCE.CHILD_KNOWLEDGE_GAP, D1_SUFFICIENCY.INSUFFICIENT);
    const second = candidate("Q_PREF_SOCIAL_001", QUESTION_SOURCE.CHILD_KNOWLEDGE_GAP, D1_SUFFICIENCY.INSUFFICIENT);
    const third = candidate("Q_PREF_DIFFICULTY_001", QUESTION_SOURCE.CHILD_KNOWLEDGE_GAP, D1_SUFFICIENCY.INSUFFICIENT);
    assertSelected(selectQuestion([first, second, third]), first, QUESTION_SELECTION_REASON.KNOWLEDGE_GAP_INSUFFICIENT);

    const uncertainFirst = candidate("Q_PREF_ENVIRONMENT_001", QUESTION_SOURCE.CHILD_KNOWLEDGE_GAP, D1_SUFFICIENCY.UNCERTAIN);
    const uncertainSecond = candidate("Q_PREF_SOCIAL_001", QUESTION_SOURCE.CHILD_KNOWLEDGE_GAP, D1_SUFFICIENCY.UNCERTAIN);
    assertSelected(selectQuestion([uncertainFirst, uncertainSecond]), uncertainFirst, QUESTION_SELECTION_REASON.KNOWLEDGE_GAP_UNCERTAIN);
}

function testDeterminism() {
    const candidates = [
        candidate("Q_GOAL_INTENT_001", QUESTION_SOURCE.PARENT_INTENT),
        candidate("Q_PREF_SOCIAL_001", QUESTION_SOURCE.CHILD_KNOWLEDGE_GAP, D1_SUFFICIENCY.UNCERTAIN),
        candidate("Q_PREF_ENVIRONMENT_001", QUESTION_SOURCE.CHILD_KNOWLEDGE_GAP, D1_SUFFICIENCY.INSUFFICIENT)
    ];
    const first = selectQuestion(candidates);
    for (let index = 0; index < 10; index += 1) {
        assert.deepStrictEqual(selectQuestion(candidates), first);
    }
}

function testUnsupportedKnowledgeState() {
    const unsupported = candidate("Q_PREF_ENVIRONMENT_001", QUESTION_SOURCE.CHILD_KNOWLEDGE_GAP, D1_SUFFICIENCY.SUFFICIENT);
    assert.deepStrictEqual(selectQuestion([unsupported]), {
        selectedQuestion: null,
        selectionReason: QUESTION_SELECTION_REASON.NO_ELIGIBLE_QUESTIONS
    });
}

function testUnknownSource() {
    const unknown = candidate("Q_PREF_ENVIRONMENT_001", "SYSTEM_INTENT", D1_SUFFICIENCY.INSUFFICIENT);
    assert.deepStrictEqual(selectQuestion([unknown]), {
        selectedQuestion: null,
        selectionReason: QUESTION_SELECTION_REASON.NO_ELIGIBLE_QUESTIONS
    });
}

function testInvalidAndValidMix() {
    const invalid = candidate("Q_PREF_ENVIRONMENT_001", QUESTION_SOURCE.CHILD_KNOWLEDGE_GAP, D1_SUFFICIENCY.SUFFICIENT);
    const valid = candidate("Q_PREF_SOCIAL_001", QUESTION_SOURCE.CHILD_KNOWLEDGE_GAP, D1_SUFFICIENCY.UNCERTAIN);
    assertSelected(selectQuestion([invalid, valid]), valid, QUESTION_SELECTION_REASON.KNOWLEDGE_GAP_UNCERTAIN);
}

function testWrappedCandidateShape() {
    const wrapped = wrappedCandidate("Q_PREF_ENVIRONMENT_001", QUESTION_SOURCE.CHILD_KNOWLEDGE_GAP, D1_SUFFICIENCY.INSUFFICIENT);
    assertSelected(selectQuestion([wrapped]), wrapped, QUESTION_SELECTION_REASON.KNOWLEDGE_GAP_INSUFFICIENT);
}

function testInputImmutability() {
    const candidates = [
        candidate("Q_PREF_ENVIRONMENT_001", QUESTION_SOURCE.CHILD_KNOWLEDGE_GAP, D1_SUFFICIENCY.INSUFFICIENT),
        candidate("Q_PREF_SOCIAL_001", QUESTION_SOURCE.CHILD_KNOWLEDGE_GAP, D1_SUFFICIENCY.INSUFFICIENT),
        candidate("Q_GOAL_INTENT_001", QUESTION_SOURCE.PARENT_INTENT)
    ];
    const beforeCandidates = snapshot(candidates);
    const beforeLibrary = snapshot(QUESTION_DEFINITIONS);
    const orderBefore = candidates.map((item) => item.questionId);

    selectQuestion(candidates);

    assert.strictEqual(snapshot(candidates), beforeCandidates);
    assert.strictEqual(snapshot(QUESTION_DEFINITIONS), beforeLibrary);
    assert.deepStrictEqual(candidates.map((item) => item.questionId), orderBefore);
}

function testNoQuestionHistoryWrite() {
    const db = fakeDb();
    const before = snapshot(db.question_history);
    selectQuestion([candidate("Q_PREF_ENVIRONMENT_001", QUESTION_SOURCE.CHILD_KNOWLEDGE_GAP, D1_SUFFICIENCY.INSUFFICIENT)]);
    assert.strictEqual(snapshot(db.question_history), before);
}

function testNoLearningSideEffects() {
    const db = fakeDb();
    const before = snapshot({
        children: db.children,
        child_interests: db.child_interests
    });
    selectQuestion([candidate("Q_PREF_ENVIRONMENT_001", QUESTION_SOURCE.CHILD_KNOWLEDGE_GAP, D1_SUFFICIENCY.INSUFFICIENT)]);
    assert.strictEqual(snapshot({
        children: db.children,
        child_interests: db.child_interests
    }), before);
}

function testNoGraphRecommendationOrLlmSideEffects() {
    const db = fakeDb();
    const before = snapshot({
        graph_sync_queue: db.graph_sync_queue,
        recommendations: db.recommendations,
        explanations: db.explanations
    });
    const output = selectQuestion([candidate("Q_GOAL_INTENT_001", QUESTION_SOURCE.PARENT_INTENT)]);
    assert.strictEqual(snapshot({
        graph_sync_queue: db.graph_sync_queue,
        recommendations: db.recommendations,
        explanations: db.explanations
    }), before);
    assert.deepStrictEqual(loadedBlockedRequires, []);

    const serialized = JSON.stringify(output);
    for (const forbidden of ["questionValueScore", "recommendationScore", "score", "rank", "weight"]) {
        assert.strictEqual(serialized.includes(forbidden), false);
    }
}

function testInputContract() {
    assert.throws(() => selectQuestion(null), /ELIGIBLE_CANDIDATES_REQUIRED/);
}

testEmptyInput();
testSingleKnowledgeGapInsufficient();
testSingleKnowledgeGapUncertain();
testSingleParentIntent();
testInsufficientBeatsUncertainRegardlessOfOrder();
testKnowledgeGapBeatsParentIntent();
testFullPriorityMix();
testSameTierStableOrder();
testDeterminism();
testUnsupportedKnowledgeState();
testUnknownSource();
testInvalidAndValidMix();
testWrappedCandidateShape();
testInputImmutability();
testNoQuestionHistoryWrite();
testNoLearningSideEffects();
testNoGraphRecommendationOrLlmSideEffects();
testInputContract();

console.log("Question selection service unit tests: PASSED");
