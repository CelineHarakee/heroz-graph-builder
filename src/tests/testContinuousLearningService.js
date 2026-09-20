const assert = require("assert");
const { ObjectId } = require("mongodb");
const { processContinuousLearningSource: processSource } = require("../learning/continuousLearningService");
const { processInterestLearningSource: compatible } = require("../learning/interestLearningService");
const { getLearningInstruction } = require("../learning/learningRuleEngine");
const { calculateNextInterestState } = require("../learning/interestStateTransition");
const { resolveOutcomeLearningContext } = require("../learning/outcomeLearningContextService");
const { getOutcomeLearningInstruction } = require("../learning/outcomeLearningRuleEngine");
const { calculateNextDevelopmentProfile } = require("../learning/developmentProfileTransition");
const { persistAppliedInterestLearning } = require("../learning/learningPersistenceService");
const ids = [1, 2, 3, 4, 5, 6].map((n) => `64f00000000000000000000${n}`);
const [childId, activityId, subcategoryId, bookingId, outA, outB] = ids;
const event = (eventType = "Attend") => ({ eventId: bookingId, eventType, childId, activityId, subcategoryId,
    bookingId, source: "Booking", occurredAt: new Date("2026-09-17T10:00:00Z"), eventData: { ratingValue: 5 },
    processing: { idempotencyKey: `${bookingId}:${eventType}` } });
