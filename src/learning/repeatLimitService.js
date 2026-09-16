const PASSIVE_TYPES = new Set(["View", "Click", "Dismiss"]);
const TRANSITION_TYPES = new Set(["Save", "Unsave"]);
const UNCAPPED_TYPES = new Set(["Book", "Attend", "Rate"]);

/**
 * Read-only evaluation after structural/reference validation and idempotency.
 * History contract: ai_jobs.event stores normalized string IDs and occurredAt
 * as a BSON Date. Only COMPLETED/APPLIED ContinuousLearning jobs contribute.
 * This query does not reserve a contribution or implement atomic persistence.
 */
async function evaluateRepeatLimit(event, options = {}) {
    function result(status, reasonCode, retryable = false, error = null) {
        return { status, reasonCode, retryable, event, error };
    }
    const type = event?.eventType;
    if (UNCAPPED_TYPES.has(type)) return result("VALID", "REPEAT_LIMIT_CLEAR");
    if (!PASSIVE_TYPES.has(type) && !TRANSITION_TYPES.has(type)) {
        return result("REJECTED", "UNSUPPORTED_EVENT_TYPE");
    }

    const value = event.occurredAt;
    const timestamp = value instanceof Date ? value.getTime()
        : typeof value === "string" && value.trim() ? Date.parse(value) : NaN;
    if (!Number.isFinite(timestamp)) return result("REJECTED", "INVALID_TIMESTAMP");
    const occurredAt = new Date(timestamp);

    try {
        const db = options.db || require("../config/mongodb").getDatabase();
        if (!db) throw new Error("MongoDB database is unavailable");
        const query = {
            jobType: "ContinuousLearning",
            status: "COMPLETED",
            outcome: "APPLIED",
            "event.childId": event.childId,
            "event.activityId": event.activityId
        };

        if (PASSIVE_TYPES.has(type)) {
            const dayStart = new Date(timestamp);
            dayStart.setUTCHours(0, 0, 0, 0);
            query["event.eventType"] = type;
            query["event.occurredAt"] = { $gte: dayStart, $lte: occurredAt };
            const prior = await db.collection("ai_jobs").findOne(query);
            return prior ? result("IGNORED", "REPEAT_LIMIT_REACHED")
                : result("VALID", "REPEAT_LIMIT_CLEAR");
        }

        query["event.eventType"] = { $in: ["Save", "Unsave"] };
        query["event.occurredAt"] = { $lt: occurredAt };
        // _id provides a deterministic tie-break for equal prior occurrence times.
        const prior = await db.collection("ai_jobs").findOne(query, {
            sort: { "event.occurredAt": -1, _id: -1 }
        });
        const previousType = prior?.event?.eventType;
        if (previousType === type || (!prior && type === "Unsave")) {
            return result("IGNORED", "NO_STATE_TRANSITION");
        }
        return result("VALID", "REPEAT_LIMIT_CLEAR");
    } catch (error) {
        return result("FAILED", "DATABASE_ERROR", true, error);
    }
}

module.exports = { evaluateRepeatLimit };
