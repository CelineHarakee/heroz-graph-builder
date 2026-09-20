const { DECISION_TYPES, validateParentDecisionEvent } = require("./parentDecisionContract");
const INTERACTION_TYPES = new Set([
    "View", "Click", "Save", "Unsave", "Dismiss", "Rate"
]);
const BOOKING_TYPES = new Set(["Book", "Attend"]);

function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isUsableString(value) {
    return typeof value === "string" && value.trim().length > 0;
}

function isValidTimestamp(value) {
    if (value instanceof Date) {
        return Number.isFinite(value.getTime());
    }
    return isUsableString(value) && Number.isFinite(Date.parse(value));
}

/**
 * Validate normalized structure only, without coercion, mutation or I/O.
 * First failure wins: event ID, type, child, activity, source, idempotency key,
 * timestamp, booking ID, eventData structure, then rating value.
 * Non-object inputs are INVALID_EVENT_DATA. Results retain the original event.
 */
function validateEvent(event) {
    function result(reasonCode) {
        return {
            status: reasonCode === "VALID_EVENT" ? "VALID" : "REJECTED",
            reasonCode,
            retryable: false,
            event,
            error: null
        };
    }

    if (event?.source === "ParentDecision" || DECISION_TYPES.includes(event?.eventType)) {
        const checked = validateParentDecisionEvent(event);
        return result(checked.status === "VALID" ? "VALID_EVENT" : checked.reasonCode);
    }
    if (!isRecord(event)) return result("INVALID_EVENT_DATA");
    if (!isUsableString(event.eventId)) return result("MISSING_EVENT_ID");

    const isBooking = BOOKING_TYPES.has(event.eventType);
    if (!isBooking && !INTERACTION_TYPES.has(event.eventType)) {
        return result("UNSUPPORTED_EVENT_TYPE");
    }
    if (!isUsableString(event.childId)) return result("MISSING_CHILD_ID");
    if (!isUsableString(event.activityId)) return result("MISSING_ACTIVITY_ID");
    if (!isUsableString(event.source)) return result("MISSING_SOURCE");
    if (event.source !== (isBooking ? "Booking" : "Interaction")) {
        return result("INVALID_EVENT_SOURCE");
    }
    if (!isRecord(event.processing) || !isUsableString(event.processing.idempotencyKey)) {
        return result("MISSING_IDEMPOTENCY_KEY");
    }
    if (!isValidTimestamp(event.occurredAt)) return result("INVALID_TIMESTAMP");
    if (isBooking && !isUsableString(event.bookingId)) return result("MISSING_BOOKING_ID");
    if (!isBooking && event.bookingId !== null) return result("INVALID_EVENT_DATA");
    if (!isRecord(event.eventData)) return result("INVALID_EVENT_DATA");

    const rating = event.eventData.ratingValue;
    if (event.eventType === "Rate") {
        if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
            return result("INVALID_RATING");
        }
    } else if (rating !== null) {
        return result("INVALID_EVENT_DATA");
    }

    return result("VALID_EVENT");
}

module.exports = { validateEvent };