const valid = (event) => ({ status: "VALID", event });
const conflict = { status: "NOT_APPLIED", reasonCode: "CONCURRENT_STATE_CHANGE", retryable: true };
function copy(v) {
    if (v instanceof ObjectId) return new ObjectId(v);
    if (v instanceof Date) return new Date(v);
    if (Array.isArray(v)) return v.map(copy);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, copy(x)]));
    return v;
}
function fixture(types = ["Attend"]) {
    const f = { events: types.map(event), trace: [], interest: null, attempts: [], commits: [], checks: 0,
        child: { _id: new ObjectId(childId), developmentProfile: [], parentGoals: [{ goalId: "preserve" }] },
        activity: { _id: new ObjectId(activityId), learningOutcomes: [{ outcomeId: new ObjectId(outA) }] },
        refs: [outA, outB].map((id) => ({ _id: new ObjectId(id), isActive: true })) };
    const db = { client: {}, collection(name) {
        assert(["child_interests", "children", "activities", "learning_outcomes"].includes(name));
        return { async findOne(query) {
            f.trace.push(`read:${name}`);
            if (name === "child_interests") {
                assert.deepStrictEqual(query, { childId: new ObjectId(childId), subcategoryId: new ObjectId(subcategoryId) });
                return copy(f.interest);
            }
            assert(query._id instanceof ObjectId);
            if (name === "children") return copy(f.child);
            if (name === "activities") return copy(f.activity);
            return copy(f.refs.find((ref) => ref._id.equals(query._id)) ?? null);
        } };
    } };
    f.commit = (args, combined) => {
        f.interest = { ...copy(combined ? args.nextInterestState : args.nextState), _id: new ObjectId(ids[0]) };
        if (combined && args.outcomeResult.status === "APPLIED") f.child.developmentProfile = copy(args.nextDevelopmentProfile);
        f.commits.push(args.event.eventType);
        return { status: "APPLIED", reasonCode: combined ? "CONTINUOUS_LEARNING_PERSISTED" : "INTEREST_LEARNING_PERSISTED", state: copy(f.interest) };
    };
    const persist = async (args, combined) => {
        f.trace.push(combined ? "persist:combined" : "persist:interest");
        assert.strictEqual(combined, args.event.eventType === "Attend");
        assert.strictEqual(args.db, db); assert.strictEqual(args.client, db.client);
        f.attempts.push(copy({ ...args, db: undefined, client: undefined }));
        return f.onPersist ? f.onPersist(args, combined) : f.commit(args, combined);
    };
    f.dependencies = {
        async processLearningSource() { f.trace.push("D7C"); f.checks++; return f.onCheck ? f.onCheck() : f.events.map(valid); },
        getLearningInstruction(e) { f.trace.push("interest:rule"); return getLearningInstruction(e); },
        calculateNextInterestState(...args) { f.trace.push("interest:calculate"); return calculateNextInterestState(...args); },
        async resolveOutcomeLearningContext(...args) { f.trace.push("outcomes:context"); return resolveOutcomeLearningContext(...args); },
        getOutcomeLearningInstruction(...args) { f.trace.push("outcomes:rule"); return getOutcomeLearningInstruction(...args); },
        calculateNextDevelopmentProfile(...args) { f.trace.push("outcomes:calculate"); return calculateNextDevelopmentProfile(...args); },
        persistAppliedInterestLearning: (args) => persist(args, false),
        persistAppliedContinuousLearning: (args) => persist(args, true)
    };
    f.options = { db, dependencies: f.dependencies };
    return f;
}
async function run(f, api = processSource) {
    const raw = { nested: { unchanged: true } }, before = copy(raw), parents = copy(f.child?.parentGoals);
    const result = await api("Booking", raw, f.options);
    assert.deepStrictEqual(raw, before); assert.deepStrictEqual(f.child?.parentGoals, parents);
    assert.strictEqual(result.status, "COMPLETED");
    assert(!JSON.stringify(result).includes("private"));
    for (const r of result.results) { assert(!Object.hasOwn(r, "error")); assert(!Object.hasOwn(r, "state")); }
    return result.results;
}
async function testFlows() {
    for (const type of ["View", "Click", "Save", "Unsave", "Dismiss", "Book", "Rate"]) {
        const f = fixture([type]);
        const [result] = await run(f);
        assert.strictEqual(result.status, "APPLIED");
        assert.deepStrictEqual(f.trace, ["D7C", "interest:rule", "read:child_interests", "interest:calculate", "persist:interest"]);
        assert.deepStrictEqual(result.requiredComponents, ["interest"]);
        assert.deepStrictEqual(result.components, { interest: { status: "APPLIED" } });
        assert.strictEqual(result.persistence.status, "APPLIED");
    }
    const f = fixture();
    f.activity.learningOutcomes.push({ outcomeId: new ObjectId(outB) });
    const [result] = await run(f);
    assert.strictEqual(f.checks, 1);
    assert.deepStrictEqual(f.trace, ["D7C", "interest:rule", "read:child_interests", "interest:calculate", "outcomes:context",
        "read:activities", "read:learning_outcomes", "read:learning_outcomes", "outcomes:rule", "read:children", "outcomes:calculate", "persist:combined"]);
    assert.deepStrictEqual(result.requiredComponents, ["interest", "outcomes"]);
    assert.strictEqual(result.components.outcomes.status, "APPLIED");
    assert.deepStrictEqual(result.outcomeTransition, [outA, outB].map((outcomeId) => ({ outcomeId,
        previousScore: 0, currentScore: 0.1, previousConfidence: 0, currentConfidence: 0.05, evidenceCount: 1 })));
    assert.strictEqual(result.transition.currentScore, 0.6);
    const empty = fixture(); empty.activity.learningOutcomes = [];
    const before = copy(empty.child);
    const [none] = await run(empty);
    assert.strictEqual(none.status, "APPLIED");
    assert.deepStrictEqual(none.components.outcomes, { status: "NOT_APPLICABLE", reasonCode: "NO_MAPPED_OUTCOMES" });
    assert.strictEqual(none.outcomeTransition, null);
    assert(!empty.trace.includes("outcomes:calculate")); assert(!empty.trace.includes("outcomes:rule"));
    assert.deepStrictEqual(empty.child, before);
    assert.deepStrictEqual(empty.attempts[0].currentDevelopmentProfile, []);
}
async function testStops() {
    for (const kind of ["missingMapping", "malformed", "missingRef", "inactive", "invalidProfile", "outOfOrder"]) {
        const f = fixture();
        if (kind === "missingMapping") delete f.activity.learningOutcomes;
        if (kind === "malformed") f.activity.learningOutcomes = [{}];
        if (kind === "missingRef") f.refs = [];
        if (kind === "inactive") f.refs[0].isActive = false;
        if (kind === "invalidProfile") f.child.developmentProfile = null;
        if (kind === "outOfOrder") f.child.developmentProfile = [{ outcomeId: outA, score: 0.1, confidenceScore: 0.05,
            evidenceCount: 1, history: [], lastEvidenceAt: new Date("2027-01-01") }];
        const before = copy(f.child), [result] = await run(f);
        assert.strictEqual(result.status, "REJECTED");
        assert.strictEqual(result.reasonCode, kind === "invalidProfile" ? "INVALID_EXISTING_DEVELOPMENT_STATE" :
            kind === "outOfOrder" ? "OUT_OF_ORDER_OUTCOME_EVENT" : "INVALID_OUTCOME_MAPPING");
        assert.strictEqual(f.attempts.length, 0); assert.strictEqual(f.interest, null); assert.deepStrictEqual(f.child, before);
    }
    for (const status of ["IGNORED", "REJECTED", "FAILED"]) {
        const f = fixture(); f.onCheck = () => [{ event: f.events[0], status, reasonCode: "STOP" }];
        assert.strictEqual((await run(f))[0].status, status);
        assert.deepStrictEqual(f.trace, ["D7C"]);
    }
    const complete = fixture(["Complete"]);
    assert.strictEqual((await run(complete))[0].reasonCode, "UNSUPPORTED_EVENT_TYPE");
    assert.strictEqual(complete.attempts.length, 0);
    for (const stage of ["resolveOutcomeLearningContext", "persistAppliedContinuousLearning"]) {
        const f = fixture();
        f.dependencies[stage] = async () => ({ status: "FAILED", reasonCode: "DATABASE_ERROR", retryable: true, error: new Error("private") });
        const [result] = await run(f);
        assert.strictEqual(result.status, "FAILED"); assert(result.retryable);
    }
}
async function testRetries() {
    for (const changed of ["interest", "profile"]) {
        const f = fixture();
        f.onPersist = (args, combined) => {
            if (f.attempts.length === 1) {
                if (changed === "interest") f.interest = { ...copy(args.nextInterestState), _id: new ObjectId(childId) };
                else f.child.developmentProfile = copy(args.nextDevelopmentProfile);
                f.activity.learningOutcomes.push({ outcomeId: new ObjectId(outB) });
                return conflict;
            }
            return f.commit(args, combined);
        };
        const [result] = await run(f);
        assert.strictEqual(result.status, "APPLIED"); assert.strictEqual(f.attempts.length, 2); assert.strictEqual(f.checks, 2);
        for (const stage of ["read:child_interests", "outcomes:context", "read:children", "interest:calculate", "outcomes:calculate"]) {
            assert.strictEqual(f.trace.filter((item) => item === stage).length, 2);
        }
        assert.strictEqual(f.attempts[1].nextDevelopmentProfile.length, 2);
        if (changed === "interest") assert.strictEqual(f.attempts[1].nextInterestState.interestScore.currentScore, 0.7);
        else assert.strictEqual(f.attempts[1].nextDevelopmentProfile[0].score, 0.2);
    }
    const exhausted = fixture(); exhausted.onPersist = () => conflict;
    const [result] = await run(exhausted);
    assert.strictEqual(result.reasonCode, "CONCURRENT_RETRY_EXHAUSTED"); assert(result.retryable);
    assert.strictEqual(exhausted.attempts.length, 3); assert.strictEqual(exhausted.checks, 3); assert.strictEqual(exhausted.commits.length, 0);
    const duplicate = fixture(); duplicate.onPersist = () => conflict;
    duplicate.onCheck = () => [{ ...valid(duplicate.events[0]), ...(duplicate.checks > 1 ? { status: "IGNORED", reasonCode: "DUPLICATE_EVENT" } : {}) }];
    assert.strictEqual((await run(duplicate))[0].reasonCode, "DUPLICATE_EVENT");
    assert.strictEqual(duplicate.attempts.length, 1); assert.strictEqual(duplicate.checks, 2);
    const changed = fixture(); changed.onPersist = () => { changed.activity.learningOutcomes = null; return conflict; };
    assert.strictEqual((await run(changed))[0].reasonCode, "INVALID_OUTCOME_MAPPING");
    assert.strictEqual(changed.attempts.length, 1);
}
async function testBookingAndCompatibility() {
    const f = fixture(["Book", "Attend"]);
    const results = await run(f);
    assert.deepStrictEqual(f.commits, ["Book", "Attend"]);
    assert.deepStrictEqual(results.map((r) => r.status), ["APPLIED", "APPLIED"]);
    assert.strictEqual(f.checks, 1);
    assert(Math.abs(results[1].transition.currentScore - 0.68) < 1e-12);
    assert.notStrictEqual(f.attempts[0].event.processing.idempotencyKey, f.attempts[1].event.processing.idempotencyKey);
    const invalid = fixture(["Book", "Attend"]); invalid.activity.learningOutcomes = null;
    assert.deepStrictEqual((await run(invalid)).map((r) => r.status), ["APPLIED", "REJECTED"]);
    assert.deepStrictEqual(invalid.commits, ["Book"]);
    for (const type of ["View", "Attend"]) {
        const direct = fixture([type]), old = fixture([type]);
        assert.deepStrictEqual(await run(old, compatible), await run(direct));
        assert.deepStrictEqual(old.trace, direct.trace);
    }
    const guard = await persistAppliedInterestLearning({ event: event(), client: { startSession() { throw Error("Must not run"); } } });
    assert.strictEqual(guard.reasonCode, "COMBINED_LEARNING_REQUIRED");
}
async function testRealPipeline() {
    // Real D7C, both transitions, and both persistence APIs; only Mongo is fake.
    const { isDeepStrictEqual } = require("util");
    for (const mapping of ["valid", "empty", "invalid"]) {
        const raw = { _id: new ObjectId(bookingId), bookingDetails: { childId: new ObjectId(childId),
            activityId: new ObjectId(activityId), status: "Confirmed", bookedAt: new Date("2026-09-17T09:00:00Z") },
            attendance: { status: "Attended", checkedInAt: new Date("2026-09-17T10:00:00Z") } };
        let durable = { children: [{ _id: new ObjectId(childId), developmentProfile: [], parentGoals: [{ goalId: "untouched" }] }],
            activities: [{ _id: new ObjectId(activityId), classification: { subcategoryId: new ObjectId(subcategoryId) },
                learningOutcomes: mapping === "invalid" ? null : mapping === "empty" ? [] : [{ outcomeId: new ObjectId(outA) }] }],
            subcategories: [{ _id: new ObjectId(subcategoryId) }], bookings: [raw],
            learning_outcomes: [{ _id: new ObjectId(outA), isActive: true }], child_interests: [], ai_jobs: [], graph_sync_queue: [] };
        let staged, active = false, commits = 0;
        const session = { startTransaction() { assert(!active); active = true; staged = copy(durable); },
            inTransaction: () => active,
            async commitTransaction() { durable = staged; staged = undefined; active = false; commits++; },
            async abortTransaction() { staged = undefined; active = false; }, async endSession() {} };
        const client = { startSession: () => session };
        const at = (doc, path) => path.split(".").reduce((v, k) => v?.[k], doc);
        const matches = (doc, filter) => Object.entries(filter).every(([k, v]) =>
            v?.$exists === false ? at(doc, k) === undefined : isDeepStrictEqual(at(doc, k), v));
        const db = { client, collection(name) {
            assert(Object.hasOwn(durable, name));
            function store(options) {
                if (options?.session) { assert.strictEqual(options.session, session); assert(active); return staged[name]; }
                assert(!active); return durable[name];
            }
            return {
                async findOne(filter, options) { return copy(store(options).find((doc) => matches(doc, filter)) ?? null); },
                async insertOne(doc, options) { assert(options.session); store(options).push(copy(doc)); return { insertedId: doc._id }; },
                async updateOne(filter, update, options) {
                    assert(options.session);
                    const doc = store(options).find((item) => matches(item, filter));
                    if (!doc) return { matchedCount: 0 };
                    Object.assign(doc, copy(update.$set)); return { matchedCount: 1 };
                }
            };
        } };
        const before = copy(raw);
        const result = await processSource("Booking", raw, { db });
        assert.deepStrictEqual(raw, before);
        assert.deepStrictEqual(result.results.map((r) => r.status), ["APPLIED", mapping === "invalid" ? "REJECTED" : "APPLIED"]);
        const expected = mapping === "invalid" ? 1 : 2;
        assert.strictEqual(commits, expected); assert.strictEqual(durable.ai_jobs.length, expected);
        assert.strictEqual(durable.graph_sync_queue.length, expected);
        assert(durable.graph_sync_queue.every((job) => job.entityType === "ChildInterest" && job.status === "PENDING"));
        assert.deepStrictEqual(durable.children[0].parentGoals, [{ goalId: "untouched" }]);
        assert.strictEqual(durable.children[0].developmentProfile.length, mapping === "valid" ? 1 : 0);
        if (mapping !== "invalid") {
            assert.strictEqual(durable.ai_jobs[1].components.outcomes.status, mapping === "empty" ? "NOT_APPLICABLE" : "APPLIED");
            const committed = copy(durable);
            const replay = await compatible("Booking", raw, { db });
            assert(replay.results.every((r) => r.reasonCode === "DUPLICATE_EVENT"));
            assert.deepStrictEqual(durable, committed); assert.strictEqual(commits, 2);
        }
        const complete = await processSource("Interaction", { interactionDetails: { interactionType: "Complete" } }, { db });
        assert.strictEqual(complete.results[0].reasonCode, "NON_LEARNING_EVENT");
    }
}

async function main() {
    await testFlows(); await testStops(); await testRetries(); await testBookingAndCompatibility(); await testRealPipeline();
    console.log("Continuous learning service unit tests: PASSED");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
