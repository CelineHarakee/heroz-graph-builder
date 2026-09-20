const assert = require("assert");
const { ObjectId } = require("mongodb");
const { processInterestLearningSource } = require("../learning/interestLearningService");
const { getLearningInstruction } = require("../learning/learningRuleEngine");
const { calculateNextInterestState } = require("../learning/interestStateTransition");

const child = "64f000000000000000000001", subcategory = "64f000000000000000000002";
function event(type = "View") {
    return { eventId: "event-1", eventType: type, childId: child, subcategoryId: subcategory,
        activityId: "64f000000000000000000003", occurredAt: new Date("2026-09-17T10:00:00Z"),
        bookingId: "booking-1", eventData: { ratingValue: 5 }, processing: { idempotencyKey: `event-1:${type}` } };
}
const valid = (value) => ({ status: "VALID", reasonCode: "REPEAT_LIMIT_CLEAR", event: value, retryable: false });
const conflict = { status: "NOT_APPLIED", reasonCode: "CONCURRENT_STATE_CHANGE", retryable: true };
const close = (a, b) => assert(Math.abs(a - b) < 1e-12);

function fixture(events = [event()]) {
    const f = { state: null, trace: [], counts: { d: 0, e: 0, p: 0, c: 0 }, calculations: [], queue: [], jobs: [], reads: [] };
    const client = {};
    const db = { client, collection(name) {
        if (name === "children") return { async findOne(query) {
            assert.deepStrictEqual(query, { _id: new ObjectId(child) });
            return { _id: new ObjectId(child), developmentProfile: [] };
        } };
        assert.strictEqual(name, "child_interests");
        return { async findOne(query) {
            f.trace.push("read");
            assert.deepStrictEqual(query, { childId: new ObjectId(child), subcategoryId: new ObjectId(subcategory) });
            f.reads.push(f.state);
            return f.state;
        } };
    } };
    f.dependencies = {
        async processLearningSource() { f.trace.push("C"); f.counts.c++; return events.map(valid); },
        getLearningInstruction(value) { f.trace.push("D"); f.counts.d++; return getLearningInstruction(value); },
        calculateNextInterestState(current, instruction, value) {
            f.trace.push("E"); f.counts.e++;
            const result = calculateNextInterestState(current, instruction, value);
            f.calculations.push(result.state);
            return result;
        },
        async persistAppliedInterestLearning(args) {
            f.trace.push(`P:${args.event.eventType}`); f.counts.p++;
            assert.strictEqual(args.client, client); assert.strictEqual(args.db, db);
            if (f.persistOverride) return f.persistOverride(args);
            return f.commit(args);
        }
    };
    f.dependencies.resolveOutcomeLearningContext = async () => ({
        status: "APPLICABLE", activityId: events[0].activityId, outcomeIds: ["64f000000000000000000010"]
    });
    f.dependencies.persistAppliedContinuousLearning = async (args) => {
        assert.strictEqual(args.event.eventType, "Attend");
        assert.strictEqual(args.outcomeResult.status, "APPLIED");
        assert.strictEqual(args.nextDevelopmentProfile[0].score, 0.1);
        f.trace.push("PC:Attend"); f.counts.p++;
        const compatibleArgs = { ...args, nextState: args.nextInterestState };
        return f.persistOverride ? f.persistOverride(compatibleArgs) : f.commit(compatibleArgs);
    };
    f.commit = (args) => {
        f.state = { ...args.nextState, _id: f.state?._id ?? new ObjectId() };
        f.jobs.push(args.event.processing.idempotencyKey);
        f.queue.push({ entityType: "ChildInterest", entityId: f.state._id, status: "PENDING" });
        return { status: "APPLIED", reasonCode: "INTEREST_LEARNING_PERSISTED", state: f.state };
    };
    f.options = { db, dependencies: f.dependencies };
    return f;
}

async function run(f, source = "Interaction") {
    const document = { fixture: "raw source", nested: { unchanged: true } };
    const before = structuredClone(document);
    const result = await processInterestLearningSource(source, document, f.options);
    assert.deepStrictEqual(document, before);
    assert.strictEqual(result.status, "COMPLETED");
    assert.strictEqual(result.sourceType, source);
    for (const item of result.results) {
        assert(!Object.hasOwn(item, "error")); assert(!Object.hasOwn(item, "state"));
    }
    return result.results;
}

async function testBasics() {
    const f = fixture();
    const [result] = await run(f);
    assert.deepStrictEqual(f.trace, ["C", "D", "read", "E", "P:View"]);
    assert.strictEqual(f.reads[0], null);
    assert.strictEqual(result.status, "APPLIED");
    assert.strictEqual(result.interestId, String(f.state._id));
    close(result.transition.previousScore, 0.5); close(result.transition.currentScore, 0.51);
    close(result.transition.previousConfidence, 0.2); close(result.transition.currentConfidence, 0.205);
    assert.strictEqual(result.transition.evidenceCount, 1);
    const existing = f.state;
    await run(f);
    assert.strictEqual(f.reads[1], existing);
}

