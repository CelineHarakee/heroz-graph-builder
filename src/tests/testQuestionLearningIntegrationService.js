const assert = require("assert");
const Module = require("module");
const { ObjectId } = require("mongodb");
const { isDeepStrictEqual } = require("util");
const {
    QUESTION_LEARNING_REASON,
    QUESTION_LEARNING_STATUS,
    integrateQuestionEvidence
} = require("../questionLearning/questionLearningIntegrationService");
const { ANSWER_EVIDENCE_SOURCE, ANSWER_EVIDENCE_TYPE } = require("../questionAnswer/answerInterpretationService");
const { QUESTION_HISTORY_OUTCOME } = require("../questionEligibility/questionHistoryService");
const { normalizeParentDecision } = require("../learning/eventNormalizer");

const blockedRequires = new Set(["@google/genai", "http", "https", "net", "tls", "neo4j-driver"]);
const originalLoad = Module._load;
const loadedBlockedRequires = [];

Module._load = function guardedLoad(request, parent, isMain) {
    if (blockedRequires.has(request)) loadedBlockedRequires.push(request);
    return originalLoad.apply(this, arguments);
};

Module._load = originalLoad;

const parentId = new ObjectId();
const childId = new ObjectId();
const questionHistoryId = new ObjectId();
const goalA = new ObjectId();
const goalB = new ObjectId();
const goalC = new ObjectId();
const occurredAt = new Date("2026-10-01T10:00:00Z");

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

function at(record, path) {
    return path.split(".").reduce((value, key) => value?.[key], record);
}

function equal(left, right) {
    if (left instanceof ObjectId && right instanceof ObjectId) return left.equals(right);
    return isDeepStrictEqual(left, right);
}

