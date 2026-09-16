const assert = require("assert");
const { validateEvent } = require("../learning/eventValidator");
const { normalizeInteraction, normalizeBooking } = require("../learning/eventNormalizer");

const TYPES = ["View", "Click", "Save", "Unsave", "Dismiss", "Rate", "Book", "Attend"];

function makeEvent(eventType = "View") {
    const isBooking = eventType === "Book" || eventType === "Attend";
    return {
        eventId: "event-1",
        eventType,
        childId: "child-1",
        activityId: "activity-1",
        subcategoryId: null,
        sessionId: null,
        bookingId: isBooking ? "event-1" : null,
        source: isBooking ? "Booking" : "Interaction",
        eventData: { ratingValue: eventType === "Rate" ? 1 : null },
        context: { recommendationId: null, surface: null },
        occurredAt: new Date("2026-09-16T10:00:00.000Z"),
        processing: {
            idempotencyKey: `${isBooking ? "booking" : "interaction"}:event-1:${eventType}`
        }
    };
}

function expectResult(event, reasonCode = "VALID_EVENT") {
    const actual = validateEvent(event);
    assert.deepStrictEqual(actual, {
        status: reasonCode === "VALID_EVENT" ? "VALID" : "REJECTED",
        reasonCode,
        retryable: false,
        event,
        error: null
    });
    assert.strictEqual(actual.event, event);
}

function testValidEvents() {
    for (const type of TYPES) expectResult(makeEvent(type));
    for (const rating of [1, 2, 3, 4, 5]) {
        const event = makeEvent("Rate");
        event.eventData.ratingValue = rating;
        expectResult(event);
    }
    const event = makeEvent();
    event.occurredAt = "2026-09-16T10:00:00.000Z";
    event.processing.idempotencyKey = "opaque-key";
    expectResult(event);
    assert.strictEqual(event.occurredAt, "2026-09-16T10:00:00.000Z");
    assert.strictEqual(event.processing.idempotencyKey, "opaque-key");
}

function testRequiredStrings() {
    for (const [field, reason] of [
        ["eventId", "MISSING_EVENT_ID"],
        ["childId", "MISSING_CHILD_ID"],
        ["activityId", "MISSING_ACTIVITY_ID"],
        ["source", "MISSING_SOURCE"]
    ]) {
        for (const value of [undefined, null, "", " \t ", 42, {}, []]) {
            expectResult({ ...makeEvent(), [field]: value }, reason);
        }
        const event = makeEvent();
        delete event[field];
        expectResult(event, reason);
    }
    for (const type of ["Complete", "Unknown", "view", undefined, null, "", {}, 1]) {
        expectResult({ ...makeEvent(), eventType: type }, "UNSUPPORTED_EVENT_TYPE");
    }
}

function testSourcesAndBookingIds() {
    for (const type of TYPES) {
        const event = makeEvent(type);
        event.source = event.source === "Booking" ? "Interaction" : "Booking";
        expectResult(event, "INVALID_EVENT_SOURCE");
        event.source = "Unknown";
        expectResult(event, "INVALID_EVENT_SOURCE");

        const isBooking = type === "Book" || type === "Attend";
        for (const value of [undefined, "", "  ", 1, {}, [], ...(isBooking ? [null] : ["booking-1"])]) {
            expectResult({ ...makeEvent(type), bookingId: value },
                isBooking ? "MISSING_BOOKING_ID" : "INVALID_EVENT_DATA");
        }
    }
}

function testProcessingAndTimestamps() {
    for (const processing of [undefined, null, {}, [], "key", 1, { idempotencyKey: null },
        { idempotencyKey: "" }, { idempotencyKey: "  " }, { idempotencyKey: 1 }]) {
        expectResult({ ...makeEvent(), processing }, "MISSING_IDEMPOTENCY_KEY");
    }
    for (const occurredAt of [undefined, null, "", "  ", "invalid", new Date("invalid"), 0, {}, []]) {
        expectResult({ ...makeEvent(), occurredAt }, "INVALID_TIMESTAMP");
    }
}

function testEventData() {
    for (const type of TYPES) {
        for (const eventData of [undefined, null, [], "rating", 5]) {
            expectResult({ ...makeEvent(type), eventData }, "INVALID_EVENT_DATA");
        }
        if (type !== "Rate") {
            for (const ratingValue of [undefined, 0, 5, "5", NaN]) {
                expectResult({ ...makeEvent(type), eventData: { ratingValue } }, "INVALID_EVENT_DATA");
            }
        }
    }
    for (const ratingValue of [null, undefined, 0, 6, 2.5, "5", NaN, Infinity, true]) {
        expectResult({ ...makeEvent("Rate"), eventData: { ratingValue } }, "INVALID_RATING");
    }
}

function testMalformedEventsAndOrder() {
    for (const event of [null, undefined, [], "event", 42, false]) {
        expectResult(event, "INVALID_EVENT_DATA");
    }
    expectResult({}, "MISSING_EVENT_ID");
    expectResult({ eventId: "id" }, "UNSUPPORTED_EVENT_TYPE");
    const event = makeEvent("Rate");
    event.childId = null;
    event.occurredAt = null;
    event.eventData.ratingValue = 0;
    expectResult(event, "MISSING_CHILD_ID");
    expectResult(event, "MISSING_CHILD_ID");
    event.childId = "child-1";
    expectResult(event, "INVALID_TIMESTAMP");
}

function testNoMutation() {
    for (const type of TYPES) {
        for (const invalid of [false, true]) {
            const event = makeEvent(type);
            const before = makeEvent(type);
            if (invalid) {
                event.eventData.ratingValue = "invalid";
                before.eventData.ratingValue = "invalid";
            }
            Object.freeze(event.eventData);
            Object.freeze(event.context);
            Object.freeze(event.processing);
            Object.freeze(event);
            validateEvent(event);
            assert.deepStrictEqual(event, before);
        }
    }
}

function testNormalizerIntegration() {
    expectResult(normalizeInteraction({
        _id: "interaction-1",
        actor: { childId: "child-1" },
        targetEntity: { entityType: "Activity", entityId: "activity-1" },
        interactionDetails: { interactionType: "View" },
        timestamp: new Date("2026-09-16T10:00:00.000Z")
    }));
    const events = normalizeBooking({
        _id: "booking-1",
        bookingDetails: {
            childId: "child-1", activityId: "activity-1", status: "Confirmed",
            bookedAt: new Date("2026-09-15T10:00:00.000Z")
        },
        attendance: { status: "CheckedOut", checkedOutAt: "2026-09-16T11:00:00.000Z" }
    });
    assert.deepStrictEqual(events.map((event) => event.eventType), ["Book", "Attend"]);
    for (const event of events) expectResult(event);
}

function main() {
    testValidEvents();
    testRequiredStrings();
    testSourcesAndBookingIds();
    testProcessingAndTimestamps();
    testEventData();
    testMalformedEventsAndOrder();
    testNoMutation();
    testNormalizerIntegration();
    console.log("Event validator unit tests: PASSED");
}

main();
