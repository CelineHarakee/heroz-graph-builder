const assert = require("assert");
const { ObjectId } = require("mongodb");
const { toGraphId } = require("../utils/idUtils");
const { normalizeInteraction, normalizeBooking } = require("../learning/eventNormalizer");
const { validateEvent } = require("../learning/eventValidator");
const { validateEventReferences } = require("../learning/eventReferenceValidator");

const ids = {
    child: "64f000000000000000000001",
    activity: "64f000000000000000000002",
    subcategory: "64f000000000000000000003",
    booking: "64f000000000000000000004",
    session: "64f000000000000000000005"
};

function fixture(type = "View") {
    const booking = {
        _id: new ObjectId(ids.booking),
        bookingDetails: {
            childId: new ObjectId(ids.child),
            activityId: new ObjectId(ids.activity),
            sessionId: new ObjectId(ids.session),
            status: "Confirmed",
            bookedAt: new Date("2026-09-15T10:00:00Z")
        },
        attendance: { status: "Attended", checkedInAt: new Date("2026-09-16T10:00:00Z") }
    };
    const event = ["Book", "Attend"].includes(type)
        ? normalizeBooking(booking).find((item) => item.eventType === type)
        : normalizeInteraction({
            _id: "interaction-1",
            actor: { childId: new ObjectId(ids.child) },
            targetEntity: { entityType: "Activity", entityId: new ObjectId(ids.activity) },
            interactionDetails: { interactionType: type, ratingValue: 5 },
            timestamp: new Date("2026-09-16T10:00:00Z")
        });
    const records = {
        children: { _id: new ObjectId(ids.child) },
        activities: {
            _id: new ObjectId(ids.activity),
            classification: { subcategoryId: new ObjectId(ids.subcategory) }
        },
        subcategories: { _id: new ObjectId(ids.subcategory) },
        bookings: booking
    };
    const calls = [];
    const db = {
        collection(name) {
            assert(Object.hasOwn(records, name), `Unexpected collection: ${name}`);
            return {
                async findOne(query) {
                    calls.push({ name, query });
                    assert.deepStrictEqual(Object.keys(query), ["_id"]);
                    const record = records[name];
                    return record && toGraphId(record._id) === toGraphId(query._id) ? record : null;
                }
            };
        }
    };
    return { event, booking, records, calls, db };
}

async function expectRejected(f, reasonCode) {
    const before = structuredClone(f.event);
    const result = await validateEventReferences(f.event, { db: f.db });
    assert.deepStrictEqual(result, {
        status: "REJECTED", reasonCode, retryable: false, event: f.event, error: null
    });
    assert.strictEqual(result.event, f.event);
    assert.deepStrictEqual(f.event, before);
}

async function testValidAndIntegration() {
    for (const type of ["View", "Click", "Save", "Unsave", "Dismiss", "Rate", "Book", "Attend"]) {
        const f = fixture(type);
        assert.strictEqual(validateEvent(f.event).status, "VALID");
        f.event.subcategoryId = "untrusted-subcategory";
        const before = structuredClone(f.event);
        const result = await validateEventReferences(f.event, { db: f.db });
        assert.deepStrictEqual(result, {
            status: "VALID", reasonCode: "VALID_REFERENCES", retryable: false,
            event: { ...before, subcategoryId: ids.subcategory }, error: null
        });
        assert.notStrictEqual(result.event, f.event);
        for (const key of ["context", "processing", "eventData", "occurredAt"]) {
            assert.notStrictEqual(result.event[key], f.event[key]);
        }
        result.event.context.surface = "changed";
        result.event.processing.idempotencyKey = "changed";
        result.event.eventData.ratingValue = 1;
        result.event.occurredAt.setUTCFullYear(2000);
        assert.deepStrictEqual(f.event, before);
        assert.deepStrictEqual(f.calls.map((call) => call.name),
            ["children", "activities", "subcategories", ...(["Book", "Attend"].includes(type) ? ["bookings"] : [])]);
        for (const call of f.calls) assert(call.query._id instanceof ObjectId);
    }
    const f = fixture("Book");
    for (const event of normalizeBooking(f.booking)) {
        assert.strictEqual(validateEvent(event).status, "VALID");
        const result = await validateEventReferences(event, { db: f.db });
        assert.strictEqual(result.status, "VALID");
        assert.strictEqual(result.event.subcategoryId, ids.subcategory);
    }
}

