const assert = require("assert");
const Module = require("module");
const { ObjectId } = require("mongodb");
const { PREFERENCE_VALUES } = require("../learning/parentDecisionContract");
const { QUESTION_DEFINITIONS } = require("../questionLibrary/questionLibrary");

const blockedRequires = new Set(["@google/genai", "http", "https", "net", "tls", "neo4j-driver"]);
const originalLoad = Module._load;
const loadedBlockedRequires = [];

Module._load = function guardedLoad(request, parent, isMain) {
    if (blockedRequires.has(request)) loadedBlockedRequires.push(request);
    return originalLoad.apply(this, arguments);
};

const {
    ANSWER_EVIDENCE_SOURCE,
    ANSWER_EVIDENCE_TYPE,
    ANSWER_INTERPRETATION_REASON,
    ANSWER_INTERPRETATION_STATUS,
    interpretQuestionAnswer
} = require("../questionAnswer/answerInterpretationService");

Module._load = originalLoad;

const childId = "child-1";
const parentId = "parent-1";
const questionHistoryId = new ObjectId();
const goalA = new ObjectId();
const goalB = new ObjectId();
const inactiveGoal = new ObjectId();

function copy(value) {
    if (value instanceof ObjectId) return new ObjectId(value);
    if (value instanceof Date) return new Date(value);
    if (Array.isArray(value)) return value.map(copy);
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copy(item)]));
    }
    return value;
}

function snapshot(value) {
    return JSON.stringify(value);
}

function at(record, keyPath) {
    return keyPath.split(".").reduce((value, key) => value?.[key], record);
}

function equal(left, right) {
    if (left instanceof ObjectId && right instanceof ObjectId) return left.equals(right);
    return left === right;
}

function matches(record, filter) {
    return Object.entries(filter).every(([key, expected]) => equal(at(record, key), expected));
}

function fakeDb(initial = {}) {
    const data = {
        goal_library: [
            { _id: goalA, name: "Problem Solving", isActive: true },
            { _id: goalB, name: "Teamwork", isActive: true },
            { _id: inactiveGoal, name: "Inactive", isActive: false }
        ],
        question_history: [],
        children: [{ _id: childId, preferences: {}, parentGoals: [], developmentProfile: [] }],
        child_interests: [],
        parent_decisions: [],
        ai_jobs: [],
        graph_sync_queue: [],
        recommendations: [{ _id: "recommendation-1", score: 0.6 }],
        explanations: [{ _id: "explanation-1", text: "stable" }],
        ...copy(initial)
    };
    const writes = [];
    const reads = [];
    return {
        data,
        writes,
        reads,
        collection(name) {
            assert(Object.hasOwn(data, name), `Unexpected collection access: ${name}`);
            return {
                async findOne(filter) {
                    reads.push({ collection: name, operation: "findOne", filter: copy(filter) });
                    return copy(data[name].find((record) => matches(record, filter)) ?? null);
                },
                async insertOne(document) {
                    writes.push({ collection: name, operation: "insertOne" });
                    data[name].push(copy(document));
                    return { insertedId: document._id };
                },
                async updateOne(filter, update) {
                    writes.push({ collection: name, operation: "updateOne" });
                    const record = data[name].find((item) => matches(item, filter));
                    if (!record) return { matchedCount: 0, modifiedCount: 0 };
                    Object.assign(record, copy(update.$set ?? {}));
                    return { matchedCount: 1, modifiedCount: 1 };
                }
            };
        }
    };
}

function byId(questionId) {
    return QUESTION_DEFINITIONS.find((question) => question.questionId === questionId);
}

async function interpret(overrides = {}) {
    return await interpretQuestionAnswer({
        db: fakeDb(),
        questionId: "Q_PREF_ENVIRONMENT_001",
        answer: "Outdoor",
        childId,
        parentId,
        questionHistoryId,
        ...overrides
    });
}

function assertInvalid(result, reason) {
    assert.strictEqual(result.status, ANSWER_INTERPRETATION_STATUS.INVALID);
    assert.strictEqual(result.reason, reason);
    assert.strictEqual(result.evidence, null);
}

function assertPreferenceEvidence(result, dimension, value) {
    assert.strictEqual(result.status, ANSWER_INTERPRETATION_STATUS.VALID);
    assert.strictEqual(result.reason, null);
    assert.deepStrictEqual(result.evidence, {
        childId,
        parentId,
        sourceQuestionId: questionIdByDimension(dimension),
        questionHistoryId,
        source: ANSWER_EVIDENCE_SOURCE,
        evidenceType: ANSWER_EVIDENCE_TYPE.PREFERENCE,
        target: {
            type: "ChildPreference",
            dimension
        },
        value
    });
}

