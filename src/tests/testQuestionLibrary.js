const assert = require("assert");
const Module = require("module");
const { PREFERENCE_VALUES } = require("../learning/parentDecisionContract");

const blockedRequires = new Set(["@google/genai", "http", "https", "net", "tls"]);
const originalLoad = Module._load;
const loadedBlockedRequires = [];

Module._load = function guardedLoad(request, parent, isMain) {
    if (blockedRequires.has(request)) loadedBlockedRequires.push(request);
    return originalLoad.apply(this, arguments);
};

const library = require("../questionLibrary/questionLibrary");

Module._load = originalLoad;

const {
    QUESTION_DEFINITIONS,
    QUESTION_CATEGORY,
    LEARNING_INTEGRATION,
    OPTION_SOURCE_TYPE,
    getOperationalQuestionDefinitions,
    isOperationallyAvailable,
    validateQuestionDefinitions
} = library;

function byId(questionId) {
    return QUESTION_DEFINITIONS.find((question) => question.questionId === questionId);
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function assertInvalid(definitions, reasonPrefix) {
    const result = validateQuestionDefinitions(definitions);
    assert.strictEqual(result.valid, false);
    assert(
        result.errors.some((error) => error.startsWith(reasonPrefix)),
        `Expected ${reasonPrefix}, found ${result.errors.join(", ")}`
    );
}

function testAllCoreDefinitionsExist() {
    assert.strictEqual(QUESTION_DEFINITIONS.length, 7);
    for (const questionId of [
        "Q_PREF_ENVIRONMENT_001",
        "Q_PREF_SOCIAL_001",
        "Q_PREF_DIFFICULTY_001",
        "Q_PREF_EXPERIENCE_001",
        "Q_PREF_COMMITMENT_001",
        "Q_GOAL_INTENT_001",
        "Q_INTEREST_SUBCATEGORY_001"
    ]) {
        assert(byId(questionId), `${questionId} must exist`);
    }
}

function testQuestionIdsAreUnique() {
    const ids = QUESTION_DEFINITIONS.map((question) => question.questionId);
    assert.deepStrictEqual([...new Set(ids)], ids);
}

function testPreferenceTargetsAndValues() {
    const expected = {
        Q_PREF_ENVIRONMENT_001: "environment",
        Q_PREF_SOCIAL_001: "socialStyle",
        Q_PREF_DIFFICULTY_001: "difficulty",
        Q_PREF_EXPERIENCE_001: "experienceStyle",
        Q_PREF_COMMITMENT_001: "commitmentPreference"
    };

    for (const [questionId, dimension] of Object.entries(expected)) {
        const question = byId(questionId);
        assert.strictEqual(question.category, QUESTION_CATEGORY.PREFERENCE);
        assert.deepStrictEqual(question.target, { type: "ChildPreference", dimension });
        assert.deepStrictEqual(question.allowedValues, PREFERENCE_VALUES[dimension]);
    }
}

function testGoalIntentUsesGoalLibrary() {
    const question = byId("Q_GOAL_INTENT_001");
    assert.strictEqual(question.category, QUESTION_CATEGORY.GOAL_INTENT);
    assert.deepStrictEqual(question.optionSource, { type: OPTION_SOURCE_TYPE.GOAL_LIBRARY });
    assert.strictEqual(Object.hasOwn(question, "allowedValues"), false);
}

function testInterestIsDynamicAndNotImplemented() {
    const question = byId("Q_INTEREST_SUBCATEGORY_001");
    assert.strictEqual(question.category, QUESTION_CATEGORY.INTEREST);
    assert.deepStrictEqual(question.target, { type: "Subcategory", dynamic: true });
    assert.strictEqual(question.learningIntegration, LEARNING_INTEGRATION.NOT_IMPLEMENTED);
    assert.strictEqual(isOperationallyAvailable(question), false);
    assert.strictEqual(Object.hasOwn(question, "allowedValues"), false);
}

function testOperationalAvailability() {
    const operational = getOperationalQuestionDefinitions();
    assert.strictEqual(operational.length, 6);
    assert(operational.every(isOperationallyAvailable));
    assert.strictEqual(isOperationallyAvailable({
        status: "ACTIVE",
        learningIntegration: "AVAILABLE"
    }), true);
}

function testValidationPassesAndRejectsMalformedDefinitions() {
    assert.deepStrictEqual(validateQuestionDefinitions(), { valid: true, errors: [] });

    const duplicate = clone(QUESTION_DEFINITIONS);
    duplicate[1].questionId = duplicate[0].questionId;
    assertInvalid(duplicate, "DUPLICATE_QUESTION_ID");

    const malformedCategory = clone(QUESTION_DEFINITIONS);
    malformedCategory[0].category = "OTHER";
    assertInvalid(malformedCategory, "INVALID_CATEGORY");

    const badPreferenceTarget = clone(QUESTION_DEFINITIONS);
    badPreferenceTarget[0].target.dimension = "unknown";
    assertInvalid(badPreferenceTarget, "INVALID_PREFERENCE_TARGET");

    const badPreferenceValues = clone(QUESTION_DEFINITIONS);
    badPreferenceValues[4].allowedValues = ["OneTime", "Weekly", "Camp", "Mixed"];
    assertInvalid(badPreferenceValues, "INVALID_PREFERENCE_ALLOWED_VALUES");

    const hardcodedGoalValues = clone(QUESTION_DEFINITIONS);
    hardcodedGoalValues[5].allowedValues = ["Improve Problem Solving"];
    assertInvalid(hardcodedGoalValues, "GOAL_VALUES_MUST_NOT_BE_HARDCODED");

    const badGoalSource = clone(QUESTION_DEFINITIONS);
    badGoalSource[5].optionSource = { type: "STATIC" };
    assertInvalid(badGoalSource, "INVALID_GOAL_OPTION_SOURCE");

    const implementedInterest = clone(QUESTION_DEFINITIONS);
    implementedInterest[6].learningIntegration = "AVAILABLE";
    assertInvalid(implementedInterest, "INTEREST_LEARNING_MUST_BE_NOT_IMPLEMENTED");

    const staticInterest = clone(QUESTION_DEFINITIONS);
    staticInterest[6].target.dynamic = false;
    assertInvalid(staticInterest, "INVALID_INTEREST_TARGET");
}

function testNoLlmApiOrNetworkRequireOnLoad() {
    assert.deepStrictEqual(loadedBlockedRequires, []);
}

testAllCoreDefinitionsExist();
testQuestionIdsAreUnique();
testPreferenceTargetsAndValues();
testGoalIntentUsesGoalLibrary();
testInterestIsDynamicAndNotImplemented();
testOperationalAvailability();
testValidationPassesAndRejectsMalformedDefinitions();
testNoLlmApiOrNetworkRequireOnLoad();

console.log("Question library unit tests: PASSED");
