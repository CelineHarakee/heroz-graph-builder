const assert = require("assert");
const { ObjectId } = require("mongodb");
const { isDeepStrictEqual } = require("util");
const { getLearningInstruction } = require("../learning/learningRuleEngine");
const { calculateNextInterestState } = require("../learning/interestStateTransition");
const { persistAppliedInterestLearning, persistAppliedContinuousLearning } = require("../learning/learningPersistenceService");

function copy(value) {
    if (value instanceof ObjectId) return new ObjectId(value);
    if (value instanceof Date) return new Date(value.getTime());
    if (Array.isArray(value)) return value.map(copy);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, copy(v)]));
    return value;
}
const ids = { child: "64f000000000000000000001", activity: "64f000000000000000000002", subcategory: "64f000000000000000000003" };
function input(existing = false) {
    const event = {
        eventId: "64f000000000000000000004", eventType: "View", childId: ids.child,
        activityId: ids.activity, subcategoryId: ids.subcategory, bookingId: null, sessionId: null,
        source: "Interaction", occurredAt: "2026-09-17T10:00:00.000Z",
        processing: { idempotencyKey: "interaction:64f000000000000000000004:View" }
    };
    const instruction = getLearningInstruction(event);
    let currentState = null;
    if (existing) {
        const prior = { ...event, occurredAt: "2026-09-16T10:00:00.000Z" };
        currentState = calculateNextInterestState(null, getLearningInstruction(prior), prior).state;
        currentState._id = new ObjectId("64f000000000000000000005");
        currentState.childId = new ObjectId(ids.child);
        currentState.subcategoryId = new ObjectId(ids.subcategory);
        currentState.unrelated = { retained: true };
        currentState.metadata.createdBy = "Original";
        currentState.metadata.version = 7;
        currentState.metadata.lastSyncedToGraph = "2026-09-16T12:00:00.000Z";
    }
    const nextState = calculateNextInterestState(currentState, instruction, event).state;
    return { event, instruction, currentState, nextState };
}

function fake(currentState = null) {
    const f = {
        durable: { child_interests: currentState ? [copy(currentState)] : [], ai_jobs: [], graph_sync_queue: [], children: [], activities: [], learning_outcomes: [] },
        calls: [], commits: 0, aborts: 0, ends: 0, fail: null, zeroMatch: false,
        error: new Error("Injected database failure")
    };
    let active = false, staged;
    function point(name) {
        f.calls.push(name);
        if (f.fail === name) {
            if (name === "ai_jobs.insert" && f.error.code === 11000 && !f.noWinner) {
                f.durable.ai_jobs.push(copy(f.winner || { jobType: "ContinuousLearning",
                    idempotencyKey: f.activeKey, status: "COMPLETED", outcome: "APPLIED" }));
            }
            throw f.error;
        }
    }
    const session = {
        startTransaction(options) {
            assert.deepStrictEqual(options, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });
            active = true; staged = copy(f.durable); point("start");
        },
        inTransaction() { return active; },
        async commitTransaction() { point("commit"); f.durable = copy(staged); active = false; f.commits++; },
        async abortTransaction() { staged = null; active = false; f.aborts++; },
        async endSession() { f.ends++; }
    };
    const valueAt = (record, path) => path.split(".").reduce((v, k) => v?.[k], record);
    function matches(record, filter) {
        return Object.entries(filter).every(([key, value]) => {
            if (value?.$exists === false) return valueAt(record, key) === undefined;
            return isDeepStrictEqual(valueAt(record, key), value);
        });
    }
    f.client = { startSession() { return session; } };
    f.db = { collection(name) {
        assert(Object.hasOwn(f.durable, name), `Unexpected collection ${name}`);
        function verify(options) { assert.strictEqual(options.session, session); assert(active); }
        return {
            async findOne(filter, options) {
                if (!options) {
                    assert(!active); assert.strictEqual(name, "ai_jobs");
                    return copy(f.durable[name].find((record) => matches(record, filter)) ?? null);
                }
                verify(options); point(`${name}.find`);
                if (name === "ai_jobs") f.activeKey = filter.idempotencyKey;
                return copy(staged[name].find((record) => matches(record, filter)) ?? null);
            },
            async insertOne(document, options) {
                verify(options); point(`${name}.insert`); staged[name].push(copy(document));
                return { insertedId: document._id };
            },
            async updateOne(filter, update, options) {
                verify(options); point(`${name}.update`);
                f.filter = filter;
                if (f.zeroMatch || f.zeroMatchCollection === name) return { matchedCount: 0 };
                const doc = staged[name].find((record) => matches(record, filter));
                if (!doc) return { matchedCount: 0 };
                Object.assign(doc, copy(update.$set));
                return { matchedCount: 1, modifiedCount: 1 };
            }
        };
    } };
    return f;
}

