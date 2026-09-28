const {
    D1_COVERAGE,
    D1_EVALUATION_STATUS,
    D1_RESOLVER,
    D1_SUFFICIENCY
} = require("./knowledgeGapConstants");
const { toGraphId } = require("../utils/idUtils");

const INTERACTION_EVENT_TYPES = new Set([
    "View",
    "Click",
    "Save",
    "Unsave",
    "Dismiss",
    "Rate"
]);

function sameId(left, right) {
    return toGraphId(left) === toGraphId(right);
}

function timestampMs(value) {
    const ms = value instanceof Date ? value.getTime()
        : typeof value === "string" && value.trim() ? Date.parse(value) : NaN;
    return Number.isFinite(ms) ? ms : null;
}

function sourceId(record) {
    return toGraphId(record?._id);
}

function isValidRating(value) {
    return Number.isInteger(value) && value >= 1 && value <= 5;
}

function eventBase({ record, eventType, occurredAt, sourceCollection }) {
    return {
        eventId: sourceId(record),
        eventType,
        occurredAt: occurredAt ?? null,
        sourceCollection
    };
}

function interactionEvents(bundle) {
    const childId = bundle?.evaluation?.childId;
    const activityId = bundle?.evaluation?.activityId;
    const events = [];

    for (const interaction of bundle?.interactions ?? []) {
        const eventType = interaction?.interactionDetails?.interactionType;
        if (!INTERACTION_EVENT_TYPES.has(eventType)) continue;
        if (!sameId(interaction?.actor?.childId, childId)) continue;
        if (interaction?.targetEntity?.entityType !== "Activity") continue;
        if (!sameId(interaction?.targetEntity?.entityId, activityId)) continue;
        if (eventType === "Rate" && !isValidRating(interaction?.interactionDetails?.ratingValue)) continue;

        events.push({
            ...eventBase({
                record: interaction,
                eventType,
                occurredAt: interaction.timestamp,
                sourceCollection: "interactions"
            }),
            ratingValue: eventType === "Rate" ? interaction.interactionDetails.ratingValue : null
        });
    }

    return events;
}

function bookingEvents(bundle) {
    const childId = bundle?.evaluation?.childId;
    const activityId = bundle?.evaluation?.activityId;
    const events = [];

    for (const booking of bundle?.bookings ?? []) {
        const details = booking?.bookingDetails;
        if (!sameId(details?.childId, childId)) continue;
        if (!sameId(details?.activityId, activityId)) continue;

        if (details?.status === "Confirmed") {
            events.push({
                ...eventBase({
                    record: booking,
                    eventType: "Book",
                    occurredAt: details.bookedAt,
                    sourceCollection: "bookings"
                }),
                bookingId: sourceId(booking)
            });
        }

        if (booking?.attendance?.status === "Attended" || booking?.attendance?.status === "CheckedOut") {
            events.push({
                ...eventBase({
                    record: booking,
                    eventType: "Attend",
                    occurredAt: booking.attendance.checkedInAt ?? booking.attendance.checkedOutAt ?? null,
                    sourceCollection: "bookings"
                }),
                bookingId: sourceId(booking)
            });
        }
    }

    return events;
}

function directEvents(bundle) {
    return [...interactionEvents(bundle), ...bookingEvents(bundle)];
}

function compareEventOrder(left, right) {
    const leftTime = timestampMs(left.occurredAt);
    const rightTime = timestampMs(right.occurredAt);

    if (leftTime !== rightTime) return leftTime - rightTime;
    return String(left.eventId).localeCompare(String(right.eventId));
}

function currentSavedState(events) {
    const stateEvents = events.filter((event) => event.eventType === "Save" || event.eventType === "Unsave");
    if (!stateEvents.length) return { status: "MISSING", saved: null };

    if (stateEvents.some((event) => timestampMs(event.occurredAt) === null || !event.eventId)) {
        return { status: "UNKNOWN", saved: null };
    }

    const latest = [...stateEvents].sort(compareEventOrder).at(-1);
    return {
        status: "RESOLVED",
        saved: latest.eventType === "Save",
        eventType: latest.eventType,
        eventId: latest.eventId,
        occurredAt: latest.occurredAt
    };
}

function latestRating(events) {
    const ratings = events.filter((event) => event.eventType === "Rate" &&
        isValidRating(event.ratingValue) && timestampMs(event.occurredAt) !== null);
    if (!ratings.length) return { status: "MISSING", ratingValue: null };

    const latestTime = Math.max(...ratings.map((event) => timestampMs(event.occurredAt)));
    const latest = ratings.filter((event) => timestampMs(event.occurredAt) === latestTime);
    const values = new Set(latest.map((event) => event.ratingValue));

    if (values.size > 1) {
        return {
            status: "AMBIGUOUS",
            ratingValue: null,
            occurredAt: latest[0].occurredAt,
            candidates: latest
        };
    }

    return {
        status: "RESOLVED",
        ratingValue: latest[0].ratingValue,
        eventId: latest[0].eventId,
        occurredAt: latest[0].occurredAt
    };
}

function evaluateActivityFamiliarity(bundle) {
    if (bundle?.evaluation?.status && bundle.evaluation.status !== D1_EVALUATION_STATUS.RESOLVED) {
        return {
            target: {
                type: "Activity",
                activityId: bundle?.evaluation?.activityId ?? null
            },
            coverageState: D1_COVERAGE.MISSING,
            sufficiencyState: D1_SUFFICIENCY.BLOCKED,
            familiarityStatus: "UNKNOWN",
            reasons: ["EVALUATION_UNRESOLVABLE"],
            events: [],
            currentSavedState: { status: "MISSING", saved: null },
            latestRating: { status: "MISSING", ratingValue: null },
            possibleResolvers: []
        };
    }

    const events = directEvents(bundle);
    const established = events.length > 0;

    return {
        target: {
            type: "Activity",
            activityId: bundle?.evaluation?.activityId ?? null
        },
        coverageState: established ? D1_COVERAGE.AVAILABLE : D1_COVERAGE.MISSING,
        sufficiencyState: established ? D1_SUFFICIENCY.SUFFICIENT : D1_SUFFICIENCY.INSUFFICIENT,
        familiarityStatus: established ? "ESTABLISHED" : "MISSING",
        reasons: established ? [] : ["NO_ACTIVITY_HISTORY"],
        events,
        currentSavedState: currentSavedState(events),
        latestRating: latestRating(events),
        possibleResolvers: established ? [] : [D1_RESOLVER.CHILD_BEHAVIOR]
    };
}

module.exports = {
    evaluateActivityFamiliarity
};
