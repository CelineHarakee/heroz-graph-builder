const assert = require("assert");
const { ObjectId } = require("mongodb");
const { isDeepStrictEqual } = require("util");
const { normalizeParentDecision } = require("../learning/eventNormalizer");
const { checkParentDecisionPreflight: check } = require("../learning/parentDecisionPreflightService");
const { calculateNextParentGoals } = require("../learning/goalDecisionTransition");
const parentId = new ObjectId(), childId = new ObjectId(), goalId = new ObjectId();
function source(type = "PreferenceUpdated", hour = 10) {
    return { _id: new ObjectId(), parentId, childId, decisionType: type,
        decisionData: type === "PreferenceUpdated" ? { dimension: "environment", value: "Indoor" } :
            { goalId, ...(type === "GoalRemoved" ? {} : { priority: 1 }) },
        occurredAt: new Date(Date.UTC(2026, 8, 20, 0) + hour * 3600000) };
}
function auditJob(s) {
    const preference = s.decisionType === "PreferenceUpdated", completedAt = new Date("2026-09-21");
    return { _id: s._id, jobType: "ContinuousLearning", idempotencyKey: `parentDecision:${s._id}:${s.decisionType}`,
        status: "COMPLETED", outcome: "APPLIED", resultStatus: "APPLIED",
        components: { [preference ? "preference" : "goals"]: { status: "APPLIED", completedAt } },
        audit: { source: "ParentDecision", decisionId: s._id, childId: s.childId,
            target: preference ? { type: "preference", key: s.decisionData.dimension } : { type: "goal", key: String(s.decisionData.goalId) },
            occurredAt: s.occurredAt,
            sourceSnapshot: { decisionId: s._id, parentId: s.parentId, childId: s.childId, decisionType: s.decisionType,
                decisionData: { ...s.decisionData }, occurredAt: s.occurredAt } } };
}
function fixture(s, jobs = []) {
    const f = { s, jobs, calls: [] };
    const at = (d, path) => path.split(".").reduce((v, k) => v?.[k], d);
    f.db = { collection(name) {
        // No Child, queue, authority, writes, sessions or connection methods exist.
        assert(["parent_decisions", "ai_jobs"].includes(name));
        return { async findOne(query, options) {
            f.calls.push({ name, query, options });
            if (name === "parent_decisions") { assert(query._id instanceof ObjectId); return f.s; }
            const found = f.jobs.filter((j) => Object.entries(query).every(([k, v]) => isDeepStrictEqual(at(j, k), v)));
            if (options) {
                assert.deepStrictEqual(options, { sort: { "audit.occurredAt": -1, _id: -1 } });
                found.sort((a, b) => b.audit.occurredAt - a.audit.occurredAt || String(b._id).localeCompare(String(a._id)));
            }
            return found[0] ?? null;
        } };
    } };
    return f;
}
async function expect(f, event, status, reasonCode) {
    const before = require("util").inspect({ source: f.s, jobs: f.jobs, event }, { depth: null });
    const result = await check({ db: f.db, event });
    assert.deepStrictEqual(result, { status, reasonCode, retryable: false });
    assert.strictEqual(require("util").inspect({ source: f.s, jobs: f.jobs, event }, { depth: null }), before);
    return result;
}
async function main() {
    for (const type of ["PreferenceUpdated", "GoalSelected", "GoalUpdated", "GoalRemoved"]) {
        const s = source(type), e = normalizeParentDecision(s);
        await expect(fixture(s), e, "ELIGIBLE", "PARENT_DECISION_PREFLIGHT_PASSED");
        const f = fixture(s, [auditJob(s), auditJob(source(type, 20))]);
        await expect(f, e, "IGNORED", "DUPLICATE_EVENT");
        assert(!f.calls.some((c) => c.options), "Replay must win before any ordering lookup");
    }
    const s = source(), e = normalizeParentDecision(s);
    await expect(fixture(null), e, "NOT_APPLIED", "PARENT_DECISION_SOURCE_MISSING");
    for (const [key, value] of [["_id", new ObjectId()], ["parentId", new ObjectId()], ["childId", new ObjectId()],
        ["decisionType", "GoalRemoved"], ["decisionData", { dimension: "environment", value: "Outdoor" }],
        ["occurredAt", new Date("2025-01-01")]]) {
        const f = fixture({ ...s, [key]: value });
        await expect(f, e, "NOT_APPLIED", "PARENT_DECISION_SOURCE_CONFLICT");
        assert.strictEqual(f.calls.length, 1);
    }
    const canonical = source("GoalSelected");
    const equivalent = { ...canonical, _id: String(canonical._id).toUpperCase(), parentId: String(parentId).toUpperCase(),
        childId: String(childId).toUpperCase(), decisionData: { goalId: String(goalId).toUpperCase(), priority: 1 } };
    await expect(fixture(equivalent), normalizeParentDecision(canonical), "ELIGIBLE", "PARENT_DECISION_PREFLIGHT_PASSED");
    for (const changed of [ { ...s, decisionType: "GoalRemoved", decisionData: { goalId } },
        { ...s, decisionData: { dimension: "environment", value: "Outdoor" } } ]) {
        await expect(fixture(changed, [auditJob(s)]), normalizeParentDecision(changed), "NOT_APPLIED", "PARENT_DECISION_SOURCE_CONFLICT");
    }
    for (const type of ["PreferenceUpdated", "GoalSelected"]) {
        for (const hour of [9, 10, 11]) {
            const incoming = source(type, hour), f = fixture(incoming, [auditJob(source(type, 10))]);
            await expect(f, normalizeParentDecision(incoming), hour > 10 ? "ELIGIBLE" : "NOT_APPLIED",
                hour > 10 ? "PARENT_DECISION_PREFLIGHT_PASSED" : "OUT_OF_ORDER_PARENT_DECISION");
        }
    }
    const history = [auditJob(source("GoalSelected", 10)), auditJob(source("GoalUpdated", 12)), auditJob(source("GoalRemoved", 14))];
    for (const type of ["GoalSelected", "GoalUpdated", "GoalRemoved"]) {
        const delayed = source(type, 13);
        await expect(fixture(delayed, history), normalizeParentDecision(delayed), "NOT_APPLIED", "OUT_OF_ORDER_PARENT_DECISION");
        const newer = source(type, 15);
        await expect(fixture(newer, history), normalizeParentDecision(newer), "ELIGIBLE", "PARENT_DECISION_PREFLIGHT_PASSED");
    }
    // Historical, failed and ignored records, other targets and other children do not order this target.
    const incoming = source("GoalSelected", 11), irrelevant = [];
    for (const change of [ { status: "FAILED" }, { resultStatus: "IGNORED" }, { outcome: "IGNORED" }, { jobType: "Other" } ]) {
        irrelevant.push({ ...auditJob(source("GoalUpdated", 20)), ...change });
    }
    const historical = { jobType: "ContinuousLearning", status: "COMPLETED", outcome: "APPLIED" };
    irrelevant.push(historical);
    const activity = auditJob(source("GoalSelected", 20)); activity.audit.source = "Booking"; irrelevant.push(activity);
    const otherChild = auditJob(source("GoalSelected", 20)); otherChild.audit.childId = new ObjectId(); irrelevant.push(otherChild);
    const otherTarget = auditJob(source("GoalSelected", 20)); otherTarget.audit.target.key = String(new ObjectId()); irrelevant.push(otherTarget);
    await expect(fixture(incoming, irrelevant), normalizeParentDecision(incoming), "ELIGIBLE", "PARENT_DECISION_PREFLIGHT_PASSED");
    // State no-ops are decided by pure transitions, never preflight.
    const selected = calculateNextParentGoals([], normalizeParentDecision(source("GoalSelected", 10))).nextParentGoals;
    for (const [type, state, reason] of [["GoalSelected", selected, "DUPLICATE_GOAL_SELECTION"],
        ["GoalUpdated", selected, "NO_GOAL_CHANGE"], ["GoalRemoved", [], "GOAL_NOT_SELECTED"]]) {
        const s = source(type, 11), e = normalizeParentDecision(s);
        await expect(fixture(s), e, "ELIGIBLE", "PARENT_DECISION_PREFLIGHT_PASSED");
        assert.strictEqual(calculateNextParentGoals(state, e).reasonCode, reason);
    }
    const absent = source("GoalRemoved", 14), empty = fixture(absent);
    await expect(empty, normalizeParentDecision(absent), "ELIGIBLE", "PARENT_DECISION_PREFLIGHT_PASSED");
    assert.strictEqual(empty.jobs.length, 0); // No tombstone is invented.
    const earlierSelect = source("GoalSelected", 13);
    await expect(fixture(earlierSelect, empty.jobs), normalizeParentDecision(earlierSelect), "ELIGIBLE", "PARENT_DECISION_PREFLIGHT_PASSED");
    for (const status of ["FAILED", "PROCESSING"]) {
        const job = auditJob(s); job.status = status;
        await expect(fixture(s, [job]), e, status === "FAILED" ? "NOT_APPLIED" : "IGNORED",
            status === "FAILED" ? "RETRY_REQUIRES_ORCHESTRATION" : "EVENT_ALREADY_PROCESSING");
    }
    const malformed = auditJob(s); malformed.components = {};
    await expect(fixture(s, [malformed]), e, "FAILED", "INVALID_PROCESSING_STATE");
    const exactHistorical = { ...historical, idempotencyKey: e.processing.idempotencyKey };
    await expect(fixture(s, [exactHistorical]), e, "IGNORED", "DUPLICATE_EVENT");
    const bad = fixture(s); bad.db.collection = () => { throw new Error("private driver details"); };
    assert.deepStrictEqual(await check({ db: bad.db, event: e }), { status: "FAILED", reasonCode: "DATABASE_ERROR", retryable: true });
    assert.strictEqual((await check({ db: bad.db, event: null })).status, "NOT_APPLIED");
    console.log("Parent decision preflight service unit tests: PASSED");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
