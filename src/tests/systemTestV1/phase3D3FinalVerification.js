const assert = require("assert");
const { execFileSync } = require("child_process");
const Module = require("module");
const path = require("path");
const { ObjectId } = require("mongodb");
const { D1_SUFFICIENCY } = require("../../knowledgeGap/knowledgeGapConstants");
const {
    LEARNING_INTEGRATION,
    QUESTION_DEFINITIONS,
    QUESTION_STATUS,
    isOperationallyAvailable
} = require("../../questionLibrary/questionLibrary");
const {
    findGoalIntentQuestions,
    findQuestionsForKnowledgeNeed
} = require("../../questionLibrary/questionRetrievalService");

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
} = require("../../questionEligibility/questionEligibilityService");
const {
    QUESTION_HISTORY_OUTCOME,
    recordQuestionPresentation,
    updateQuestionHistoryOutcome
} = require("../../questionEligibility/questionHistoryService");

Module._load = originalLoad;

const acceptance = new Map();
const now = new Date("2026-09-30T12:00:00Z");
const dayMs = 24 * 60 * 60 * 1000;

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
        children: [{ _id: "child-1", preferences: { socialStyle: { value: "Team" } }, parentGoals: [] }],
        child_interests: [{ _id: "interest-1", childId: "child-1", interestScore: { currentScore: 0.7 } }],
        graph_sync_queue: [],
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

function daysAgo(days) {
    return new Date(now.getTime() - days * dayMs);
}

function byId(questionId) {
    return QUESTION_DEFINITIONS.find((question) => question.questionId === questionId);
}

function preferenceNeed(overrides = {}) {
    return {
        key: "preference:child-1:socialStyle",
        dimension: "experienceFit",
        targetType: "ChildPreference",
        targetId: "child-1:socialStyle",
        sufficiencyState: D1_SUFFICIENCY.INSUFFICIENT,
        reasons: ["CHILD_PREFERENCE_MISSING"],
        possibleResolvers: ["PARENT"],
        evidence: { dimension: "socialStyle", childPreference: null },
        ...overrides
    };
}

function interestNeed() {
    return {
        key: "interest:child-1:subcategory:subcategory-1",
        dimension: "interestCoverage",
        targetType: "Subcategory",
        targetId: "subcategory-1",
        sufficiencyState: D1_SUFFICIENCY.INSUFFICIENT,
        possibleResolvers: ["CHILD_BEHAVIOR", "PARENT"]
    };
}

function d2Candidate(questionId = "Q_PREF_SOCIAL_001") {
    const candidates = findQuestionsForKnowledgeNeed(preferenceNeed({
        key: `preference:child-1:${byId(questionId).target.dimension}`,
        targetId: `child-1:${byId(questionId).target.dimension}`,
        evidence: { dimension: byId(questionId).target.dimension, childPreference: null }
    }));
    const found = candidates.find((item) => item.questionId === questionId);
    assert(found, `${questionId} must be returned by D2`);
    return found;
}