async function run(data, f) {
    const before = copy(data);
    const result = await persistAppliedInterestLearning({ ...data, client: f.client, db: f.db });
    assert.deepStrictEqual(data, before, "Supplied event/instruction/states must not mutate");
    return result;
}

async function testSuccess() {
    for (const existing of [false, true]) {
        const data = input(existing), f = fake(data.currentState);
        const result = await run(data, f);
        assert.strictEqual(result.status, "APPLIED");
        assert.strictEqual(result.reasonCode, "INTEREST_LEARNING_PERSISTED");
        assert.strictEqual(f.commits, 1); assert.strictEqual(f.aborts, 0); assert.strictEqual(f.ends, 1);
        assert.deepStrictEqual(f.calls, ["start", "ai_jobs.find", "child_interests.find",
            `child_interests.${existing ? "update" : "insert"}`, "ai_jobs.insert", "graph_sync_queue.insert", "commit"]);
        const state = f.durable.child_interests[0], job = f.durable.ai_jobs[0], queue = f.durable.graph_sync_queue[0];
        assert.deepStrictEqual(result.state, state);
        for (const key of ["_id", "childId", "subcategoryId"]) assert(state[key] instanceof ObjectId);
        assert.strictEqual(String(state.childId), ids.child);
        assert.strictEqual(String(state.subcategoryId), ids.subcategory);
        if (existing) {
            assert.deepStrictEqual(state._id, data.currentState._id);
            assert.deepStrictEqual(state.unrelated, { retained: true });
            assert.strictEqual(state.metadata.createdBy, "Original");
            assert.strictEqual(state.metadata.version, 7);
            assert.deepStrictEqual(state.metadata.createdAt, new Date(data.currentState.metadata.createdAt));
            assert.deepStrictEqual(state.metadata.lastSyncedToGraph, new Date(data.currentState.metadata.lastSyncedToGraph));
            for (const key of ["_id", "interestScore.currentScore", "confidence.currentScore", "confidence.evidenceCount",
                "interestScore", "confidence", "scoreHistory", "metadata", "evidenceSummary"]) assert(Object.hasOwn(f.filter, key));
        }
        for (const value of [state.interestScore.lastCalculatedAt, state.interestScore.lastDecayAt,
            state.confidence.lastCalculatedAt, state.metadata.createdAt, state.metadata.updatedAt,
            ...state.scoreHistory.map((entry) => entry.timestamp)]) assert(value instanceof Date);
        assert(queue._id instanceof ObjectId);
        assert.deepStrictEqual(queue.entityId, state._id);
        assert.strictEqual(queue.entityType, "ChildInterest");
        assert.strictEqual(queue.status, "PENDING");
        assert.strictEqual(queue.operation, existing ? "UPDATE" : "CREATE");
        assert(queue.createdAt instanceof Date);
        assert(job._id instanceof ObjectId);
        assert.strictEqual(job.jobType, "ContinuousLearning");
        assert.strictEqual(job.status, "COMPLETED"); assert.strictEqual(job.outcome, "APPLIED");
        assert.strictEqual(job.idempotencyKey, data.event.processing.idempotencyKey);
        assert.deepStrictEqual(job.source, { collection: "Interaction", documentId: data.event.eventId, eventType: "View" });
        assert.deepStrictEqual(job.event, {
            eventType: "View", childId: ids.child, activityId: ids.activity, subcategoryId: ids.subcategory,
            bookingId: null, sessionId: null, occurredAt: new Date(data.event.occurredAt)
        });
        for (const value of [job.processing.completedAt, job.metadata.createdAt, job.metadata.updatedAt]) assert(value instanceof Date);
    }
}

async function testTimestampSafety() {
    const paths = ["interestScore.lastCalculatedAt", "interestScore.lastDecayAt", "confidence.lastCalculatedAt",
        "metadata.createdAt", "metadata.updatedAt", "metadata.lastSyncedToGraph", "scoreHistory.0.timestamp"];
    for (const path of paths) {
        const data = input();
        const keys = path.split("."); const last = keys.pop();
        keys.reduce((v, k) => v[k], data.nextState)[last] = "invalid";
        const f = fake();
        const result = await run(data, f);
        assert.strictEqual(result.reasonCode, "INVALID_TIMESTAMP");
        assert.deepStrictEqual(f.calls, []);
    }
    const data = input(); data.event.occurredAt = null;
    assert.strictEqual((await run(data, fake())).reasonCode, "INVALID_TIMESTAMP");
}

