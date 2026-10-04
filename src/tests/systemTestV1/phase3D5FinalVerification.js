const assert = require("assert");
const { execFileSync } = require("child_process");
const Module = require("module");
const path = require("path");
const { ObjectId } = require("mongodb");
const { D1_SUFFICIENCY } = require("../../knowledgeGap/knowledgeGapConstants");
const { PREFERENCE_VALUES } = require("../../learning/parentDecisionContract");
const {
    LEARNING_INTEGRATION,
    QUESTION_DEFINITIONS,
    QUESTION_STATUS
} = require("../../questionLibrary/questionLibrary");
const {
    QUESTION_SOURCE,
    findQuestionsForKnowledgeNeed
} = require("../../questionLibrary/questionRetrievalService");
const {
    QUESTION_ELIGIBILITY_STATUS,
    evaluateQuestionEligibility
} = require("../../questionEligibility/questionEligibilityService");
const { QUESTION_HISTORY_OUTCOME } = require("../../questionEligibility/questionHistoryService");
const {
    QUESTION_SELECTION_REASON,
    selectQuestion
} = require("../../questionSelection/questionSelectionService");

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
} = require("../../questionAnswer/answerInterpretationService");

Module._load = originalLoad;

const acceptance = new Map();
const now = new Date("2026-09-30T12:00:00Z");
const childId = "child-1";
const parentId = "parent-1";
const questionHistoryId = new ObjectId();
const goalA = new ObjectId();
const goalB = new ObjectId();
const inactiveGoal = new ObjectId();

function mark(label, fn) {
    return Promise.resolve()
        .then(fn)
        .then(() => acceptance.set(label, "PASS"));
}

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
    return Object.entries(filter).every(([key, expected]) => {
        const actual = at(record, key);
        if (expected && typeof expected === "object" && Array.isArray(expected.$in)) {
            return expected.$in.some((item) => equal(actual, item));
        }
        return equal(actual, expected);
    });
}

function sortRecords(records, sort) {
    if (!sort) return records;
    const [[key, direction]] = Object.entries(sort);
    return [...records].sort((left, right) => {
        const leftValue = at(left, key);
        const rightValue = at(right, key);
        if (leftValue > rightValue) return direction * 1;
        if (leftValue < rightValue) return direction * -1;
        return 0;
    });
}

