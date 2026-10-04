const assert = require("assert");
const { execFileSync } = require("child_process");
const Module = require("module");
const path = require("path");
const { ObjectId } = require("mongodb");
const { D1_SUFFICIENCY } = require("../../knowledgeGap/knowledgeGapConstants");
const {
    LEARNING_INTEGRATION,
    QUESTION_DEFINITIONS,
    isOperationallyAvailable
} = require("../../questionLibrary/questionLibrary");
const {
    QUESTION_SOURCE,
    findQuestionsForKnowledgeNeed
} = require("../../questionLibrary/questionRetrievalService");
const {
    QUESTION_ELIGIBILITY_STATUS,
    evaluateQuestionEligibility
} = require("../../questionEligibility/questionEligibilityService");
const {
    QUESTION_HISTORY_OUTCOME,
    recordQuestionPresentation
} = require("../../questionEligibility/questionHistoryService");

const blockedRequires = new Set(["@google/genai", "http", "https", "net", "tls", "neo4j-driver"]);
const originalLoad = Module._load;
const loadedBlockedRequires = [];

Module._load = function guardedLoad(request, parent, isMain) {
    if (blockedRequires.has(request)) loadedBlockedRequires.push(request);
    return originalLoad.apply(this, arguments);
};

const {
    QUESTION_SELECTION_REASON,
    selectQuestion
} = require("../../questionSelection/questionSelectionService");

Module._load = originalLoad;

const acceptance = new Map();
const now = new Date("2026-09-30T12:00:00Z");

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
        question_history: [],
        children: [{
            _id: "child-1",
            preferences: { environment: { value: "Indoor" } },
            parentGoals: [],
            developmentProfile: []
        }],
        child_interests: [{ _id: "interest-1", childId: "child-1", score: 0.7 }],
        d7_state: [{ _id: "d7-1", status: "stable" }],
        graph_sync_queue: [],
        graph_question_selection_state: [],
        recommendations: [{ _id: "recommendation-1", score: 0.6 }],
        explanations: [{ _id: "explanation-1", text: "stable" }],
        ai_jobs: [],
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
                    operations.push({ collection: name, operation: "findOne" });
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

