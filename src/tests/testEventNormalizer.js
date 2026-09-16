const assert = require("assert");
const { ObjectId } = require("mongodb");
const { normalizeInteraction, normalizeBooking } = require("../learning/eventNormalizer");

const IDS = {
    event: "64f000000000000000000001",
    child: "64f000000000000000000002",
    activity: "64f000000000000000000003",
    session: "64f000000000000000000004",
    recommendation: "64f000000000000000000005"
};

function makeInteraction(interactionType = "View") {
    return {
        _id: new ObjectId(IDS.event),
        actor: { childId: new ObjectId(IDS.child), actorType: "Child" },
        targetEntity: {
            entityType: "Activity",
            entityId: new ObjectId(IDS.activity)
        },
        interactionDetails: { interactionType, ratingValue: 4, durationSeconds: 12 },
        context: {
            surface: "recommendations",
            recommendationId: new ObjectId(IDS.recommendation),
            sessionId: new ObjectId(IDS.session)
        },
        timestamp: new Date("2026-09-16T10:00:00.000Z"),
        metadata: { version: 1 }
    };
}

function testSupportedTypes() {
    for (const eventType of ["View", "Click", "Save", "Unsave", "Dismiss", "Rate"]) {
        const input = makeInteraction(eventType);
        assert.deepStrictEqual(normalizeInteraction(input), {
            eventId: IDS.event,
            eventType,
            childId: IDS.child,
            activityId: IDS.activity,
            subcategoryId: null,
            sessionId: IDS.session,
            bookingId: null,
            source: "Interaction",
            eventData: { ratingValue: eventType === "Rate" ? 4 : null },
            context: {
                recommendationId: IDS.recommendation,
                surface: "recommendations"
            },
            occurredAt: input.timestamp,
            processing: { idempotencyKey: `interaction:${IDS.event}:${eventType}` }
        }, eventType);
    }
}

function testOptionalContext() {
    for (const context of [undefined, null, {}]) {
        const input = makeInteraction();
        input.context = context;
        const event = normalizeInteraction(input);
        assert.strictEqual(event.sessionId, null);
        assert.deepStrictEqual(event.context, { recommendationId: null, surface: null });
    }

    const input = makeInteraction();
    delete input.context;
    assert.strictEqual(normalizeInteraction(input).context.surface, null);
    input.context = { surface: "" };
    assert.strictEqual(normalizeInteraction(input).context.surface, "");
}

function testUnsupportedTypes() {
    for (const type of [
        "Book", "Attend", "Complete", "QuestionAnswered", "QuestionSkipped",
        "FeedbackSubmitted", "Share", "Unknown", "view", undefined, null
    ]) {
        const input = makeInteraction();
        input.interactionDetails.interactionType = type;
        assert.strictEqual(normalizeInteraction(input), null, String(type));
    }
    for (const input of [undefined, null, {}, { interactionDetails: null }]) {
        assert.strictEqual(normalizeInteraction(input), null);
    }
}

function testStringIdsAndDeterminism() {
    const input = makeInteraction();
    input._id = IDS.event;
    input.actor.childId = IDS.child;
    input.targetEntity.entityId = IDS.activity;
    input.context.sessionId = IDS.session;
    input.context.recommendationId = IDS.recommendation;
    assert.deepStrictEqual(normalizeInteraction(input), normalizeInteraction(makeInteraction()));
    assert.deepStrictEqual(normalizeInteraction(input), normalizeInteraction(input));
}

function testValidationIsDeferred() {
    const input = makeInteraction("Rate");
    for (const ratingValue of [0, 6, "invalid", null, undefined]) {
        input.interactionDetails.ratingValue = ratingValue;
        assert.strictEqual(normalizeInteraction(input).eventData.ratingValue, ratingValue);
    }
    for (const timestamp of [null, undefined, "invalid", new Date("invalid")]) {
        input.timestamp = timestamp;
        assert.strictEqual(normalizeInteraction(input).occurredAt, timestamp);
    }
    delete input.timestamp;
    assert.strictEqual(normalizeInteraction(input).occurredAt, undefined);
    delete input.actor;
    delete input.targetEntity;
    delete input._id;
    const event = normalizeInteraction(input);
    assert.strictEqual(event.eventId, null);
    assert.strictEqual(event.childId, null);
    assert.strictEqual(event.activityId, null);
}

function testInputNotMutated() {
    for (const type of ["View", "Click", "Save", "Unsave", "Dismiss", "Rate", "Book"]) {
        const input = makeInteraction(type);
        const before = makeInteraction(type);
        normalizeInteraction(input);
        assert.deepStrictEqual(input, before);
    }
}

function makeBooking(status = "Confirmed", attendanceStatus = "Attended") {
    return {
        _id: new ObjectId(IDS.event),
        bookingDetails: {
            childId: new ObjectId(IDS.child),
            activityId: new ObjectId(IDS.activity),
            sessionId: new ObjectId(IDS.session),
            status,
            bookedAt: new Date("2026-09-15T10:00:00.000Z")
        },
        attendance: {
            status: attendanceStatus,
            checkedInAt: new Date("2026-09-16T10:00:00.000Z"),
            checkedOutAt: new Date("2026-09-16T11:00:00.000Z")
        }
    };
}

