const { ObjectId } = require("mongodb");
const { toMongoId, toGraphId } = require("../utils/idUtils");
const identity = (v) => v instanceof ObjectId || (typeof v === "string" && v.trim().length > 0);
const key = (v) => toGraphId(toMongoId(v));

/** Read-only context for a trusted, D7C-verified Attend. Never opens a connection. */
async function resolveOutcomeLearningContext(event, options = {}) {
    const result = (status, reasonCode) => ({ status, reasonCode });
    if (!event || typeof event !== "object" || Array.isArray(event)) return result("REJECTED", "INVALID_EVENT");
    if (event.eventType !== "Attend") return result("NOT_APPLICABLE", "UNSUPPORTED_OUTCOME_EVENT");
    if (!identity(event.activityId)) return result("REJECTED", "INVALID_EVENT");
    try {
        const db = options.db || require("../config/mongodb").getDatabase();
        const activity = await db.collection("activities").findOne({ _id: toMongoId(event.activityId) });
        if (!activity || !Array.isArray(activity.learningOutcomes)) return result("REJECTED", "INVALID_OUTCOME_MAPPING");
        const outcomeIds = [];
        const seen = new Set();
        for (const mapping of activity.learningOutcomes) {
            if (!mapping || Array.isArray(mapping) || !identity(mapping.outcomeId)) return result("REJECTED", "INVALID_OUTCOME_MAPPING");
            const id = key(mapping.outcomeId);
            if (seen.has(id)) return result("REJECTED", "DUPLICATE_OUTCOME_MAPPING");
            seen.add(id);
            outcomeIds.push(id);
        }
        if (!outcomeIds.length) return result("NOT_APPLICABLE", "NO_MAPPED_OUTCOMES");
        for (const id of outcomeIds) {
            const reference = await db.collection("learning_outcomes").findOne({ _id: toMongoId(id) });
            if (!reference || !identity(reference._id) || key(reference._id) !== id || reference.isActive !== true) {
                return result("REJECTED", "INVALID_OUTCOME_MAPPING");
            }
        }
        // Canonical IDs are all the reference information the pure layer needs.
        return { status: "APPLICABLE", reasonCode: "VALID_OUTCOME_CONTEXT", activityId: key(event.activityId), outcomeIds };
    } catch (_) {
        return { status: "FAILED", reasonCode: "DATABASE_ERROR", retryable: true };
    }
}
module.exports = { resolveOutcomeLearningContext };