function questionIdByDimension(dimension) {
    return QUESTION_DEFINITIONS.find((question) => question.target?.dimension === dimension)?.questionId;
}

async function testValidPreference() {
    const result = await interpret();
    assertPreferenceEvidence(result, "environment", "Outdoor");
}

async function testEachPreferenceDimension() {
    for (const [dimension, values] of Object.entries(PREFERENCE_VALUES)) {
        const result = await interpret({
            questionId: questionIdByDimension(dimension),
            answer: values[0]
        });
        assertPreferenceEvidence(result, dimension, values[0]);
    }
}

async function testInvalidPreferenceValue() {
    assertInvalid(await interpret({ answer: "Usually outdoors" }), ANSWER_INTERPRETATION_REASON.ANSWER_NOT_ALLOWED);
}

async function testSingleChoiceArrayRejected() {
    assertInvalid(await interpret({ answer: ["Outdoor"] }), ANSWER_INTERPRETATION_REASON.INVALID_ANSWER_FORMAT);
}

async function testMissingSingleChoiceAnswer() {
    for (const answer of [null, undefined, ""]) {
        assertInvalid(await interpret({ answer }), ANSWER_INTERPRETATION_REASON.ANSWER_REQUIRED);
    }
}

async function testValidGoalIntent() {
    const result = await interpret({
        questionId: "Q_GOAL_INTENT_001",
        answer: [goalB, String(goalA)]
    });
    assert.strictEqual(result.status, ANSWER_INTERPRETATION_STATUS.VALID);
    assert.deepStrictEqual(result.evidence, {
        childId,
        parentId,
        sourceQuestionId: "Q_GOAL_INTENT_001",
        questionHistoryId,
        source: ANSWER_EVIDENCE_SOURCE,
        evidenceType: ANSWER_EVIDENCE_TYPE.GOAL_INTENT,
        values: [String(goalB), String(goalA)]
    });
}

async function testInvalidGoalIdAtomic() {
    const result = await interpret({
        questionId: "Q_GOAL_INTENT_001",
        answer: [goalA, new ObjectId()]
    });
    assertInvalid(result, ANSWER_INTERPRETATION_REASON.OPTION_NOT_FOUND);
}

async function testEmptyMultiChoice() {
    assertInvalid(await interpret({ questionId: "Q_GOAL_INTENT_001", answer: [] }), ANSWER_INTERPRETATION_REASON.ANSWER_REQUIRED);
}

async function testInvalidMultiChoiceFormat() {
    assertInvalid(await interpret({ questionId: "Q_GOAL_INTENT_001", answer: goalA }), ANSWER_INTERPRETATION_REASON.INVALID_ANSWER_FORMAT);
}

async function testDuplicateGoalIds() {
    assertInvalid(await interpret({ questionId: "Q_GOAL_INTENT_001", answer: [goalA, String(goalA)] }), ANSWER_INTERPRETATION_REASON.ANSWER_NOT_ALLOWED);
}

async function testInterestQuestionBlocked() {
    assertInvalid(await interpret({
        questionId: "Q_INTEREST_SUBCATEGORY_001",
        answer: "High"
    }), ANSWER_INTERPRETATION_REASON.QUESTION_NOT_OPERATIONAL);
}

async function testNonOperationalQuestion() {
    const result = await interpretQuestionAnswer({
        db: fakeDb(),
        question: { ...byId("Q_PREF_ENVIRONMENT_001"), status: "INACTIVE" },
        answer: "Outdoor",
        childId,
        parentId
    });
    assertInvalid(result, ANSWER_INTERPRETATION_REASON.QUESTION_NOT_OPERATIONAL);

    assertInvalid(await interpret({
        questionId: "Q_INTEREST_SUBCATEGORY_001",
        answer: "Anything"
    }), ANSWER_INTERPRETATION_REASON.QUESTION_NOT_OPERATIONAL);
}

async function testQuestionBankControl() {
    assertInvalid(await interpretQuestionAnswer({
        db: fakeDb(),
        question: {
            questionId: "Q_FAKE_001",
            category: "PREFERENCE",
            answerFormat: "SINGLE_CHOICE",
            allowedValues: ["Anything"],
            status: "ACTIVE",
            learningIntegration: "AVAILABLE",
            target: { type: "ChildPreference", dimension: "environment" }
        },
        answer: "Anything",
        childId,
        parentId
    }), ANSWER_INTERPRETATION_REASON.QUESTION_NOT_FOUND);
}

