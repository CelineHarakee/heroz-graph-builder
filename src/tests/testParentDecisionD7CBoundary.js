const assert = require("assert");
const { ObjectId } = require("mongodb");
const { inspect } = require("util");
const { normalizeParentDecision } = require("../learning/eventNormalizer");
const { validateEvent } = require("../learning/eventValidator");
const { processLearningSource } = require("../learning/learningEventProcessor");
const ids = Array.from({ length: 4 }, () => new ObjectId());
function source(type = "PreferenceUpdated") {
    return { _id: ids[0], parentId: ids[1], childId: ids[2], decisionType: type,
        decisionData: type === "PreferenceUpdated" ? { dimension: "environment", value: "Indoor" } :
            { goalId: ids[3], ...(type === "GoalRemoved" ? {} : { priority: 1 }) },
        occurredAt: new Date("2026-09-20T00:00:00Z"),
        context: { source: "ParentConfirmation", recommendationId: null, sessionId: null },
        metadata: { version: 1, createdAt: new Date("2026-09-20T00:00:00Z") } };
}
function fixture() {
    const f = { calls: [], records: { children: { _id: ids[2], parentId: ids[1] }, parents: { _id: ids[1] }, goal_library: { _id: ids[3], isActive: true } } };
    f.db = { collection(name) {
        assert(Object.hasOwn(f.records, name), `Forbidden collection: ${name}`);
        return { async findOne(query) { f.calls.push(name); assert(query._id instanceof ObjectId); return f.records[name]; } };
    } };
    return f;
}
async function run(doc, f = fixture()) {
    const before = inspect({ doc, records: f.records }, { depth: null });
    const result = await processLearningSource("ParentDecision", doc, { db: f.db });
    assert.strictEqual(result.length, 1);
    assert.strictEqual(inspect({ doc, records: f.records }, { depth: null }), before);
    return result[0];
}
async function main() {
    for (const type of ["PreferenceUpdated", "GoalSelected", "GoalRemoved", "GoalUpdated"]) {
        const doc = source(type), f = fixture(), result = await run(doc, f);
        assert.strictEqual(result.status, "VALID");
        const event = result.event;
        assert.strictEqual(event.eventId, String(ids[0])); assert.strictEqual(event.parentId, String(ids[1]));
        assert.strictEqual(event.childId, String(ids[2])); assert.strictEqual(event.eventType, type);
        assert.strictEqual(event.source, "ParentDecision");
        for (const field of ["activityId", "subcategoryId", "bookingId", "sessionId"]) assert.strictEqual(event[field], null);
        assert.deepStrictEqual(event.occurredAt, doc.occurredAt);
        assert.deepStrictEqual(event.context, doc.context);
        assert.strictEqual(event.processing.idempotencyKey, `parentDecision:${ids[0]}:${type}`);
        assert.deepStrictEqual(event.eventData, type === "PreferenceUpdated" ? doc.decisionData : { ...doc.decisionData, goalId: String(ids[3]) });
        assert.deepStrictEqual(f.calls, type === "PreferenceUpdated" ? ["children", "parents"] : ["children", "parents", "goal_library"]);
        assert.deepStrictEqual(Object.keys(event).sort(), ["eventId", "eventType", "parentId", "childId", "activityId", "subcategoryId", "sessionId", "bookingId", "source", "eventData", "context", "occurredAt", "processing"].sort());
    }
    for (const [field, value, reason] of [["_id", "bad", "INVALID_EVENT_ID"], ["parentId", {}, "INVALID_PARENT_AUTHORITY"],
        ["childId", [], "INVALID_PARENT_AUTHORITY"], ["occurredAt", "2026-09-20", "INVALID_TIMESTAMP"],
        ["occurredAt", new Date(NaN), "INVALID_TIMESTAMP"], ["decisionType", "GoalCompleted", "UNSUPPORTED_DECISION_TYPE"]]) {
        const f = fixture(), result = await run({ ...source(), [field]: value }, f);
        assert.strictEqual(result.reasonCode, reason); assert.strictEqual(result.status, "REJECTED"); assert.deepStrictEqual(f.calls, []);
    }
    for (const change of ["parentMissing", "childMissing", "mismatch", "missingParentId"]) {
        const f = fixture();
        if (change === "parentMissing") f.records.parents = null;
        if (change === "childMissing") f.records.children = null;
        if (change === "mismatch") f.records.children.parentId = new ObjectId();
        if (change === "missingParentId") delete f.records.children.parentId;
        assert.strictEqual((await run(source(), f)).reasonCode, "INVALID_PARENT_AUTHORITY");
    }
    for (const type of ["GoalSelected", "GoalRemoved", "GoalUpdated"]) {
        const missing = fixture(); missing.records.goal_library = null;
        assert.strictEqual((await run(source(type), missing)).reasonCode, "INVALID_GOAL_REFERENCE");
        const inactive = fixture(); inactive.records.goal_library.isActive = false;
        assert.strictEqual((await run(source(type), inactive)).status, type === "GoalSelected" ? "REJECTED" : "VALID");
    }
    const canonical = source("GoalSelected");
    for (const field of ["_id", "parentId", "childId"]) canonical[field] = String(canonical[field]).toUpperCase();
    canonical.decisionData.goalId = String(ids[3]).toUpperCase();
    assert.strictEqual((await run(canonical)).event.eventData.goalId, String(ids[3]));
    const badPayload = source(); badPayload.decisionData.confidenceScore = 1;
    const noReads = fixture(); assert.strictEqual((await run(badPayload, noReads)).reasonCode, "INVALID_DECISION_PAYLOAD"); assert.strictEqual(noReads.calls.length, 0);
    const normalized = normalizeParentDecision(source());
    normalized.processing.idempotencyKey = "forged";
    assert.strictEqual(validateEvent(normalized).reasonCode, "INVALID_IDEMPOTENCY_KEY");
    normalized.processing.idempotencyKey = `parentDecision:${ids[0]}:PreferenceUpdated`;
    normalized.activityId = String(ids[3]);
    assert.strictEqual(validateEvent(normalized).reasonCode, "INVALID_EVENT_DATA");
    const errorDb = { collection() { throw new Error("injected database failure"); } };
    assert.strictEqual((await processLearningSource("ParentDecision", source(), { db: errorDb }))[0].reasonCode, "DATABASE_ERROR");
    // No ai_jobs/repeat lookup and no writer methods exist on these mocks.
    // Replay remains VALID at this boundary until future durable processing exists.
    assert.strictEqual((await run(source())).status, "VALID");
    console.log("Parent decision D7C boundary tests: PASSED");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
