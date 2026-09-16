const assert = require("assert");
const { processLearningSource } = require("../learning/learningEventProcessor");
const { getLearningInstruction } = require("../learning/learningRuleEngine");
const { calculateNextInterestState } = require("../learning/interestStateTransition");

const START = Date.parse("2026-01-01T00:00:00Z");
const at = (days) => new Date(START + days * 86400000);
const close = (actual, expected) => assert(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);

function interaction(type = "View", days = 1, ratingValue = 5) {
    return { _id: "interaction-1", actor: { childId: "child-1" },
        targetEntity: { entityType: "Activity", entityId: "activity-1" },
        interactionDetails: { interactionType: type, ratingValue }, timestamp: at(days) };
}

function booking(status = "Pending") {
    return { _id: "booking-1", bookingDetails: {
        childId: "child-1", activityId: "activity-1", status, bookedAt: at(0)
    }, attendance: { status: "Attended", checkedInAt: at(1) } };
}

function current(interest = 0.70, confidence = 0.60) {
    return { childId: "child-1", subcategoryId: "subcategory-1",
        interestScore: { currentScore: interest, previousScore: interest, lastCalculatedAt: at(0), lastDecayAt: at(0) },
        confidence: { currentScore: confidence, evidenceCount: 4, lastCalculatedAt: at(0) },
        evidenceSummary: { interactionBreakdown: [{ interactionType: "Rate", count: 4 }] },
        scoreHistory: [{ eventId: "prior", eventType: "Rate", timestamp: at(0) }],
        metadata: { version: 1, createdAt: at(-10), createdBy: "Original", updatedAt: at(0), lastSyncedToGraph: at(-1) }
    };
}

function history(exact = false) {
    return { _id: "job-1", jobType: "ContinuousLearning", status: "COMPLETED", outcome: "APPLIED",
        idempotencyKey: exact ? "interaction:interaction-1:View" : "different-event",
        event: { eventType: "View", childId: "child-1", activityId: "activity-1", occurredAt: at(1) } };
}

const field = (record, path) => path.split(".").reduce((value, key) => value?.[key], record);

