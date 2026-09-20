const { ObjectId } = require("mongodb");
const { toMongoId, toGraphId } = require("../utils/idUtils");
const identity = (v) => v instanceof ObjectId || (typeof v === "string" && v.trim().length > 0);
const key = (v) => toGraphId(toMongoId(v));

/** Pure exposure instruction. D7C verification is a caller precondition. */
function getOutcomeLearningInstruction(event, context) {
    const reject = (reasonCode) => ({ status: "NOT_APPLICABLE", reasonCode });
    if (!event || typeof event !== "object" || Array.isArray(event)) return reject("INVALID_EVENT");
    if (event.eventType !== "Attend") return reject("UNSUPPORTED_OUTCOME_EVENT");
    const timestamp = event.occurredAt instanceof Date ? event.occurredAt.getTime() :
        typeof event.occurredAt === "string" ? Date.parse(event.occurredAt) : NaN;
    if (!["eventId", "childId", "activityId", "bookingId"].every((field) => identity(event[field])) || !Number.isFinite(timestamp)) return reject("INVALID_EVENT");
    if (!context || typeof context !== "object" || Array.isArray(context)) return reject("INVALID_CONTEXT");
    if (context.status === "NOT_APPLICABLE" && context.reasonCode === "NO_MAPPED_OUTCOMES") return reject("NO_MAPPED_OUTCOMES");
    if (context.status !== "APPLICABLE" || !identity(context.activityId) || key(context.activityId) !== key(event.activityId) ||
        !Array.isArray(context.outcomeIds) || !context.outcomeIds.every(identity)) return reject("INVALID_CONTEXT");
    const outcomeIds = context.outcomeIds.map(key);
    if (new Set(outcomeIds).size !== outcomeIds.length) return reject("INVALID_CONTEXT");
    if (!outcomeIds.length) return reject("NO_MAPPED_OUTCOMES");
    return {
        status: "APPLICABLE", reasonCode: "OUTCOME_LEARNING_RULE_APPLIED",
        eventId: key(event.eventId), eventType: "Attend", childId: key(event.childId), activityId: key(event.activityId),
        learning: { scoreDelta: 0.10, confidenceDelta: 0.05, evidenceIncrement: 1 }, outcomeIds,
        rule: { ruleType: "VERIFIED_ATTENDANCE_EXPOSURE", version: 1 }
    };
}
module.exports = { getOutcomeLearningInstruction };
