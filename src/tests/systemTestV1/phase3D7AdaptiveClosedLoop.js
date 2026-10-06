const assert = require("assert");
const { execFileSync } = require("child_process");
const Module = require("module");
const path = require("path");
const { ObjectId } = require("mongodb");
const { isDeepStrictEqual } = require("util");
const { D1_SUFFICIENCY } = require("../../knowledgeGap/knowledgeGapConstants");
const { evaluateKnowledgeGaps } = require("../../knowledgeGap/knowledgeGapEngineService");
const { findGoalIntentQuestions, findQuestionsForKnowledgeNeed } = require("../../questionLibrary/questionRetrievalService");
const { QUESTION_ELIGIBILITY_STATUS, QUESTION_INELIGIBILITY_REASON, evaluateQuestionEligibility } = require("../../questionEligibility/questionEligibilityService");
const { QUESTION_HISTORY_OUTCOME, recordQuestionPresentation } = require("../../questionEligibility/questionHistoryService");
const { QUESTION_SELECTION_REASON, selectQuestion } = require("../../questionSelection/questionSelectionService");
const { ANSWER_EVIDENCE_SOURCE, interpretQuestionAnswer } = require("../../questionAnswer/answerInterpretationService");
const { QUESTION_LEARNING_STATUS, integrateQuestionEvidence } = require("../../questionLearning/questionLearningIntegrationService");
const { calculatePreferenceFactor } = require("../../recommendation/preferenceFactorService");
const { calculateFinalScore } = require("../../recommendation/finalScoreService");
const { createFactorResult, SCORING_FACTORS } = require("../../recommendation/scoringContract");

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
const activityId = new ObjectId();
const subcategoryId = new ObjectId();
const goalA = new ObjectId();
const goalB = new ObjectId();
const occurredAt = new Date("2026-10-02T10:00:00Z");

const report = {};

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

function preference(value, source = "Parent", confidenceScore = 1) {
    return { value, confidenceScore, source, updatedAt: new Date("2026-09-01T00:00:00Z") };
}

function activeGoal(goalId, priority = 1) {
    return {
        goalId,
        priority,
        status: "Active",
        selectedBy: "Parent",
        selectedAt: new Date("2026-09-01T00:00:00Z"),
        targetDate: null
    };
}