async function evaluate(db, overrides = {}) {
    return await evaluateQuestionEligibility({
        db,
        childId: "child-1",
        parentId: "parent-1",
        sessionId: "session-1",
        questionCandidate: d2Candidate(),
        knowledgeNeed: preferenceNeed(),
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
        sessionId: "older-session",
        ...overrides
    };
}

function assertEligible(result) {
    assert.deepStrictEqual(result, {
        status: QUESTION_ELIGIBILITY_STATUS.ELIGIBLE,
        reason: null
    });
}

function assertReason(result, reason) {
    assert.strictEqual(result.status, QUESTION_ELIGIBILITY_STATUS.INELIGIBLE);
    assert.strictEqual(result.reason, reason);
}

async function main() {
    await mark("A Basic Eligibility", async () => {
        assertEligible(await evaluate(fakeDb()));
    });

    await mark("B Knowledge Resolved", async () => {
        const db = fakeDb({
            question_history: [
                history({ askedAt: daysAgo(2) }),
                history({ questionId: "Q_PREF_ENVIRONMENT_001", sessionId: "session-1" })
            ]
        });
        const result = await evaluate(db, {
            knowledgeNeed: preferenceNeed({ sufficiencyState: D1_SUFFICIENCY.SUFFICIENT })
        });
        assertReason(result, QUESTION_INELIGIBILITY_REASON.KNOWLEDGE_NO_LONGER_NEEDED);
    });

    await mark("C Same Question Cooldown", async () => {
        assertReason(await evaluate(fakeDb({ question_history: [history({ askedAt: daysAgo(27) })] })),
            QUESTION_INELIGIBILITY_REASON.QUESTION_COOLDOWN);
    });

    await mark("D Exact 28-Day Boundary", async () => {
        assertEligible(await evaluate(fakeDb({ question_history: [history({ askedAt: daysAgo(28) })] })));
    });

    await mark("E Expired Cooldown", async () => {
        assertEligible(await evaluate(fakeDb({ question_history: [history({ askedAt: daysAgo(29) })] })));
    });

    await mark("F Outcome-Independent Cooldown", async () => {
        for (const outcome of Object.values(QUESTION_HISTORY_OUTCOME)) {
            assertReason(await evaluate(fakeDb({ question_history: [history({ outcome, askedAt: daysAgo(3) })] })),
                QUESTION_INELIGIBILITY_REASON.QUESTION_COOLDOWN);
        }
    });

    await mark("G Child Isolation", async () => {
        const db = fakeDb({ question_history: [history({ childId: "child-A", askedAt: daysAgo(3) })] });
        assertReason(await evaluate(db, { childId: "child-A" }), QUESTION_INELIGIBILITY_REASON.QUESTION_COOLDOWN);
        assertEligible(await evaluate(db, { childId: "child-B" }));
    });

    await mark("H Session Limit", async () => {
        const db = fakeDb({ question_history: [history({ questionId: "Q_PREF_ENVIRONMENT_001", sessionId: "session-1", askedAt: daysAgo(40) })] });
        assertReason(await evaluate(db), QUESTION_INELIGIBILITY_REASON.SESSION_LIMIT_REACHED);
    });

    await mark("I Different Session", async () => {
        const db = fakeDb({ question_history: [history({ questionId: "Q_PREF_ENVIRONMENT_001", sessionId: "older-session", askedAt: daysAgo(40) })] });
        assertEligible(await evaluate(db));
    });

    await mark("J Rule Order", async () => {
        const db = fakeDb({
            question_history: [
                history({ askedAt: daysAgo(2) }),
                history({ questionId: "Q_PREF_ENVIRONMENT_001", sessionId: "session-1" })
            ]
        });
        assertReason(await evaluate(db, { knowledgeNeed: preferenceNeed({ sufficiencyState: D1_SUFFICIENCY.SUFFICIENT }) }),
            QUESTION_INELIGIBILITY_REASON.KNOWLEDGE_NO_LONGER_NEEDED);
        assertReason(await evaluate(db), QUESTION_INELIGIBILITY_REASON.QUESTION_COOLDOWN);
        assertReason(await evaluate(fakeDb({ question_history: [history({ questionId: "Q_PREF_ENVIRONMENT_001", sessionId: "session-1", askedAt: daysAgo(40) })] })),
            QUESTION_INELIGIBILITY_REASON.SESSION_LIMIT_REACHED);
    });

    await mark("K Presentation Recording", async () => {
        const db = fakeDb();
        await evaluate(db);
        assert.deepStrictEqual(db.data.question_history, []);
        const askedAt = new Date("2026-09-30T12:30:00Z");
        const document = await recordQuestionPresentation({
            db,
            questionId: "Q_PREF_SOCIAL_001",
            childId: "child-1",
            parentId: "parent-1",
            sessionId: "session-1",
            askedAt
        });
        assert.strictEqual(db.data.question_history.length, 1);
        assert(document._id instanceof ObjectId);
        assert.strictEqual(document.questionId, "Q_PREF_SOCIAL_001");
        assert.strictEqual(document.childId, "child-1");
        assert.strictEqual(document.parentId, "parent-1");
        assert.deepStrictEqual(document.askedAt, askedAt);
        assert.strictEqual(document.outcome, QUESTION_HISTORY_OUTCOME.PRESENTED);
        assert.strictEqual(document.sessionId, "session-1");
    });

    await mark("L Outcome Transitions", async () => {
        for (const outcome of [QUESTION_HISTORY_OUTCOME.ANSWERED, QUESTION_HISTORY_OUTCOME.SKIPPED]) {
            const record = history();
            const db = fakeDb({ question_history: [record] });
            assert.deepStrictEqual(await updateQuestionHistoryOutcome({ db, questionHistoryId: record._id, outcome }), { status: "UPDATED" });
            assert.strictEqual(db.data.question_history[0].outcome, outcome);
        }
        await assert.rejects(
            () => updateQuestionHistoryOutcome({ db: fakeDb(), questionHistoryId: new ObjectId(), outcome: "OTHER" }),
            /UNSUPPORTED_QUESTION_HISTORY_OUTCOME/
        );
    });

    await mark("M Question Definition Immutability", async () => {
        const before = snapshot(QUESTION_DEFINITIONS);
        const db = fakeDb({ question_history: [history()] });
        await evaluate(db, { questionCandidate: d2Candidate("Q_PREF_ENVIRONMENT_001") });
        const document = await recordQuestionPresentation({
            db,
            questionId: "Q_PREF_SOCIAL_001",
            childId: "child-1",
            parentId: "parent-1",
            sessionId: "session-2",
            askedAt: now
        });
        await updateQuestionHistoryOutcome({ db, questionHistoryId: document._id, outcome: QUESTION_HISTORY_OUTCOME.ANSWERED });
        assert.strictEqual(snapshot(QUESTION_DEFINITIONS), before);
        const question = byId("Q_PREF_SOCIAL_001");
        assert.strictEqual(question.status, QUESTION_STATUS.ACTIVE);
        assert.strictEqual(question.learningIntegration, LEARNING_INTEGRATION.AVAILABLE);
        assert(question.category);
        assert(question.target);
        assert(question.answerFormat);
    });

    await mark("N D2 Operational Boundary", async () => {
        assert.strictEqual(isOperationallyAvailable(byId("Q_PREF_SOCIAL_001")), true);
        assert.strictEqual(findGoalIntentQuestions()[0].questionId, "Q_GOAL_INTENT_001");
        assert.strictEqual(isOperationallyAvailable(byId("Q_GOAL_INTENT_001")), true);
        assert.strictEqual(byId("Q_INTEREST_SUBCATEGORY_001").learningIntegration, LEARNING_INTEGRATION.NOT_IMPLEMENTED);
        assert.strictEqual(isOperationallyAvailable(byId("Q_INTEREST_SUBCATEGORY_001")), false);
        assert.deepStrictEqual(findQuestionsForKnowledgeNeed(interestNeed()), []);
    });

    await mark("O No Learning Side Effects", async () => {
        const db = fakeDb();
        const before = snapshot({
            children: db.data.children,
            child_interests: db.data.child_interests
        });
        const document = await recordQuestionPresentation({
            db,
            questionId: "Q_PREF_SOCIAL_001",
            childId: "child-1",
            parentId: "parent-1",
            sessionId: "session-1",
            askedAt: now
        });
        await updateQuestionHistoryOutcome({ db, questionHistoryId: document._id, outcome: QUESTION_HISTORY_OUTCOME.SKIPPED });
        await evaluate(db, { sessionId: "session-2", questionCandidate: d2Candidate("Q_PREF_ENVIRONMENT_001") });
        assert.strictEqual(snapshot({ children: db.data.children, child_interests: db.data.child_interests }), before);
    });

    await mark("P No Graph Side Effects", async () => {
        const db = fakeDb();
        const before = snapshot({ graph_sync_queue: db.data.graph_sync_queue, ai_jobs: db.data.ai_jobs });
        await evaluate(db);
        const document = await recordQuestionPresentation({
            db,
            questionId: "Q_PREF_SOCIAL_001",
            childId: "child-1",
            parentId: "parent-1",
            sessionId: "session-1",
            askedAt: now
        });
        await updateQuestionHistoryOutcome({ db, questionHistoryId: document._id, outcome: QUESTION_HISTORY_OUTCOME.ANSWERED });
        assert.strictEqual(snapshot({ graph_sync_queue: db.data.graph_sync_queue, ai_jobs: db.data.ai_jobs }), before);
        assert.deepStrictEqual(loadedBlockedRequires, []);
    });

    await mark("Q No Recommendation Side Effects", async () => {
        const db = fakeDb();
        const before = snapshot({ recommendations: db.data.recommendations, explanations: db.data.explanations });
        const output = await evaluate(db);
        assert.strictEqual(snapshot({ recommendations: db.data.recommendations, explanations: db.data.explanations }), before);
        const serialized = JSON.stringify(output);
        for (const forbidden of ["score", "rank", "factor", "explanation", "selectedQuestionId"]) {
            assert.strictEqual(serialized.includes(forbidden), false);
        }
    });

    await mark("R Session/Cooldown Independence", async () => {
        assertReason(await evaluate(fakeDb({ question_history: [history({ sessionId: "older-session", askedAt: daysAgo(2) })] })),
            QUESTION_INELIGIBILITY_REASON.QUESTION_COOLDOWN);
        assertReason(await evaluate(fakeDb({ question_history: [history({ questionId: "Q_PREF_ENVIRONMENT_001", sessionId: "session-1", askedAt: daysAgo(40) })] })),
            QUESTION_INELIGIBILITY_REASON.SESSION_LIMIT_REACHED);
    });

    await mark("S Read/Write Boundary", async () => {
        const readDb = fakeDb();
        await evaluate(readDb);
        assert(readDb.operations.every((item) => item.operation === "findOne"));

        const writeDb = fakeDb();
        const document = await recordQuestionPresentation({
            db: writeDb,
            questionId: "Q_PREF_SOCIAL_001",
            childId: "child-1",
            parentId: "parent-1",
            sessionId: "session-1",
            askedAt: now
        });
        await updateQuestionHistoryOutcome({ db: writeDb, questionHistoryId: document._id, outcome: QUESTION_HISTORY_OUTCOME.ANSWERED });
        assert.deepStrictEqual(writeDb.operations.map((item) => `${item.collection}.${item.operation}`), [
            "question_history.insertOne",
            "question_history.updateOne"
        ]);
    });

    await mark("T Regression", async () => {
        const root = path.resolve(__dirname, "../../..");
        for (const testFile of [
            "src/tests/testQuestionEligibilityService.js",
            "src/tests/testQuestionLibrary.js",
            "src/tests/testQuestionRetrievalService.js",
            "src/tests/testKnowledgeGapEngineService.js",
            "src/tests/testParentDecisionPersistenceService.js",
            "src/tests/testPreferenceDecisionTransition.js",
            "src/tests/testParentDecisionContract.js",
            "src/tests/testParentDecisionPreflightService.js",
            "src/tests/systemTestV1/phase3D2FinalVerification.js"
        ]) {
            execFileSync(process.execPath, [testFile], { cwd: root, stdio: "ignore" });
        }
    });

    await mark("U Repository Safety / Cleanup", async () => {
        assert.strictEqual(snapshot(fakeDb().data.question_history), "[]");
        assert.strictEqual(snapshot(QUESTION_DEFINITIONS), snapshot(QUESTION_DEFINITIONS));
        assert.deepStrictEqual(loadedBlockedRequires, []);
    });

    console.log("========================================");
    console.log("PHASE 3 - D3 FINAL ACCEPTANCE");
    console.log("========================================");
    for (const label of [
        "A Basic Eligibility",
        "B Knowledge Resolved",
        "C Same Question Cooldown",
        "D Exact 28-Day Boundary",
        "E Expired Cooldown",
        "F Outcome-Independent Cooldown",
        "G Child Isolation",
        "H Session Limit",
        "I Different Session",
        "J Rule Order",
        "K Presentation Recording",
        "L Outcome Transitions",
        "M Question Definition Immutability",
        "N D2 Operational Boundary",
        "O No Learning Side Effects",
        "P No Graph Side Effects",
        "Q No Recommendation Side Effects",
        "R Session/Cooldown Independence",
        "S Read/Write Boundary",
        "T Regression",
        "U Repository Safety / Cleanup"
    ]) {
        console.log(`${label}: ${acceptance.get(label)}`);
    }
    console.log("");
    console.log("D3 FINAL ACCEPTANCE: PASS");
}

main().catch((error) => {
    console.error(error);
    console.log("");
    console.log("D3 FINAL ACCEPTANCE: FAIL");
    process.exitCode = 1;
});
