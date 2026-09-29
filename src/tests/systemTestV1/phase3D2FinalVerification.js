const assert = require("assert");
const { execFileSync } = require("child_process");
const Module = require("module");
const path = require("path");
const { PREFERENCE_VALUES, validateParentDecisionPayload } = require("../../learning/parentDecisionContract");

const blockedRequires = new Set(["@google/genai", "http", "https", "net", "tls"]);
const originalLoad = Module._load;
const loadedBlockedRequires = [];

Module._load = function guardedLoad(request, parent, isMain) {
    if (blockedRequires.has(request)) loadedBlockedRequires.push(request);
    return originalLoad.apply(this, arguments);
};

const {
    ANSWER_FORMAT,
    LEARNING_INTEGRATION,
    OPTION_SOURCE_TYPE,
    QUESTION_CATEGORY,
    QUESTION_DEFINITIONS,
    QUESTION_STATUS,
    RESPONDENT,
    isOperationallyAvailable,
    validateQuestionDefinitions
} = require("../../questionLibrary/questionLibrary");
const {
    QUESTION_SOURCE,
    findGoalIntentQuestions,
    findQuestionsForKnowledgeNeed
} = require("../../questionLibrary/questionRetrievalService");

Module._load = originalLoad;

const acceptance = new Map();
const forbiddenOutputFields = [
    "priorityScore",
    "relevanceScore",
    "informationGainScore",
    "askProbability",
    "recommendationScore",
    "cooldown",
    "lastAskedAt",
    "nextEligibleAt"
];

function mark(label, fn) {
    fn();
    acceptance.set(label, "PASS");
}

function byId(questionId) {
    return QUESTION_DEFINITIONS.find((question) => question.questionId === questionId);
}

function snapshot(value) {
    return JSON.stringify(value);
}

function preferenceNeed(dimension) {
    return {
        key: `preference:child-1:${dimension}`,
        dimension: "experienceFit",
        targetType: "ChildPreference",
        targetId: `child-1:${dimension}`,
        sufficiencyState: "INSUFFICIENT",
        reasons: ["CHILD_PREFERENCE_MISSING"],
        possibleResolvers: ["PARENT"],
        evidence: { dimension, childPreference: null }
    };
}

