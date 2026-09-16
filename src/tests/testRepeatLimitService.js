const assert = require("assert");
const { evaluateRepeatLimit } = require("../learning/repeatLimitService");
const { normalizeInteraction } = require("../learning/eventNormalizer");
const { validateEvent } = require("../learning/eventValidator");
const { validateEventReferences } = require("../learning/eventReferenceValidator");
const { checkEventIdempotency } = require("../learning/eventIdempotencyService");

function event(type = "View", time = "2026-09-16T14:00:00Z") {
    return { ...normalizeInteraction({
        _id: "interaction-1", actor: { childId: "child-1" },
        targetEntity: { entityType: "Activity", entityId: "activity-1" },
        interactionDetails: { interactionType: "View" }, timestamp: new Date(time)
    }), eventType: type };
}

function job(type = "View", time = "2026-09-16T10:00:00Z", overrides = {}) {
    return { _id: "job-1", jobType: "ContinuousLearning", status: "COMPLETED",
        outcome: "APPLIED", event: event(type, time), ...overrides };
}

function field(object, path) {
    return path.split(".").reduce((value, key) => value?.[key], object);
}

function fakeDb(records = []) {
    const calls = [];
    return { calls, collection(name) {
        assert.strictEqual(name, "ai_jobs");
        return { async findOne(query, options = {}) {
            calls.push({ query, options });
            const matches = records.filter((record) => Object.entries(query).every(([key, expected]) => {
                const actual = field(record, key);
                if (expected && typeof expected === "object") {
                    return Object.entries(expected).every(([operator, value]) => {
                        if (operator === "$in") return value.includes(actual);
                        if (!(actual instanceof Date)) return false;
                        if (operator === "$gte") return actual >= value;
                        if (operator === "$lte") return actual <= value;
                        if (operator === "$lt") return actual < value;
                        throw new Error(`Unexpected operator ${operator}`);
                    });
                }
                return actual === expected;
            }));
            if (options.sort) matches.sort((a, b) => {
                for (const [key, direction] of Object.entries(options.sort)) {
                    const av = field(a, key), bv = field(b, key);
                    if (av < bv) return -direction;
                    if (av > bv) return direction;
                }
                return 0;
            });
            return matches[0] ?? null;
        } };
    } };
}

async function check(input, records = [], reasonCode = "REPEAT_LIMIT_CLEAR") {
    const before = structuredClone(input);
    const db = fakeDb(records);
    const result = await evaluateRepeatLimit(input, { db });
    const status = reasonCode === "REPEAT_LIMIT_CLEAR" ? "VALID"
        : ["INVALID_TIMESTAMP", "UNSUPPORTED_EVENT_TYPE"].includes(reasonCode) ? "REJECTED" : "IGNORED";
    assert.deepStrictEqual(result, { status, reasonCode, retryable: false, event: input, error: null });
    assert.strictEqual(result.event, input);
    if (input?.occurredAt instanceof Date) {
        assert(Object.is(input.occurredAt.getTime(), before.occurredAt.getTime()));
        assert.deepStrictEqual({ ...input, occurredAt: null }, { ...before, occurredAt: null });
    } else {
        assert.deepStrictEqual(input, before);
    }
    return db;
}

async function testPassive() {
    for (const type of ["View", "Click", "Dismiss"]) {
        await check(event(type));
        await check(event(type), [job(type)], "REPEAT_LIMIT_REACHED");
        await check(event(type, "2026-09-17T00:00:00Z"), [job(type)]);
        await check(event(type), [job(type, "2026-09-16T15:00:00Z")]);
        await check(event(type), [job(type, "2026-09-16T14:00:00Z")], "REPEAT_LIMIT_REACHED");
    }
    await check(event("Click"), [job()]);
    await check(event("Dismiss"), [job()]);
    await check({ ...event(), activityId: "activity-2" }, [job()]);
    await check({ ...event(), childId: "child-2" }, [job()]);
    for (const overrides of [
        { outcome: "IGNORED" }, { status: "FAILED" }, { status: "PROCESSING" },
        { status: "REJECTED" }, { jobType: "OtherJob" }
    ]) await check(event(), [job("View", undefined, overrides)]);

    const input = event();
    input.occurredAt = "2026-09-17T01:00:00+03:00";
    const db = await check(input, [job()], "REPEAT_LIMIT_REACHED");
    assert.deepStrictEqual(db.calls[0].query["event.occurredAt"], {
        $gte: new Date("2026-09-16T00:00:00Z"), $lte: new Date("2026-09-16T22:00:00Z")
    });
    await check(event("View", "2026-09-17T00:00:00Z"), [job("View", "2026-09-16T23:59:59.999Z")]);
}

