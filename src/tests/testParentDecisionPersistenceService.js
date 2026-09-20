const assert = require("assert");
const { ObjectId } = require("mongodb");
const { isDeepStrictEqual } = require("util");
const { normalizeParentDecision } = require("../learning/eventNormalizer");
const { calculateNextPreferences } = require("../learning/preferenceDecisionTransition");
const { calculateNextParentGoals } = require("../learning/goalDecisionTransition");
const { persistParentDecision } = require("../learning/parentDecisionPersistenceService");
const { checkEventIdempotency } = require("../learning/eventIdempotencyService");
function copy(v) {
    if (v instanceof ObjectId) return new ObjectId(v);
    if (v instanceof Date) return new Date(v);
    if (Array.isArray(v)) return v.map(copy);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, copy(x)]));
    return v;
}
function fixture() {
    const childId = new ObjectId(), parentId = new ObjectId(), goalId = new ObjectId();
    const f = { childId, parentId, goalId, active: false, commits: 0, aborts: 0, calls: [], fail: null,
        data: { children: [{ _id: childId, parentId, preferences: {}, parentGoals: [], developmentProfile: [{ retained: true }], name: "Retain" }],
            parents: [{ _id: parentId }], goal_library: [{ _id: goalId, isActive: true }], parent_decisions: [], ai_jobs: [], graph_sync_queue: [] } };
    const at = (doc, path) => path.split(".").reduce((v, k) => v?.[k], doc);
    const matches = (doc, filter) => Object.entries(filter).every(([k, v]) => v?.$exists === false ? at(doc, k) === undefined : isDeepStrictEqual(at(doc, k), v));
    function point(name) { f.calls.push(name); if (f.fail === name) throw f.error || new Error("private injected error"); }
    const session = {
        startTransaction(opts) { assert.deepStrictEqual(opts, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } }); f.active = true; f.staged = copy(f.data); },
        inTransaction: () => f.active,
        async commitTransaction() { point("commit"); f.data = f.staged; f.active = false; f.commits++; },
        async abortTransaction() { f.staged = null; f.active = false; f.aborts++; }, async endSession() {}
    };
    f.client = { startSession: () => session };
    f.db = { collection(name) {
        assert(Object.hasOwn(f.data, name));
        function store(options) {
            if (options?.session) { assert.strictEqual(options.session, session); assert(f.active); return f.staged[name]; }
            assert(!f.active); return f.data[name];
        }
        return {
            async findOne(filter, options) {
                point(`${name}.find`);
                const records = store(options).filter((doc) => matches(doc, filter));
                if (options?.sort) records.sort((a, b) => b.audit.occurredAt - a.audit.occurredAt || String(b._id).localeCompare(String(a._id)));
                return copy(records[0] ?? null);
            },
            async updateOne(filter, update, options) {
                assert.strictEqual(name, "children"); assert(options.session); point("children.update");
                if (f.zeroMatch) return { matchedCount: 0 };
                const doc = store(options).find((d) => matches(d, filter));
                if (!doc) return { matchedCount: 0 };
                if (Array.isArray(update)) {
                    assert.deepStrictEqual(Object.keys(update[0].$set), ["preferences"]);
                    const merge = update[0].$set.preferences.$mergeObjects;
                    doc.preferences = { ...(doc.preferences ?? {}), ...copy(merge[1].$literal) };
                } else { assert.deepStrictEqual(Object.keys(update.$set), ["parentGoals"]); Object.assign(doc, copy(update.$set)); }
                point("afterChild"); return { matchedCount: 1 };
            },
            async insertOne(doc, options) {
                assert(options.session); assert(["ai_jobs", "graph_sync_queue"].includes(name)); point(`${name}.insert`);
                if (name === "ai_jobs" && f.race) {
                    f.data.ai_jobs.push(copy(f.race));
                    throw Object.assign(new Error("race"), { code: 11000, keyPattern: { _id: 1 } });
                }
                store(options).push(copy(doc)); point(`after:${name}`); return { insertedId: doc._id };
            }
        };
    } };
    f.prepare = (type = "PreferenceUpdated", hour = 10, value = "Indoor") => {
        const source = { _id: new ObjectId(), parentId, childId, decisionType: type,
            decisionData: type === "PreferenceUpdated" ? { dimension: "environment", value } : { goalId, ...(type === "GoalRemoved" ? {} : { priority: value === "Indoor" ? 1 : value }) },
            occurredAt: new Date(`2026-09-20T${String(hour).padStart(2, "0")}:00:00Z`) };
        f.data.parent_decisions.push(copy(source));
        const event = normalizeParentDecision(source), child = f.data.children[0];
        const currentPreferences = copy(child?.preferences), currentParentGoals = copy(child?.parentGoals);
        const transition = type === "PreferenceUpdated" ? calculateNextPreferences(currentPreferences, event) : calculateNextParentGoals(currentParentGoals, event);
        return { event, currentPreferences, currentParentGoals, transition };
    };
    return f;
}
async function run(f, input) {
    const before = copy(input), result = await persistParentDecision({ ...input, client: f.client, db: f.db });
    assert.deepStrictEqual(input, before); assert(!Object.hasOwn(result, "error")); assert(!JSON.stringify(result).includes("private"));
    return result;
}
async function preferences() {
    for (const prefs of [undefined, null, {}, { environment: { value: "Indoor", confidenceScore: 0.65, source: "Onboarding", updatedAt: new Date("2027-01-01") } }]) {
        const f = fixture(); f.data.children[0].preferences = copy(prefs);
        const input = f.prepare(), before = copy(f.data.children[0]), started = Date.now();
        const result = await run(f, input); assert.strictEqual(result.status, "APPLIED"); assert(!result.queueIntentCreated);
        const child = f.data.children[0], job = f.data.ai_jobs[0];
        assert.deepStrictEqual(child.preferences.environment, input.transition.nextState);
        assert.deepStrictEqual({ ...child, preferences: undefined }, { ...before, preferences: undefined });
        assert.deepStrictEqual(job.audit.previousState, input.transition.previousState); assert.deepStrictEqual(job.audit.nextState, input.transition.nextState);
        assert.strictEqual(job.components.preference.status, "APPLIED");
        for (const key of ["decisionId", "parentId", "childId"]) assert(job.audit[key] instanceof ObjectId);
        assert(job.audit.occurredAt instanceof Date); assert(job.audit.persistedAt instanceof Date);
        assert(job.audit.persistedAt.getTime() >= started); assert.deepStrictEqual(job.components.preference.completedAt, job.audit.persistedAt);
        assert.strictEqual(f.data.graph_sync_queue.length, 0);
        assert.strictEqual((await checkEventIdempotency(input.event, { db: f.db })).reasonCode, "DUPLICATE_EVENT");
        const committed = copy(f.data); assert.strictEqual((await run(f, input)).reasonCode, "DUPLICATE_EVENT"); assert.deepStrictEqual(f.data, committed);
        const reaffirm = f.prepare("PreferenceUpdated", 11); assert.strictEqual((await run(f, reaffirm)).status, "APPLIED"); assert.strictEqual(f.data.ai_jobs.length, 2);
        // Audit checkpoint remains authoritative even if current state loses Parent provenance.
        f.data.children[0].preferences.environment.source = "Onboarding";
        for (const hour of [10, 11]) {
            const stale = f.prepare("PreferenceUpdated", hour), state = copy(f.data);
            assert.strictEqual((await run(f, stale)).reasonCode, "OUT_OF_ORDER_PARENT_DECISION"); assert.deepStrictEqual(f.data, state);
        }
    }
    const f = fixture(), input = f.prepare();
    f.data.children[0].preferences.socialStyle = { unrelated: true };
    f.data.children[0].developmentProfile = [{ changedByD7F: true }];
    assert.strictEqual((await run(f, input)).status, "APPLIED");
    assert.deepStrictEqual(f.data.children[0].preferences.socialStyle, { unrelated: true });
    assert.deepStrictEqual(f.data.children[0].developmentProfile, [{ changedByD7F: true }]);
}
async function goals() {
    const f = fixture();
    for (const [type, hour, priority] of [["GoalSelected", 10, 1], ["GoalUpdated", 12, 2], ["GoalRemoved", 14, 2]]) {
        const input = f.prepare(type, hour, priority), before = copy(f.data.children[0]);
        assert.strictEqual((await run(f, input)).status, "APPLIED");
        assert.deepStrictEqual(f.data.children[0].parentGoals, input.transition.nextParentGoals);
        assert.deepStrictEqual({ ...f.data.children[0], parentGoals: undefined }, { ...before, parentGoals: undefined });
        const job = f.data.ai_jobs.at(-1), q = f.data.graph_sync_queue.at(-1);
        assert.strictEqual(job.components.goals.status, "APPLIED");
        assert.deepStrictEqual(job.audit.previousState, input.transition.previousState); assert.deepStrictEqual(job.audit.nextState, input.transition.nextState);
        if (job.audit.nextState) assert(job.audit.nextState.goalId instanceof ObjectId);
        assert(q.entityId instanceof ObjectId); assert(q.entityId.equals(f.childId)); assert.strictEqual(q.entityType, "Child");
        assert.strictEqual(q.operation, "UPDATE"); assert.strictEqual(q.status, "PENDING"); assert(q.createdAt instanceof Date);
        assert.strictEqual((await run(f, input)).reasonCode, "DUPLICATE_EVENT");
    }
    assert.strictEqual(f.data.ai_jobs.length, 3); assert.strictEqual(f.data.graph_sync_queue.length, 3);
    for (const [type, hour] of [["GoalSelected", 13], ["GoalUpdated", 13], ["GoalSelected", 14]]) {
        const input = f.prepare(type, hour), before = copy(f.data);
        assert.strictEqual((await run(f, input)).reasonCode, "OUT_OF_ORDER_PARENT_DECISION"); assert.deepStrictEqual(f.data, before);
    }
    const no = fixture(), ignored = no.prepare("GoalRemoved");
    const before = copy(no.data); assert.strictEqual((await run(no, ignored)).reasonCode, "GOAL_NOT_SELECTED"); assert.deepStrictEqual(no.data, before);
    assert.strictEqual(no.commits, 0);
    // No ignored-removal tombstone: older selection is still allowed by locked V1.
    assert.strictEqual((await run(no, no.prepare("GoalSelected", 9))).status, "APPLIED");
    for (const type of ["GoalSelected", "GoalUpdated"]) {
        const input = no.prepare(type, 11), before = copy(no.data);
        assert.strictEqual((await run(no, input)).status, "IGNORED"); assert.deepStrictEqual(no.data, before);
    }
}
async function guards() {
    for (const type of ["PreferenceUpdated", "GoalSelected"]) {
        for (const change of ["sourceMissing", "sourcePayload", "sourceType", "parentMissing", "authority", "stale", "zeroMatch", "forgedTransition"]) {
            const f = fixture(), input = f.prepare(type);
            if (change === "sourceMissing") f.data.parent_decisions = [];
            if (change === "sourcePayload") f.data.parent_decisions[0].occurredAt = new Date("2026-01-01");
            if (change === "sourceType") f.data.parent_decisions[0].decisionType = "GoalRemoved";
            if (change === "parentMissing") f.data.parents = [];
            if (change === "authority") f.data.children[0].parentId = new ObjectId();
            if (change === "stale") {
                if (type === "PreferenceUpdated") f.data.children[0].preferences.environment = { changed: true };
                else f.data.children[0].parentGoals.push({ changed: true });
            }
            if (change === "zeroMatch") f.zeroMatch = true;
            if (change === "forgedTransition") input.transition.nextState.priority = 99;
            const before = copy(f.data), result = await run(f, input);
            const reason = { sourceMissing: "PARENT_DECISION_SOURCE_MISSING", sourcePayload: "PARENT_DECISION_SOURCE_CONFLICT", sourceType: "PARENT_DECISION_SOURCE_CONFLICT",
                parentMissing: "INVALID_PARENT_AUTHORITY", authority: "INVALID_PARENT_AUTHORITY", stale: "CONCURRENT_STATE_CHANGE", zeroMatch: "CONCURRENT_STATE_CHANGE", forgedTransition: "INVALID_TRANSITION" }[change];
            assert.strictEqual(result.reasonCode, reason); assert.deepStrictEqual(f.data, before);
        }
        for (const fail of ["afterChild", "after:ai_jobs", ...(type === "GoalSelected" ? ["after:graph_sync_queue"] : []), "commit"]) {
            const f = fixture(), input = f.prepare(type), before = copy(f.data); f.fail = fail;
            assert.strictEqual((await run(f, input)).reasonCode, "DATABASE_ERROR"); assert.deepStrictEqual(f.data, before); assert.strictEqual(f.aborts, 1);
        }
    }
    const f = fixture(), first = f.prepare(); assert.strictEqual((await run(f, first)).status, "APPLIED");
    const reused = f.data.parent_decisions[0]; reused.decisionType = "GoalSelected"; reused.decisionData = { goalId: f.goalId, priority: 1 };
    const e = normalizeParentDecision(reused), before = copy(f.data);
    assert.strictEqual((await run(f, { event: e, currentParentGoals: [], transition: calculateNextParentGoals([], e) })).reasonCode, "PARENT_DECISION_SOURCE_CONFLICT");
    assert.deepStrictEqual(f.data, before);
    // Simulated concurrent source winner after transaction snapshot creation.
    for (const conflict of [false, true]) {
        const r = fixture(), input = r.prepare();
        await run(r, input); const winner = copy(r.data.ai_jobs[0]);
        r.data.ai_jobs = []; r.data.children[0].preferences = {}; r.race = winner;
        if (conflict) r.race.audit.sourceSnapshot.decisionData.value = "Outdoor";
        assert.strictEqual((await run(r, input)).reasonCode, conflict ? "PARENT_DECISION_SOURCE_CONFLICT" : "DUPLICATE_EVENT");
        assert.deepStrictEqual(r.data.children[0].preferences, {}); assert.strictEqual(r.data.ai_jobs.length, 1);
    }
}
async function main() { await preferences(); await goals(); await guards(); console.log("Parent decision persistence service unit tests: PASSED"); }
main().catch((error) => { console.error(error); process.exitCode = 1; });
