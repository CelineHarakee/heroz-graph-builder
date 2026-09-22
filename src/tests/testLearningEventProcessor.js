const assert = require("assert");
const { processLearningSource } = require("../learning/learningEventProcessor");

function interaction(type = "View") {
    return {
        _id: "interaction-1", actor: { childId: "child-1" },
        targetEntity: { entityType: "Activity", entityId: "activity-1" },
        interactionDetails: { interactionType: type, ratingValue: 5 },
        timestamp: new Date("2026-09-16T14:00:00Z"), subcategoryId: "fake"
    };
}

function booking(status = "Confirmed", attendance = "Attended") {
    return {
        _id: "booking-1",
        bookingDetails: {
            childId: "child-1", activityId: "activity-1", sessionId: "session-1",
            status, bookedAt: new Date("2026-09-15T10:00:00Z")
        },
        attendance: { status: attendance, checkedInAt: new Date("2026-09-16T10:00:00Z") }
    };
}

function history(type = "View", overrides = {}) {
    return {
        _id: "job-1", source: { documentId: "prior-source" }, jobType: "ContinuousLearning", status: "COMPLETED", outcome: "APPLIED",
        idempotencyKey: "different-event",
        event: { eventType: type, childId: "child-1", activityId: "activity-1", occurredAt: new Date("2026-09-16T10:00:00Z") },
        ...overrides
    };
}

function field(record, path) {
    return path.split(".").reduce((value, key) => value?.[key], record);
}

function fixture() {
    const records = {
        children: [{ _id: "child-1" }],
        activities: [{ _id: "activity-1", classification: { subcategoryId: "subcategory-1" } }],
        subcategories: [{ _id: "subcategory-1" }], bookings: [booking()], ai_jobs: []
    };
    const calls = [];
    const f = { records, calls, failAt: null, error: new Error("Database unavailable") };
    f.db = { collection(name) {
        assert(Object.hasOwn(records, name), `Unexpected collection ${name}`);
        // No write methods exist on this fake.
        return { async findOne(query, options = {}) { return (await this.find(query, options).toArray())[0] ?? null; },
            find(query, options = {}) { return { toArray: async () => {
            const stage = name === "ai_jobs" ? (query.idempotencyKey ? "idempotency" : "repeat") : name;
            calls.push(stage);
            if (f.failAt === stage) throw f.error;
            const matches = records[name].filter((record) => Object.entries(query).every(([path, expected]) => {
                const actual = field(record, path);
                if (expected && typeof expected === "object") {
                    return Object.entries(expected).every(([operator, value]) => {
                        if (operator === "$in") return value.includes(actual);
                        if (operator === "$gte") return actual >= value;
                        if (operator === "$lte") return actual <= value;
                        if (operator === "$lt") return actual < value;
                        throw new Error(`Unexpected query operator ${operator}`);
                    });
                }
                return actual === expected;
            }));
            if (options.sort) matches.sort((a, b) => {
                for (const [path, direction] of Object.entries(options.sort)) {
                    if (field(a, path) < field(b, path)) return -direction;
                    if (field(a, path) > field(b, path)) return direction;
                }
                return 0;
            });
            return matches;
        } }; } };
    } };
    return f;
}

async function run(source, document, f = fixture()) {
    const before = structuredClone(document);
    const recordsBefore = structuredClone(f.records);
    const results = await processLearningSource(source, document, { db: f.db });
    assert.deepStrictEqual(document, before);
    assert.deepStrictEqual(f.records, recordsBefore);
    return results;
}

function expect(result, status = "VALID", reasonCode = "REPEAT_LIMIT_CLEAR") {
    assert.strictEqual(result.status, status);
    assert.strictEqual(result.reasonCode, reasonCode);
    assert.strictEqual(result.retryable, status === "FAILED");
    if (status !== "FAILED") assert.strictEqual(result.error, null);
    if (status === "VALID") assert.strictEqual(result.event.subcategoryId, "subcategory-1");
}

async function testInteractionsAndFailFast() {
    for (const type of ["View", "Rate", "Save"]) {
        const f = fixture();
        const results = await run("Interaction", interaction(type), f);
        assert.strictEqual(results.length, 1);
        expect(results[0]);
        assert.deepStrictEqual(f.calls, ["children", "activities", "subcategories", "idempotency", ...(type === "Rate" ? [] : ["repeat"])]);
    }
    for (const type of ["Share", "Complete", "Book", "Attend"]) {
        const f = fixture();
        const [result] = await run("Interaction", interaction(type), f);
        expect(result, "IGNORED", "NON_LEARNING_EVENT");
        assert.strictEqual(result.event, null);
        assert.deepStrictEqual(f.calls, []);
    }
    const f = fixture();
    const raw = interaction();
    delete raw.actor.childId;
    expect((await run("Interaction", raw, f))[0], "REJECTED", "MISSING_CHILD_ID");
    assert.deepStrictEqual(f.calls, []);
    for (const [name, reason, expectedCalls] of [
        ["children", "CHILD_NOT_FOUND", ["children"]],
        ["activities", "ACTIVITY_NOT_FOUND", ["children", "activities"]],
        ["subcategories", "SUBCATEGORY_NOT_FOUND", ["children", "activities", "subcategories"]]
    ]) {
        const f = fixture();
        f.records[name] = [];
        expect((await run("Interaction", interaction(), f))[0], "REJECTED", reason);
        assert.deepStrictEqual(f.calls, expectedCalls);
    }
}

