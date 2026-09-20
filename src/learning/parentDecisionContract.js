const { ObjectId } = require("mongodb");
const DECISION_TYPES = Object.freeze(["PreferenceUpdated", "GoalSelected", "GoalRemoved", "GoalUpdated"]);
const PREFERENCE_VALUES = Object.freeze({
    environment: Object.freeze(["Indoor", "Outdoor", "Mixed"]),
    socialStyle: Object.freeze(["Individual", "Team", "Mixed"]),
    difficulty: Object.freeze(["Beginner", "Intermediate", "Advanced"]),
    experienceStyle: Object.freeze(["Structured", "Creative", "Exploratory", "Mixed"]),
    commitmentPreference: Object.freeze(["OneTime", "Weekly"])
});
const record = (v) => v !== null && typeof v === "object" && !Array.isArray(v) &&
    (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
function canonicalParentDecisionId(value) {
    if (value instanceof ObjectId) return value.toHexString();
    return typeof value === "string" && /^[a-fA-F0-9]{24}$/.test(value) ? new ObjectId(value).toHexString() : null;
}
function validateParentDecisionPayload(type, payload) {
    const reject = (reasonCode) => ({ status: "REJECTED", reasonCode });
    if (!DECISION_TYPES.includes(type)) return reject("UNSUPPORTED_DECISION_TYPE");
    if (!record(payload)) return reject("INVALID_DECISION_PAYLOAD");
    const fields = type === "PreferenceUpdated" ? ["dimension", "value"] :
        type === "GoalRemoved" ? ["goalId"] : ["goalId", "priority"];
    if (Object.keys(payload).some((field) => !fields.includes(field))) return reject("INVALID_DECISION_PAYLOAD");
    if (type === "PreferenceUpdated") {
        if (typeof payload.dimension !== "string" || !Object.hasOwn(PREFERENCE_VALUES, payload.dimension)) return reject("INVALID_PREFERENCE_DIMENSION");
        if (!PREFERENCE_VALUES[payload.dimension].includes(payload.value)) return reject("INVALID_PREFERENCE_VALUE");
    } else {
        if (!canonicalParentDecisionId(payload.goalId)) return reject("INVALID_GOAL_REFERENCE");
        if (type !== "GoalRemoved" && (!Number.isInteger(payload.priority) || ![1, 2, 3].includes(payload.priority))) return reject("INVALID_GOAL_PRIORITY");
    }
    if (fields.some((field) => !Object.hasOwn(payload, field))) return reject("INVALID_DECISION_PAYLOAD");
    return { status: "VALID", reasonCode: "VALID_DECISION_PAYLOAD" };
}
/** Trusted source boundary only: relationship checks do not authenticate a caller.
 * Later decisions use confidence 1/source Parent; no transitions occur here.
 * Ignored removals of absent goals have no durable ordering tombstone in V1.
 */
function validateParentDecisionEvent(event) {
    const reject = (reasonCode) => ({ status: "REJECTED", reasonCode });
    if (!record(event)) return reject("INVALID_EVENT_DATA");
    if (!DECISION_TYPES.includes(event.eventType)) return reject("UNSUPPORTED_DECISION_TYPE");
    if (event.source !== "ParentDecision") return reject("INVALID_EVENT_SOURCE");
    for (const [field, reason] of [["eventId", "INVALID_EVENT_ID"], ["parentId", "INVALID_PARENT_AUTHORITY"], ["childId", "INVALID_PARENT_AUTHORITY"]]) {
        if (!canonicalParentDecisionId(event[field]) || event[field] !== canonicalParentDecisionId(event[field])) return reject(reason);
    }
    if (!(event.occurredAt instanceof Date) || !Number.isFinite(event.occurredAt.getTime())) return reject("INVALID_TIMESTAMP");
    if (event.activityId !== null || event.subcategoryId !== null || event.bookingId !== null) return reject("INVALID_EVENT_DATA");
    if (!record(event.context) || Object.keys(event.context).some((k) => !["source", "recommendationId", "sessionId"].includes(k)) ||
        !(event.context.source === null || (typeof event.context.source === "string" && event.context.source.trim().length > 0))) return reject("INVALID_DECISION_CONTEXT");
    for (const value of [event.sessionId, event.context.sessionId, event.context.recommendationId]) {
        if (value !== null && (!canonicalParentDecisionId(value) || value !== canonicalParentDecisionId(value))) return reject("INVALID_DECISION_CONTEXT");
    }
    if (event.sessionId !== event.context.sessionId) return reject("INVALID_DECISION_CONTEXT");
    if (!record(event.processing) || event.processing.idempotencyKey !== `parentDecision:${event.eventId}:${event.eventType}`) return reject("INVALID_IDEMPOTENCY_KEY");
    return validateParentDecisionPayload(event.eventType, event.eventData);
}
module.exports = { DECISION_TYPES, PREFERENCE_VALUES, canonicalParentDecisionId, validateParentDecisionPayload, validateParentDecisionEvent };
