const assert = require("assert");
const { normalizeInteraction } = require("../learning/eventNormalizer");
const { validateEvent } = require("../learning/eventValidator");
const { validateEventReferences } = require("../learning/eventReferenceValidator");
const { checkEventIdempotency } = require("../learning/eventIdempotencyService");

function makeEvent() {
    return normalizeInteraction({
        _id: "interaction-1",
        actor: { childId: "child-1" },
        targetEntity: { entityType: "Activity", entityId: "activity-1" },
        interactionDetails: { interactionType: "View" },
        timestamp: new Date("2026-09-16T10:00:00.000Z")
    });
}

function fakeDb(records = []) {
    const calls = [];
    return {
        calls,
        collection(name) {
            assert.strictEqual(name, "ai_jobs");
            return {
                async findOne(query) {
                    calls.push(query);
                    assert.deepStrictEqual(Object.keys(query).sort(), ["idempotencyKey", "jobType"]);
                    return records.find((record) => record.jobType === query.jobType &&
                        record.idempotencyKey === query.idempotencyKey) ?? null;
                }
            };
        }
    };
}

async function expectResult(event, db, status, reasonCode, retryable = false, error = null) {
    const before = structuredClone(event);
    const result = await checkEventIdempotency(event, { db });
    assert.deepStrictEqual(result, { status, reasonCode, retryable, event, error });
    assert.strictEqual(result.event, event);
    assert.deepStrictEqual(event, before);
}

async function testStates() {
    const event = makeEvent();
    for (const [state, status, reason] of [
        [null, "VALID", "IDEMPOTENCY_CLEAR"],
        [{ status: "COMPLETED", outcome: "APPLIED" }, "IGNORED", "DUPLICATE_EVENT"],
        [{ status: "COMPLETED", outcome: "IGNORED" }, "IGNORED", "DUPLICATE_EVENT"],
        [{ status: "FAILED" }, "VALID", "IDEMPOTENCY_RETRY_ALLOWED"],
        [{ status: "PROCESSING" }, "IGNORED", "EVENT_ALREADY_PROCESSING"]
    ]) {
        const db = fakeDb(state ? [{
            jobType: "ContinuousLearning", idempotencyKey: event.processing.idempotencyKey, ...state
        }] : []);
        await expectResult(event, db, status, reason);
        assert.deepStrictEqual(db.calls, [{
            jobType: "ContinuousLearning", idempotencyKey: event.processing.idempotencyKey
        }]);
    }
}

async function testExactQueryScope() {
    const event = makeEvent();
    const db = fakeDb([
        { jobType: "OtherJob", idempotencyKey: event.processing.idempotencyKey, status: "COMPLETED", outcome: "APPLIED" },
        { jobType: "ContinuousLearning", idempotencyKey: "another-key", status: "COMPLETED", outcome: "APPLIED" }
    ]);
    await expectResult(event, db, "VALID", "IDEMPOTENCY_CLEAR");
    event.processing.idempotencyKey = " exact untrimmed key ";
    await expectResult(event, db, "VALID", "IDEMPOTENCY_CLEAR");
    assert.strictEqual(db.calls.at(-1).idempotencyKey, " exact untrimmed key ");
}

async function testMalformedInput() {
    const db = { collection() { throw new Error("Must not access database"); } };
    for (const event of [null, undefined, {}, [], "event", { processing: null }, { processing: "bad" }]) {
        await expectResult(event, db, "REJECTED", "MISSING_IDEMPOTENCY_KEY");
    }
    for (const key of [undefined, null, "", " \t\n", 1, {}, []]) {
        const event = makeEvent();
        event.processing.idempotencyKey = key;
        await expectResult(event, db, "REJECTED", "MISSING_IDEMPOTENCY_KEY");
    }
}