async function testProvenance() {
    const result = await interpret();
    assert.strictEqual(result.evidence.childId, childId);
    assert.strictEqual(result.evidence.parentId, parentId);
    assert.strictEqual(result.evidence.sourceQuestionId, "Q_PREF_ENVIRONMENT_001");
    assert.strictEqual(result.evidence.questionHistoryId, questionHistoryId);
    assert.strictEqual(result.evidence.source, ANSWER_EVIDENCE_SOURCE);
}

async function testInputImmutability() {
    const db = fakeDb();
    const answer = [goalA, goalB];
    const input = {
        db,
        questionId: "Q_GOAL_INTENT_001",
        answer,
        childId,
        parentId,
        questionHistoryId
    };
    const beforeInput = snapshot({
        questionId: input.questionId,
        answer: input.answer,
        childId: input.childId,
        parentId: input.parentId,
        questionHistoryId: input.questionHistoryId
    });
    const beforeGoals = snapshot(db.data.goal_library);
    const beforeQuestions = snapshot(QUESTION_DEFINITIONS);

    await interpretQuestionAnswer(input);

    assert.strictEqual(snapshot({
        questionId: input.questionId,
        answer: input.answer,
        childId: input.childId,
        parentId: input.parentId,
        questionHistoryId: input.questionHistoryId
    }), beforeInput);
    assert.strictEqual(snapshot(db.data.goal_library), beforeGoals);
    assert.strictEqual(snapshot(QUESTION_DEFINITIONS), beforeQuestions);
}

async function testNoQuestionHistoryWrite() {
    const db = fakeDb();
    const before = snapshot(db.data.question_history);
    await interpretQuestionAnswer({ db, questionId: "Q_PREF_ENVIRONMENT_001", answer: "Outdoor", childId, parentId });
    assert.strictEqual(snapshot(db.data.question_history), before);
    assert.deepStrictEqual(db.writes, []);
}

async function testNoLearningSideEffects() {
    const db = fakeDb();
    const before = snapshot({
        children: db.data.children,
        child_interests: db.data.child_interests,
        parent_decisions: db.data.parent_decisions,
        ai_jobs: db.data.ai_jobs
    });
    await interpretQuestionAnswer({ db, questionId: "Q_PREF_ENVIRONMENT_001", answer: "Outdoor", childId, parentId });
    assert.strictEqual(snapshot({
        children: db.data.children,
        child_interests: db.data.child_interests,
        parent_decisions: db.data.parent_decisions,
        ai_jobs: db.data.ai_jobs
    }), before);
}

async function testNoGraphSideEffects() {
    const db = fakeDb();
    const before = snapshot(db.data.graph_sync_queue);
    await interpretQuestionAnswer({ db, questionId: "Q_GOAL_INTENT_001", answer: [goalA], childId, parentId });
    assert.strictEqual(snapshot(db.data.graph_sync_queue), before);
    assert.strictEqual(loadedBlockedRequires.includes("neo4j-driver"), false);
}

async function testNoRecommendationSideEffects() {
    const db = fakeDb();
    const before = snapshot({
        recommendations: db.data.recommendations,
        explanations: db.data.explanations
    });
    await interpretQuestionAnswer({ db, questionId: "Q_PREF_ENVIRONMENT_001", answer: "Outdoor", childId, parentId });
    assert.strictEqual(snapshot({
        recommendations: db.data.recommendations,
        explanations: db.data.explanations
    }), before);
}

async function testNoLlmNetwork() {
    assert.deepStrictEqual(loadedBlockedRequires, []);
}

async function main() {
    await testValidPreference();
    await testEachPreferenceDimension();
    await testInvalidPreferenceValue();
    await testSingleChoiceArrayRejected();
    await testMissingSingleChoiceAnswer();
    await testValidGoalIntent();
    await testInvalidGoalIdAtomic();
    await testEmptyMultiChoice();
    await testInvalidMultiChoiceFormat();
    await testDuplicateGoalIds();
    await testInterestQuestionBlocked();
    await testNonOperationalQuestion();
    await testQuestionBankControl();
    await testProvenance();
    await testInputImmutability();
    await testNoQuestionHistoryWrite();
    await testNoLearningSideEffects();
    await testNoGraphSideEffects();
    await testNoRecommendationSideEffects();
    await testNoLlmNetwork();
    console.log("Answer interpretation service unit tests: PASSED");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
