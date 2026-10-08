const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const { ObjectId } = require("mongodb");
const root = path.resolve(__dirname, "..");
const originalLoad = Module._load;
// Guard project dependencies for both orchestration and real Phase 3 delegates.
Module._load = function (request, parent, isMain) {
    const resolved = Module._resolveFilename(request, parent);
    if (typeof resolved === "string" && resolved.startsWith(root + path.sep)) {
        const relative = path.relative(root, resolved);
        assert.ok(relative === "recommendation/preferenceComparisonService.js" ||
            !/^(recommendation|traversal|builders|questionAnswer|questionLearning|workers)\//.test(relative), relative);
        assert.ok(!relative.startsWith("learning/") || relative === "learning/parentDecisionContract.js", relative);
        assert.ok(!relative.startsWith("config/"), relative);
    }
    return originalLoad.call(this, request, parent, isMain);
};
const { METHOD, PATH, handleNextQuestion } = require("../api/v1/adaptiveQuestions");
const { evaluateKnowledgeGaps } = require("../knowledgeGap/knowledgeGapEngineService");
const { findQuestionsForKnowledgeNeed } = require("../questionLibrary/questionRetrievalService");
const { evaluateQuestionEligibility } = require("../questionEligibility/questionEligibilityService");
const { selectQuestion } = require("../questionSelection/questionSelectionService");
const { recordQuestionPresentation } = require("../questionEligibility/questionHistoryService");
const { QUESTION_DEFINITIONS } = require("../questionLibrary/questionLibrary");
const ids = Object.fromEntries(["child", "parent", "activity", "subcategory"].map((key, i) => [key, new ObjectId(`507f1f77bcf86cd79943901${i}`)]));
const body = { activityId: String(ids.activity), sessionId: "session-pref" };
const delegates = { evaluateKnowledgeGaps, findQuestionsForKnowledgeNeed, evaluateQuestionEligibility, selectQuestion, recordQuestionPresentation };
const pref = QUESTION_DEFINITIONS.find(q => q.questionId === "Q_PREF_ENVIRONMENT_001");
function matches(record, query) {
    return Object.entries(query).every(([key, expected]) => {
        const actual = key.split(".").reduce((value, part) => value?.[part], record);
        return expected?.$in ? expected.$in.includes(actual) : String(actual) === String(expected);
    });
}
function fixture() {
    const data = {
        children: [{ _id: ids.child, parentId: ids.parent, preferences: {}, parentGoals: [], developmentProfile: [] }],
        activities: [{ _id: ids.activity, classification: { subcategoryId: ids.subcategory },
            experience: { environment: "Outdoor", socialStyle: "Team", difficulty: "Beginner", experienceStyles: ["Structured"], commitmentType: "Weekly" }, learningOutcomes: [] }],
        subcategories: [{ _id: ids.subcategory }], child_interests: [], question_history: []
    };
    const writes = [];
    const db = {
        listCollections: () => ({ toArray: async () => [] }),
        collection(name) {
            assert.ok(Object.hasOwn(data, name), `Unexpected collection ${name}`);
            const methods = {
                async findOne(query, options = {}) {
                    const found = data[name].filter(record => matches(record, query));
                    if (options.sort) found.sort((a, b) => b.askedAt - a.askedAt);
                    return found[0] ?? null;
                }
            };
            if (name === "question_history") methods.insertOne = async document => {
                assert.equal(document.outcome, "PRESENTED");
                writes.push(name); data[name].push(document);
                return { insertedId: document._id };
            };
            return new Proxy(methods, { get(target, key) {
                assert.ok(Object.hasOwn(target, key), `Forbidden operation ${name}.${String(key)}`);
                return target[key];
            } });
        }
    };
    return { db, data, writes };
}
const noQuestion = { status: 200, body: { success: true, data: { childId: String(ids.child), question: null } } };
const internalError = { status: 500, body: { success: false, error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred." } } };
const resolved = knowledgeGaps => ({ evaluation: { status: "RESOLVED" }, knowledgeGaps });
const need = { targetType: "ChildPreference", evidence: { dimension: "environment" }, sufficiencyState: "INSUFFICIENT" };
let checks = 0;
async function check(label, run) { await run(); checks++; console.log(`PASS ${label}`); }
async function main() {
    await check("POST endpoint", () => {
        assert.equal(METHOD, "POST");
        assert.equal(PATH, "/api/v1/children/{childId}/questions/next");
    });
    await check("real D1-D4 delegation, exact projection and one authoritative PRESENTED write", async () => {
        const f = fixture();
        const before = JSON.stringify({ ...f.data, question_history: [] });
        const calls = {};
        const services = Object.fromEntries(Object.entries(delegates).map(([name, fn]) => [name, (...args) => {
            (calls[name] ??= []).push(args); return fn(...args);
        }]));
        const response = await handleNextQuestion(String(ids.child), body, { db: f.db, services });
        assert.equal(f.data.question_history.length, 1);
        const history = f.data.question_history[0];
        assert.deepEqual(response, { status: 200, body: { success: true, data: {
            childId: String(ids.child), question: { questionId: pref.questionId,
                fallbackTemplate: pref.fallbackTemplate, answerFormat: pref.answerFormat, allowedValues: pref.allowedValues },
            questionHistoryId: String(history._id)
        } } });
        assert.equal(response.body.data.question.allowedValues, pref.allowedValues);
        assert.deepEqual(Object.keys(history).sort(), ["_id", "questionId", "childId", "parentId", "askedAt", "outcome", "sessionId"].sort());
        assert.equal(String(history.childId), String(ids.child));
        assert.equal(String(history.parentId), String(ids.parent));
        assert.equal(history.sessionId, body.sessionId);
        assert.equal(history.outcome, "PRESENTED");
        assert.equal(history.questionId, pref.questionId);
        for (const name of Object.keys(delegates)) assert.ok(calls[name].length > 0, name);
        assert.equal(calls.selectQuestion.length, 1);
        assert.equal(calls.recordQuestionPresentation.length, 1);
        for (const [input] of calls.evaluateQuestionEligibility) assert.equal(input.questionCandidate.knowledgeNeed, input.knowledgeNeed);
        assert.equal(JSON.stringify({ ...f.data, question_history: [] }), before);
        assert.deepEqual(f.writes, ["question_history"]);
        assert.deepEqual(await handleNextQuestion(String(ids.child), body, { db: f.db }), noQuestion);
        assert.equal(f.data.question_history.length, 1);
        // Different session: recently presented environment stays on cooldown,
        // while a different preference can still be selected by existing services.
        const next = await handleNextQuestion(String(ids.child), { ...body, sessionId: "session-next" }, { db: f.db });
        assert.equal(next.status, 200);
        assert.notEqual(next.body.data.question.questionId, pref.questionId);
    });
    await check("resolved empty, unmatched, ineligible and unselected results never write", async () => {
        const cases = [
            { evaluateKnowledgeGaps: async () => resolved([]) },
            { evaluateKnowledgeGaps: async () => resolved([{ targetType: "Unknown" }]) },
            { evaluateKnowledgeGaps: async () => resolved([need]), evaluateQuestionEligibility: async () => ({ status: "INELIGIBLE", reason: "QUESTION_COOLDOWN" }) },
            { selectQuestion: () => ({ selectedQuestion: null, selectionReason: "NO_ELIGIBLE_QUESTIONS" }) }
        ];
        for (const services of cases) {
            const f = fixture();
            assert.deepEqual(await handleNextQuestion(String(ids.child), body, { db: f.db, services }), noQuestion);
            assert.deepEqual(f.writes, []);
        }
    });
    await check("V1 excludes goal, interest and nonoperational preferences without fallbacks", async () => {
        const f = fixture();
        const questions = QUESTION_DEFINITIONS.filter(q => q.category !== "PREFERENCE");
        questions.push({ ...pref, status: "INACTIVE" }, { ...pref, learningIntegration: "NOT_IMPLEMENTED" });
        const services = {
            evaluateKnowledgeGaps: async () => resolved([need]),
            findQuestionsForKnowledgeNeed: () => questions.map(question => ({ question, questionId: question.questionId })),
            evaluateQuestionEligibility: () => { throw new Error("Excluded candidate reached eligibility"); }
        };
        assert.deepEqual(await handleNextQuestion(String(ids.child), body, { db: f.db, services }), noQuestion);
        assert.deepEqual(f.writes, []);
    });
    await check("invalid IDs/body and all client overrides return 400 before DB access", async () => {
        const options = { db: { collection() { throw new Error("Should not read"); } } };
        const requests = [
            ...[undefined, null, "", "bad", 1, {}].map(id => [id, body]),
            ...[undefined, null, [], "body"].map(value => [String(ids.child), value]),
            ...[undefined, null, "bad", 1, {}].map(activityId => [String(ids.child), { ...body, activityId }]),
            ...[undefined, null, "", " ", 1, {}, []].map(sessionId => [String(ids.child), { ...body, sessionId }]),
            ...["parentId", "knowledgeNeed", "priority", "askedAt", "currentTime", "db", "eligibility", "category", "services"].map(key => [String(ids.child), { ...body, [key]: "untrusted" }])
        ];
        for (const [childId, input] of requests) {
            const response = await handleNextQuestion(childId, input, options);
            assert.equal(response.status, 400);
            assert.equal(response.body.error.code, "BAD_REQUEST");
        }
    });
    await check("missing child/activity/parent/subcategory and unresolved D1 are errors", async () => {
        for (const [collection, status, code] of [["children", 404, "CHILD_NOT_FOUND"], ["activities", 404, "ACTIVITY_NOT_FOUND"], ["subcategories", 500, "INTERNAL_ERROR"]]) {
            const f = fixture(); f.data[collection] = [];
            const response = await handleNextQuestion(String(ids.child), body, { db: f.db });
            assert.equal(response.status, status); assert.equal(response.body.error.code, code);
            assert.deepEqual(f.writes, []);
        }
        const f = fixture(); delete f.data.children[0].parentId;
        assert.deepEqual(await handleNextQuestion(String(ids.child), body, { db: f.db }), internalError);
        for (const reason of ["CHILD_NOT_FOUND", "ACTIVITY_NOT_FOUND", "SUBCATEGORY_NOT_FOUND", "ACTIVITY_SUBCATEGORY_MISSING", "UNKNOWN"]) {
            const f = fixture();
            const response = await handleNextQuestion(String(ids.child), body, { db: f.db, services: {
                evaluateKnowledgeGaps: async () => ({ evaluation: { status: "UNRESOLVABLE", reason }, knowledgeGaps: [] })
            } });
            assert.equal(response.status, ["CHILD_NOT_FOUND", "ACTIVITY_NOT_FOUND"].includes(reason) ? 404 : 500);
            assert.deepEqual(f.writes, []);
        }
    });
    await check("failures at every delegate and DB boundary are safe 500, never No Question", async () => {
        const fail = () => { throw new Error("mongodb://user:secret@private neo4j://private internal stack"); };
        for (const name of Object.keys(delegates)) {
            const f = fixture();
            assert.deepEqual(await handleNextQuestion(String(ids.child), body, { db: f.db, services: { [name]: fail } }), internalError);
            assert.deepEqual(f.writes, []);
        }
        assert.deepEqual(await handleNextQuestion(String(ids.child), body, { db: { collection: fail } }), internalError);
    });
    console.log(`${checks} grouped D4 checks passed using real Phase 3 delegates and guarded database writes/dependencies.`);
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { Module._load = originalLoad; });
