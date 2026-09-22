const assert = require("assert");
const { processLearningSource } = require("../learning/learningEventProcessor");
const { getLearningInstruction } = require("../learning/learningRuleEngine");

function interaction(type = "View", ratingValue = 5) {
    return {
        _id: "interaction-1", actor: { childId: "child-1" },
        targetEntity: { entityType: "Activity", entityId: "activity-1" },
        interactionDetails: { interactionType: type, ratingValue },
        timestamp: new Date("2026-09-16T14:00:00Z")
    };
}

function booking(status = "Confirmed", attendanceStatus = "Attended") {
    return {
        _id: "booking-1",
        bookingDetails: {
            childId: "child-1", activityId: "activity-1", sessionId: "session-1",
            status, bookedAt: new Date("2026-09-15T10:00:00Z")
        },
        attendance: { status: attendanceStatus, checkedInAt: new Date("2026-09-16T10:00:00Z") }
    };
}

function history(type = "View", idempotencyKey = "different-source-event") {
    return {
        _id: "job-1", source: { documentId: "prior-source" }, jobType: "ContinuousLearning", status: "COMPLETED", outcome: "APPLIED",
        idempotencyKey,
        event: { eventType: type, childId: "child-1", activityId: "activity-1", occurredAt: new Date("2026-09-16T10:00:00Z") }
    };
}

function field(record, path) {
    return path.split(".").reduce((value, key) => value?.[key], record);
}