function matches(record, filter) {
    return Object.entries(filter).every(([key, expected]) => {
        const actual = at(record, key);
        if (expected?.$exists === false) return actual === undefined;
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

function activeGoal(goalId, priority = 1, selectedAt = new Date("2026-09-01T00:00:00Z")) {
    return {
        goalId,
        priority,
        status: "Active",
        selectedBy: "Parent",
        selectedAt,
        targetDate: null
    };
}

function makeDb(overrides = {}) {
    const data = {
        parents: [{ _id: parentId }],
        children: [{
            _id: childId,
            parentId,
            preferences: {},
            parentGoals: [],
            developmentProfile: [{ retained: true }]
        }],
        goal_library: [
            { _id: goalA, isActive: true },
            { _id: goalB, isActive: true },
            { _id: goalC, isActive: true }
        ],
        parent_decisions: [],
        question_history: [{
            _id: questionHistoryId,
            questionId: "Q_PREF_ENVIRONMENT_001",
            childId,
            parentId,
            askedAt: new Date("2026-10-01T09:00:00Z"),
            outcome: QUESTION_HISTORY_OUTCOME.PRESENTED,
            sessionId: "session-1"
        }],
        ai_jobs: [],
        graph_sync_queue: [],
        child_interests: [{ _id: "interest-1", score: 0.7 }],
        recommendations: [{ _id: "recommendation-1", score: 0.6 }],
        explanations: [{ _id: "explanation-1", text: "stable" }],
        ...copy(overrides)
    };
    const calls = [];
    let active = false;
    let staged = null;
    const session = {
        startTransaction() {
            active = true;
            staged = copy(data);
        },
        inTransaction: () => active,
        async commitTransaction() {
            Object.keys(data).forEach((key) => delete data[key]);
            Object.assign(data, staged);
            staged = null;
            active = false;
        },
        async abortTransaction() {
            staged = null;
            active = false;
        },
        async endSession() {}
    };
    const client = { startSession: () => session };
    const db = {
        data,
        calls,
        client,
        collection(name) {
            if (!Object.hasOwn(data, name)) data[name] = [];
            function store(options) {
                return options?.session ? staged[name] : data[name];
            }
            return {
                async findOne(filter, options = {}) {
                    calls.push({ collection: name, operation: "findOne" });
                    return copy(sortRecords(store(options).filter((record) => matches(record, filter)), options.sort)[0] ?? null);
                },
                async insertOne(document, options = {}) {
                    calls.push({ collection: name, operation: "insertOne" });
                    store(options).push(copy(document));
                    return { insertedId: document._id };
                },
                async updateOne(filter, update, options = {}) {
                    calls.push({ collection: name, operation: "updateOne" });
                    const record = store(options).find((item) => matches(item, filter));
                    if (!record) return { matchedCount: 0, modifiedCount: 0 };
                    if (Array.isArray(update)) {
                        const merge = update[0].$set.preferences.$mergeObjects;
                        record.preferences = { ...(record.preferences ?? {}), ...copy(merge[1].$literal) };
                    } else if (update.$set) {
                        Object.assign(record, copy(update.$set));
                    }
                    return { matchedCount: 1, modifiedCount: 1 };
                }
            };
        }
    };
    return db;
}

function preferenceEvidence(value = "Outdoor") {
    return {
        childId,
        parentId,
        sourceQuestionId: "Q_PREF_ENVIRONMENT_001",
        questionHistoryId,
        source: ANSWER_EVIDENCE_SOURCE,
        evidenceType: ANSWER_EVIDENCE_TYPE.PREFERENCE,
        target: { type: "ChildPreference", dimension: "environment" },
        value
    };
}

function goalEvidence(values) {
    return {
        childId,
        parentId,
        sourceQuestionId: "Q_GOAL_INTENT_001",
        questionHistoryId,
        source: ANSWER_EVIDENCE_SOURCE,
        evidenceType: ANSWER_EVIDENCE_TYPE.GOAL_INTENT,
        values: values.map(String)
    };
}

async function integrate(db, evidence, extra = {}) {
    return await integrateQuestionEvidence({
        db,
        client: db.client,
        evidence,
        occurredAt,
        ...extra
    });
}

function child(db) {
    return db.data.children[0];
}

function activeIds(db) {
    return child(db).parentGoals
        .filter((goal) => goal.status === "Active")
        .map((goal) => String(goal.goalId))
        .sort();
}

async function testPreferenceEvidence() {
    const db = makeDb();
    const result = await integrate(db, preferenceEvidence());
    assert.strictEqual(result.status, QUESTION_LEARNING_STATUS.APPLIED);
    assert.strictEqual(result.questionHistory.status, "UPDATED");
    assert.strictEqual(child(db).preferences.environment.value, "Outdoor");
    assert.strictEqual(child(db).preferences.environment.source, "Parent");
    assert.strictEqual(db.data.question_history[0].outcome, QUESTION_HISTORY_OUTCOME.ANSWERED);
    assert.strictEqual(db.data.parent_decisions.length, 1);
    assert.strictEqual(db.data.parent_decisions[0].decisionType, "PreferenceUpdated");
    assert.deepStrictEqual(db.data.parent_decisions[0].decisionData, { dimension: "environment", value: "Outdoor" });
    assert.strictEqual(db.data.ai_jobs.length, 1);
    assert.strictEqual(db.data.graph_sync_queue.length, 0);
}

async function testPreferenceReplay() {
    const db = makeDb();
    await integrate(db, preferenceEvidence());
    const before = snapshot({
        decisions: db.data.parent_decisions,
        jobs: db.data.ai_jobs,
        preferences: child(db).preferences
    });
    const replay = await integrate(db, preferenceEvidence());
    assert.strictEqual(replay.status, QUESTION_LEARNING_STATUS.APPLIED);
    assert.strictEqual(db.data.parent_decisions.length, 1);
    assert.strictEqual(db.data.ai_jobs.length, 1);
    assert.strictEqual(snapshot({
        decisions: db.data.parent_decisions,
        jobs: db.data.ai_jobs,
        preferences: child(db).preferences
    }), before);
}

async function testGoalSelection() {
    const db = makeDb();
    child(db).parentGoals = [activeGoal(goalA, 1)];
    const result = await integrate(db, goalEvidence([goalA, goalB]));
    assert.strictEqual(result.status, QUESTION_LEARNING_STATUS.APPLIED);
    assert.deepStrictEqual(activeIds(db), [String(goalA), String(goalB)].sort());
    assert.strictEqual(child(db).parentGoals.find((goal) => String(goal.goalId) === String(goalA)).priority, 1);
    assert.strictEqual(child(db).parentGoals.find((goal) => String(goal.goalId) === String(goalB)).priority, 2);
    assert.strictEqual(db.data.graph_sync_queue.length, 1);
}

async function testGoalRemoval() {
    const db = makeDb();
    child(db).parentGoals = [activeGoal(goalA, 1), activeGoal(goalC, 3)];
    const result = await integrate(db, goalEvidence([goalA]));
    assert.strictEqual(result.status, QUESTION_LEARNING_STATUS.APPLIED);
    assert.deepStrictEqual(activeIds(db), [String(goalA)]);
    assert.strictEqual(db.data.graph_sync_queue.length, 1);
}

async function testGoalCombinedDiff() {
    const db = makeDb();
    child(db).parentGoals = [activeGoal(goalA, 1), activeGoal(goalC, 3)];
    const result = await integrate(db, goalEvidence([goalA, goalB]));
    assert.strictEqual(result.status, QUESTION_LEARNING_STATUS.APPLIED);
    assert.deepStrictEqual(activeIds(db), [String(goalA), String(goalB)].sort());
    assert.strictEqual(child(db).parentGoals.find((goal) => String(goal.goalId) === String(goalA)).priority, 1);
    assert.strictEqual(child(db).parentGoals.find((goal) => String(goal.goalId) === String(goalB)).priority, 2);
    assert.strictEqual(db.data.graph_sync_queue.length, 2);
    assert.deepStrictEqual(db.data.parent_decisions.map((doc) => doc.decisionType).sort(), ["GoalRemoved", "GoalSelected"]);
}

async function testGoalReplay() {
    const db = makeDb();
    child(db).parentGoals = [activeGoal(goalA, 1), activeGoal(goalC, 3)];
    await integrate(db, goalEvidence([goalA, goalB]));
    const before = snapshot({
        goals: child(db).parentGoals,
        decisions: db.data.parent_decisions,
        jobs: db.data.ai_jobs,
        queue: db.data.graph_sync_queue
    });
    const replay = await integrate(db, goalEvidence([goalA, goalB]));
    assert.strictEqual(replay.status, QUESTION_LEARNING_STATUS.APPLIED);
    assert.strictEqual(snapshot({
        goals: child(db).parentGoals,
        decisions: db.data.parent_decisions,
        jobs: db.data.ai_jobs,
        queue: db.data.graph_sync_queue
    }), before);
}

async function testPartialFailureRetry() {
    const db = makeDb();
    child(db).parentGoals = [activeGoal(goalA, 1), activeGoal(goalC, 3)];
    let removeAttempts = 0;
    const dependencies = {
        async persistParentDecision(args) {
            if (args.event.eventType === "GoalRemoved") {
                removeAttempts += 1;
                if (removeAttempts === 1) {
                    return { status: "FAILED", reasonCode: "DATABASE_ERROR", retryable: true };
                }
            }
            const { persistParentDecision } = require("../learning/parentDecisionPersistenceService");
            return await persistParentDecision(args);
        }
    };

    const first = await integrate(db, goalEvidence([goalA, goalB]), { dependencies });
    assert.strictEqual(first.status, QUESTION_LEARNING_STATUS.FAILED);
    assert.strictEqual(db.data.question_history[0].outcome, QUESTION_HISTORY_OUTCOME.PRESENTED);
    assert.deepStrictEqual(activeIds(db), [String(goalA), String(goalB), String(goalC)].sort());

    const second = await integrate(db, goalEvidence([goalA, goalB]), { dependencies });
    assert.strictEqual(second.status, QUESTION_LEARNING_STATUS.APPLIED);
    assert.strictEqual(db.data.question_history[0].outcome, QUESTION_HISTORY_OUTCOME.ANSWERED);
    assert.deepStrictEqual(activeIds(db), [String(goalA), String(goalB)].sort());
}

async function testUnsupportedInterest() {
    const db = makeDb();
    const before = snapshot({
        child_interests: db.data.child_interests,
        question_history: db.data.question_history,
        children: db.data.children
    });
    const result = await integrate(db, {
        evidenceType: "INTEREST",
        childId,
        parentId,
        questionHistoryId,
        source: ANSWER_EVIDENCE_SOURCE
    });
    assert.strictEqual(result.status, QUESTION_LEARNING_STATUS.INVALID);
    assert.strictEqual(result.reason, QUESTION_LEARNING_REASON.UNSUPPORTED_EVIDENCE_TYPE);
    assert.strictEqual(snapshot({
        child_interests: db.data.child_interests,
        question_history: db.data.question_history,
        children: db.data.children
    }), before);
}

async function testNoDirectProfileOrRecommendationWrites() {
    const db = makeDb();
    const before = snapshot({
        developmentProfile: child(db).developmentProfile,
        child_interests: db.data.child_interests,
        recommendations: db.data.recommendations,
        explanations: db.data.explanations
    });
    await integrate(db, preferenceEvidence());
    assert.strictEqual(snapshot({
        developmentProfile: child(db).developmentProfile,
        child_interests: db.data.child_interests,
        recommendations: db.data.recommendations,
        explanations: db.data.explanations
    }), before);
    assert.deepStrictEqual(loadedBlockedRequires, []);
}

async function main() {
    await testPreferenceEvidence();
    await testPreferenceReplay();
    await testGoalSelection();
    await testGoalRemoval();
    await testGoalCombinedDiff();
    await testGoalReplay();
    await testPartialFailureRetry();
    await testUnsupportedInterest();
    await testNoDirectProfileOrRecommendationWrites();
    console.log("Question learning integration service unit tests: PASSED");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