async function testRollback() {
    for (const existing of [false, true]) {
        for (const fail of ["ai_jobs.find", "child_interests.find", `child_interests.${existing ? "update" : "insert"}`,
            "ai_jobs.insert", "graph_sync_queue.insert", "commit"]) {
            const data = input(existing), f = fake(data.currentState), before = copy(f.durable);
            f.fail = fail;
            const result = await run(data, f);
            assert.strictEqual(result.reasonCode, "DATABASE_ERROR");
            assert.strictEqual(result.state, null);
            assert.deepStrictEqual(f.durable, before);
            assert.strictEqual(f.commits, 0); assert.strictEqual(f.aborts, 1); assert.strictEqual(f.ends, 1);
        }
    }
}

async function testDuplicatesAndRaces() {
    for (const outcome of ["APPLIED", "IGNORED"]) {
        const data = input(), f = fake();
        f.durable.ai_jobs.push({ jobType: "ContinuousLearning", idempotencyKey: data.event.processing.idempotencyKey, status: "COMPLETED", outcome });
        const before = copy(f.durable);
        const result = await run(data, f);
        assert.strictEqual(result.reasonCode, "DUPLICATE_EVENT"); assert.strictEqual(result.status, "IGNORED");
        assert.deepStrictEqual(f.calls, ["start", "ai_jobs.find"]);
        assert.deepStrictEqual(f.durable, before);
    }
    for (const [fail, keyPattern, reason] of [
        ["ai_jobs.insert", { jobType: 1, idempotencyKey: 1 }, "DUPLICATE_EVENT"],
        ["child_interests.insert", { childId: 1, subcategoryId: 1 }, "CONCURRENT_STATE_CHANGE"],
        ["graph_sync_queue.insert", { _id: 1 }, "DATABASE_ERROR"]
    ]) {
        const data = input(), f = fake(), before = copy(f.durable);
        f.fail = fail; f.error = Object.assign(new Error("Duplicate key"), { code: 11000, keyPattern });
        assert.strictEqual((await run(data, f)).reasonCode, reason);
        if (reason === "DUPLICATE_EVENT") before.ai_jobs = copy(f.durable.ai_jobs);
        assert.deepStrictEqual(f.durable, before);
        assert.strictEqual(f.aborts, 1);
    }
    for (const status of ["PROCESSING", "FAILED", "unknown"]) {
        const data = input(), f = fake();
        f.durable.ai_jobs.push({ jobType: "ContinuousLearning", idempotencyKey: data.event.processing.idempotencyKey, status });
        const result = await run(data, f);
        assert.strictEqual(result.reasonCode, status === "PROCESSING" ? "EVENT_ALREADY_PROCESSING"
            : status === "FAILED" ? "RETRY_REQUIRES_ORCHESTRATION" : "INVALID_PROCESSING_STATE");
        assert.strictEqual(f.durable.child_interests.length, 0);
    }
}

async function testConcurrency() {
    for (const change of ["score", "confidence", "evidence", "history", "decay", "metadata", "zeroMatch", "writeConflict"]) {
        const data = input(true), f = fake(data.currentState);
        const stored = f.durable.child_interests[0];
        if (change === "score") stored.interestScore.currentScore += 0.01;
        if (change === "confidence") stored.confidence.currentScore += 0.01;
        if (change === "evidence") stored.confidence.evidenceCount++;
        if (change === "history") stored.scoreHistory[0].timestamp = "2026-09-16T11:00:00Z";
        if (change === "decay") stored.interestScore.lastDecayAt = "2026-09-16T11:00:00Z";
        if (change === "metadata") stored.metadata.lastSyncedToGraph = "2026-09-16T13:00:00Z";
        if (change === "zeroMatch") f.zeroMatch = true;
        if (change === "writeConflict") {
            f.fail = "child_interests.update"; f.error = Object.assign(new Error("Write conflict"), { code: 112 });
        }
        const before = copy(f.durable);
        const result = await run(data, f);
        assert.strictEqual(result.reasonCode, "CONCURRENT_STATE_CHANGE");
        assert.strictEqual(result.retryable, true);
        assert.deepStrictEqual(f.durable, before);
        assert(!f.calls.includes("ai_jobs.insert")); assert(!f.calls.includes("graph_sync_queue.insert"));
    }
    const data = input(), f = fake(input(true).currentState);
    assert.strictEqual((await run(data, f)).reasonCode, "CONCURRENT_STATE_CHANGE");
    const stale = input(true);
    assert.strictEqual((await run(stale, fake())).reasonCode, "CONCURRENT_STATE_CHANGE");
}