function fixture() {
    const records = {
        children: [{ _id: "child-1" }],
        activities: [{ _id: "activity-1", classification: { subcategoryId: "authoritative-subcategory" } }],
        subcategories: [{ _id: "authoritative-subcategory" }], bookings: [booking()], ai_jobs: []
    };
    const f = { records, fail: false };
    f.db = { collection(name) {
        assert(Object.hasOwn(records, name), `Unexpected collection: ${name}`);
        // Intentionally exposes reads only; production write calls would fail.
        return { async findOne(query, options = {}) { return (await this.find(query, options).toArray())[0] ?? null; },
            find(query, options = {}) { return { toArray: async () => {
            if (f.fail) throw new Error("Simulated database failure");
            const matches = records[name].filter((record) => Object.entries(query).every(([path, expected]) => {
                const actual = field(record, path);
                if (expected && typeof expected === "object") {
                    return Object.entries(expected).every(([operator, value]) => {
                        if (operator === "$in") return value.includes(actual);
                        if (operator === "$gte") return actual >= value;
                        if (operator === "$lte") return actual <= value;
                        if (operator === "$lt") return actual < value;
                        throw new Error(`Unexpected operator: ${operator}`);
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

// Test-only boundary: count actual calls to the real D7D mapper.
async function runBoundary(sourceType, document, f) {
    const before = structuredClone(document);
    const recordsBefore = structuredClone(f.records);
    let invocationCount = 0;
    const invokedEvents = [];
    function invokeD7D(event) {
        invocationCount += 1;
        invokedEvents.push(event);
        return getLearningInstruction(event);
    }
    const results = await processLearningSource(sourceType, document, { db: f.db });
    const rows = [];
    for (const result of results) {
        const countBefore = invocationCount;
        let instruction = null;
        if (result.status === "VALID") {
            instruction = invokeD7D(result.event);
            assert.strictEqual(invocationCount, countBefore + 1);
            assert.strictEqual(invokedEvents.at(-1), result.event);
        } else {
            assert.strictEqual(invocationCount, countBefore, "Non-VALID result must not invoke D7D");
        }
        assert.notStrictEqual(result.event?.eventType, "Complete");
        assert.notStrictEqual(instruction?.eventType, "Complete");
        rows.push({ result, instruction, countBefore, countAfter: invocationCount });
    }
    assert.strictEqual(invocationCount, results.filter((result) => result.status === "VALID").length);
    assert.deepStrictEqual(document, before);
    assert.deepStrictEqual(f.records, recordsBefore);
    return { rows, invocationCount };
}

function expectApplicable(row, type, interestDelta, confidenceDelta) {
    assert.strictEqual(row.result.status, "VALID");
    assert.strictEqual(row.result.reasonCode, "REPEAT_LIMIT_CLEAR");
    assert.strictEqual(row.instruction.status, "APPLICABLE");
    assert.strictEqual(row.instruction.eventType, type);
    assert.strictEqual(row.instruction.subcategoryId, "authoritative-subcategory");
    assert.deepStrictEqual(row.instruction.learning, { interestDelta, confidenceDelta, evidenceIncrement: 1 });
}

function expectBlocked(row, status, reasonCode) {
    assert.strictEqual(row.result.status, status);
    assert.strictEqual(row.result.reasonCode, reasonCode);
    assert.strictEqual(row.instruction, null);
    assert.strictEqual(row.countAfter, row.countBefore);
}

async function main() {
    let cases = 0;
    for (const [type, interest, confidence] of [["View", 0.01, 0.005], ["Rate", 0.10, 0.05]]) {
        const run = await runBoundary("Interaction", interaction(type), fixture());
        assert.strictEqual(run.rows.length, 1);
        assert.strictEqual(run.invocationCount, 1);
        expectApplicable(run.rows[0], type, interest, confidence);
        cases += 1;
    }

    const blockedCases = [
        ["View", 5, (f) => f.records.ai_jobs.push(history("View", "interaction:interaction-1:View")), "IGNORED", "DUPLICATE_EVENT"],
        ["View", 5, (f) => f.records.ai_jobs.push(history()), "IGNORED", "REPEAT_LIMIT_REACHED"],
        ["Save", 5, (f) => f.records.ai_jobs.push(history("Save")), "IGNORED", "NO_STATE_TRANSITION"],
        ["View", 5, (f) => { f.records.children = []; }, "REJECTED", "CHILD_NOT_FOUND"],
        ["Rate", 6, () => {}, "REJECTED", "INVALID_RATING"],
        ["View", 5, (f) => { f.fail = true; }, "FAILED", "DATABASE_ERROR"],
        ["Share", 5, () => {}, "IGNORED", "NON_LEARNING_EVENT"],
        ["Complete", 5, () => {}, "IGNORED", "NON_LEARNING_EVENT"]
    ];
    for (const [type, rating, configure, status, reason] of blockedCases) {
        const f = fixture();
        configure(f);
        const run = await runBoundary("Interaction", interaction(type, rating), f);
        assert.strictEqual(run.rows.length, 1);
        assert.strictEqual(run.invocationCount, 0);
        expectBlocked(run.rows[0], status, reason);
        cases += 1;
    }

    for (const [status, attendance, type, interest, confidence] of [
        ["Confirmed", null, "Book", 0.08, 0.03],
        ["Pending", "Attended", "Attend", 0.10, 0.04],
        ["Pending", "CheckedOut", "Attend", 0.10, 0.04]
    ]) {
        const f = fixture();
        const raw = booking(status, attendance);
        f.records.bookings = [structuredClone(raw)];
        const run = await runBoundary("Booking", raw, f);
        assert.strictEqual(run.rows.length, 1);
        assert.strictEqual(run.invocationCount, 1);
        expectApplicable(run.rows[0], type, interest, confidence);
        cases += 1;
    }

    for (const duplicate of [false, true]) {
        const f = fixture();
        if (duplicate) f.records.ai_jobs.push(history("Book", "booking:booking-1:Book"));
        const run = await runBoundary("Booking", booking(), f);
        assert.strictEqual(run.rows.length, 2);
        assert.strictEqual(run.invocationCount, duplicate ? 1 : 2);
        if (duplicate) {
            expectBlocked(run.rows[0], "IGNORED", "DUPLICATE_EVENT");
        } else {
            expectApplicable(run.rows[0], "Book", 0.08, 0.03);
            assert.notStrictEqual(run.rows[0].instruction, run.rows[1].instruction);
            assert.notStrictEqual(run.rows[0].instruction.learning, run.rows[1].instruction.learning);
        }
        expectApplicable(run.rows[1], "Attend", 0.10, 0.04);
        cases += 1;
    }
    assert.strictEqual(cases, 15);
    console.log("D7C learning rule boundary tests: PASSED (15 cases)");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