function testBookingMapping() {
    const input = makeBooking();
    const events = normalizeBooking(input);
    assert.deepStrictEqual(events, ["Book", "Attend"].map((eventType) => ({
        eventId: IDS.event,
        eventType,
        childId: IDS.child,
        activityId: IDS.activity,
        subcategoryId: null,
        sessionId: IDS.session,
        bookingId: IDS.event,
        source: "Booking",
        eventData: { ratingValue: null },
        context: { recommendationId: null, surface: null },
        occurredAt: eventType === "Book"
            ? input.bookingDetails.bookedAt : input.attendance.checkedInAt,
        processing: { idempotencyKey: `booking:${IDS.event}:${eventType}` }
    })));
    assert.notStrictEqual(events[0].processing.idempotencyKey, events[1].processing.idempotencyKey);
    assert.deepStrictEqual(normalizeBooking(input), events);

    input._id = IDS.event;
    input.bookingDetails.childId = IDS.child;
    input.bookingDetails.activityId = IDS.activity;
    input.bookingDetails.sessionId = IDS.session;
    assert.deepStrictEqual(normalizeBooking(input), events);
}

function testBookingStatusCombinations() {
    for (const status of ["Confirmed", "Pending", "Cancelled", "Complete", "Unknown", null, undefined]) {
        for (const attendanceStatus of ["Attended", "CheckedOut", "NoShow", "Complete", "Unknown", null, undefined]) {
            const input = makeBooking();
            input.bookingDetails.status = status;
            input.attendance.status = attendanceStatus;
            const expectedTypes = [];
            if (status === "Confirmed") expectedTypes.push("Book");
            if (["Attended", "CheckedOut"].includes(attendanceStatus)) expectedTypes.push("Attend");
            const events = normalizeBooking(input);
            assert.deepStrictEqual(events.map((event) => event.eventType), expectedTypes);
            assert(!events.some((event) => event.eventType === "Complete"));
        }
    }
}

function testBookingTimestamps() {
    for (const status of ["Attended", "CheckedOut"]) {
        const input = makeBooking("Pending", status);
        assert.strictEqual(normalizeBooking(input)[0].occurredAt, input.attendance.checkedInAt);
        delete input.attendance.checkedInAt;
        assert.strictEqual(normalizeBooking(input)[0].occurredAt, input.attendance.checkedOutAt);
        input.attendance.checkedInAt = null;
        assert.strictEqual(normalizeBooking(input)[0].occurredAt, input.attendance.checkedOutAt);
        delete input.attendance.checkedOutAt;
        assert.strictEqual(normalizeBooking(input)[0].occurredAt, null);
        input.attendance.checkedOutAt = null;
        assert.strictEqual(normalizeBooking(input)[0].occurredAt, null);
    }

    const input = makeBooking();
    delete input.bookingDetails.bookedAt;
    assert.strictEqual(normalizeBooking(input)[0].occurredAt, undefined);
    for (const timestamp of [null, "invalid", 0, new Date("invalid")]) {
        input.bookingDetails.bookedAt = timestamp;
        input.attendance.checkedInAt = timestamp;
        const events = normalizeBooking(input);
        assert.strictEqual(events[0].occurredAt, timestamp);
        assert.strictEqual(events[1].occurredAt, timestamp ?? input.attendance.checkedOutAt);
    }
}

function testBookingMissingFields() {
    for (const input of [undefined, null, {}, { bookingDetails: null, attendance: null }]) {
        assert.deepStrictEqual(normalizeBooking(input), []);
    }
    const input = makeBooking();
    delete input.attendance;
    delete input.bookingDetails.sessionId;
    const events = normalizeBooking(input);
    assert.deepStrictEqual(events.map((event) => event.eventType), ["Book"]);
    assert.strictEqual(events[0].sessionId, null);

    const sparseEvent = normalizeBooking({ attendance: { status: "Attended" } })[0];
    assert.strictEqual(sparseEvent.eventType, "Attend");
    for (const key of ["eventId", "childId", "activityId", "sessionId", "bookingId", "occurredAt"]) {
        assert.strictEqual(sparseEvent[key], null);
    }
}

function testBookingInputNotMutated() {
    for (const status of ["Confirmed", "Pending", "Cancelled"]) {
        for (const attendanceStatus of ["Attended", "CheckedOut", "NoShow", "Unknown"]) {
            const input = makeBooking(status, attendanceStatus);
            const before = makeBooking(status, attendanceStatus);
            normalizeBooking(input);
            assert.deepStrictEqual(input, before);
        }
    }
}

function main() {
    testSupportedTypes();
    testOptionalContext();
    testUnsupportedTypes();
    testStringIdsAndDeterminism();
    testValidationIsDeferred();
    testInputNotMutated();
    testBookingMapping();
    testBookingStatusCombinations();
    testBookingTimestamps();
    testBookingMissingFields();
    testBookingInputNotMutated();
    console.log("Event normalizer unit tests: PASSED");
}

main();