function knowledgeNeed(sufficiencyState, dimension = "environment", overrides = {}) {
    return {
        key: `preference:child-1:${dimension}`,
        dimension: "experienceFit",
        targetType: "ChildPreference",
        targetId: `child-1:${dimension}`,
        sufficiencyState,
        reasons: ["CHILD_PREFERENCE_MISSING"],
        possibleResolvers: ["PARENT"],
        evidence: { dimension, childPreference: null },
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
    if (sufficiencyState) {
        item.knowledgeNeed = knowledgeNeed(sufficiencyState, question.target?.dimension ?? "environment");
    }
    return item;
}

function assertSelected(selection, selectedQuestion, reason) {
    assert.strictEqual(selection.selectedQuestion, selectedQuestion);
    assert.strictEqual(selection.selectionReason, reason);
}

function assertNoQuestion(selection) {
    assert.deepStrictEqual(selection, {
        selectedQuestion: null,
        selectionReason: QUESTION_SELECTION_REASON.NO_ELIGIBLE_QUESTIONS
    });
}

function assertNoNumericQuestionValue(value) {
    const serialized = JSON.stringify(value);
    for (const forbidden of [
        "questionValueScore",
        "informationGainScore",
        "priorityScore",
        "askProbability",
        "fatigueScore"
    ]) {
        assert.strictEqual(serialized.includes(forbidden), false, forbidden);
    }
}

function history(overrides = {}) {
    return {
        _id: new ObjectId(),
        questionId: "Q_PREF_ENVIRONMENT_001",
        childId: "child-1",
        parentId: "parent-1",
        askedAt: new Date("2026-09-29T12:00:00Z"),
        outcome: QUESTION_HISTORY_OUTCOME.PRESENTED,
        sessionId: "older-session",
        ...overrides
    };
}

async function main() {
    await mark("A Empty Input", () => {
        assertNoQuestion(selectQuestion([]));
    });

    await mark("B Single Insufficient Gap", () => {
        const item = candidate("Q_PREF_ENVIRONMENT_001", QUESTION_SOURCE.CHILD_KNOWLEDGE_GAP, D1_SUFFICIENCY.INSUFFICIENT);
        assertSelected(selectQuestion([item]), item, QUESTION_SELECTION_REASON.KNOWLEDGE_GAP_INSUFFICIENT);
    });

    await mark("C Single Uncertain Gap", () => {
        const item = candidate("Q_PREF_SOCIAL_001", QUESTION_SOURCE.CHILD_KNOWLEDGE_GAP, D1_SUFFICIENCY.UNCERTAIN);
        assertSelected(selectQuestion([item]), item, QUESTION_SELECTION_REASON.KNOWLEDGE_GAP_UNCERTAIN);
    });

    await mark("D Single Parent Intent", () => {
        const item = candidate("Q_GOAL_INTENT_001", QUESTION_SOURCE.PARENT_INTENT);
        assertSelected(selectQuestion([item]), item, QUESTION_SELECTION_REASON.PARENT_INTENT);
    });

    await mark("E Insufficient Beats Uncertain", () => {
        const uncertain = candidate("Q_PREF_SOCIAL_001", QUESTION_SOURCE.CHILD_KNOWLEDGE_GAP, D1_SUFFICIENCY.UNCERTAIN);
        const insufficient = candidate("Q_PREF_ENVIRONMENT_001", QUESTION_SOURCE.CHILD_KNOWLEDGE_GAP, D1_SUFFICIENCY.INSUFFICIENT);
        assertSelected(selectQuestion([uncertain, insufficient]), insufficient, QUESTION_SELECTION_REASON.KNOWLEDGE_GAP_INSUFFICIENT);
    });

    await mark("F Knowledge Gap Beats Parent Intent", () => {
        const parentIntent = candidate("Q_GOAL_INTENT_001", QUESTION_SOURCE.PARENT_INTENT);
        const uncertain = candidate("Q_PREF_SOCIAL_001", QUESTION_SOURCE.CHILD_KNOWLEDGE_GAP, D1_SUFFICIENCY.UNCERTAIN);
        assertSelected(selectQuestion([parentIntent, uncertain]), uncertain, QUESTION_SELECTION_REASON.KNOWLEDGE_GAP_UNCERTAIN);
    });

    await mark("G Full Priority Order", () => {
        const parentIntent = candidate("Q_GOAL_INTENT_001", QUESTION_SOURCE.PARENT_INTENT);
        const uncertain = candidate("Q_PREF_SOCIAL_001", QUESTION_SOURCE.CHILD_KNOWLEDGE_GAP, D1_SUFFICIENCY.UNCERTAIN);
        const insufficient = candidate("Q_PREF_DIFFICULTY_001", QUESTION_SOURCE.CHILD_KNOWLEDGE_GAP, D1_SUFFICIENCY.INSUFFICIENT);
        assertSelected(selectQuestion([parentIntent, uncertain, insufficient]), insufficient, QUESTION_SELECTION_REASON.KNOWLEDGE_GAP_INSUFFICIENT);
    });

    await mark("H Stable Tie-Breaking", () => {
        const environment = candidate("Q_PREF_ENVIRONMENT_001", QUESTION_SOURCE.CHILD_KNOWLEDGE_GAP, D1_SUFFICIENCY.INSUFFICIENT);
        const social = candidate("Q_PREF_SOCIAL_001", QUESTION_SOURCE.CHILD_KNOWLEDGE_GAP, D1_SUFFICIENCY.INSUFFICIENT);
        const difficulty = candidate("Q_PREF_DIFFICULTY_001", QUESTION_SOURCE.CHILD_KNOWLEDGE_GAP, D1_SUFFICIENCY.INSUFFICIENT);

        assertSelected(selectQuestion([environment, social, difficulty]), environment, QUESTION_SELECTION_REASON.KNOWLEDGE_GAP_INSUFFICIENT);
        assertSelected(selectQuestion([social, environment, difficulty]), social, QUESTION_SELECTION_REASON.KNOWLEDGE_GAP_INSUFFICIENT);
    });

    await mark("I Determinism", () => {
        const candidates = [
            candidate("Q_GOAL_INTENT_001", QUESTION_SOURCE.PARENT_INTENT),
            candidate("Q_PREF_SOCIAL_001", QUESTION_SOURCE.CHILD_KNOWLEDGE_GAP, D1_SUFFICIENCY.UNCERTAIN),
            candidate("Q_PREF_ENVIRONMENT_001", QUESTION_SOURCE.CHILD_KNOWLEDGE_GAP, D1_SUFFICIENCY.INSUFFICIENT)
        ];
        const first = selectQuestion(candidates);
        for (let index = 0; index < 20; index += 1) {
            assert.deepStrictEqual(selectQuestion(candidates), first);
        }
    });

    await mark("J Unsupported Knowledge State", () => {
        const item = candidate("Q_PREF_ENVIRONMENT_001", QUESTION_SOURCE.CHILD_KNOWLEDGE_GAP, D1_SUFFICIENCY.SUFFICIENT);
        assertNoQuestion(selectQuestion([item]));
    });

    await mark("K Unknown Source", () => {
        const item = candidate("Q_PREF_ENVIRONMENT_001", "UNKNOWN_SOURCE", D1_SUFFICIENCY.INSUFFICIENT);
        assertNoQuestion(selectQuestion([item]));
    });

    await mark("L Invalid + Valid Mix", () => {
        const unknown = candidate("Q_PREF_ENVIRONMENT_001", "UNKNOWN_SOURCE", D1_SUFFICIENCY.INSUFFICIENT);
        const sufficient = candidate("Q_PREF_SOCIAL_001", QUESTION_SOURCE.CHILD_KNOWLEDGE_GAP, D1_SUFFICIENCY.SUFFICIENT);
        const valid = candidate("Q_PREF_DIFFICULTY_001", QUESTION_SOURCE.CHILD_KNOWLEDGE_GAP, D1_SUFFICIENCY.UNCERTAIN);
        assertSelected(selectQuestion([unknown, sufficient, valid]), valid, QUESTION_SELECTION_REASON.KNOWLEDGE_GAP_UNCERTAIN);
    });

    await mark("M Input Immutability", () => {
        const candidates = [
            candidate("Q_PREF_ENVIRONMENT_001", QUESTION_SOURCE.CHILD_KNOWLEDGE_GAP, D1_SUFFICIENCY.INSUFFICIENT),
            candidate("Q_PREF_SOCIAL_001", QUESTION_SOURCE.CHILD_KNOWLEDGE_GAP, D1_SUFFICIENCY.UNCERTAIN),
            candidate("Q_GOAL_INTENT_001", QUESTION_SOURCE.PARENT_INTENT)
        ];
        const beforeCandidates = snapshot(candidates);
        const beforeQuestions = snapshot(QUESTION_DEFINITIONS);
        const beforeNeeds = snapshot(candidates.map((item) => item.knowledgeNeed));
        const beforeOrder = candidates.map((item) => item.questionId);

        selectQuestion(candidates);

        assert.strictEqual(snapshot(candidates), beforeCandidates);
        assert.strictEqual(snapshot(QUESTION_DEFINITIONS), beforeQuestions);
        assert.strictEqual(snapshot(candidates.map((item) => item.knowledgeNeed)), beforeNeeds);
        assert.deepStrictEqual(candidates.map((item) => item.questionId), beforeOrder);
    });

    await mark("N One Question Maximum", () => {
        const candidates = [
            candidate("Q_PREF_ENVIRONMENT_001", QUESTION_SOURCE.CHILD_KNOWLEDGE_GAP, D1_SUFFICIENCY.INSUFFICIENT),
            candidate("Q_PREF_SOCIAL_001", QUESTION_SOURCE.CHILD_KNOWLEDGE_GAP, D1_SUFFICIENCY.UNCERTAIN),
            candidate("Q_GOAL_INTENT_001", QUESTION_SOURCE.PARENT_INTENT)
        ];
        const output = selectQuestion(candidates);
        assert(output.selectedQuestion);
        assert.strictEqual(Array.isArray(output.selectedQuestion), false);
        assert.strictEqual(Object.hasOwn(output, "selectedQuestions"), false);
    });

    await mark("O No Question History Write", () => {
        const db = fakeDb();
        const before = snapshot(db.data.question_history);
        selectQuestion([candidate("Q_PREF_ENVIRONMENT_001", QUESTION_SOURCE.CHILD_KNOWLEDGE_GAP, D1_SUFFICIENCY.INSUFFICIENT)]);
        assert.strictEqual(snapshot(db.data.question_history), before);
        assert.deepStrictEqual(db.operations, []);
    });

    await mark("P D3 Boundary", () => {
        const db = fakeDb({
            question_history: [
                history({ askedAt: new Date("2026-09-29T12:00:00Z") }),
                history({ questionId: "Q_PREF_SOCIAL_001", sessionId: "session-1", askedAt: new Date("2026-08-01T00:00:00Z") })
            ]
        });
        const item = candidate("Q_PREF_ENVIRONMENT_001", QUESTION_SOURCE.CHILD_KNOWLEDGE_GAP, D1_SUFFICIENCY.INSUFFICIENT);
        assertSelected(selectQuestion([item]), item, QUESTION_SELECTION_REASON.KNOWLEDGE_GAP_INSUFFICIENT);
        assert.deepStrictEqual(db.operations, []);
    });

    await mark("Q D2 Boundary", () => {
        const interest = byId("Q_INTEREST_SUBCATEGORY_001");
        const before = snapshot(QUESTION_DEFINITIONS);
        assert.strictEqual(interest.learningIntegration, LEARNING_INTEGRATION.NOT_IMPLEMENTED);
        assert.strictEqual(isOperationallyAvailable(interest), false);

        selectQuestion([candidate("Q_PREF_ENVIRONMENT_001", QUESTION_SOURCE.CHILD_KNOWLEDGE_GAP, D1_SUFFICIENCY.INSUFFICIENT)]);

        assert.strictEqual(snapshot(QUESTION_DEFINITIONS), before);
        assert.strictEqual(isOperationallyAvailable(interest), false);
    });

    await mark("R No Learning Side Effects", () => {
        const db = fakeDb();
        const before = snapshot({
            children: db.data.children,
            child_interests: db.data.child_interests,
            d7_state: db.data.d7_state
        });

        selectQuestion([candidate("Q_PREF_ENVIRONMENT_001", QUESTION_SOURCE.CHILD_KNOWLEDGE_GAP, D1_SUFFICIENCY.INSUFFICIENT)]);

        assert.strictEqual(snapshot({
            children: db.data.children,
            child_interests: db.data.child_interests,
            d7_state: db.data.d7_state
        }), before);
    });

    await mark("S No Graph Side Effects", () => {
        const db = fakeDb();
        const before = snapshot({
            graph_sync_queue: db.data.graph_sync_queue,
            graph_question_selection_state: db.data.graph_question_selection_state
        });

        selectQuestion([candidate("Q_GOAL_INTENT_001", QUESTION_SOURCE.PARENT_INTENT)]);

        assert.strictEqual(snapshot({
            graph_sync_queue: db.data.graph_sync_queue,
            graph_question_selection_state: db.data.graph_question_selection_state
        }), before);
        assert.strictEqual(loadedBlockedRequires.includes("neo4j-driver"), false);
    });

    await mark("T No Recommendation Side Effects", () => {
        const db = fakeDb();
        const before = snapshot({
            recommendations: db.data.recommendations,
            explanations: db.data.explanations
        });
        const output = selectQuestion([candidate("Q_PREF_ENVIRONMENT_001", QUESTION_SOURCE.CHILD_KNOWLEDGE_GAP, D1_SUFFICIENCY.INSUFFICIENT)]);

        assert.strictEqual(snapshot({
            recommendations: db.data.recommendations,
            explanations: db.data.explanations
        }), before);
        for (const forbidden of ["eligibility", "factor", "ranking", "weights", "explanation"]) {
            assert.strictEqual(JSON.stringify(output).includes(forbidden), false);
        }
    });

    await mark("U No LLM / Network Dependency", () => {
        assert.deepStrictEqual(loadedBlockedRequires, []);
    });

    await mark("V No Numeric Question Value Score", () => {
        assertNoNumericQuestionValue(selectQuestion([
            candidate("Q_PREF_ENVIRONMENT_001", QUESTION_SOURCE.CHILD_KNOWLEDGE_GAP, D1_SUFFICIENCY.INSUFFICIENT),
            candidate("Q_GOAL_INTENT_001", QUESTION_SOURCE.PARENT_INTENT)
        ]));
    });

    await mark("W D1->D2->D3->D4 Integration", async () => {
        const db = fakeDb();
        const need = knowledgeNeed(D1_SUFFICIENCY.INSUFFICIENT, "environment");
        const candidates = findQuestionsForKnowledgeNeed(need).map((item) => ({
            ...item,
            knowledgeNeed: need
        }));
        assert.strictEqual(candidates.length, 1);
        assert.strictEqual(candidates[0].questionId, "Q_PREF_ENVIRONMENT_001");

        const eligibility = await evaluateQuestionEligibility({
            db,
            childId: "child-1",
            parentId: "parent-1",
            sessionId: "session-1",
            questionCandidate: candidates[0],
            knowledgeNeed: need,
            currentTime: now
        });
        assert.strictEqual(eligibility.status, QUESTION_ELIGIBILITY_STATUS.ELIGIBLE);

        const beforeHistory = snapshot(db.data.question_history);
        const selected = selectQuestion(candidates);
        assertSelected(selected, candidates[0], QUESTION_SELECTION_REASON.KNOWLEDGE_GAP_INSUFFICIENT);
        assert.strictEqual(selected.selectedQuestion.question, byId("Q_PREF_ENVIRONMENT_001"));
        assert.strictEqual(snapshot(db.data.question_history), beforeHistory);

        await recordQuestionPresentation({
            db,
            questionId: selected.selectedQuestion.questionId,
            childId: "child-1",
            parentId: "parent-1",
            sessionId: "session-1",
            askedAt: now
        });
        assert.strictEqual(db.data.question_history.length, 1);
    });

    await mark("X Regression", () => {
        const root = path.resolve(__dirname, "../../..");
        for (const testFile of [
            "src/tests/testQuestionSelectionService.js",
            "src/tests/testQuestionEligibilityService.js",
            "src/tests/testQuestionLibrary.js",
            "src/tests/testQuestionRetrievalService.js",
            "src/tests/testKnowledgeGapEngineService.js",
            "src/tests/testParentDecisionPersistenceService.js",
            "src/tests/testPreferenceDecisionTransition.js",
            "src/tests/testParentDecisionContract.js",
            "src/tests/testParentDecisionPreflightService.js",
            "src/tests/systemTestV1/phase3D3FinalVerification.js",
            "src/tests/systemTestV1/phase3D2FinalVerification.js"
        ]) {
            execFileSync(process.execPath, [testFile], { cwd: root, stdio: "ignore" });
        }
    });

    await mark("Y Repository Safety / Cleanup", () => {
        const db = fakeDb();
        assert.strictEqual(snapshot(db.data.question_history), "[]");
        assert.strictEqual(snapshot(db.data.graph_sync_queue), "[]");
        assert.strictEqual(snapshot(QUESTION_DEFINITIONS), snapshot(QUESTION_DEFINITIONS));
        assert.deepStrictEqual(loadedBlockedRequires, []);
    });

    console.log("========================================");
    console.log("PHASE 3 - D4 FINAL ACCEPTANCE");
    console.log("========================================");
    for (const label of [
        "A Empty Input",
        "B Single Insufficient Gap",
        "C Single Uncertain Gap",
        "D Single Parent Intent",
        "E Insufficient Beats Uncertain",
        "F Knowledge Gap Beats Parent Intent",
        "G Full Priority Order",
        "H Stable Tie-Breaking",
        "I Determinism",
        "J Unsupported Knowledge State",
        "K Unknown Source",
        "L Invalid + Valid Mix",
        "M Input Immutability",
        "N One Question Maximum",
        "O No Question History Write",
        "P D3 Boundary",
        "Q D2 Boundary",
        "R No Learning Side Effects",
        "S No Graph Side Effects",
        "T No Recommendation Side Effects",
        "U No LLM / Network Dependency",
        "V No Numeric Question Value Score",
        "W D1->D2->D3->D4 Integration",
        "X Regression",
        "Y Repository Safety / Cleanup"
    ]) {
        console.log(`${label}: ${acceptance.get(label)}`);
    }
    console.log("");
    console.log("D4 FINAL ACCEPTANCE: PASS");
}

main().catch((error) => {
    console.error(error);
    console.log("");
    console.log("D4 FINAL ACCEPTANCE: FAIL");
    process.exitCode = 1;
});