function interestNeed() {
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

function assertOneCandidate(candidates, questionId) {
    assert.strictEqual(candidates.length, 1);
    assert.strictEqual(candidates[0].questionId, questionId);
    assert.strictEqual(candidates[0].question, byId(questionId));
    assert.strictEqual(isOperationallyAvailable(candidates[0].question), true);
    return candidates[0];
}

function assertNoForbiddenFields(value) {
    const serialized = JSON.stringify(value);
    for (const field of forbiddenOutputFields) {
        assert.strictEqual(serialized.includes(`"${field}"`), false, `${field} must not appear in D2 output`);
    }
}

mark("A. Question Library Contract", () => {
    const expectedIds = [
        "Q_PREF_ENVIRONMENT_001",
        "Q_PREF_SOCIAL_001",
        "Q_PREF_DIFFICULTY_001",
        "Q_PREF_EXPERIENCE_001",
        "Q_PREF_COMMITMENT_001",
        "Q_GOAL_INTENT_001",
        "Q_INTEREST_SUBCATEGORY_001"
    ];
    assert.deepStrictEqual(QUESTION_DEFINITIONS.map((question) => question.questionId), expectedIds);
    assert.strictEqual(new Set(expectedIds).size, expectedIds.length);

    const validCategories = Object.values(QUESTION_CATEGORY);
    const validFormats = Object.values(ANSWER_FORMAT);
    const validStatuses = Object.values(QUESTION_STATUS);
    const validIntegrations = Object.values(LEARNING_INTEGRATION);

    for (const question of QUESTION_DEFINITIONS) {
        assert(validCategories.includes(question.category));
        assert.strictEqual(question.respondent, RESPONDENT.PARENT);
        assert(validFormats.includes(question.answerFormat));
        assert(validStatuses.includes(question.status));
        assert(validIntegrations.includes(question.learningIntegration));
    }
    assert.deepStrictEqual(validateQuestionDefinitions(), { valid: true, errors: [] });
});

mark("B. Preference Vocabulary", () => {
    assert.deepStrictEqual(PREFERENCE_VALUES, {
        environment: ["Indoor", "Outdoor", "Mixed"],
        socialStyle: ["Individual", "Team", "Mixed"],
        difficulty: ["Beginner", "Intermediate", "Advanced"],
        experienceStyle: ["Structured", "Creative", "Exploratory", "Mixed"],
        commitmentPreference: ["OneTime", "Weekly"]
    });

    for (const [dimension, values] of Object.entries(PREFERENCE_VALUES)) {
        const question = QUESTION_DEFINITIONS.find((item) =>
            item.category === QUESTION_CATEGORY.PREFERENCE &&
            item.target.dimension === dimension);
        assert(question);
        assert.deepStrictEqual(question.allowedValues, values);
    }

    assert.strictEqual(PREFERENCE_VALUES.commitmentPreference.includes("Camp"), false);
    assert.strictEqual(PREFERENCE_VALUES.commitmentPreference.includes("Mixed"), false);
    assert.strictEqual(validateParentDecisionPayload("PreferenceUpdated", {
        dimension: "commitmentPreference",
        value: "Camp"
    }).reasonCode, "INVALID_PREFERENCE_VALUE");
    assert.strictEqual(validateParentDecisionPayload("PreferenceUpdated", {
        dimension: "commitmentPreference",
        value: "Mixed"
    }).reasonCode, "INVALID_PREFERENCE_VALUE");
});

mark("C. Preference Retrieval", () => {
    const expected = {
        environment: "Q_PREF_ENVIRONMENT_001",
        socialStyle: "Q_PREF_SOCIAL_001",
        difficulty: "Q_PREF_DIFFICULTY_001",
        experienceStyle: "Q_PREF_EXPERIENCE_001",
        commitmentPreference: "Q_PREF_COMMITMENT_001"
    };

    for (const [dimension, questionId] of Object.entries(expected)) {
        const candidates = findQuestionsForKnowledgeNeed(preferenceNeed(dimension));
        const candidate = assertOneCandidate(candidates, questionId);
        assert.strictEqual(candidate.question.status, QUESTION_STATUS.ACTIVE);
        assert.strictEqual(candidate.question.learningIntegration, LEARNING_INTEGRATION.AVAILABLE);
        assert.strictEqual(candidate.source, QUESTION_SOURCE.CHILD_KNOWLEDGE_GAP);
        assert.strictEqual(candidate.target.dimension, dimension);
        assert.strictEqual(new Set(candidates.map((item) => item.questionId)).size, candidates.length);
    }
});

mark("D. Parent Goal Intent", () => {
    const candidate = assertOneCandidate(findGoalIntentQuestions(), "Q_GOAL_INTENT_001");
    assert.strictEqual(candidate.category, QUESTION_CATEGORY.GOAL_INTENT);
    assert.strictEqual(candidate.question.respondent, RESPONDENT.PARENT);
    assert.strictEqual(candidate.question.answerFormat, ANSWER_FORMAT.MULTI_CHOICE);
    assert.deepStrictEqual(candidate.question.optionSource, { type: OPTION_SOURCE_TYPE.GOAL_LIBRARY });
    assert.strictEqual(candidate.question.learningIntegration, LEARNING_INTEGRATION.AVAILABLE);
    assert.strictEqual(candidate.question.status, QUESTION_STATUS.ACTIVE);
    assert.strictEqual(candidate.source, QUESTION_SOURCE.PARENT_INTENT);
    assert.strictEqual(Object.hasOwn(candidate.question, "allowedValues"), false);
});

mark("E. Interest Safety Boundary", () => {
    const question = byId("Q_INTEREST_SUBCATEGORY_001");
    assert(question);
    assert.strictEqual(question.category, QUESTION_CATEGORY.INTEREST);
    assert.deepStrictEqual(question.target, { type: "Subcategory", dynamic: true });
    assert.strictEqual(question.respondent, RESPONDENT.PARENT);
    assert.strictEqual(question.learningIntegration, LEARNING_INTEGRATION.NOT_IMPLEMENTED);
    assert.strictEqual(Object.hasOwn(question, "allowedValues"), false);

    const result = findQuestionsForKnowledgeNeed(interestNeed());
    assert.deepStrictEqual(result, []);
    const serialized = JSON.stringify(result);
    for (const eventType of ["View", "Click", "Save", "Book", "Attend", "Rate"]) {
        assert.strictEqual(serialized.includes(eventType), false);
    }
    assert.strictEqual(serialized.includes("child_interests"), false);
});

mark("F. Non-Parent Gap Exclusion", () => {
    const unsupportedNeeds = [
        { key: "catalog:activity:activity-1:experience:environment", dimension: "experienceFit", targetType: "ActivityExperienceAttribute", evidence: { dimension: "environment" } },
        { key: "catalog:activity:activity-1:experience:experienceStyle", dimension: "experienceFit", targetType: "ActivityExperienceAttribute", evidence: { dimension: "experienceStyle" } },
        { key: "familiarity:child-1:activity:activity-1", dimension: "activityFamiliarity", targetType: "Activity" },
        { source: "BEHAVIOR", targetType: "Behavior" },
        { source: "EXPLORATION", targetType: "Activity" },
        { source: "SESSION_INFORMATION", targetType: "Session" },
        { source: "SESSION_AVAILABILITY", targetType: "Session" },
        { source: "SYSTEM", targetType: "SystemData" },
        { key: "development:child-1:activity:activity-1", dimension: "developmentalRelevance", targetType: "Activity" }
    ];

    for (const need of unsupportedNeeds) {
        assert.deepStrictEqual(findQuestionsForKnowledgeNeed(need), []);
    }
});

mark("G. D1 -> D2 Compatibility", () => {
    assert.strictEqual(
        assertOneCandidate(findQuestionsForKnowledgeNeed(preferenceNeed("environment")), "Q_PREF_ENVIRONMENT_001").questionId,
        "Q_PREF_ENVIRONMENT_001"
    );
    assert.deepStrictEqual(findQuestionsForKnowledgeNeed(interestNeed()), []);
});

mark("H. Immutability", () => {
    const d1Evaluation = {
        evaluation: { status: "RESOLVED", childId: "child-1", activityId: "activity-1", subcategoryId: "subcategory-1" },
        knowledgeGaps: [preferenceNeed("environment"), interestNeed()]
    };
    const needBefore = snapshot(d1Evaluation.knowledgeGaps[0]);
    const evaluationBefore = snapshot(d1Evaluation);
    const questionsBefore = snapshot(QUESTION_DEFINITIONS);
    const preferenceValuesBefore = snapshot(PREFERENCE_VALUES);

    for (const gap of d1Evaluation.knowledgeGaps) {
        findQuestionsForKnowledgeNeed(gap);
    }
    findGoalIntentQuestions();

    assert.strictEqual(snapshot(d1Evaluation.knowledgeGaps[0]), needBefore);
    assert.strictEqual(snapshot(d1Evaluation), evaluationBefore);
    assert.strictEqual(snapshot(QUESTION_DEFINITIONS), questionsBefore);
    assert.strictEqual(snapshot(PREFERENCE_VALUES), preferenceValuesBefore);
});

mark("I. Operational Availability", () => {
    assert.strictEqual(isOperationallyAvailable({ status: "ACTIVE", learningIntegration: "AVAILABLE" }), true);
    assert.strictEqual(isOperationallyAvailable({ status: "ACTIVE", learningIntegration: "NOT_IMPLEMENTED" }), false);
    assert.strictEqual(isOperationallyAvailable({ status: "INACTIVE", learningIntegration: "AVAILABLE" }), false);
    assert.strictEqual(isOperationallyAvailable({ status: "DRAFT", learningIntegration: "AVAILABLE" }), false);
});

mark("J. D2 Scope Boundary", () => {
    const outputs = [
        ...findQuestionsForKnowledgeNeed(preferenceNeed("environment")),
        ...findGoalIntentQuestions(),
        ...findQuestionsForKnowledgeNeed(interestNeed())
    ];
    assertNoForbiddenFields(outputs);
    for (const forbidden of [
        "interpretedAnswer",
        "answerPersistence",
        "parent_decisions",
        "child_interests",
        "D7",
        "ranking",
        "priority",
        "fatigue",
        "frequency"
    ]) {
        assert.strictEqual(JSON.stringify(outputs).includes(forbidden), false);
    }
});

mark("K. No LLM / Network Dependency", () => {
    assert.deepStrictEqual(loadedBlockedRequires, []);
});

mark("L. Regression", () => {
    const root = path.resolve(__dirname, "../../..");
    for (const testFile of [
        "src/tests/testQuestionLibrary.js",
        "src/tests/testQuestionRetrievalService.js",
        "src/tests/testKnowledgeGapEngineService.js",
        "src/tests/testParentDecisionContract.js",
        "src/tests/testPreferenceDecisionTransition.js",
        "src/tests/testPreferenceFactor.js"
    ]) {
        execFileSync(process.execPath, [testFile], {
            cwd: root,
            stdio: "ignore"
        });
    }
});

mark("M. Repository Safety", () => {
    assert.strictEqual(typeof findQuestionsForKnowledgeNeed, "function");
    assert.strictEqual(typeof findGoalIntentQuestions, "function");
});

console.log("========================================");
console.log("PHASE 3 - D2 FINAL ACCEPTANCE");
console.log("========================================");
for (const label of [
    "A. Question Library Contract",
    "B. Preference Vocabulary",
    "C. Preference Retrieval",
    "D. Parent Goal Intent",
    "E. Interest Safety Boundary",
    "F. Non-Parent Gap Exclusion",
    "G. D1 -> D2 Compatibility",
    "H. Immutability",
    "I. Operational Availability",
    "J. D2 Scope Boundary",
    "K. No LLM / Network Dependency",
    "L. Regression",
    "M. Repository Safety"
]) {
    console.log(`${label.padEnd(36)} ${acceptance.get(label)}`);
}
console.log("");
console.log("----------------------------------------");
console.log("D2 FINAL ACCEPTANCE: PASS");
console.log("----------------------------------------");
console.log("Phase 3 Deliverable 2 -");
console.log("Question Knowledge Model / Library");
console.log("is implementation-complete,");
console.log("verified, and ready to freeze.");
console.log("========================================");