async function testUnknownStates() {
    const event = makeEvent();
    const states = [undefined, null, "", "Unknown", "completed", 1, {}, []]
        .map((status) => ({ status }));
    states.push(...[undefined, null, "", "Unknown", "applied", {}, 1]
        .map((outcome) => ({ status: "COMPLETED", outcome })));
    for (const state of states) {
        const db = fakeDb([{
            jobType: "ContinuousLearning", idempotencyKey: event.processing.idempotencyKey, ...state
        }]);
        await expectResult(event, db, "FAILED", "INVALID_PROCESSING_STATE");
    }
}

async function testDatabaseFailuresAndDefaultDb() {
    const event = makeEvent();
    const error = new Error("Database read failed");
    for (const db of [
        { collection() { return { async findOne() { throw error; } }; } },
        { collection() { throw error; } }
    ]) {
        await expectResult(event, db, "FAILED", "DATABASE_ERROR", true, error);
    }
    const configPath = require.resolve("../config/mongodb");
    const previous = require.cache[configPath];
    try {
        require.cache[configPath] = { exports: { getDatabase: () => undefined } };
        const result = await checkEventIdempotency(event);
        assert(result.error instanceof Error);
        assert.deepStrictEqual(result, {
            status: "FAILED", reasonCode: "DATABASE_ERROR", retryable: true, event, error: result.error
        });
        assert.strictEqual(result.event, event);
        require.cache[configPath] = { exports: { getDatabase: () => fakeDb() } };
        assert.strictEqual((await checkEventIdempotency(event)).reasonCode, "IDEMPOTENCY_CLEAR");
    } finally {
        if (previous) require.cache[configPath] = previous;
        else delete require.cache[configPath];
    }
}

async function testPipeline() {
    const event = makeEvent();
    assert.strictEqual(validateEvent(event).status, "VALID");
    const jobs = fakeDb();
    const records = {
        children: { _id: "child-1" },
        activities: { _id: "activity-1", classification: { subcategoryId: "subcategory-1" } },
        subcategories: { _id: "subcategory-1" }
    };
    const db = { collection(name) {
        if (name === "ai_jobs") return jobs.collection(name);
        assert(Object.hasOwn(records, name));
        return { async findOne(query) {
            return records[name]._id === query._id ? records[name] : null;
        } };
    } };
    const references = await validateEventReferences(event, { db });
    assert.strictEqual(references.status, "VALID");
    assert.strictEqual(references.event.subcategoryId, "subcategory-1");
    await expectResult(references.event, db, "VALID", "IDEMPOTENCY_CLEAR");
}

async function testComponents() {
    const event = { ...makeEvent(), eventType: "Attend" };
    const applied = () => ({ status: "APPLIED", completedAt: new Date() });
    for (const components of [undefined, { interest: applied(), outcomes: applied() },
        { interest: applied(), outcomes: { status: "NOT_APPLICABLE", reasonCode: "NO_MAPPED_OUTCOMES", completedAt: new Date() } },
        {}, null, { interest: applied() }, { interest: applied(), outcomes: { status: "APPLIED", completedAt: "bad" } }]) {
        const valid = components === undefined || (components?.outcomes?.completedAt instanceof Date);
        const db = fakeDb([{ jobType: "ContinuousLearning", idempotencyKey: event.processing.idempotencyKey,
            status: "COMPLETED", outcome: "APPLIED", ...(components === undefined ? {} : { components }) }]);
        await expectResult(event, db, valid ? "IGNORED" : "FAILED", valid ? "DUPLICATE_EVENT" : "INVALID_PROCESSING_STATE");
    }
    for (const status of ["FAILED", "PROCESSING"]) {
        const db = fakeDb([{ jobType: "ContinuousLearning", idempotencyKey: event.processing.idempotencyKey, status, components: null }]);
        await expectResult(event, db, status === "FAILED" ? "VALID" : "IGNORED",
            status === "FAILED" ? "IDEMPOTENCY_RETRY_ALLOWED" : "EVENT_ALREADY_PROCESSING");
    }
}

async function main() {
    await testComponents();
    await testStates();
    await testExactQueryScope();
    await testMalformedInput();
    await testUnknownStates();
    await testDatabaseFailuresAndDefaultDb();
    await testPipeline();
    console.log("Event idempotency service unit tests: PASSED");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
