const assert = require("assert");
const { execFileSync } = require("child_process");
const Module = require("module");
const path = require("path");
const { ObjectId } = require("mongodb");
const { isDeepStrictEqual } = require("util");
const { D1_SUFFICIENCY } = require("../../knowledgeGap/knowledgeGapConstants");
const { PREFERENCE_VALUES } = require("../../learning/parentDecisionContract");
const { QUESTION_HISTORY_OUTCOME } = require("../../questionEligibility/questionHistoryService");
const { QUESTION_ELIGIBILITY_STATUS, evaluateQuestionEligibility } = require("../../questionEligibility/questionEligibilityService");
const { findQuestionsForKnowledgeNeed } = require("../../questionLibrary/questionRetrievalService");
const { QUESTION_SELECTION_REASON, selectQuestion } = require("../../questionSelection/questionSelectionService");
const {
    ANSWER_EVIDENCE_SOURCE,
    ANSWER_EVIDENCE_TYPE,
    interpretQuestionAnswer
} = require("../../questionAnswer/answerInterpretationService");
const {
    QUESTION_LEARNING_REASON,
    QUESTION_LEARNING_STATUS,
    integrateQuestionEvidence
} = require("../../questionLearning/questionLearningIntegrationService");

const blockedRequires = new Set(["@google/genai", "http", "https", "net", "tls", "neo4j-driver"]);
const originalLoad = Module._load;
const loadedBlockedRequires = [];

Module._load = function guardedLoad(request, parent, isMain) {
    if (blockedRequires.has(request)) loadedBlockedRequires.push(request);
    return originalLoad.apply(this, arguments);
};

Module._load = originalLoad;

const acceptance = new Map();
const parentId = new ObjectId();
const childId = new ObjectId();
const questionHistoryId = new ObjectId();
const goalA = new ObjectId();
const goalB = new ObjectId();
const goalC = new ObjectId();
const occurredAt = new Date("2026-10-01T10:00:00Z");

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

