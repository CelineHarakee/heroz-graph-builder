const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const { ObjectId } = require("mongodb");
const root = path.resolve(__dirname, "..");
const allowed = new Set([
    "api/v1/questionAnswers.js", "api/v1/index.js", "api/apiError.js", "api/apiResponse.js",
    "api/requestValidation.js", "services/questionAnswerSubmissionService.js", "utils/idUtils.js"
].map(file => path.join(root, file)));
const interpreterPath = path.join(root, "questionAnswer/answerInterpretationService.js");
const integrationPath = path.join(root, "questionLearning/questionLearningIntegrationService.js");
const originalLoad = Module._load;
let integrationDelegate;
// The default integration module is a boundary double; real D6/D7 behavior is
// covered by their unchanged regression suites. Interpretation is real here.
Module._load = function (request, parent, isMain) {
    const resolved = Module._resolveFilename(request, parent);
    if (parent && allowed.has(parent.filename)) {
        assert.ok(allowed.has(resolved) || request === "mongodb" || [interpreterPath, integrationPath,
            path.join(root, "questionLibrary/questionLibrary.js"),
            path.join(root, "questionEligibility/questionHistoryService.js")].includes(resolved), request);
        if (resolved === integrationPath) return {
            QUESTION_LEARNING_STATUS: { APPLIED: "APPLIED" },
            integrateQuestionEvidence: input => integrationDelegate(input)
        };
    }
    return originalLoad.call(this, request, parent, isMain);
};
const { METHOD, PATH, handleQuestionAnswer } = require("../api/v1/questionAnswers");
const { interpretQuestionAnswer } = require("../questionAnswer/answerInterpretationService");
const { QUESTION_DEFINITIONS, isOperationallyAvailable } = require("../questionLibrary/questionLibrary");
const { submitQuestionAnswer } = require("../services/questionAnswerSubmissionService");
const historyId = new ObjectId("507f1f77bcf86cd799439010");
const childId = new ObjectId("507f1f77bcf86cd799439011");
const parentId = new ObjectId("507f1f77bcf86cd799439012");
const preferenceQuestions = QUESTION_DEFINITIONS.filter(q => q.category === "PREFERENCE" && isOperationallyAvailable(q));
const success = { status: 200, body: { success: true, data: { questionHistoryId: String(historyId), status: "ANSWERED" } } };
const safeFailure = { status: 500, body: { success: false, error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred." } } };
function fixture(question = preferenceQuestions[0]) {
    const f = { history: { _id: historyId, childId, parentId, questionId: question.questionId,
        askedAt: new Date("2026-01-01"), outcome: "PRESENTED", sessionId: "product-session" }, calls: [] };
    const client = {};
    f.db = { client, collection(name) {
        assert.equal(name, "question_history");
        return new Proxy({ async findOne(query) {
            assert.deepEqual(query, { _id: historyId });
            f.calls.push("read");
            return f.history ? { ...f.history } : null;
        } }, { get(target, key) {
            assert.ok(Object.hasOwn(target, key), `Direct API write/operation forbidden: ${String(key)}`);
            return target[key];
        } });
    } };
    f.services = {
        async interpretQuestionAnswer(input) {
            assert.equal(f.calls[0], "read");
            f.calls.push("interpret");
            assert.equal(input.questionId, f.history.questionId);
            assert.equal(input.childId, childId); assert.equal(input.parentId, parentId);
            assert.equal(input.questionHistoryId, historyId);
            return interpretQuestionAnswer(input);
        },
        async integrateQuestionEvidence(input) {
            f.calls.push("integrate");
            assert.equal(input.client, client); assert.equal(input.db, f.db);
            assert.equal(input.questionHistoryId, historyId);
            assert.equal(input.evidence.sourceQuestionId, f.history.questionId);
            assert.equal(input.evidence.childId, childId); assert.equal(input.evidence.parentId, parentId);
            assert.equal(input.evidence.evidenceType, "PREFERENCE");
            assert.ok(input.occurredAt instanceof Date && Math.abs(Date.now() - input.occurredAt.getTime()) < 10000);
            assert.equal(Object.hasOwn(input, "sessionId"), false);
            assert.equal(Object.hasOwn(input, "recommendationId"), false);
            f.history.outcome = "ANSWERED"; // Simulates the delegate's durable completion.
            return { status: "APPLIED", questionHistory: { status: "UPDATED" } };
        }
    };
    f.options = { db: f.db, services: f.services };
    return f;
}
let checks = 0;
async function check(name, run) { await run(); checks++; console.log(`PASS ${name}`); }
async function main() {
    await check("endpoint contract", () => {
        assert.equal(METHOD, "POST");
        assert.equal(PATH, "/api/v1/question-presentations/{questionHistoryId}/answer");
    });
    for (const question of preferenceQuestions) {
        await check(`real interpretation and authoritative learning inputs: ${question.questionId}`, async () => {
            const f = fixture(question);
            const answer = question.allowedValues.find(value => value === "Outdoor") ?? question.allowedValues[0];
            assert.deepEqual(await handleQuestionAnswer(String(historyId), { answer }, f.options), success);
            assert.deepEqual(f.calls, ["read", "interpret", "integrate", "read"]);
            f.calls.length = 0;
            assert.deepEqual(await handleQuestionAnswer(String(historyId), { answer: "different answer" }, f.options), success);
            assert.deepEqual(f.calls, ["read"]);
        });
    }
    await check("default exported interpretation/integration boundaries are used", async () => {
        const f = fixture();
        integrationDelegate = f.services.integrateQuestionEvidence;
        assert.deepEqual(await handleQuestionAnswer(String(historyId), { answer: "Outdoor" }, { db: f.db }), success);
        assert.deepEqual(f.calls, ["read", "integrate", "read"]);
    });
    await check("structural validation rejects malformed IDs, bodies and client identity overrides", async () => {
        const requests = [
            ...[undefined, null, "", "bad", 1, {}, []].map(id => [id, { answer: "Outdoor" }]),
            ...[undefined, null, [], "Outdoor", {}].map(body => [String(historyId), body]),
            ...["childId", "parentId", "questionId", "sessionId", "activityId", "occurredAt", "recommendationId", "evidence", "learningState"].map(key => [String(historyId), { answer: "Outdoor", [key]: "client" }])
        ];
        for (const [id, body] of requests) {
            const f = fixture();
            assert.equal((await handleQuestionAnswer(id, body, f.options)).status, 400);
            assert.deepEqual(f.calls, []);
        }
    });
    await check("missing, skipped and invalid states stop before interpretation/learning", async () => {
        for (const state of [null, "SKIPPED", "UNKNOWN", undefined]) {
            const f = fixture();
            if (state === null) f.history = null; else f.history.outcome = state;
            assert.equal((await handleQuestionAnswer(String(historyId), { answer: "Outdoor" }, f.options)).status, state === null ? 404 : 409);
            assert.deepEqual(f.calls, ["read"]);
        }
    });
    await check("goal, interest and unknown definitions never learn", async () => {
        for (const questionId of ["Q_GOAL_INTENT_001", "Q_INTEREST_SUBCATEGORY_001", "UNKNOWN"]) {
            const f = fixture(); f.history.questionId = questionId;
            assert.equal((await handleQuestionAnswer(String(historyId), { answer: "Outdoor" }, f.options)).status, 409);
            assert.deepEqual(f.calls, ["read"]);
        }
    });
    await check("interpreter owns invalid/empty answer rules; no skip or integration", async () => {
        for (const answer of [null, undefined, "", " \t", [], {}, "invalid", 1, true]) {
            const f = fixture();
            const response = await handleQuestionAnswer(String(historyId), { answer }, f.options);
            assert.equal(response.status, 400); assert.equal(response.body.error.code, "INVALID_ANSWER");
            assert.deepEqual(f.calls, ["read", "interpret"]);
            assert.equal(f.history.outcome, "PRESENTED");
        }
        const f = fixture();
        await assert.rejects(() => submitQuestionAnswer(String(historyId), "invalid", f.options), error =>
            error.interpretationReason === "ANSWER_NOT_ALLOWED");
    });
    await check("APPLIED is insufficient without a final authoritative ANSWERED record", async () => {
        for (const outcome of ["PRESENTED", "SKIPPED", null]) {
            const f = fixture();
            f.services.integrateQuestionEvidence = async () => {
                f.calls.push("integrate");
                if (outcome === null) f.history = null; else f.history.outcome = outcome;
                return { status: "APPLIED", questionHistory: { status: "UPDATED" } };
            };
            assert.deepEqual(await handleQuestionAnswer(String(historyId), { answer: "Outdoor" }, f.options), safeFailure);
            assert.deepEqual(f.calls, ["read", "interpret", "integrate", "read"]);
        }
    });
    await check("learning failure cannot claim success even if history says ANSWERED", async () => {
        for (const status of ["FAILED", "INVALID", undefined]) {
            const f = fixture();
            f.services.integrateQuestionEvidence = async () => { f.history.outcome = "ANSWERED"; return { status }; };
            assert.deepEqual(await handleQuestionAnswer(String(historyId), { answer: "Outdoor" }, f.options), safeFailure);
        }
    });
    await check("exceptions at interpretation, integration, initial and final reads are sanitized", async () => {
        const fail = () => { throw new Error("mongodb://user:secret@private neo4j://private stack"); };
        for (const name of ["interpretQuestionAnswer", "integrateQuestionEvidence"]) {
            const f = fixture(); f.services[name] = fail;
            assert.deepEqual(await handleQuestionAnswer(String(historyId), { answer: "Outdoor" }, f.options), safeFailure);
            if (name === "interpretQuestionAnswer") assert.deepEqual(f.calls, ["read"]);
        }
        const f = fixture(); f.db.collection = fail;
        assert.deepEqual(await handleQuestionAnswer(String(historyId), { answer: "Outdoor" }, f.options), safeFailure);
        const g = fixture();
        const integrate = g.services.integrateQuestionEvidence;
        g.services.integrateQuestionEvidence = async input => { const result = await integrate(input); g.db.collection = fail; return result; };
        assert.deepEqual(await handleQuestionAnswer(String(historyId), { answer: "Outdoor" }, g.options), safeFailure);
    });
    console.log(`${checks} grouped D5 checks passed; Phase 4 database writes and unrelated dependencies prohibited.`);
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { Module._load = originalLoad; });