function fixture() {
    const records = { children: [{ _id: "child-1" }],
        activities: [{ _id: "activity-1", classification: { subcategoryId: "subcategory-1" } }],
        subcategories: [{ _id: "subcategory-1" }], bookings: [booking()], ai_jobs: [] };
    const f = { records, forbiddenAccesses: [] };
    f.db = { collection(name) {
        assert(Object.hasOwn(records, name), `Unexpected collection: ${name}`);
        const readOnly = { async findOne(query, options = {}) {
            const matches = records[name].filter((record) => Object.entries(query).every(([key, expected]) => {
                const actual = field(record, key);
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
                for (const [key, direction] of Object.entries(options.sort)) {
                    if (field(a, key) < field(b, key)) return -direction;
                    if (field(a, key) > field(b, key)) return direction;
                }
                return 0;
            });
            return matches[0] ?? null;
        } };
        // No write APIs or Neo4j adapter: even attempted unsupported access fails.
        assert.deepStrictEqual(Object.keys(readOnly), ["findOne"]);
        return new Proxy(readOnly, { get(target, key) {
            if (!(key in target)) {
                f.forbiddenAccesses.push(String(key));
                throw new Error(`Forbidden database method: ${String(key)}`);
            }
            return target[key];
        } });
    } };
    return f;
}

// Test-only composition, with sequential state handoff for multi-event bookings.
async function pipeline(sourceType, raw, suppliedCurrentState, f = fixture()) {
    const before = structuredClone(suppliedCurrentState);
    const rawBefore = structuredClone(raw);
    const recordsBefore = structuredClone(f.records);
    const results = await processLearningSource(sourceType, raw, { db: f.db });
    let state = suppliedCurrentState;
    let d7dCalls = 0, d7eCalls = 0;
    const rows = [];
    for (const result of results) {
        const dBefore = d7dCalls, eBefore = d7eCalls;
        let instruction = null, calculation = null;
        if (result.status === "VALID") {
            d7dCalls += 1;
            instruction = getLearningInstruction(result.event);
            if (instruction.status === "APPLICABLE") {
                const eventBefore = structuredClone(result.event);
                const instructionBefore = structuredClone(instruction);
                d7eCalls += 1;
                calculation = calculateNextInterestState(state, instruction, result.event);
                assert.deepStrictEqual(result.event, eventBefore);
                assert.deepStrictEqual(instruction, instructionBefore);
                if (calculation.status === "APPLIED") state = calculation.state;
            } else {
                assert.strictEqual(d7eCalls, eBefore);
            }
        } else {
            assert.strictEqual(d7dCalls, dBefore);
            assert.strictEqual(d7eCalls, eBefore);
        }
        rows.push({ result, instruction, calculation });
    }
    assert.deepStrictEqual(suppliedCurrentState, before);
    assert.deepStrictEqual(raw, rawBefore);
    assert.deepStrictEqual(f.records, recordsBefore);
    assert.deepStrictEqual(f.forbiddenAccesses, []);
    return { rows, d7dCalls, d7eCalls };
}

function applied(run, index = 0) {
    const row = run.rows[index];
    assert.strictEqual(row.result.status, "VALID");
    assert.strictEqual(row.instruction.status, "APPLICABLE");
    assert.strictEqual(row.calculation.status, "APPLIED");
    assert.strictEqual(row.calculation.error, null);
    assert.strictEqual(row.calculation.state.childId, "child-1");
    assert.strictEqual(row.calculation.state.subcategoryId, "subcategory-1");
    return row.calculation.state;
}

function values(state, interest, confidence, evidence) {
    close(state.interestScore.currentScore, interest);
    close(state.confidence.currentScore, confidence);
    assert.strictEqual(state.confidence.evidenceCount, evidence);
}

async function main() {
    let cases = 0;
    // 1–2: new View and verified Attend.
    for (const type of ["View", "Attend"]) {
        const run = await pipeline(type === "View" ? "Interaction" : "Booking",
            type === "View" ? interaction() : booking(), null);
        assert.strictEqual(run.rows.length, 1);
        assert.strictEqual(run.d7dCalls, 1);
        assert.strictEqual(run.d7eCalls, 1);
        const state = applied(run);
        values(state, type === "View" ? 0.51 : 0.60, type === "View" ? 0.205 : 0.24, 1);
        assert.strictEqual(state.interestScore.previousScore, 0.50);
        assert.deepStrictEqual(state.evidenceSummary.interactionBreakdown, [{ interactionType: type, count: 1 }]);
        assert.strictEqual(state.scoreHistory.length, 1);
        cases += 1;
    }
    // 3–6: Save, negative evidence, neutral rating, and upper-bound Rate 5.
    for (const [type, initial, rating, interest, confidence] of [
        ["Save", current(), 5, 0.75, 0.62], ["Dismiss", current(0.4), 5, 0.35, 0.62],
        ["Rate", current(0.65), 3, 0.65, 0.63], ["Rate", current(0.97, 0.98), 5, 1, 1]
    ]) {
        const run = await pipeline("Interaction", interaction(type, 1, rating), initial);
        const state = applied(run);
        values(state, interest, confidence, 5);
        assert.strictEqual(state.interestScore.previousScore, initial.interestScore.currentScore);
        assert.strictEqual(state.scoreHistory.length, initial.scoreHistory.length + 1);
        assert.deepStrictEqual(state.scoreHistory[0], initial.scoreHistory[0]);
        assert.deepStrictEqual(state.metadata.createdAt, initial.metadata.createdAt);
        assert.strictEqual(state.evidenceSummary.interactionBreakdown.find((item) => item.interactionType === type).count, type === "Rate" ? 5 : 1);
        if (type === "Rate") assert.deepStrictEqual(run.rows[0].instruction.learning, {
            interestDelta: rating === 3 ? 0 : 0.10, confidenceDelta: rating === 3 ? 0.03 : 0.05, evidenceIncrement: 1
        });
        cases += 1;
    }
    // 7: one outstanding decay cycle precedes Click learning; checkpoint is day 60.
    const decay = await pipeline("Interaction", interaction("Click", 65), current());
    const decayed = applied(decay);
    assert.strictEqual(decay.rows[0].calculation.transition.decayCycles, 1);
    close(decayed.interestScore.previousScore, 0.70 * 0.98);
    close(decayed.scoreHistory.at(-1).previousConfidence, 0.60 * 0.99);
    values(decayed, 0.70 * 0.98 + 0.02, 0.60 * 0.99 + 0.01, 5);
    assert.deepStrictEqual(decayed.interestScore.lastDecayAt, at(60));
    cases += 1;
    // 8: the decay floor is not a global score floor.
    const floor = applied(await pipeline("Interaction", interaction("Dismiss", 65), current(0.10, 0.10)));
    assert.strictEqual(floor.interestScore.previousScore, 0.10);
    values(floor, 0.05, 0.12, 5);
    cases += 1;
    // 9: Attend clamps both scores.
    values(applied(await pipeline("Booking", booking(), current(0.97, 0.98))), 1, 1, 5);
    cases += 1;
    // 10–12: blocked D7C results never invoke either learning stage.
    for (const [kind, status, reason] of [["duplicate", "IGNORED", "DUPLICATE_EVENT"],
        ["repeat", "IGNORED", "REPEAT_LIMIT_REACHED"], ["missing", "REJECTED", "CHILD_NOT_FOUND"]]) {
        const f = fixture();
        if (kind === "missing") f.records.children = [];
        else f.records.ai_jobs.push(history(kind === "duplicate"));
        const run = await pipeline("Interaction", interaction(), current(), f);
        assert.strictEqual(run.rows[0].result.status, status);
        assert.strictEqual(run.rows[0].result.reasonCode, reason);
        assert.strictEqual(run.d7dCalls, 0);
        assert.strictEqual(run.d7eCalls, 0);
        assert.strictEqual(run.rows[0].instruction, null);
        assert.strictEqual(run.rows[0].calculation, null);
        cases += 1;
    }
    // 13: independent Book and Attend instructions, sequential in-memory states.
    const f = fixture();
    const raw = booking("Confirmed");
    f.records.bookings = [structuredClone(raw)];
    const both = await pipeline("Booking", raw, null, f);
    assert.deepStrictEqual(both.rows.map((row) => row.result.event.eventType), ["Book", "Attend"]);
    assert.strictEqual(both.d7dCalls, 2);
    assert.strictEqual(both.d7eCalls, 2);
    values(applied(both, 0), 0.58, 0.23, 1);
    const final = applied(both, 1);
    values(final, 0.68, 0.27, 2);
    close(final.interestScore.previousScore, 0.58);
    assert.deepStrictEqual(final.evidenceSummary.interactionBreakdown, [{ interactionType: "Book", count: 1 }, { interactionType: "Attend", count: 1 }]);
    assert.deepStrictEqual(final.scoreHistory.map((item) => item.eventType), ["Book", "Attend"]);
    cases += 1;
    // 14: valid operational evidence can still be out of order for learned state.
    const later = current();
    later.scoreHistory.push({ timestamp: at(2) });
    const older = await pipeline("Interaction", interaction(), later);
    assert.strictEqual(older.rows[0].result.status, "VALID");
    assert.strictEqual(older.d7eCalls, 1);
    assert.deepStrictEqual(older.rows[0].calculation, {
        status: "NOT_APPLIED", reasonCode: "OUT_OF_ORDER_EVENT", state: later, transition: null, error: null
    });
    assert.strictEqual(older.rows[0].calculation.state, later);
    cases += 1;
    // 15: output mutation cannot modify supplied state; input immutability is also
    // asserted on every invocation above.
    const initial = current();
    const before = structuredClone(initial);
    const isolated = applied(await pipeline("Interaction", interaction("Save"), initial));
    isolated.scoreHistory[0].eventId = "changed";
    isolated.evidenceSummary.interactionBreakdown[0].count = 999;
    isolated.metadata.createdAt.setUTCFullYear(2000);
    assert.deepStrictEqual(initial, before);
    cases += 1;
    assert.strictEqual(cases, 15);
    console.log("D7 interest learning pipeline tests: PASSED (15 cases)");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