async function testReplayAndBookingSnapshot() {
    const data = input(), f = fake();
    assert.strictEqual((await run(data, f)).status, "APPLIED");
    const committed = copy(f.durable);
    const replay = await run(data, f);
    assert.strictEqual(replay.reasonCode, "DUPLICATE_EVENT");
    assert.deepStrictEqual(f.durable, committed);
    assert.strictEqual(f.durable.graph_sync_queue.length, 1);

    const bookingData = input();
    Object.assign(bookingData.event, {
        eventType: "Book", source: "Booking", bookingId: "64f000000000000000000006",
        sessionId: "64f000000000000000000007", processing: { idempotencyKey: "booking:64f000000000000000000006:Book" }
    });
    bookingData.instruction = getLearningInstruction(bookingData.event);
    bookingData.nextState = calculateNextInterestState(null, bookingData.instruction, bookingData.event).state;
    const bookingDb = fake();
    assert.strictEqual((await run(bookingData, bookingDb)).status, "APPLIED");
    const job = bookingDb.durable.ai_jobs[0];
    assert.strictEqual(job.source.collection, "Booking");
    assert.strictEqual(job.event.bookingId, bookingData.event.bookingId);
    assert.strictEqual(job.event.sessionId, bookingData.event.sessionId);

    for (const [index, stage, reason] of [
        ["uniq_learning_idempotency", "ai_jobs.insert", "DUPLICATE_EVENT"],
        ["uniq_child_interest", "child_interests.insert", "CONCURRENT_STATE_CHANGE"]
    ]) {
        const race = fake();
        race.fail = stage;
        race.error = Object.assign(new Error(`E11000 duplicate key error index: ${index} dup key`), { code: 11000 });
        assert.strictEqual((await run(input(), race)).reasonCode, reason);
        assert.strictEqual(race.durable.child_interests.length, 0);
        assert.strictEqual(race.durable.ai_jobs.length, reason === "DUPLICATE_EVENT" ? 1 : 0);
        assert.strictEqual(race.durable.graph_sync_queue.length, 0);
    }
}