function fakeDb(initial = {}) {
    const data = {
        goal_library: [
            { _id: goalA, name: "Problem Solving", isActive: true },
            { _id: goalB, name: "Teamwork", isActive: true },
            { _id: inactiveGoal, name: "Inactive", isActive: false }
        ],
        question_history: [],
        children: [{
            _id: childId,
            preferences: { environment: { value: "Indoor" } },
            parentGoals: [],
            developmentProfile: []
        }],
        child_interests: [{ _id: "interest-1", childId, score: 0.7 }],
        parent_decisions: [],
        ai_jobs: [],
        graph_sync_queue: [],
        recommendations: [{ _id: "recommendation-1", score: 0.6 }],
        explanations: [{ _id: "explanation-1", text: "stable" }],
        ...copy(initial)
    };
    const operations = [];

    return {
        data,
        operations,
        collection(name) {
            assert(Object.hasOwn(data, name), `Unexpected collection access: ${name}`);
            return {
                async findOne(filter, options = {}) {
                    operations.push({ collection: name, operation: "findOne", filter: copy(filter) });
                    const records = data[name].filter((record) => matches(record, filter));
                    return copy(sortRecords(records, options.sort)[0] ?? null);
                },
                async insertOne(document) {
                    operations.push({ collection: name, operation: "insertOne" });
                    data[name].push(copy(document));
                    return { insertedId: document._id };
                },
                async updateOne(filter, update) {
                    operations.push({ collection: name, operation: "updateOne" });
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

function questionIdByDimension(dimension) {
    return QUESTION_DEFINITIONS.find((question) => question.target?.dimension === dimension)?.questionId;
}

function knowledgeNeed(sufficiencyState, dimension = "environment") {
    return {
        key: `preference:${childId}:${dimension}`,
        dimension: "experienceFit",
        targetType: "ChildPreference",
        targetId: `${childId}:${dimension}`,
        sufficiencyState,
        reasons: ["CHILD_PREFERENCE_MISSING"],
        possibleResolvers: ["PARENT"],
        evidence: { dimension, childPreference: null }
    };
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
        target: { type: "ChildPreference", dimension },
        value
    });
}

async function interpret(db, overrides = {}) {
    return await interpretQuestionAnswer({
        db,
        questionId: "Q_PREF_ENVIRONMENT_001",
        answer: "Outdoor",
        childId,
        parentId,
        questionHistoryId,
        ...overrides
    });
}

async function main() {
    await mark("A Approved Question Bank", async () => {
        const db = fakeDb();
        assertPreferenceEvidence(await interpret(db), "environment", "Outdoor");

        const invented = await interpretQuestionAnswer({
            db,
            question: {
                questionId: "Q_FAKE_001",
                category: "PREFERENCE",
                target: { type: "ChildPreference", dimension: "environment" },
                answerFormat: "SINGLE_CHOICE",
                allowedValues: ["Invented"],
                status: QUESTION_STATUS.ACTIVE,
                learningIntegration: LEARNING_INTEGRATION.AVAILABLE
            },
            answer: "Invented",
            childId,
            parentId
        });
        assertInvalid(invented, ANSWER_INTERPRETATION_REASON.QUESTION_NOT_FOUND);
    });

    await mark("B All Five Preferences", async () => {
        const db = fakeDb();
        for (const [dimension, values] of Object.entries(PREFERENCE_VALUES)) {
            assertPreferenceEvidence(await interpret(db, {
                questionId: questionIdByDimension(dimension),
                answer: values[0]
            }), dimension, values[0]);
        }
    });

    await mark("C Invalid Preference Value", async () => {
        assertInvalid(await interpret(fakeDb(), { answer: "Usually outdoors" }),
            ANSWER_INTERPRETATION_REASON.ANSWER_NOT_ALLOWED);
    });

    await mark("D Single-Choice Format", async () => {
        assertPreferenceEvidence(await interpret(fakeDb(), { answer: "Outdoor" }), "environment", "Outdoor");
        assertInvalid(await interpret(fakeDb(), { answer: ["Outdoor"] }),
            ANSWER_INTERPRETATION_REASON.INVALID_ANSWER_FORMAT);
    });

    await mark("E Missing Answer", async () => {
        for (const answer of [null, undefined, ""]) {
            assertInvalid(await interpret(fakeDb(), { answer }), ANSWER_INTERPRETATION_REASON.ANSWER_REQUIRED);
        }
        assertInvalid(await interpret(fakeDb(), { questionId: "Q_GOAL_INTENT_001", answer: [] }),
            ANSWER_INTERPRETATION_REASON.ANSWER_REQUIRED);
    });

    await mark("F Valid Goal Intent", async () => {
        const result = await interpret(fakeDb(), {
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
    });

    await mark("G Atomic Goal Validation", async () => {
        assertInvalid(await interpret(fakeDb(), {
            questionId: "Q_GOAL_INTENT_001",
            answer: [goalA, new ObjectId()]
        }), ANSWER_INTERPRETATION_REASON.OPTION_NOT_FOUND);
    });

    await mark("H Duplicate Goal IDs", async () => {
        assertInvalid(await interpret(fakeDb(), {
            questionId: "Q_GOAL_INTENT_001",
            answer: [goalA, String(goalA)]
        }), ANSWER_INTERPRETATION_REASON.ANSWER_NOT_ALLOWED);
    });

    await mark("I Empty Goal Selection", async () => {
        assertInvalid(await interpret(fakeDb(), { questionId: "Q_GOAL_INTENT_001", answer: [] }),
            ANSWER_INTERPRETATION_REASON.ANSWER_REQUIRED);
    });

    await mark("J Invalid Goal Format", async () => {
        assertInvalid(await interpret(fakeDb(), { questionId: "Q_GOAL_INTENT_001", answer: goalA }),
            ANSWER_INTERPRETATION_REASON.INVALID_ANSWER_FORMAT);
    });

    await mark("K Inactive Goal", async () => {
        assertInvalid(await interpret(fakeDb(), {
            questionId: "Q_GOAL_INTENT_001",
            answer: [inactiveGoal]
        }), ANSWER_INTERPRETATION_REASON.OPTION_NOT_FOUND);
    });

    await mark("L Interest Blocked", async () => {
        const question = byId("Q_INTEREST_SUBCATEGORY_001");
        assert.strictEqual(question.learningIntegration, LEARNING_INTEGRATION.NOT_IMPLEMENTED);
        assertInvalid(await interpret(fakeDb(), {
            questionId: "Q_INTEREST_SUBCATEGORY_001",
            answer: "High"
        }), ANSWER_INTERPRETATION_REASON.QUESTION_NOT_OPERATIONAL);
    });

    await mark("M Non-Operational Question", async () => {
        assertInvalid(await interpretQuestionAnswer({
            db: fakeDb(),
            question: { ...byId("Q_PREF_ENVIRONMENT_001"), status: QUESTION_STATUS.INACTIVE },
            answer: "Outdoor",
            childId,
            parentId
        }), ANSWER_INTERPRETATION_REASON.QUESTION_NOT_OPERATIONAL);
        assertInvalid(await interpretQuestionAnswer({
            db: fakeDb(),
            question: { ...byId("Q_PREF_ENVIRONMENT_001"), learningIntegration: LEARNING_INTEGRATION.NOT_IMPLEMENTED },
            answer: "Outdoor",
            childId,
            parentId
        }), ANSWER_INTERPRETATION_REASON.QUESTION_NOT_OPERATIONAL);
    });

    await mark("N Provenance", async () => {
        const evidence = (await interpret(fakeDb())).evidence;
        assert.strictEqual(evidence.childId, childId);
        assert.strictEqual(evidence.parentId, parentId);
        assert.strictEqual(evidence.sourceQuestionId, "Q_PREF_ENVIRONMENT_001");
        assert.strictEqual(evidence.questionHistoryId, questionHistoryId);
        assert.strictEqual(evidence.evidenceType, ANSWER_EVIDENCE_TYPE.PREFERENCE);
        assert.strictEqual(evidence.source, ANSWER_EVIDENCE_SOURCE);
        assert.deepStrictEqual(evidence.target, { type: "ChildPreference", dimension: "environment" });
        assert.strictEqual(evidence.value, "Outdoor");
    });

    await mark("O Input Immutability", async () => {
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
    });

    await mark("P No Question History Write", async () => {
        const db = fakeDb({
            question_history: [{
                _id: questionHistoryId,
                questionId: "Q_PREF_ENVIRONMENT_001",
                childId,
                parentId,
                askedAt: now,
                outcome: QUESTION_HISTORY_OUTCOME.PRESENTED,
                sessionId: "session-1"
            }]
        });
        const before = snapshot(db.data.question_history);
        await interpret(db);
        assert.strictEqual(snapshot(db.data.question_history), before);
        assert(db.operations.every((item) => item.operation === "findOne"));
    });

    await mark("Q No Learning Side Effects", async () => {
        const db = fakeDb();
        const before = snapshot({
            children: db.data.children,
            child_interests: db.data.child_interests,
            parent_decisions: db.data.parent_decisions,
            ai_jobs: db.data.ai_jobs
        });
        await interpret(db);
        assert.strictEqual(snapshot({
            children: db.data.children,
            child_interests: db.data.child_interests,
            parent_decisions: db.data.parent_decisions,
            ai_jobs: db.data.ai_jobs
        }), before);
    });

    await mark("R No Graph Side Effects", async () => {
        const db = fakeDb();
        const before = snapshot(db.data.graph_sync_queue);
        await interpret(db, { questionId: "Q_GOAL_INTENT_001", answer: [goalA] });
        assert.strictEqual(snapshot(db.data.graph_sync_queue), before);
        assert.strictEqual(loadedBlockedRequires.includes("neo4j-driver"), false);
    });

    await mark("S No Recommendation Side Effects", async () => {
        const db = fakeDb();
        const before = snapshot({
            recommendations: db.data.recommendations,
            explanations: db.data.explanations
        });
        await interpret(db);
        assert.strictEqual(snapshot({
            recommendations: db.data.recommendations,
            explanations: db.data.explanations
        }), before);
    });

    await mark("T No LLM / Agent / Network", () => {
        assert.deepStrictEqual(loadedBlockedRequires, []);
    });

    await mark("U D2->D3->D4->D5 Flow", async () => {
        const db = fakeDb();
        const need = knowledgeNeed(D1_SUFFICIENCY.INSUFFICIENT, "environment");
        const candidates = findQuestionsForKnowledgeNeed(need).map((candidate) => ({
            ...candidate,
            knowledgeNeed: need
        }));
        assert.strictEqual(candidates.length, 1);
        assert.strictEqual(candidates[0].question, byId("Q_PREF_ENVIRONMENT_001"));

        const eligibility = await evaluateQuestionEligibility({
            db,
            childId,
            parentId,
            sessionId: "session-1",
            questionCandidate: candidates[0],
            knowledgeNeed: need,
            currentTime: now
        });
        assert.strictEqual(eligibility.status, QUESTION_ELIGIBILITY_STATUS.ELIGIBLE);

        const selection = selectQuestion(candidates);
        assert.strictEqual(selection.selectionReason, QUESTION_SELECTION_REASON.KNOWLEDGE_GAP_INSUFFICIENT);
        assert.strictEqual(selection.selectedQuestion, candidates[0]);

        const result = await interpretQuestionAnswer({
            db,
            questionId: selection.selectedQuestion.questionId,
            answer: "Outdoor",
            childId,
            parentId,
            questionHistoryId
        });
        assertPreferenceEvidence(result, "environment", "Outdoor");
        assert.strictEqual(result.evidence.sourceQuestionId, selection.selectedQuestion.questionId);
    });

    await mark("V D5 Stops Before Learning", async () => {
        const db = fakeDb();
        const before = snapshot({
            children: db.data.children,
            child_interests: db.data.child_interests,
            parent_decisions: db.data.parent_decisions,
            ai_jobs: db.data.ai_jobs,
            graph_sync_queue: db.data.graph_sync_queue
        });
        const result = await interpret(db);
        assert.strictEqual(result.status, ANSWER_INTERPRETATION_STATUS.VALID);
        assert(result.evidence);
        assert.strictEqual(snapshot({
            children: db.data.children,
            child_interests: db.data.child_interests,
            parent_decisions: db.data.parent_decisions,
            ai_jobs: db.data.ai_jobs,
            graph_sync_queue: db.data.graph_sync_queue
        }), before);
    });

    await mark("W Regression", () => {
        const root = path.resolve(__dirname, "../../..");
        for (const testFile of [
            "src/tests/testAnswerInterpretationService.js",
            "src/tests/testQuestionSelectionService.js",
            "src/tests/testQuestionEligibilityService.js",
            "src/tests/testQuestionLibrary.js",
            "src/tests/testQuestionRetrievalService.js",
            "src/tests/testKnowledgeGapEngineService.js",
            "src/tests/testParentDecisionPersistenceService.js",
            "src/tests/testPreferenceDecisionTransition.js",
            "src/tests/testParentDecisionContract.js",
            "src/tests/testParentDecisionPreflightService.js",
            "src/tests/systemTestV1/phase3D4FinalVerification.js",
            "src/tests/systemTestV1/phase3D3FinalVerification.js",
            "src/tests/systemTestV1/phase3D2FinalVerification.js"
        ]) {
            execFileSync(process.execPath, [testFile], { cwd: root, stdio: "ignore" });
        }
    });

    await mark("X Repository Safety / Cleanup", () => {
        assert.strictEqual(snapshot(fakeDb().data.question_history), "[]");
        assert.strictEqual(snapshot(fakeDb().data.graph_sync_queue), "[]");
        assert.deepStrictEqual(loadedBlockedRequires, []);
    });

    console.log("========================================");
    console.log("PHASE 3 - D5 FINAL ACCEPTANCE");
    console.log("========================================");
    for (const label of [
        "A Approved Question Bank",
        "B All Five Preferences",
        "C Invalid Preference Value",
        "D Single-Choice Format",
        "E Missing Answer",
        "F Valid Goal Intent",
        "G Atomic Goal Validation",
        "H Duplicate Goal IDs",
        "I Empty Goal Selection",
        "J Invalid Goal Format",
        "K Inactive Goal",
        "L Interest Blocked",
        "M Non-Operational Question",
        "N Provenance",
        "O Input Immutability",
        "P No Question History Write",
        "Q No Learning Side Effects",
        "R No Graph Side Effects",
        "S No Recommendation Side Effects",
        "T No LLM / Agent / Network",
        "U D2->D3->D4->D5 Flow",
        "V D5 Stops Before Learning",
        "W Regression",
        "X Repository Safety / Cleanup"
    ]) {
        console.log(`${label}: ${acceptance.get(label)}`);
    }
    console.log("");
    console.log("D5 FINAL ACCEPTANCE: PASS");
}

main().catch((error) => {
    console.error(error);
    console.log("");
    console.log("D5 FINAL ACCEPTANCE: FAIL");
    process.exitCode = 1;
});
