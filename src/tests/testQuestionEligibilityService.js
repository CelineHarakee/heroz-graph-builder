const assert = require("assert");
const Module = require("module");
const { ObjectId } = require("mongodb");
const { QUESTION_DEFINITIONS } = require("../questionLibrary/questionLibrary");
const { D1_SUFFICIENCY } = require("../knowledgeGap/knowledgeGapConstants");

const blockedRequires = new Set(["@google/genai", "http", "https", "net", "tls", "neo4j-driver"]);
const originalLoad = Module._load;
const loadedBlockedRequires = [];

Module._load = function guardedLoad(request, parent, isMain) {
    if (blockedRequires.has(request)) loadedBlockedRequires.push(request);
    return originalLoad.apply(this, arguments);
};

const {
    QUESTION_ELIGIBILITY_STATUS,
    QUESTION_INELIGIBILITY_REASON,
    evaluateQuestionEligibility
} = require("../questionEligibility/questionEligibilityService");
const {
    QUESTION_HISTORY_OUTCOME,
    recordQuestionPresentation,
    updateQuestionHistoryOutcome
} = require("../questionEligibility/questionHistoryService");

Module._load = originalLoad;

const now = new Date("2026-09-30T12:00:00Z");

function copy(value) {
    if (value instanceof ObjectId) return new ObjectId(value);
    if (value instanceof Date) return new Date(value);
    if (Array.isArray(value)) return value.map(copy);
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copy(item)]));
    }
    return value;
}

function at(record, path) {
    return path.split(".").reduce((value, key) => value?.[key], record);
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
    return [...records].sort((left, right) => direction * (at(left, key) > at(right, key) ? 1 : -1));
}