const { getOutcomeLearningInstruction } = require("../learning/outcomeLearningRuleEngine");
const { calculateNextDevelopmentProfile } = require("../learning/developmentProfileTransition");
const outcomeIds = ["64f000000000000000000010", "64f000000000000000000011"];
function combined(empty = false, existing = false) {
    const data = input(existing);
    Object.assign(data.event, { eventType: "Attend", source: "Booking", bookingId: "64f000000000000000000006",
        processing: { idempotencyKey: "booking:64f000000000000000000006:Attend" } });
    data.instruction = getLearningInstruction(data.event);
    data.nextState = calculateNextInterestState(data.currentState, data.instruction, data.event).state;
    const oldEntry = (outcomeId) => ({ outcomeId: new ObjectId(outcomeId), score: 0.3, confidenceScore: 0.2,
        evidenceCount: 2, trend: "Stable", history: [], lastEvidenceAt: new Date("2025-01-01"), lastUpdated: new Date("2025-01-02") });
    data.currentDevelopmentProfile = [oldEntry(outcomeIds[0]), oldEntry("64f000000000000000000012")];
    data.outcomeResult = empty ? { status: "NOT_APPLICABLE", reasonCode: "NO_MAPPED_OUTCOMES" } :
        calculateNextDevelopmentProfile(data.currentDevelopmentProfile,
            getOutcomeLearningInstruction(data.event, { status: "APPLICABLE", activityId: ids.activity, outcomeIds }), data.event);
    if (!empty) data.nextDevelopmentProfile = data.outcomeResult.developmentProfile;
    const f = fake(data.currentState);
    f.durable.children = [{ _id: new ObjectId(ids.child), developmentProfile: copy(data.currentDevelopmentProfile),
        parentGoals: [{ goalId: "unchanged" }], preferences: { retained: true }, status: "Active", name: "Preserved" }];
    f.durable.activities = [{ _id: new ObjectId(ids.activity), learningOutcomes: empty ? [] : outcomeIds.map((id) => ({ outcomeId: new ObjectId(id) })) }];
    f.durable.learning_outcomes = outcomeIds.map((id) => ({ _id: new ObjectId(id), isActive: true }));
    return { data, f };
}
async function runCombined(data, f) {
    const before = copy(data);
    const result = await persistAppliedContinuousLearning({ ...data, currentInterestState: data.currentState,
        nextInterestState: data.nextState, client: f.client, db: f.db });
    assert.deepStrictEqual(data, before);
    return result;
}
async function testCombined() {
    for (const empty of [false, true]) for (const existing of [false, true]) {
        const { data, f } = combined(empty, existing), before = copy(f.durable.children[0]), start = Date.now();
        assert.strictEqual((await runCombined(data, f)).status, "APPLIED");
        assert.strictEqual(f.commits, 1);
        assert.strictEqual(f.durable.child_interests.length, 1);
        assert.strictEqual(f.durable.ai_jobs.length, 1);
        assert.strictEqual(f.durable.graph_sync_queue.length, 1);
        const job = f.durable.ai_jobs[0], queue = f.durable.graph_sync_queue[0], child = f.durable.children[0];
        assert.strictEqual(job.components.interest.status, "APPLIED");
        assert.strictEqual(job.components.outcomes.status, empty ? "NOT_APPLICABLE" : "APPLIED");
        assert(job.components.interest.completedAt instanceof Date);
        assert.deepStrictEqual(job.components.outcomes.completedAt, job.processing.completedAt);
        assert.strictEqual(queue.entityType, "ChildInterest"); assert.strictEqual(queue.status, "PENDING");
        assert.deepStrictEqual(queue.entityId, f.durable.child_interests[0]._id);
        assert.deepStrictEqual({ ...child, developmentProfile: undefined }, { ...before, developmentProfile: undefined });
        if (empty) {
            assert.deepStrictEqual(child, before);
            assert.strictEqual(job.components.outcomes.reasonCode, "NO_MAPPED_OUTCOMES");
            assert(!f.calls.includes("children.update"));
        } else {
            assert.strictEqual(child.developmentProfile.length, 3);
            assert.deepStrictEqual(child.developmentProfile[1], before.developmentProfile[1]);
            for (const [index, score, count] of [[0, 0.4, 3], [2, 0.1, 1]]) {
                const entry = child.developmentProfile[index];
                assert(entry.outcomeId instanceof ObjectId);
                assert.strictEqual(entry.score, score); assert.strictEqual(entry.evidenceCount, count);
                assert.deepStrictEqual(entry.lastEvidenceAt, new Date(data.event.occurredAt));
                assert(entry.lastUpdated.getTime() >= start && entry.lastUpdated.getTime() <= Date.now());
                assert.deepStrictEqual(entry.history.at(-1).timestamp, new Date(data.event.occurredAt));
                assert.strictEqual(typeof entry.history.at(-1).bookingId, "string");
            }
        }
        const committed = copy(f.durable);
        assert.strictEqual((await runCombined(data, f)).reasonCode, "DUPLICATE_EVENT");
        assert.deepStrictEqual(f.durable, committed);
    }
    const { data, f } = combined();
    assert.strictEqual((await run(data, f)).reasonCode, "COMBINED_LEARNING_REQUIRED");
    assert.deepStrictEqual(f.calls, []);
    for (const type of ["View", "Save", "Book"]) {
        const data = input(), f = fake();
        data.event.eventType = type; data.instruction = getLearningInstruction(data.event);
        data.nextState = calculateNextInterestState(null, data.instruction, data.event).state;
        assert.strictEqual((await run(data, f)).status, "APPLIED");
        assert.deepStrictEqual(Object.keys(f.durable.ai_jobs[0].components), ["interest"]);
        assert.strictEqual(f.durable.graph_sync_queue.length, 1);
        assert.deepStrictEqual(f.durable.children, []);
    }
}
async function testCombinedFailures() {
    // Fail after interest, profile, job, and queue staging, respectively.
    for (const existing of [false, true]) for (const fail of ["children.update", "ai_jobs.insert", "graph_sync_queue.insert", "commit"]) {
        const { data, f } = combined(false, existing), before = copy(f.durable); f.fail = fail;
        assert.strictEqual((await runCombined(data, f)).reasonCode, "DATABASE_ERROR");
        assert.deepStrictEqual(f.durable, before); assert.strictEqual(f.aborts, 1);
    }
    for (const stale of ["interest", "profile", "both", "conditional"]) {
        const { data, f } = combined(false, true);
        if (["interest", "both"].includes(stale)) f.durable.child_interests[0].confidence.evidenceCount++;
        if (["profile", "both"].includes(stale)) f.durable.children[0].developmentProfile[1].score += 0.1;
        if (stale === "conditional") f.zeroMatchCollection = "children";
        const before = copy(f.durable);
        const result = await runCombined(data, f);
        assert.strictEqual(result.reasonCode, "CONCURRENT_STATE_CHANGE"); assert(result.retryable);
        assert.deepStrictEqual(f.durable, before);
    }
    for (const change of ["mapping", "inactive", "missing", "calculation", "emptyClaim"]) {
        const { data, f } = combined();
        if (change === "mapping") f.durable.activities[0].learningOutcomes = [];
        if (change === "inactive") f.durable.learning_outcomes[0].isActive = false;
        if (change === "missing") f.durable.learning_outcomes = [];
        if (change === "calculation") data.nextDevelopmentProfile[0].score = 1;
        if (change === "emptyClaim") data.outcomeResult = { status: "NOT_APPLICABLE", reasonCode: "NO_MAPPED_OUTCOMES" };
        const before = copy(f.durable);
        assert.notStrictEqual((await runCombined(data, f)).status, "APPLIED");
        assert.deepStrictEqual(f.durable, before);
    }
    for (const components of [undefined, { interest: { status: "APPLIED", completedAt: new Date() } }, null]) {
        const { data, f } = combined();
        f.durable.ai_jobs.push({ jobType: "ContinuousLearning", idempotencyKey: data.event.processing.idempotencyKey,
            status: "COMPLETED", outcome: "APPLIED", ...(components === undefined ? {} : { components }) });
        const before = copy(f.durable), result = await runCombined(data, f);
        assert.strictEqual(result.reasonCode, components === undefined ? "DUPLICATE_EVENT" : "INVALID_PROCESSING_STATE");
        assert.deepStrictEqual(f.durable, before);
    }
    // Empty mapping still requires the same profile snapshot, without writing it.
    {
        const { data, f } = combined(true);
        f.durable.children[0].developmentProfile[0].score += 0.1;
        const before = copy(f.durable);
        assert.strictEqual((await runCombined(data, f)).reasonCode, "CONCURRENT_STATE_CHANGE");
        assert.deepStrictEqual(f.durable, before);
    }
    // Component-bearing winners must be complete even after a uniqueness race.
    for (const complete of [false, true]) {
        const { data, f } = combined();
        f.fail = "ai_jobs.insert";
        f.error = Object.assign(new Error("race"), { code: 11000, keyPattern: { jobType: 1, idempotencyKey: 1 } });
        const component = { status: "APPLIED", completedAt: new Date() };
        f.winner = { jobType: "ContinuousLearning", idempotencyKey: data.event.processing.idempotencyKey,
            status: "COMPLETED", outcome: "APPLIED", components: { interest: component, ...(complete ? { outcomes: component } : {}) } };
        const before = copy(f.durable);
        assert.strictEqual((await runCombined(data, f)).reasonCode, complete ? "DUPLICATE_EVENT" : "INVALID_PROCESSING_STATE");
        before.ai_jobs = [f.winner]; assert.deepStrictEqual(f.durable, before);
    }
    for (const status of ["COMPLETED", "FAILED", "PROCESSING", "malformed"]) {
        const { data, f } = combined();
        f.fail = "ai_jobs.insert";
        f.error = Object.assign(new Error("race"), { code: 11000, keyPattern: { jobType: 1, idempotencyKey: 1 } });
        f.winner = { jobType: "ContinuousLearning", idempotencyKey: data.event.processing.idempotencyKey, status, outcome: "APPLIED" };
        const before = copy(f.durable), result = await runCombined(data, f);
        assert.strictEqual(result.reasonCode, { COMPLETED: "DUPLICATE_EVENT", FAILED: "RETRY_REQUIRES_ORCHESTRATION",
            PROCESSING: "EVENT_ALREADY_PROCESSING", malformed: "INVALID_PROCESSING_STATE" }[status]);
        before.ai_jobs = [f.winner]; assert.deepStrictEqual(f.durable, before);
    }
}

async function main() {
    await testCombined();
    await testCombinedFailures();
    await testSuccess();
    await testTimestampSafety();
    await testRollback();
    await testDuplicatesAndRaces();
    await testConcurrency();
    await testReplayAndBookingSnapshot();
    console.log("Learning persistence service unit tests: PASSED");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
