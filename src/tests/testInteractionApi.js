const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const { ObjectId } = require("mongodb");
const { normalizeInteraction } = require("../learning/eventNormalizer");
const { validateEvent } = require("../learning/eventValidator");
const { processContinuousLearningSource } = require("../learning/continuousLearningService");
const root = path.resolve(__dirname, "..");
const allowed = new Set([
    "observability/runtimeMetrics.js", "observability/structuredLogger.js", "observability/traceContext.js", "reliability/reliabilityFailure.js","api/v1/interactions.js", "services/interactionSubmissionService.js",
    "api/v1/index.js", "api/apiError.js", "api/apiResponse.js", "api/requestValidation.js", "utils/idUtils.js"
].map(file => path.join(root, file)));
const enginePath = path.join(root, "learning/continuousLearningService.js");
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (parent && allowed.has(parent.filename)) {
        const resolved = Module._resolveFilename(request, parent);
        assert.ok(allowed.has(resolved) || resolved === enginePath || ["mongodb", "node:async_hooks", "node:crypto"].includes(request), `Forbidden API dependency: ${request}`);
    }
    return originalLoad.call(this, request, parent, isMain);
};
const { METHOD, PATH, handleInteraction } = require("../api/v1/interactions");
const childId = "507f1f77bcf86cd799439010";
const activityId = "507f1f77bcf86cd799439011";
function fixture(changeResult) {
    const f = { stored: [], calls: [] };
    f.db = { client: {}, collection(name) {
        assert.equal(name, "interactions");
        return new Proxy({ async insertOne(source) {
            f.calls.push("insert"); f.stored.push(source);
            return { acknowledged: true, insertedId: source._id };
        } }, { get(target, key) {
            assert.ok(Object.hasOwn(target, key), `Unexpected operation ${String(key)}`);
            return target[key];
        } });
    } };
    f.processContinuousLearningSource = async (sourceType, source, options) => {
        f.calls.push("D7");
        assert.equal(sourceType, "Interaction"); assert.equal(source, f.stored.at(-1));
        assert.equal(options.db, f.db); assert.equal(options.client, f.db.client);
        assert.deepEqual(f.calls.slice(-2), ["insert", "D7"]);
        const event = normalizeInteraction(source);
        const checked = validateEvent(event); // Real authoritative rating validation.
        const result = { eventId: event?.eventId ?? null, eventType: event?.eventType ?? null,
            status: checked.status === "VALID" ? "APPLIED" : checked.status,
            reasonCode: checked.status === "VALID" ? "INTEREST_LEARNING_PERSISTED" : checked.reasonCode };
        const response = { status: "COMPLETED", sourceType, results: [result] };
        return changeResult ? changeResult(response, source) : response;
    };
    return f;
}
const input = { activityId, interactionType: "Save" };
const failure = { status: 500, body: { success: false, error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred." } } };
let count = 0;
async function check(label, run) { await run(); count++; console.log(`PASS ${label}`); }
async function main() {
    await check("endpoint", () => { assert.equal(METHOD, "POST"); assert.equal(PATH, "/api/v1/children/{childId}/interactions"); });
    for (const interactionType of ["View", "Click", "Save", "Unsave", "Dismiss", "Rate"]) {
        await check(`${interactionType}: exact canonical source, insert-before-D7 and public projection`, async () => {
            const f = fixture();
            const body = { activityId, interactionType, ...(interactionType === "Rate" ? { ratingValue: 5 } : {}) };
            const before = Date.now();
            const response = await handleInteraction(childId, body, f);
            const source = f.stored[0];
            assert.ok(source._id instanceof ObjectId);
            assert.ok(source.timestamp instanceof Date && source.timestamp.getTime() >= before && source.timestamp.getTime() <= Date.now());
            assert.deepEqual(source, { _id: source._id, actor: { childId: new ObjectId(childId) },
                targetEntity: { entityId: new ObjectId(activityId) }, interactionDetails: {
                    interactionType, ...(interactionType === "Rate" ? { ratingValue: 5 } : {})
                }, timestamp: source.timestamp });
            assert.deepEqual(response, { status: 200, body: { success: true, data: { interactionId: String(source._id), status: "RECORDED" } } });
            assert.deepEqual(f.calls, ["insert", "D7"]);
        });
    }
    await check("Book/Attend/unsupported types and non-Rate rating rejected before insertion", async () => {
        for (const body of [ ...["Book", "Attend", "Complete", "save", "", undefined, 1].map(interactionType => ({ activityId, interactionType })), { ...input, ratingValue: 5 }]) {
            const f = fixture(); assert.equal((await handleInteraction(childId, body, f)).status, 400); assert.deepEqual(f.calls, []);
        }
    });
    await check("IDs, bodies and all client-owned forbidden fields reject before writes", async () => {
        const requests = [
            ...[undefined, null, "", "bad", {}, 1].map(id => [id, input]),
            ...[undefined, null, [], "body", {}].map(body => [childId, body]),
            ...[undefined, null, "", "bad", 1].map(id => [childId, { ...input, activityId: id }]),
            ...["parentId", "interactionId", "_id", "timestamp", "occurredAt", "sessionId", "recommendationId", "subcategoryId", "categoryId", "learningOutcomeId", "actor", "targetEntity", "context", "source", "evidence", "learningState"].map(key => [childId, { ...input, [key]: "client" }])
        ];
        for (const [id, body] of requests) { const f = fixture(); assert.equal((await handleInteraction(id, body, f)).status, 400); assert.deepEqual(f.calls, []); }
    });
    await check("invalid Rate reaches real top-level D7 validator after source insertion", async () => {
        for (const ratingValue of [undefined, null, "5", 0, 6, 1.5, {}, []]) {
            const f = fixture();
            // No source lookup or learning writes occur: actual D7 rejects before reference validation.
            delete f.processContinuousLearningSource;
            const response = await handleInteraction(childId, { activityId, interactionType: "Rate", ratingValue }, f);
            assert.equal(response.status, 400); assert.equal(response.body.error.code, "INTERACTION_REJECTED");
            assert.equal(f.stored.length, 1); assert.deepEqual(f.calls, ["insert"]);
        }
    });
    await check("legitimate completed suppression and same-event replay map to RECORDED", async () => {
        for (const reasonCode of ["REPEAT_LIMIT_REACHED", "NO_STATE_TRANSITION", "DUPLICATE_EVENT"]) {
            const f = fixture(response => { Object.assign(response.results[0], { status: "IGNORED", reasonCode }); return response; });
            assert.equal((await handleInteraction(childId, input, f)).status, 200);
        }
    });
    await check("rejected, failed, unfinished and unknown results never become RECORDED", async () => {
        for (const [status, reasonCode, expected] of [
            ["REJECTED", "CHILD_NOT_FOUND", 400], ["FAILED", "DATABASE_ERROR", 500],
            ["IGNORED", "NON_LEARNING_EVENT", 500], ["IGNORED", "EVENT_ALREADY_PROCESSING", 409],
            ["FAILED", "INVALID_PROCESSING_STATE", 500], ["REJECTED", "RETRY_REQUIRES_ORCHESTRATION", 409],
            ["IGNORED", "UNKNOWN", 500], ["APPLIED", "UNKNOWN", 500]
        ]) {
            const f = fixture(response => { Object.assign(response.results[0], { status, reasonCode }); return response; });
            const response = await handleInteraction(childId, input, f);
            assert.equal(response.status, expected); assert.equal(response.body.success, false);
            assert.equal(f.stored.length, 1); assert.deepEqual(f.calls, ["insert", "D7"]);
        }
    });
    await check("COMPLETED alone, wrong cardinality/source or event identity fails safely", async () => {
        for (const change of [() => ({ status: "COMPLETED" }), r => ({ ...r, results: [] }),
            r => ({ ...r, results: [...r.results, ...r.results] }), r => ({ ...r, status: "PROCESSING" }),
            r => ({ ...r, sourceType: "Booking" }),
            r => { r.results[0].eventId = "another-source"; r.results[0].status = "IGNORED"; r.results[0].reasonCode = "DUPLICATE_EVENT"; return r; },
            r => { r.results[0].eventType = "Attend"; return r; }
        ]) assert.deepEqual(await handleInteraction(childId, input, fixture(change)), failure);
    });
    await check("source insertion failure stops D7; D7 failure retains source without rollback", async () => {
        const fail = () => { throw new Error("mongodb://user:secret@private neo4j://private stack"); };
        const f = fixture(); f.db.collection = fail;
        assert.deepEqual(await handleInteraction(childId, input, f), failure); assert.deepEqual(f.calls, []);
        const g = fixture(); g.processContinuousLearningSource = fail;
        assert.deepEqual(await handleInteraction(childId, input, g), failure); assert.equal(g.stored.length, 1);
    });
    await check("identical new submissions retain separate canonical identities", async () => {
        const f = fixture();
        const first = await handleInteraction(childId, input, f);
        const second = await handleInteraction(childId, input, f);
        assert.equal(first.status, 200); assert.equal(second.status, 200);
        assert.notEqual(first.body.data.interactionId, second.body.data.interactionId);
        assert.equal(f.stored.length, 2); assert.deepEqual(f.calls, ["insert", "D7", "insert", "D7"]);
    });
    console.log(`${count} grouped D6 checks passed; only source insertion is available to Phase 4.`);
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { Module._load = originalLoad; });