async function testMissingReferences() {
    for (const [collection, reason] of [
        ["children", "CHILD_NOT_FOUND"], ["activities", "ACTIVITY_NOT_FOUND"],
        ["subcategories", "SUBCATEGORY_NOT_FOUND"], ["bookings", "BOOKING_NOT_FOUND"]
    ]) {
        const f = fixture("Book");
        f.records[collection] = null;
        await expectRejected(f, reason);
        assert.strictEqual(f.calls.at(-1).name, collection);
    }
    for (const value of [undefined, null, "", "  ", {}, [], 0, false]) {
        const f = fixture();
        f.records.activities.classification.subcategoryId = value;
        await expectRejected(f, "ACTIVITY_SUBCATEGORY_MISSING");
        assert.strictEqual(f.calls.length, 2);
    }
    const f = fixture();
    delete f.records.activities.classification;
    await expectRejected(f, "ACTIVITY_SUBCATEGORY_MISSING");
}

async function testBookingConsistency() {
    for (const type of ["Book", "Attend"]) {
        for (const [field, reason] of [
            ["childId", "BOOKING_CHILD_MISMATCH"],
            ["activityId", "BOOKING_ACTIVITY_MISMATCH"],
            ["sessionId", "BOOKING_SESSION_MISMATCH"]
        ]) {
            const f = fixture(type);
            f.booking.bookingDetails[field] = "different-id";
            await expectRejected(f, reason);
        }
        for (const missingSide of ["event", "booking"]) {
            const f = fixture(type);
            if (missingSide === "event") f.event.sessionId = null;
            else delete f.booking.bookingDetails.sessionId;
            const result = await validateEventReferences(f.event, { db: f.db });
            assert.strictEqual(result.status, "VALID");
            assert.strictEqual(result.event.sessionId, f.event.sessionId);
        }
        const f = fixture(type);
        delete f.booking.bookingDetails;
        await expectRejected(f, "BOOKING_CHILD_MISMATCH");
    }
}

async function testOperationalEvidence() {
    for (const status of ["Pending", "Cancelled", null, undefined]) {
        const f = fixture("Book");
        f.booking.bookingDetails.status = status;
        await expectRejected(f, "BOOKING_NOT_CONFIRMED");
    }
    for (const status of ["NoShow", "Cancelled", "Unknown", null, undefined]) {
        const f = fixture("Attend");
        f.booking.attendance.status = status;
        await expectRejected(f, "ATTENDANCE_NOT_VERIFIED");
    }
    const missing = fixture("Attend");
    delete missing.booking.attendance;
    await expectRejected(missing, "ATTENDANCE_NOT_VERIFIED");
    for (const status of ["Attended", "CheckedOut"]) {
        const f = fixture("Attend");
        f.booking.attendance.status = status;
        const result = await validateEventReferences(f.event, { db: f.db });
        assert.strictEqual(result.status, "VALID");
        assert.strictEqual(result.event.eventType, "Attend");
        assert(!normalizeBooking(f.booking).some((event) => event.eventType === "Complete"));
    }
}

async function testDatabaseFailures() {
    for (const collection of ["children", "activities", "subcategories", "bookings"]) {
        const f = fixture("Book");
        const error = new Error("Database read failed");
        const db = { collection(name) {
            return name === collection ? { async findOne() { throw error; } } : f.db.collection(name);
        } };
        assert.deepStrictEqual(await validateEventReferences(f.event, { db }), {
            status: "FAILED", reasonCode: "DATABASE_ERROR", retryable: true, event: f.event, error
        });
    }
    // Stub configuration without loading credentials or constructing a real client.
    const configPath = require.resolve("../config/mongodb");
    const previous = require.cache[configPath];
    try {
        require.cache[configPath] = { exports: { getDatabase: () => undefined } };
        const f = fixture();
        const result = await validateEventReferences(f.event);
        assert.strictEqual(result.status, "FAILED");
        assert.strictEqual(result.reasonCode, "DATABASE_ERROR");
        assert.strictEqual(result.retryable, true);
        assert.strictEqual(result.event, f.event);
        assert(result.error instanceof Error);
        require.cache[configPath] = { exports: { getDatabase: () => f.db } };
        assert.strictEqual((await validateEventReferences(f.event)).status, "VALID");
    } finally {
        if (previous) require.cache[configPath] = previous;
        else delete require.cache[configPath];
    }
}

async function main() {
    await testValidAndIntegration();
    await testMissingReferences();
    await testBookingConsistency();
    await testOperationalEvidence();
    await testDatabaseFailures();
    console.log("Event reference validator unit tests: PASSED");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
