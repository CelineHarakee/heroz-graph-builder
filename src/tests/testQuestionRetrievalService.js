const assert = require("assert");
const Module = require("module");
const { QUESTION_DEFINITIONS, isOperationallyAvailable } = require("../questionLibrary/questionLibrary");

const blockedRequires = new Set(["@google/genai", "http", "https", "net", "tls"]);
const originalLoad = Module._load;
const loadedBlockedRequires = [];

Module._load = function guardedLoad(request, parent, isMain) {
    if (blockedRequires.has(request)) loadedBlockedRequires.push(request);
    return originalLoad.apply(this, arguments);
};

const {
    QUESTION_SOURCE,
    findGoalIntentQuestions,
    findQuestionsForKnowledgeNeed
} = require("../questionLibrary/questionRetrievalService");

Module._load = originalLoad;

function snapshot(value) {
    return JSON.stringify(value);
}

function preferenceGap(dimension, overrides = {}) {
    return {
        key: `preference:child-1:${dimension}`,
        dimension: "experienceFit",
        targetType: "ChildPreference",
        targetId: `child-1:${dimension}`,
        sufficiencyState: "INSUFFICIENT",
        reasons: ["CHILD_PREFERENCE_MISSING"],
        possibleResolvers: ["PARENT"],
        evidence: { dimension, childPreference: null },
        ...overrides
    };
}

function interestGap() {
    return {
        key: "interest:child-1:subcategory:subcategory-1",
        dimension: "interestCoverage",
        targetType: "Subcategory",
        targetId: "subcategory-1",
        sufficiencyState: "INSUFFICIENT",
        reasons: ["NO_INTEREST_EVIDENCE"],
        possibleResolvers: ["CHILD_BEHAVIOR", "PARENT"],
        evidence: { score: null, confidence: null, evidenceCount: null }
    };
}

function firstId(candidates) {
    assert.strictEqual(candidates.length, 1);
    assert(isOperationallyAvailable(candidates[0].question));
    return candidates[0].questionId;
}

function testPreferenceMappings() {
    const expected = {
        environment: "Q_PREF_ENVIRONMENT_001",
        socialStyle: "Q_PREF_SOCIAL_001",
        difficulty: "Q_PREF_DIFFICULTY_001",
        experienceStyle: "Q_PREF_EXPERIENCE_001",
        commitmentPreference: "Q_PREF_COMMITMENT_001"
    };

    for (const [dimension, questionId] of Object.entries(expected)) {
        const candidates = findQuestionsForKnowledgeNeed(preferenceGap(dimension));
        assert.strictEqual(firstId(candidates), questionId);
        assert.strictEqual(candidates[0].source, QUESTION_SOURCE.CHILD_KNOWLEDGE_GAP);
        assert.deepStrictEqual(candidates[0].target, {
            type: "ChildPreference",
            dimension
        });
    }
}

function testGoalIntentRetrieval() {
    assert.strictEqual(firstId(findGoalIntentQuestions()), "Q_GOAL_INTENT_001");
    const fromUnifiedSource = findQuestionsForKnowledgeNeed({ source: QUESTION_SOURCE.PARENT_INTENT });
    assert.strictEqual(firstId(fromUnifiedSource), "Q_GOAL_INTENT_001");
    assert.strictEqual(fromUnifiedSource[0].source, QUESTION_SOURCE.PARENT_INTENT);
}

function testInterestIsNotOperational() {
    assert.deepStrictEqual(findQuestionsForKnowledgeNeed(interestGap()), []);
}

function testUnsupportedGapsReturnEmpty() {
    const unsupported = [
        {
            key: "catalog:activity:activity-1:experience:environment",
            dimension: "experienceFit",
            targetType: "ActivityExperienceAttribute",
            evidence: { dimension: "environment", activityValue: null }
        },
        {
            key: "familiarity:child-1:activity:activity-1",
            dimension: "activityFamiliarity",
            targetType: "Activity",
            evidence: { events: [] }
        },
        { source: "SESSION", targetType: "Session" },
        { source: "SYSTEM", targetType: "SystemData" },
        { source: "BEHAVIOR", targetType: "Behavior" },
        { source: "EXPLORATION", targetType: "Activity" },
        {
            key: "development:child-1:activity:activity-1",
            dimension: "developmentalRelevance",
            targetType: "Activity"
        }
    ];

    for (const need of unsupported) {
        assert.deepStrictEqual(findQuestionsForKnowledgeNeed(need), []);
    }
}

function testUnknownPreferenceDimensionReturnsEmpty() {
    assert.deepStrictEqual(findQuestionsForKnowledgeNeed(preferenceGap("unknown")), []);
}

function testOperationalAndNoDuplicates() {
    const candidates = findQuestionsForKnowledgeNeed(preferenceGap("environment"));
    assert(candidates.every((item) => isOperationallyAvailable(item.question)));
    assert.strictEqual(new Set(candidates.map((item) => item.questionId)).size, candidates.length);
}

function testInputsAndLibraryAreNotMutated() {
    const need = preferenceGap("environment");
    const beforeNeed = snapshot(need);
    const beforeLibrary = snapshot(QUESTION_DEFINITIONS);

    findQuestionsForKnowledgeNeed(need);
    findGoalIntentQuestions();

    assert.strictEqual(snapshot(need), beforeNeed);
    assert.strictEqual(snapshot(QUESTION_DEFINITIONS), beforeLibrary);
}

function testNoLlmApiOrNetworkRequireOnLoad() {
    assert.deepStrictEqual(loadedBlockedRequires, []);
}

testPreferenceMappings();
testGoalIntentRetrieval();
testInterestIsNotOperational();
testUnsupportedGapsReturnEmpty();
testUnknownPreferenceDimensionReturnsEmpty();
testOperationalAndNoDuplicates();
testInputsAndLibraryAreNotMutated();
testNoLlmApiOrNetworkRequireOnLoad();

console.log("Question retrieval unit tests: PASSED");