function fakeDb(initial = {}) {
    const data = {
        question_history: [],
        children: [{ _id: "child-1", preferences: { untouched: true } }],
        child_interests: [{ _id: "interest-1", score: 0.7 }],
        goal_library: [{ _id: "goal-1", isActive: true }],
        graph_sync_queue: [],
        ai_jobs: [],
        ...copy(initial)
    };
    const writes = [];

    return {
        data,
        writes,
        collection(name) {
            if (!Object.hasOwn(data, name)) data[name] = [];
            return {
                async findOne(filter, options = {}) {
                    const records = data[name].filter((record) => matches(record, filter));
                    return copy(sortRecords(records, options.sort)[0] ?? null);
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

function daysAgo(days) {
    return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

function knowledgeNeed(overrides = {}) {
    return {
        key: "preference:child-1:socialStyle",
        targetType: "ChildPreference",
        sufficiencyState: D1_SUFFICIENCY.INSUFFICIENT,
        evidence: { dimension: "socialStyle" },
        ...overrides
    };
}

function candidate(questionId = "Q_PREF_SOCIAL_001") {
    const question = QUESTION_DEFINITIONS.find((item) => item.questionId === questionId);
    return { question, questionId, category: question.category, target: question.target };
}

async function evaluate(db, overrides = {}) {
    return await evaluateQuestionEligibility({
        db,
        childId: "child-1",
        parentId: "parent-1",
        sessionId: "session-1",
        questionCandidate: candidate(),
        knowledgeNeed: knowledgeNeed(),
        currentTime: now,
        ...overrides
    });
}

function history(overrides = {}) {
    return {
        _id: new ObjectId(),
        questionId: "Q_PREF_SOCIAL_001",
        childId: "child-1",
        parentId: "parent-1",
        askedAt: daysAgo(1),
        outcome: QUESTION_HISTORY_OUTCOME.PRESENTED,
        sessionId: "old-session",
        ...overrides
    };
}

async function testEligibleQuestion() {
    assert.deepStrictEqual(await evaluate(fakeDb()), {
        status: QUESTION_ELIGIBILITY_STATUS.ELIGIBLE,
        reason: null
    });
}

async function testKnowledgeNoLongerNeeded() {
    const result = await evaluate(fakeDb(), {
        knowledgeNeed: knowledgeNeed({ sufficiencyState: D1_SUFFICIENCY.SUFFICIENT })
    });
    assert.strictEqual(result.status, QUESTION_ELIGIBILITY_STATUS.INELIGIBLE);
    assert.strictEqual(result.reason, QUESTION_INELIGIBILITY_REASON.KNOWLEDGE_NO_LONGER_NEEDED);
}

async function testRecentSameQuestionCooldown() {
    const db = fakeDb({ question_history: [history({ askedAt: daysAgo(27) })] });
    const result = await evaluate(db);
    assert.strictEqual(result.reason, QUESTION_INELIGIBILITY_REASON.QUESTION_COOLDOWN);
}

async function testCooldownBoundaryAndExpiry() {
    assert.strictEqual((await evaluate(fakeDb({ question_history: [history({ askedAt: daysAgo(28) })] }))).status, QUESTION_ELIGIBILITY_STATUS.ELIGIBLE);
    assert.strictEqual((await evaluate(fakeDb({ question_history: [history({ askedAt: daysAgo(29) })] }))).status, QUESTION_ELIGIBILITY_STATUS.ELIGIBLE);
}

async function testOutcomeIndependence() {
    for (const outcome of Object.values(QUESTION_HISTORY_OUTCOME)) {
        const result = await evaluate(fakeDb({ question_history: [history({ outcome, askedAt: daysAgo(2) })] }));
        assert.strictEqual(result.reason, QUESTION_INELIGIBILITY_REASON.QUESTION_COOLDOWN);
    }
}

async function testChildIsolation() {
    const result = await evaluate(fakeDb({
        question_history: [history({ childId: "child-A", askedAt: daysAgo(2) })]
    }), { childId: "child-B" });
    assert.strictEqual(result.status, QUESTION_ELIGIBILITY_STATUS.ELIGIBLE);
}

async function testSessionLimitAndDifferentSession() {
    const limited = await evaluate(fakeDb({
        question_history: [history({ questionId: "Q_PREF_ENVIRONMENT_001", sessionId: "session-1", askedAt: daysAgo(50) })]
    }));
    assert.strictEqual(limited.reason, QUESTION_INELIGIBILITY_REASON.SESSION_LIMIT_REACHED);

    const allowed = await evaluate(fakeDb({
        question_history: [history({ questionId: "Q_PREF_ENVIRONMENT_001", sessionId: "session-old", askedAt: daysAgo(50) })]
    }));
    assert.strictEqual(allowed.status, QUESTION_ELIGIBILITY_STATUS.ELIGIBLE);
}

async function testEvaluationDoesNotWriteHistory() {
    const db = fakeDb();
    const before = copy(db.data);
    await evaluate(db);
    assert.deepStrictEqual(db.data, before);
    assert.deepStrictEqual(db.writes, []);
}

async function testPresentationRecording() {
    const db = fakeDb();
    const askedAt = new Date("2026-09-30T12:30:00Z");
    const stored = await recordQuestionPresentation({
        db,
        questionId: "Q_PREF_SOCIAL_001",
        childId: "child-1",
        parentId: "parent-1",
        sessionId: "session-1",
        askedAt
    });

    assert(stored._id instanceof ObjectId);
    assert.deepStrictEqual(db.data.question_history[0], stored);
    assert.strictEqual(stored.questionId, "Q_PREF_SOCIAL_001");
    assert.strictEqual(stored.childId, "child-1");
    assert.strictEqual(stored.parentId, "parent-1");
    assert.deepStrictEqual(stored.askedAt, askedAt);
    assert.strictEqual(stored.sessionId, "session-1");
    assert.strictEqual(stored.outcome, QUESTION_HISTORY_OUTCOME.PRESENTED);
}

async function testOutcomeUpdate() {
    for (const outcome of [QUESTION_HISTORY_OUTCOME.ANSWERED, QUESTION_HISTORY_OUTCOME.SKIPPED]) {
        const record = history();
        const db = fakeDb({ question_history: [record] });
        const result = await updateQuestionHistoryOutcome({ db, questionHistoryId: record._id, outcome });
        assert.deepStrictEqual(result, { status: "UPDATED" });
        assert.strictEqual(db.data.question_history[0].outcome, outcome);
    }

    await assert.rejects(
        () => updateQuestionHistoryOutcome({ db: fakeDb(), questionHistoryId: new ObjectId(), outcome: "OTHER" }),
        /UNSUPPORTED_QUESTION_HISTORY_OUTCOME/
    );
}

async function testQuestionDefinitionImmutabilityAndNoSideEffects() {
    const db = fakeDb({
        question_history: [history({ questionId: "Q_PREF_ENVIRONMENT_001", sessionId: "session-old", askedAt: daysAgo(50) })]
    });
    const beforeLibrary = JSON.stringify(QUESTION_DEFINITIONS);
    const beforeNonHistory = {
        children: copy(db.data.children),
        child_interests: copy(db.data.child_interests),
        goal_library: copy(db.data.goal_library),
        graph_sync_queue: copy(db.data.graph_sync_queue),
        ai_jobs: copy(db.data.ai_jobs)
    };

    await evaluate(db);
    await recordQuestionPresentation({
        db,
        questionId: "Q_PREF_SOCIAL_001",
        childId: "child-1",
        parentId: "parent-1",
        sessionId: "session-2",
        askedAt: now
    });

    assert.strictEqual(JSON.stringify(QUESTION_DEFINITIONS), beforeLibrary);
    assert.deepStrictEqual({
        children: db.data.children,
        child_interests: db.data.child_interests,
        goal_library: db.data.goal_library,
        graph_sync_queue: db.data.graph_sync_queue,
        ai_jobs: db.data.ai_jobs
    }, beforeNonHistory);
}

async function testNoLlmNetworkOrNeo4jRequireOnLoad() {
    assert.deepStrictEqual(loadedBlockedRequires, []);
}

async function main() {
    await testEligibleQuestion();
    await testKnowledgeNoLongerNeeded();
    await testRecentSameQuestionCooldown();
    await testCooldownBoundaryAndExpiry();
    await testOutcomeIndependence();
    await testChildIsolation();
    await testSessionLimitAndDifferentSession();
    await testEvaluationDoesNotWriteHistory();
    await testPresentationRecording();
    await testOutcomeUpdate();
    await testQuestionDefinitionImmutabilityAndNoSideEffects();
    await testNoLlmNetworkOrNeo4jRequireOnLoad();
    console.log("Question eligibility service unit tests: PASSED");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