async function testTransitions() {
    await check(event("Save"));
    await check(event("Unsave"), [], "NO_STATE_TRANSITION");
    for (const previous of ["Save", "Unsave"]) {
        for (const current of ["Save", "Unsave"]) {
            const db = await check(event(current), [job(previous)],
                previous === current ? "NO_STATE_TRANSITION" : "REPEAT_LIMIT_CLEAR");
            assert.deepStrictEqual(db.calls[0].options.sort, { "event.occurredAt": -1, _id: -1 });
        }
    }
    const history = [];
    for (const [type, time] of [["Save", "10"], ["Unsave", "11"], ["Save", "12"]]) {
        const timestamp = `2026-09-16T${time}:00:00Z`;
        await check(event(type, timestamp), history);
        history.push(job(type, timestamp, { _id: time }));
    }
    await check(event("Save"), history, "NO_STATE_TRANSITION");
    // Storage order and processing time must not determine the latest state.
    await check(event("Save"), [
        job("Unsave", "2026-09-16T12:00:00Z", { processing: { completedAt: new Date(0) } }),
        job("Save", "2026-09-16T10:00:00Z", { processing: { completedAt: new Date("2026-09-20") } })
    ]);
    for (const overrides of [{ outcome: "IGNORED" }, { status: "FAILED" }, { status: "PROCESSING" }]) {
        await check(event("Save"), [job("Save", undefined, overrides)]);
        await check(event("Unsave"), [job("Save", undefined, overrides)], "NO_STATE_TRANSITION");
    }
    for (const time of ["2026-09-16T15:00:00Z", "2026-09-16T14:00:00Z"]) {
        await check(event("Save"), [job("Save", time)]);
        await check(event("Unsave"), [job("Save", time)], "NO_STATE_TRANSITION");
    }
}

async function testSafetyAndFailures() {
    for (const type of ["Book", "Attend", "Rate"]) {
        const db = await check(event(type));
        assert.strictEqual(db.calls.length, 0);
    }
    for (const input of [null, undefined, {}, event("Complete"), event("Unknown")]) {
        await check(input, [], "UNSUPPORTED_EVENT_TYPE");
    }
    for (const type of ["View", "Click", "Dismiss", "Save", "Unsave"]) {
        for (const occurredAt of [null, undefined, "bad", "", new Date("bad"), 0]) {
            const db = await check({ ...event(type), occurredAt }, [], "INVALID_TIMESTAMP");
            assert.strictEqual(db.calls.length, 0);
        }
    }
    const input = event();
    const error = new Error("Read failed");
    const db = { collection() { return { async findOne() { throw error; } }; } };
    for (const type of ["View", "Save"]) {
        const item = event(type);
        assert.deepStrictEqual(await evaluateRepeatLimit(item, { db }), {
            status: "FAILED", reasonCode: "DATABASE_ERROR", retryable: true, event: item, error
        });
    }
    const path = require.resolve("../config/mongodb");
    const previous = require.cache[path];
    try {
        require.cache[path] = { exports: { getDatabase: () => undefined } };
        const result = await evaluateRepeatLimit(input);
        assert(result.error instanceof Error);
        assert.deepStrictEqual(result, {
            status: "FAILED", reasonCode: "DATABASE_ERROR", retryable: true, event: input, error: result.error
        });
        require.cache[path] = { exports: { getDatabase: () => fakeDb() } };
        assert.strictEqual((await evaluateRepeatLimit(input)).status, "VALID");
    } finally {
        if (previous) require.cache[path] = previous;
        else delete require.cache[path];
    }
}

async function testPipeline() {
    const input = event();
    assert.strictEqual(validateEvent(input).status, "VALID");
    const jobs = fakeDb();
    const records = {
        children: { _id: "child-1" },
        activities: { _id: "activity-1", classification: { subcategoryId: "subcategory-1" } },
        subcategories: { _id: "subcategory-1" }
    };
    const db = { collection(name) {
        if (name === "ai_jobs") return jobs.collection(name);
        assert(Object.hasOwn(records, name));
        return { async findOne(query) { return records[name]._id === query._id ? records[name] : null; } };
    } };
    const references = await validateEventReferences(input, { db });
    assert.strictEqual(references.status, "VALID");
    assert.strictEqual((await checkEventIdempotency(references.event, { db })).status, "VALID");
    const result = await evaluateRepeatLimit(references.event, { db });
    assert.strictEqual(result.status, "VALID");
    assert.strictEqual(result.reasonCode, "REPEAT_LIMIT_CLEAR");
}

async function main() {
    await testPassive();
    await testTransitions();
    await testSafetyAndFailures();
    await testPipeline();
    console.log("Repeat limit service unit tests: PASSED");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