function activeGoal(goalId, priority = 1, selectedAt = new Date("2026-09-01T00:00:00Z")) {
    return { goalId, priority, status: "Active", selectedBy: "Parent", selectedAt, targetDate: null };
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
        child_interests: [{ _id: "interest-1", score: 0.7, confidence: { currentScore: 0.5, evidenceCount: 2 } }],
        recommendations: [{ _id: "recommendation-1", score: 0.6 }],
        explanations: [{ _id: "explanation-1", text: "stable" }],
        ...copy(overrides)
    };
    let active = false;
    let staged = null;
    const session = {
        startTransaction() { active = true; staged = copy(data); },
        inTransaction: () => active,
        async commitTransaction() {
            Object.keys(data).forEach((key) => delete data[key]);
            Object.assign(data, staged);
            staged = null;
            active = false;
        },
        async abortTransaction() { staged = null; active = false; },
        async endSession() {}
    };
    const client = { startSession: () => session };
    const db = {
        data,
        client,
        collection(name) {
            if (!Object.hasOwn(data, name)) data[name] = [];
            function store(options = {}) { return options.session ? staged[name] : data[name]; }
            return {
                async findOne(filter, options = {}) {
                    return copy(sortRecords(store(options).filter((record) => matches(record, filter)), options.sort)[0] ?? null);
                },
                async insertOne(document, options = {}) {
                    store(options).push(copy(document));
                    return { insertedId: document._id };
                },
                async updateOne(filter, update, options = {}) {
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

function child(db) {
    return db.data.children[0];
}

function activeIds(db) {
    return child(db).parentGoals
        .filter((goal) => goal.status === "Active")
        .map((goal) => String(goal.goalId))
        .sort();
}

function preferenceEvidence(dimension = "environment", value = "Outdoor") {
    const questionIds = {
        environment: "Q_PREF_ENVIRONMENT_001",
        socialStyle: "Q_PREF_SOCIAL_001",
        difficulty: "Q_PREF_DIFFICULTY_001",
        experienceStyle: "Q_PREF_EXPERIENCE_001",
        commitmentPreference: "Q_PREF_COMMITMENT_001"
    };
    return {
        childId,
        parentId,
        sourceQuestionId: questionIds[dimension],
        questionHistoryId,
        source: ANSWER_EVIDENCE_SOURCE,
        evidenceType: ANSWER_EVIDENCE_TYPE.PREFERENCE,
        target: { type: "ChildPreference", dimension },
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
    return await integrateQuestionEvidence({ db, client: db.client, evidence, occurredAt, ...extra });
}

function preferenceNeed(dimension) {
    return {
        key: `preference:${childId}:${dimension}`,
        dimension: "experienceFit",
        targetType: "ChildPreference",
        targetId: `${childId}:${dimension}`,
        sufficiencyState: D1_SUFFICIENCY.INSUFFICIENT,
        reasons: ["CHILD_PREFERENCE_MISSING"],
        possibleResolvers: ["PARENT"],
        evidence: { dimension, childPreference: null }
    };
}

async function main() {
    await mark("A Preference Closed Loop", async () => {
        const db = makeDb();
        const interpreted = await interpretQuestionAnswer({
            db,
            questionId: "Q_PREF_ENVIRONMENT_001",
            answer: "Outdoor",
            childId,
            parentId,
            questionHistoryId
        });
        assert.strictEqual(interpreted.status, "VALID");
        const result = await integrate(db, interpreted.evidence);
        assert.strictEqual(result.status, QUESTION_LEARNING_STATUS.APPLIED);
        assert.strictEqual(child(db).preferences.environment.value, "Outdoor");
        assert.strictEqual(db.data.parent_decisions[0].decisionType, "PreferenceUpdated");
        assert.strictEqual(db.data.ai_jobs[0].components.preference.status, "APPLIED");
        assert.strictEqual(db.data.question_history[0].outcome, QUESTION_HISTORY_OUTCOME.ANSWERED);
    });

    await mark("B All Five Preferences", async () => {
        for (const [dimension, values] of Object.entries(PREFERENCE_VALUES)) {
            const db = makeDb();
            const result = await integrate(db, preferenceEvidence(dimension, values[0]));
            assert.strictEqual(result.status, QUESTION_LEARNING_STATUS.APPLIED);
            assert.strictEqual(child(db).preferences[dimension].value, values[0]);
        }
    });

    await mark("C Preference Replay", async () => {
        const db = makeDb();
        await integrate(db, preferenceEvidence());
        const before = snapshot({ decisions: db.data.parent_decisions, jobs: db.data.ai_jobs, child: child(db) });
        await integrate(db, preferenceEvidence());
        assert.strictEqual(db.data.parent_decisions.length, 1);
        assert.strictEqual(db.data.ai_jobs.length, 1);
        assert.strictEqual(snapshot({ decisions: db.data.parent_decisions, jobs: db.data.ai_jobs, child: child(db) }), before);
    });

    await mark("D Goal Addition", async () => {
        const db = makeDb();
        child(db).parentGoals = [activeGoal(goalA, 1)];
        await integrate(db, goalEvidence([goalA, goalB]));
        assert.deepStrictEqual(activeIds(db), [String(goalA), String(goalB)].sort());
        assert.strictEqual(child(db).parentGoals.find((goal) => String(goal.goalId) === String(goalA)).priority, 1);
        assert.strictEqual(child(db).parentGoals.find((goal) => String(goal.goalId) === String(goalB)).priority, 2);
    });

    await mark("E Goal Removal", async () => {
        const db = makeDb();
        child(db).parentGoals = [activeGoal(goalA, 1), activeGoal(goalC, 3)];
        await integrate(db, goalEvidence([goalA]));
        assert.deepStrictEqual(activeIds(db), [String(goalA)]);
    });

    await mark("F Goal Combined Diff", async () => {
        const db = makeDb();
        child(db).parentGoals = [activeGoal(goalA, 1), activeGoal(goalC, 3)];
        await integrate(db, goalEvidence([goalA, goalB]));
        assert.deepStrictEqual(activeIds(db), [String(goalA), String(goalB)].sort());
        assert.strictEqual(child(db).parentGoals.find((goal) => String(goal.goalId) === String(goalA)).priority, 1);
        assert.strictEqual(child(db).parentGoals.find((goal) => String(goal.goalId) === String(goalB)).priority, 2);
        assert.deepStrictEqual(db.data.parent_decisions.map((doc) => doc.decisionType).sort(), ["GoalRemoved", "GoalSelected"]);
        assert.strictEqual(db.data.parent_decisions.some((doc) => doc.decisionType === "GoalUpdated"), false);
    });

    await mark("G Goal Graph Sync", async () => {
        const db = makeDb();
        child(db).parentGoals = [activeGoal(goalA, 1), activeGoal(goalC, 3)];
        await integrate(db, goalEvidence([goalA, goalB]));
        assert.strictEqual(db.data.graph_sync_queue.length, 2);
        assert(db.data.graph_sync_queue.every((item) =>
            item.entityType === "Child" &&
            item.operation === "UPDATE" &&
            item.status === "PENDING" &&
            item.entityId.equals(childId)));
    });

    await mark("H Goal Replay", async () => {
        const db = makeDb();
        child(db).parentGoals = [activeGoal(goalA, 1), activeGoal(goalC, 3)];
        await integrate(db, goalEvidence([goalA, goalB]));
        const before = snapshot({ goals: child(db).parentGoals, decisions: db.data.parent_decisions, jobs: db.data.ai_jobs, queue: db.data.graph_sync_queue });
        await integrate(db, goalEvidence([goalA, goalB]));
        assert.strictEqual(snapshot({ goals: child(db).parentGoals, decisions: db.data.parent_decisions, jobs: db.data.ai_jobs, queue: db.data.graph_sync_queue }), before);
    });

    await mark("I Question History Ordering", async () => {
        const db = makeDb();
        assert.strictEqual(db.data.question_history[0].outcome, QUESTION_HISTORY_OUTCOME.PRESENTED);
        await integrate(db, preferenceEvidence());
        assert.strictEqual(db.data.question_history[0].outcome, QUESTION_HISTORY_OUTCOME.ANSWERED);
    });

    await mark("J Failure Safety", async () => {
        const db = makeDb();
        child(db).parentGoals = [activeGoal(goalA, 1), activeGoal(goalC, 3)];
        let removeAttempts = 0;
        const dependencies = {
            async persistParentDecision(args) {
                if (args.event.eventType === "GoalRemoved" && ++removeAttempts === 1) {
                    return { status: "FAILED", reasonCode: "DATABASE_ERROR", retryable: true };
                }
                const { persistParentDecision } = require("../../learning/parentDecisionPersistenceService");
                return await persistParentDecision(args);
            }
        };
        const failed = await integrate(db, goalEvidence([goalA, goalB]), { dependencies });
        assert.strictEqual(failed.status, QUESTION_LEARNING_STATUS.FAILED);
        assert.strictEqual(db.data.question_history[0].outcome, QUESTION_HISTORY_OUTCOME.PRESENTED);
        assert.deepStrictEqual(activeIds(db), [String(goalA), String(goalB), String(goalC)].sort());
        const retried = await integrate(db, goalEvidence([goalA, goalB]), { dependencies });
        assert.strictEqual(retried.status, QUESTION_LEARNING_STATUS.APPLIED);
        assert.strictEqual(db.data.question_history[0].outcome, QUESTION_HISTORY_OUTCOME.ANSWERED);
        assert.deepStrictEqual(activeIds(db), [String(goalA), String(goalB)].sort());
    });

    await mark("K ParentDecision Source Integrity", async () => {
        const db = makeDb();
        await integrate(db, preferenceEvidence());
        const original = copy(db.data.parent_decisions[0]);
        await integrate(db, preferenceEvidence());
        assert.strictEqual(db.data.parent_decisions.length, 1);
        assert.deepStrictEqual(db.data.parent_decisions[0], original);

        db.data.parent_decisions[0].decisionData.value = "Indoor";
        const conflict = await integrate(db, preferenceEvidence());
        assert.strictEqual(conflict.status, QUESTION_LEARNING_STATUS.FAILED);
        assert.strictEqual(conflict.reason, QUESTION_LEARNING_REASON.SOURCE_CONFLICT);
    });

    await mark("L Interest Remains Blocked", async () => {
        const db = makeDb();
        const before = snapshot({ interests: db.data.child_interests, history: db.data.question_history });
        const result = await integrate(db, {
            evidenceType: "INTEREST",
            childId,
            parentId,
            questionHistoryId,
            source: ANSWER_EVIDENCE_SOURCE
        });
        assert.strictEqual(result.status, QUESTION_LEARNING_STATUS.INVALID);
        assert.strictEqual(snapshot({ interests: db.data.child_interests, history: db.data.question_history }), before);
    });

    await mark("M Development Data Unchanged", async () => {
        const db = makeDb();
        const before = snapshot(child(db).developmentProfile);
        await integrate(db, preferenceEvidence());
        assert.strictEqual(snapshot(child(db).developmentProfile), before);
    });

    await mark("N Recommendation Boundary", async () => {
        const db = makeDb();
        const before = snapshot({ recommendations: db.data.recommendations, explanations: db.data.explanations });
        await integrate(db, preferenceEvidence());
        assert.strictEqual(snapshot({ recommendations: db.data.recommendations, explanations: db.data.explanations }), before);
    });

    await mark("O Ownership Boundaries", async () => {
        const db = makeDb();
        await integrate(db, preferenceEvidence());
        assert.strictEqual(db.data.parent_decisions.length, 1);
        assert.strictEqual(db.data.ai_jobs.length, 1);
        assert.strictEqual(db.data.ai_jobs[0].jobType, "ContinuousLearning");
        assert.strictEqual(db.data.ai_jobs[0].audit.source, "ParentDecision");
    });

    await mark("P Integrated Question Flow", async () => {
        const db = makeDb({ question_history: [] });
        const need = preferenceNeed("environment");
        const candidates = findQuestionsForKnowledgeNeed(need).map((candidate) => ({ ...candidate, knowledgeNeed: need }));
        assert.strictEqual(candidates.length, 1);
        const eligibility = await evaluateQuestionEligibility({
            db,
            childId,
            parentId,
            sessionId: "session-1",
            questionCandidate: candidates[0],
            knowledgeNeed: need,
            currentTime: occurredAt
        });
        assert.strictEqual(eligibility.status, QUESTION_ELIGIBILITY_STATUS.ELIGIBLE);
        const selection = selectQuestion(candidates);
        assert.strictEqual(selection.selectionReason, QUESTION_SELECTION_REASON.KNOWLEDGE_GAP_INSUFFICIENT);
        db.data.question_history.push({
            _id: questionHistoryId,
            questionId: selection.selectedQuestion.questionId,
            childId,
            parentId,
            askedAt: occurredAt,
            outcome: QUESTION_HISTORY_OUTCOME.PRESENTED,
            sessionId: "session-1"
        });
        const interpreted = await interpretQuestionAnswer({
            db,
            questionId: selection.selectedQuestion.questionId,
            answer: "Outdoor",
            childId,
            parentId,
            questionHistoryId
        });
        assert.strictEqual(interpreted.status, "VALID");
        const integrated = await integrate(db, interpreted.evidence);
        assert.strictEqual(integrated.status, QUESTION_LEARNING_STATUS.APPLIED);
        assert.strictEqual(child(db).preferences.environment.value, "Outdoor");
        assert.strictEqual(db.data.question_history[0].outcome, QUESTION_HISTORY_OUTCOME.ANSWERED);
    });

    await mark("Q Regression", () => {
        const root = path.resolve(__dirname, "../../..");
        for (const testFile of [
            "src/tests/testQuestionLearningIntegrationService.js",
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
            "src/tests/systemTestV1/phase3D5FinalVerification.js",
            "src/tests/systemTestV1/phase3D4FinalVerification.js",
            "src/tests/systemTestV1/phase3D3FinalVerification.js",
            "src/tests/systemTestV1/phase3D2FinalVerification.js"
        ]) {
            execFileSync(process.execPath, [testFile], { cwd: root, stdio: "ignore" });
        }
    });

    await mark("R Cleanup / Repository Safety", () => {
        const db = makeDb();
        assert.strictEqual(db.data.parent_decisions.length, 0);
        assert.strictEqual(db.data.ai_jobs.length, 0);
        assert.strictEqual(db.data.graph_sync_queue.length, 0);
        assert.strictEqual(db.data.question_history[0].outcome, QUESTION_HISTORY_OUTCOME.PRESENTED);
        assert.deepStrictEqual(loadedBlockedRequires, []);
    });

    console.log("========================================");
    console.log("PHASE 3 - D6 FINAL ACCEPTANCE");
    console.log("========================================");
    for (const label of [
        "A Preference Closed Loop",
        "B All Five Preferences",
        "C Preference Replay",
        "D Goal Addition",
        "E Goal Removal",
        "F Goal Combined Diff",
        "G Goal Graph Sync",
        "H Goal Replay",
        "I Question History Ordering",
        "J Failure Safety",
        "K ParentDecision Source Integrity",
        "L Interest Remains Blocked",
        "M Development Data Unchanged",
        "N Recommendation Boundary",
        "O Ownership Boundaries",
        "P Integrated Question Flow",
        "Q Regression",
        "R Cleanup / Repository Safety"
    ]) {
        console.log(`${label}: ${acceptance.get(label)}`);
    }
    console.log("");
    console.log("D6 FINAL ACCEPTANCE: PASS");
}

main().catch((error) => {
    console.error(error);
    console.log("");
    console.log("D6 FINAL ACCEPTANCE: FAIL");
    process.exitCode = 1;
});