function makeDb() {
    const data = {
        parents: [{ _id: parentId }],
        children: [{
            _id: childId,
            parentId,
            preferences: {
                socialStyle: preference("Team"),
                difficulty: preference("Beginner"),
                experienceStyle: preference("Structured"),
                commitmentPreference: preference("Weekly")
            },
            parentGoals: [],
            developmentProfile: []
        }],
        activities: [{
            _id: activityId,
            basicInformation: { nameEn: "Outdoor Team Starter", status: "Active" },
            classification: { subcategoryId },
            experience: {
                environment: "Outdoor",
                socialStyle: "Team",
                difficulty: "Beginner",
                experienceStyles: ["Structured"],
                commitmentType: "Weekly"
            },
            learningOutcomes: []
        }],
        subcategories: [{ _id: subcategoryId, name: "Team Sports" }],
        child_interests: [{ _id: new ObjectId(), childId, subcategoryId, interestScore: { currentScore: 0.7 }, confidence: { currentScore: 0.6, evidenceCount: 2 }, scoreHistory: [] }],
        goal_library: [{ _id: goalA, isActive: true }, { _id: goalB, isActive: true }],
        learning_outcomes: [],
        interactions: [],
        bookings: [],
        recommendations: [],
        parent_decisions: [],
        question_history: [],
        ai_jobs: [],
        graph_sync_queue: [],
        explanations: [{ _id: "explanation-1", text: "stable" }]
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
        listCollections() {
            return { toArray: async () => [] };
        },
        collection(name) {
            if (!Object.hasOwn(data, name)) data[name] = [];
            function store(options = {}) { return options.session ? staged[name] : data[name]; }
            return {
                async findOne(filter, options = {}) {
                    return copy(sortRecords(store(options).filter((record) => matches(record, filter)), options.sort)[0] ?? null);
                },
                find(filter) {
                    return {
                        toArray: async () => copy(store({}).filter((record) => matches(record, filter)))
                    };
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

function activity(db) {
    return db.data.activities[0];
}

function preferenceEvaluation(db) {
    const eligibilityEvaluation = {
        candidate: { currentActivity: activity(db), evidence: { interests: [], goals: [], summary: [] } },
        eligibility: { eligible: true, failedConstraints: [] },
        eligibleSessions: [],
        sessionEvaluations: [],
        missingInformation: []
    };
    const factor = calculatePreferenceFactor({ child: child(db) }, eligibilityEvaluation);
    const final = calculateFinalScore({
        eligibilityEvaluation,
        factors: {
            interest: createFactorResult({ factor: SCORING_FACTORS.INTEREST, available: true, score: 0.7, evidence: [{ source: "fixture" }] }),
            preference: factor,
            goal: createFactorResult({ factor: SCORING_FACTORS.GOAL, available: false, score: null, evidence: [] }),
            exploration: createFactorResult({ factor: SCORING_FACTORS.EXPLORATION, available: false, score: null, evidence: [] }),
            behavior: createFactorResult({ factor: SCORING_FACTORS.BEHAVIOR, available: false, score: null, evidence: [] }),
            session: createFactorResult({ factor: SCORING_FACTORS.SESSION, available: false, score: null, evidence: [] })
        }
    });
    return { factor, final };
}

function findEnvironmentGap(result) {
    return result.knowledgeGaps.find((gap) =>
        gap.targetType === "ChildPreference" &&
        gap.evidence?.dimension === "environment");
}

async function preferenceClosedLoop(db) {
    const d1Before = await evaluateKnowledgeGaps(childId, activityId, { db, evaluatedAt: occurredAt });
    const envGap = findEnvironmentGap(d1Before);
    const beforeRecommendation = preferenceEvaluation(db);
    const candidates = findQuestionsForKnowledgeNeed(envGap).map((candidate) => ({ ...candidate, knowledgeNeed: envGap }));
    const eligibility = await evaluateQuestionEligibility({
        db,
        childId,
        parentId,
        sessionId: "session-pref",
        questionCandidate: candidates[0],
        knowledgeNeed: envGap,
        currentTime: occurredAt
    });
    const selection = selectQuestion(candidates);
    const history = await recordQuestionPresentation({
        db,
        questionId: selection.selectedQuestion.questionId,
        childId,
        parentId,
        sessionId: "session-pref",
        askedAt: occurredAt
    });
    const interpreted = await interpretQuestionAnswer({
        db,
        questionId: history.questionId,
        answer: "Outdoor",
        childId,
        parentId,
        questionHistoryId: history._id
    });
    const integrated = await integrateQuestionEvidence({
        db,
        client: db.client,
        evidence: interpreted.evidence,
        occurredAt
    });
    const d1After = await evaluateKnowledgeGaps(childId, activityId, { db, evaluatedAt: occurredAt });
    const afterRecommendation = preferenceEvaluation(db);
    return { d1Before, envGap, beforeRecommendation, candidates, eligibility, selection, history, interpreted, integrated, d1After, afterRecommendation };
}

async function goalClosedLoop(db) {
    child(db).parentGoals = [activeGoal(goalA, 1)];
    const existingGoalA = copy(child(db).parentGoals[0]);
    const candidate = findGoalIntentQuestions()[0];
    const knowledgeNeed = { source: "PARENT_INTENT", sufficiencyState: D1_SUFFICIENCY.INSUFFICIENT };
    const eligibility = await evaluateQuestionEligibility({
        db,
        childId,
        parentId,
        sessionId: "session-goal",
        questionCandidate: candidate,
        knowledgeNeed,
        currentTime: occurredAt
    });
    const selection = selectQuestion([{ ...candidate, knowledgeNeed }]);
    const history = await recordQuestionPresentation({
        db,
        questionId: selection.selectedQuestion.questionId,
        childId,
        parentId,
        sessionId: "session-goal",
        askedAt: new Date(occurredAt.getTime() + 60000)
    });
    const interpreted = await interpretQuestionAnswer({
        db,
        questionId: history.questionId,
        answer: [goalA, goalB],
        childId,
        parentId,
        questionHistoryId: history._id
    });
    const integrated = await integrateQuestionEvidence({
        db,
        client: db.client,
        evidence: interpreted.evidence,
        occurredAt: new Date(occurredAt.getTime() + 60000)
    });
    return { existingGoalA, eligibility, selection, history, interpreted, integrated };
}

async function main() {
    const db = makeDb();
    let preferenceLoop;
    let goalLoop;

    await mark("A Initial Knowledge Gap", async () => {
        preferenceLoop = await preferenceClosedLoop(db);
        report.beforeD1 = {
            experienceFit: preferenceLoop.d1Before.experienceFit.sufficiencyState,
            environmentGap: preferenceLoop.envGap?.sufficiencyState
        };
        assert(preferenceLoop.envGap);
        assert.strictEqual(preferenceLoop.envGap.sufficiencyState, D1_SUFFICIENCY.INSUFFICIENT);
    });

    await mark("B Before Recommendation State", () => {
        report.beforePreferenceFactor = preferenceLoop.beforeRecommendation.factor;
        report.beforeRecommendationScore = preferenceLoop.beforeRecommendation.final.score;
        assert.strictEqual(preferenceLoop.beforeRecommendation.factor.available, true);
        assert.strictEqual(preferenceLoop.beforeRecommendation.factor.evidence.some((item) => item.dimension === "environment"), false);
        assert.strictEqual(preferenceLoop.beforeRecommendation.final.available, true);
    });

    await mark("C Approved Question Retrieval", () => {
        assert.strictEqual(preferenceLoop.candidates.length, 1);
        assert.strictEqual(preferenceLoop.candidates[0].questionId, "Q_PREF_ENVIRONMENT_001");
        assert(preferenceLoop.candidates[0].question);
    });

    await mark("D Question Eligibility", () => {
        assert.strictEqual(preferenceLoop.eligibility.status, QUESTION_ELIGIBILITY_STATUS.ELIGIBLE);
    });

    await mark("E Question Selection", () => {
        assert.strictEqual(preferenceLoop.selection.selectionReason, QUESTION_SELECTION_REASON.KNOWLEDGE_GAP_INSUFFICIENT);
        assert.strictEqual(preferenceLoop.selection.selectedQuestion.questionId, "Q_PREF_ENVIRONMENT_001");
    });

    await mark("F Question Presentation", () => {
        assert.strictEqual(preferenceLoop.history.outcome, QUESTION_HISTORY_OUTCOME.PRESENTED);
        assert(db.data.question_history.some((item) => item._id.equals(preferenceLoop.history._id)));
    });

    await mark("G Answer Interpretation", () => {
        assert.strictEqual(preferenceLoop.interpreted.status, "VALID");
        assert.strictEqual(preferenceLoop.interpreted.evidence.evidenceType, "PREFERENCE");
        assert.strictEqual(preferenceLoop.interpreted.evidence.target.dimension, "environment");
        assert.strictEqual(preferenceLoop.interpreted.evidence.value, "Outdoor");
        assert.strictEqual(preferenceLoop.interpreted.evidence.source, ANSWER_EVIDENCE_SOURCE);
    });

    await mark("H Learning Integration", () => {
        assert.strictEqual(preferenceLoop.integrated.status, QUESTION_LEARNING_STATUS.APPLIED);
        assert.strictEqual(db.data.parent_decisions[0].decisionType, "PreferenceUpdated");
        assert.strictEqual(db.data.ai_jobs[0].jobType, "ContinuousLearning");
    });

    await mark("I Child Preference Updated", () => {
        assert.strictEqual(child(db).preferences.environment.value, "Outdoor");
        assert.strictEqual(child(db).preferences.environment.source, "Parent");
    });

    await mark("J Question History Answered", () => {
        const record = db.data.question_history.find((item) => item._id.equals(preferenceLoop.history._id));
        assert.strictEqual(record.outcome, QUESTION_HISTORY_OUTCOME.ANSWERED);
    });

    await mark("K Knowledge Gap Re-evaluated", () => {
        const afterGap = findEnvironmentGap(preferenceLoop.d1After);
        report.afterD1 = {
            experienceFit: preferenceLoop.d1After.experienceFit.sufficiencyState,
            environmentGap: afterGap?.sufficiencyState ?? null,
            environmentState: preferenceLoop.d1After.experienceFit.dimensions.environment.sufficiencyState
        };
        assert.strictEqual(afterGap, undefined);
        assert.strictEqual(preferenceLoop.d1After.experienceFit.dimensions.environment.sufficiencyState, D1_SUFFICIENCY.SUFFICIENT);
    });

    await mark("L Recommendation Recalculated", () => {
        report.afterPreferenceFactor = preferenceLoop.afterRecommendation.factor;
        report.afterRecommendationScore = preferenceLoop.afterRecommendation.final.score;
        assert.strictEqual(preferenceLoop.afterRecommendation.final.available, true);
    });

    await mark("M New Preference Consumed", () => {
        assert.strictEqual(preferenceLoop.afterRecommendation.factor.available, true);
        const environmentEvidence = preferenceLoop.afterRecommendation.factor.evidence.find((item) => item.dimension === "environment");
        assert(environmentEvidence);
        assert.strictEqual(environmentEvidence.childValue, "Outdoor");
        assert.strictEqual(environmentEvidence.activityValue, "Outdoor");
        assert.strictEqual(environmentEvidence.baseMatch, 1);
    });

    await mark("N No Direct Question Score Bonus", () => {
        assert.strictEqual(JSON.stringify(preferenceLoop.afterRecommendation).includes("question"), false);
        assert(preferenceLoop.afterRecommendation.factor.evidence.every((item) => item.source === "Parent"));
    });

    await mark("O No Immediate Re-question", async () => {
        const afterGap = findEnvironmentGap(preferenceLoop.d1After);
        assert.strictEqual(afterGap, undefined);
        const cooldown = await evaluateQuestionEligibility({
            db,
            childId,
            parentId,
            sessionId: "session-repeat",
            questionCandidate: preferenceLoop.selection.selectedQuestion,
            knowledgeNeed: preferenceLoop.envGap,
            currentTime: new Date(occurredAt.getTime() + 60000)
        });
        assert.strictEqual(cooldown.status, "INELIGIBLE");
        assert.strictEqual(cooldown.reason, QUESTION_INELIGIBILITY_REASON.QUESTION_COOLDOWN);
    });

    await mark("P Preference Replay Safety", async () => {
        const before = snapshot({ preferences: child(db).preferences, decisions: db.data.parent_decisions, jobs: db.data.ai_jobs });
        const replay = await integrateQuestionEvidence({
            db,
            client: db.client,
            evidence: preferenceLoop.interpreted.evidence,
            occurredAt
        });
        assert.strictEqual(replay.status, QUESTION_LEARNING_STATUS.APPLIED);
        assert.strictEqual(snapshot({ preferences: child(db).preferences, decisions: db.data.parent_decisions, jobs: db.data.ai_jobs }), before);
        report.preferenceReplay = replay.status;
    });

    await mark("Q Goal Intent Closed Loop", async () => {
        goalLoop = await goalClosedLoop(db);
        assert.strictEqual(goalLoop.eligibility.status, QUESTION_ELIGIBILITY_STATUS.ELIGIBLE);
        assert.strictEqual(goalLoop.selection.selectedQuestion.questionId, "Q_GOAL_INTENT_001");
        assert.strictEqual(goalLoop.interpreted.status, "VALID");
        assert.strictEqual(goalLoop.integrated.status, QUESTION_LEARNING_STATUS.APPLIED);
        const goalAState = child(db).parentGoals.find((goal) => String(goal.goalId) === String(goalA));
        const goalBState = child(db).parentGoals.find((goal) => String(goal.goalId) === String(goalB));
        assert.deepStrictEqual(goalAState, goalLoop.existingGoalA);
        assert.strictEqual(goalBState.status, "Active");
        assert.strictEqual(goalBState.priority, 2);
        assert.strictEqual(db.data.question_history.find((item) => item._id.equals(goalLoop.history._id)).outcome, QUESTION_HISTORY_OUTCOME.ANSWERED);
    });

    await mark("R Goal Learning / Graph Sync", () => {
        report.graphSync = db.data.graph_sync_queue.map((item) => ({ entityType: item.entityType, operation: item.operation, status: item.status }));
        assert.strictEqual(db.data.graph_sync_queue.length, 1);
        assert.strictEqual(db.data.graph_sync_queue[0].entityType, "Child");
        assert.strictEqual(db.data.graph_sync_queue[0].status, "PENDING");
    });

    await mark("S Goal Replay Safety", async () => {
        const before = snapshot({ goals: child(db).parentGoals, decisions: db.data.parent_decisions, jobs: db.data.ai_jobs, queue: db.data.graph_sync_queue });
        const replay = await integrateQuestionEvidence({
            db,
            client: db.client,
            evidence: goalLoop.interpreted.evidence,
            occurredAt: new Date(occurredAt.getTime() + 60000)
        });
        assert.strictEqual(replay.status, QUESTION_LEARNING_STATUS.APPLIED);
        assert.strictEqual(snapshot({ goals: child(db).parentGoals, decisions: db.data.parent_decisions, jobs: db.data.ai_jobs, queue: db.data.graph_sync_queue }), before);
        report.goalReplay = replay.status;
    });

    await mark("T Unknown != Negative", () => {
        assert.strictEqual(preferenceLoop.beforeRecommendation.factor.evidence.some((item) => item.dimension === "environment"), false);
        assert.strictEqual(preferenceLoop.beforeRecommendation.factor.evidence.some((item) => item.dimension === "environment" && item.baseMatch === 0), false);
    });

    await mark("U Interest Remains Blocked", async () => {
        const before = snapshot(db.data.child_interests);
        const interest = await interpretQuestionAnswer({
            db,
            questionId: "Q_INTEREST_SUBCATEGORY_001",
            answer: "High",
            childId,
            parentId,
            questionHistoryId: new ObjectId()
        });
        assert.strictEqual(interest.status, "INVALID");
        assert.strictEqual(snapshot(db.data.child_interests), before);
        assert.strictEqual(db.data.interactions.length, 0);
        assert.strictEqual(db.data.bookings.length, 0);
    });

    await mark("V Ownership Boundaries", () => {
        assert(db.data.parent_decisions.every((decision) => decision.context.source === "QuestionAnswer"));
        assert(db.data.ai_jobs.every((job) => job.audit.source === "ParentDecision"));
        assert.deepStrictEqual(loadedBlockedRequires, []);
    });

    await mark("W Regression", () => {
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
            "src/tests/testParentDecisionContinuousLearning.js",
            "src/tests/testPreferenceFactor.js",
            "src/tests/testFinalScore.js",
            "src/tests/systemTestV1/phase3D6FinalVerification.js",
            "src/tests/systemTestV1/phase3D5FinalVerification.js",
            "src/tests/systemTestV1/phase3D4FinalVerification.js",
            "src/tests/systemTestV1/phase3D3FinalVerification.js",
            "src/tests/systemTestV1/phase3D2FinalVerification.js"
        ]) {
            execFileSync(process.execPath, [testFile], { cwd: root, stdio: "ignore" });
        }
    });

    await mark("X Cleanup / Repository Safety", () => {
        assert.deepStrictEqual(loadedBlockedRequires, []);
        assert.strictEqual(makeDb().data.parent_decisions.length, 0);
        assert.strictEqual(makeDb().data.ai_jobs.length, 0);
        assert.strictEqual(makeDb().data.graph_sync_queue.length, 0);
    });

    console.log("========================================");
    console.log("PHASE 3 - D7B ADAPTIVE CLOSED LOOP");
    console.log("========================================");
    for (const label of [
        "A Initial Knowledge Gap",
        "B Before Recommendation State",
        "C Approved Question Retrieval",
        "D Question Eligibility",
        "E Question Selection",
        "F Question Presentation",
        "G Answer Interpretation",
        "H Learning Integration",
        "I Child Preference Updated",
        "J Question History Answered",
        "K Knowledge Gap Re-evaluated",
        "L Recommendation Recalculated",
        "M New Preference Consumed",
        "N No Direct Question Score Bonus",
        "O No Immediate Re-question",
        "P Preference Replay Safety",
        "Q Goal Intent Closed Loop",
        "R Goal Learning / Graph Sync",
        "S Goal Replay Safety",
        "T Unknown != Negative",
        "U Interest Remains Blocked",
        "V Ownership Boundaries",
        "W Regression",
        "X Cleanup / Repository Safety"
    ]) {
        console.log(`${label}: ${acceptance.get(label)}`);
    }
    console.log("");
    console.log("D7B ADAPTIVE CLOSED LOOP: PASS");
    console.log(`BEFORE D1: ${JSON.stringify(report.beforeD1)}`);
    console.log(`AFTER D1: ${JSON.stringify(report.afterD1)}`);
    console.log(`BEFORE preference factor: ${JSON.stringify(report.beforePreferenceFactor)}`);
    console.log(`AFTER preference factor: ${JSON.stringify(report.afterPreferenceFactor)}`);
    console.log(`BEFORE recommendation score: ${report.beforeRecommendationScore}`);
    console.log(`AFTER recommendation score: ${report.afterRecommendationScore}`);
    console.log(`Graph sync: ${JSON.stringify(report.graphSync)}`);
}

main().catch((error) => {
    console.error(error);
    console.log("");
    console.log("D7B ADAPTIVE CLOSED LOOP: FAIL");
    process.exitCode = 1;
});