async function testStops() {
    for (const status of ["IGNORED", "REJECTED", "FAILED"]) {
        const f = fixture();
        f.dependencies.processLearningSource = async () => [{ ...valid(event()), status, reasonCode: "STOP", retryable: status === "FAILED" }];
        assert.strictEqual((await run(f))[0].status, status);
        assert.deepStrictEqual(f.counts, { c: 0, d: 0, e: 0, p: 0 });
    }
    const unsupported = fixture([event("Complete")]);
    assert.strictEqual((await run(unsupported))[0].reasonCode, "UNSUPPORTED_EVENT_TYPE");
    assert.strictEqual(unsupported.counts.e, 0); assert.strictEqual(unsupported.counts.p, 0);
    const rejected = fixture();
    rejected.dependencies.calculateNextInterestState = () => ({ status: "NOT_APPLIED", reasonCode: "OUT_OF_ORDER_EVENT" });
    assert.strictEqual((await run(rejected))[0].reasonCode, "OUT_OF_ORDER_EVENT");
    assert.strictEqual(rejected.counts.p, 0);
    for (const throwing of [true, false]) {
        const f = fixture();
        f.persistOverride = () => {
            if (throwing) throw new Error("private database details");
            return { status: "FAILED", reasonCode: "DATABASE_ERROR", retryable: true, error: new Error("private") };
        };
        const [result] = await run(f);
        assert.strictEqual(result.status, "FAILED"); assert.strictEqual(result.retryable, true);
        assert.strictEqual(result.reasonCode, "DATABASE_ERROR"); assert.strictEqual(f.counts.p, 1);
    }
    const duplicate = fixture();
    duplicate.persistOverride = () => ({ status: "IGNORED", reasonCode: "DUPLICATE_EVENT" });
    const [result] = await run(duplicate);
    assert.strictEqual(result.status, "IGNORED"); assert.strictEqual(result.transition, null);
    assert.strictEqual(duplicate.queue.length, 0);
}

async function testBooking() {
    const f = fixture([event("Book"), event("Attend")]);
    const results = await run(f, "Booking");
    assert.deepStrictEqual(results.map((r) => r.status), ["APPLIED", "APPLIED"]);
    assert.deepStrictEqual(f.trace, ["C", "D", "read", "E", "P:Book", "D", "read", "E", "PC:Attend"]);
    close(f.reads[1].interestScore.currentScore, 0.58);
    close(results[1].transition.currentScore, 0.68);
    close(results[1].transition.currentConfidence, 0.27);
    assert.strictEqual(results[1].transition.evidenceCount, 2);
    assert.strictEqual(f.jobs.length, 2); assert.notStrictEqual(f.jobs[0], f.jobs[1]);
    assert.strictEqual(f.queue.length, 2); assert(f.queue.every((job) => job.status === "PENDING"));
    const failure = fixture([event("Book"), event("Attend")]);
    failure.persistOverride = (args) => args.event.eventType === "Book"
        ? { status: "IGNORED", reasonCode: "DUPLICATE_EVENT" } : failure.commit(args);
    assert.deepStrictEqual((await run(failure, "Booking")).map((r) => r.status), ["IGNORED", "APPLIED"]);
}

async function testRetries() {
    const f = fixture();
    f.persistOverride = (args) => {
        if (f.counts.p === 1) {
            f.state = { ...args.nextState, _id: new ObjectId() };
            return conflict;
        }
        return f.commit(args);
    };
    assert.strictEqual((await run(f))[0].status, "APPLIED");
    assert.strictEqual(f.counts.p, 2); assert.strictEqual(f.counts.c, 2);
    assert.notStrictEqual(f.calculations[0], f.calculations[1]);
    close(f.calculations[1].interestScore.currentScore, 0.52);
    for (const reason of ["DUPLICATE_EVENT", "REPEAT_LIMIT_REACHED"]) {
        const blocked = fixture();
        blocked.dependencies.processLearningSource = async () => {
            blocked.counts.c++;
            return [{ ...valid(event()), status: blocked.counts.c === 1 ? "VALID" : "IGNORED", reasonCode: reason }];
        };
        blocked.persistOverride = () => conflict;
        const [result] = await run(blocked);
        assert.strictEqual(result.reasonCode, reason); assert.strictEqual(result.status, "IGNORED");
        assert.strictEqual(blocked.counts.p, 1); assert.strictEqual(blocked.counts.e, 1);
    }
    const exhausted = fixture(); exhausted.persistOverride = () => conflict;
    const [result] = await run(exhausted);
    assert.strictEqual(result.reasonCode, "CONCURRENT_RETRY_EXHAUSTED");
    assert.strictEqual(result.status, "FAILED"); assert.strictEqual(result.retryable, true);
    assert.strictEqual(exhausted.counts.p, 3); assert.strictEqual(exhausted.counts.c, 3);
    assert.strictEqual(exhausted.reads.length, 3); assert.strictEqual(exhausted.counts.e, 3);
}

async function testRealD7C() {
    const f = fixture();
    delete f.dependencies.processLearningSource;
    const records = { children: { _id: new ObjectId(child) },
        activities: { _id: new ObjectId("64f000000000000000000003"), classification: { subcategoryId: new ObjectId(subcategory) } },
        subcategories: { _id: new ObjectId(subcategory) } };
    const originalCollection = f.options.db.collection;
    f.options.db.collection = (name) => {
        if (name === "child_interests") return originalCollection(name);
        assert(name === "ai_jobs" || Object.hasOwn(records, name));
        return { async findOne() { return records[name] ?? null; } };
    };
    const raw = { _id: new ObjectId(), actor: { childId: child },
        targetEntity: { entityType: "Activity", entityId: "64f000000000000000000003" },
        interactionDetails: { interactionType: "View" }, timestamp: new Date("2026-09-17T10:00:00Z") };
    const result = await processInterestLearningSource("Interaction", raw, f.options);
    assert.strictEqual(result.results[0].status, "APPLIED");
    raw.interactionDetails.interactionType = "Complete";
    const calls = { ...f.counts };
    assert.strictEqual((await processInterestLearningSource("Interaction", raw, f.options)).results[0].reasonCode, "NON_LEARNING_EVENT");
    assert.deepStrictEqual(f.counts, calls);
}

async function main() {
    await testBasics(); await testStops(); await testBooking(); await testRetries(); await testRealD7C();
    console.log("Interest learning service unit tests: PASSED");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
