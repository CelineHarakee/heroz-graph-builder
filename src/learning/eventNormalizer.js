const { toGraphId } = require("../utils/idUtils");

const SUPPORTED_INTERACTION_TYPES = new Set([
    "View", "Click", "Save", "Unsave", "Dismiss", "Rate"
]);

/**
 * Structurally normalize an interaction without validating references or values.
 * Unsupported or missing types return null. Book and Attend require booking
 * evidence via normalizeBooking; Complete has no authoritative mapping yet.
 * Missing timestamps and Rate values are preserved for later validation.
 */
function normalizeInteraction(interaction) {
    const details = interaction?.interactionDetails;
    const eventType = details?.interactionType;

    if (!SUPPORTED_INTERACTION_TYPES.has(eventType)) {
        return null;
    }

    const eventId = toGraphId(interaction._id);
    const context = interaction.context;

    return {
        eventId,
        eventType,
        childId: toGraphId(interaction.actor?.childId),
        activityId: toGraphId(interaction.targetEntity?.entityId),
        subcategoryId: null,
        sessionId: toGraphId(context?.sessionId),
        bookingId: null,
        source: "Interaction",
        eventData: {
            ratingValue: eventType === "Rate" ? details.ratingValue : null
        },
        context: {
            recommendationId: toGraphId(context?.recommendationId),
            surface: context?.surface ?? null
        },
        occurredAt: interaction.timestamp,
        processing: {
            idempotencyKey: `interaction:${eventId}:${eventType}`
        }
    };
}

/**
 * Return zero, one or two events in Book-then-Attend order.
 * Booking and attendance statuses are independent source-evidence gates.
 * Missing attendance timestamps become null; other values await validation.
 * CheckedOut is attendance evidence only. Complete is never produced.
 */
function normalizeBooking(booking) {
    const details = booking?.bookingDetails;
    const attendance = booking?.attendance;
    const events = [];

    function makeEvent(eventType, occurredAt) {
        const eventId = toGraphId(booking?._id);

        return {
            eventId,
            eventType,
            childId: toGraphId(details?.childId),
            activityId: toGraphId(details?.activityId),
            subcategoryId: null,
            sessionId: toGraphId(details?.sessionId),
            bookingId: eventId,
            source: "Booking",
            eventData: { ratingValue: null },
            context: { recommendationId: null, surface: null },
            occurredAt,
            processing: {
                idempotencyKey: `booking:${eventId}:${eventType}`
            }
        };
    }

    if (details?.status === "Confirmed") {
        events.push(makeEvent("Book", details.bookedAt));
    }

    if (attendance?.status === "Attended" || attendance?.status === "CheckedOut") {
        events.push(makeEvent(
            "Attend",
            attendance.checkedInAt ?? attendance.checkedOutAt ?? null
        ));
    }

    return events;
}

/** No filtering of unsupported decisions: preserve them for controlled rejection.
 * Source records are trusted inputs; metadata remains on the source record.
 * Canonical event identity plus complete payload supports later integrity checks.
 */
function normalizeParentDecision(document) {
    const { canonicalParentDecisionId: id } = require("./parentDecisionContract");
    const canonicalOrOriginal = (value) => id(value) ?? value;
    const context = document?.context;
    const payload = document?.decisionData;
    return {
        eventId: canonicalOrOriginal(document?._id), eventType: document?.decisionType,
        parentId: canonicalOrOriginal(document?.parentId), childId: canonicalOrOriginal(document?.childId),
        activityId: null, subcategoryId: null, bookingId: null,
        sessionId: context?.sessionId == null ? null : canonicalOrOriginal(context.sessionId),
        source: "ParentDecision",
        eventData: payload && typeof payload === "object" && !Array.isArray(payload)
            ? { ...payload, ...(Object.hasOwn(payload, "goalId") ? { goalId: canonicalOrOriginal(payload.goalId) } : {}) } : payload,
        context: context == null ? { source: null, recommendationId: null, sessionId: null } :
            (typeof context === "object" && !Array.isArray(context) ? { ...context,
                source: context.source ?? null,
                recommendationId: context.recommendationId == null ? null : canonicalOrOriginal(context.recommendationId),
                sessionId: context.sessionId == null ? null : canonicalOrOriginal(context.sessionId) } : context),
        occurredAt: document?.occurredAt instanceof Date ? new Date(document.occurredAt) : document?.occurredAt,
        processing: { idempotencyKey: `parentDecision:${id(document?._id)}:${document?.decisionType}` }
    };
}
module.exports = { normalizeInteraction, normalizeBooking, normalizeParentDecision };