async function testIdempotencyAndRepeats() {
    for (const [status, reason] of [["COMPLETED", "DUPLICATE_EVENT"], ["PROCESSING", "EVENT_ALREADY_PROCESSING"], ["FAILED", "REPEAT_LIMIT_CLEAR"]]) {
        const f = fixture();
        f.records.ai_jobs.push(history("View", { idempotencyKey: "interaction:interaction-1:View", status }));
        expect((await run("Interaction", interaction(), f))[0], status === "FAILED" ? "VALID" : "IGNORED", reason);
        assert.strictEqual(f.calls.includes("repeat"), status === "FAILED");
    }
    for (const [type, previous, status, reason] of [
        ["View", "View", "IGNORED", "REPEAT_LIMIT_REACHED"],
        ["Save", "Save", "IGNORED", "NO_STATE_TRANSITION"],
        ["Save", "Unsave", "VALID", "REPEAT_LIMIT_CLEAR"]
    ]) {
        const f = fixture();
        f.records.ai_jobs.push(history(previous));
        expect((await run("Interaction", interaction(type), f))[0], status, reason);
        assert.strictEqual(f.calls.at(-1), "repeat");
    }
}

async function testBookings() {
    for (const [status, attendance, types] of [
        ["Confirmed", undefined, ["Book"]], ["Pending", "Attended", ["Attend"]],
        ["Confirmed", "Attended", ["Book", "Attend"]], ["Pending", "CheckedOut", ["Attend"]],
        ["Confirmed", "NoShow", ["Book"]]
    ]) {
        const f = fixture();
        const raw = booking(status, attendance);
        raw.attendance.status = attendance;
        f.records.bookings = [structuredClone(raw)];
        const results = await run("Booking", raw, f);
        assert.deepStrictEqual(results.map((r) => r.event.eventType), types);
        results.forEach((r) => expect(r));
    }
    for (const status of ["Pending", "Cancelled"]) {
        const f = fixture();
        const [result] = await run("Booking", booking(status, "NoShow"), f);
        expect(result, "IGNORED", "NON_LEARNING_EVENT");
        assert.strictEqual(result.event, null);
        assert.deepStrictEqual(f.calls, []);
    }
    for (const failure of ["duplicate", "operational", "structural"]) {
        const f = fixture();
        const raw = booking();
        if (failure === "duplicate") f.records.ai_jobs.push(history("Book", { idempotencyKey: "booking:booking-1:Book" }));
        if (failure === "operational") f.records.bookings[0].bookingDetails.status = "Cancelled";
        if (failure === "structural") delete raw.bookingDetails.bookedAt;
        const results = await run("Booking", raw, f);
        assert.strictEqual(results.length, 2);
        expect(results[0], failure === "duplicate" ? "IGNORED" : "REJECTED",
            failure === "duplicate" ? "DUPLICATE_EVENT" : failure === "operational" ? "BOOKING_NOT_CONFIRMED" : "INVALID_TIMESTAMP");
        expect(results[1]);
        assert.strictEqual(results[1].event.eventType, "Attend");
    }
}

async function testErrors() {
    const f = fixture();
    expect((await run("Unknown", {}, f))[0], "REJECTED", "UNSUPPORTED_SOURCE");
    assert.deepStrictEqual(f.calls, []);
    for (const stage of ["children", "idempotency", "repeat"]) {
        const f = fixture();
        f.failAt = stage;
        const [result] = await run("Interaction", interaction(), f);
        expect(result, "FAILED", "DATABASE_ERROR");
        assert.strictEqual(result.error, f.error);
        assert.strictEqual(f.calls.at(-1), stage);
    }
    const error = new Error("Unexpected normalization failure");
    const raw = { get interactionDetails() { throw error; } };
    assert.deepStrictEqual(await processLearningSource("Interaction", raw), [{
        status: "FAILED", reasonCode: "PROCESSING_ERROR", retryable: true, event: null, error
    }]);
}

async function testUnexpectedPerEventErrorAndResultIdentity() {
    // Isolate dependency stubs to verify returned-event passing and exact result identity.
    const processorPath = require.resolve("../learning/learningEventProcessor");
    const validatorPath = require.resolve("../learning/eventValidator");
    const referencePath = require.resolve("../learning/eventReferenceValidator");
    const saved = [processorPath, validatorPath, referencePath].map((path) => [path, require.cache[path]]);
    const error = new Error("Unexpected stage failure");
    let thrownEvent;
    const rejection = { status: "REJECTED", reasonCode: "TEST_REJECTION", retryable: false, event: null, error: null };
    try {
        require.cache[validatorPath] = { exports: { validateEvent(event) {
            if (event.eventType === "Book") { thrownEvent = event; throw error; }
            if (event.eventType === "View") return rejection;
            return { status: "VALID", event: { ...event, marker: "validated" } };
        } } };
        const realReferences = saved[2][1].exports.validateEventReferences;
        require.cache[referencePath] = { exports: { async validateEventReferences(event, options) {
            assert.strictEqual(event.marker, "validated");
            return realReferences(event, options);
        } } };
        delete require.cache[processorPath];
        const isolated = require("../learning/learningEventProcessor").processLearningSource;
        const results = await isolated("Booking", booking(), { db: fixture().db });
        assert.deepStrictEqual(results[0], { status: "FAILED", reasonCode: "PROCESSING_ERROR", retryable: true, event: thrownEvent, error });
        expect(results[1]);
        assert.strictEqual(results[1].event.marker, "validated");
        assert.strictEqual((await isolated("Interaction", interaction()))[0], rejection);
    } finally {
        for (const [path, cached] of saved) require.cache[path] = cached;
    }
}

async function main() {
    await testInteractionsAndFailFast();
    await testIdempotencyAndRepeats();
    await testBookings();
    await testErrors();
    await testUnexpectedPerEventErrorAndResultIdentity();
    console.log("Learning event processor unit tests: PASSED");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
