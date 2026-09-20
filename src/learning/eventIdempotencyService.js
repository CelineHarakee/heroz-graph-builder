const { validateLearningComponents } = require("./learningComponentContract");
/**
 * Read-only exact-event check. Does not acquire locks or recover stale jobs.
 * This check alone cannot guarantee exactly-once learning: later D7H persistence
 * must retain the idempotency key with the learning transition so a crash before
 * ai_jobs completion cannot cause the same delta to be applied twice.
 */
async function checkEventIdempotency(event, options = {}) {
    function result(status, reasonCode, retryable = false, error = null) {
        return { status, reasonCode, retryable, event, error };
    }

    const key = event?.processing?.idempotencyKey;
    if (typeof key !== "string" || key.trim().length === 0) {
        return result("REJECTED", "MISSING_IDEMPOTENCY_KEY");
    }

    try {
        const db = options.db || require("../config/mongodb").getDatabase();
        if (!db) throw new Error("MongoDB database is unavailable");

        const job = await db.collection("ai_jobs").findOne({
            jobType: "ContinuousLearning",
            idempotencyKey: key
        });

        if (job == null) return result("VALID", "IDEMPOTENCY_CLEAR");
        if (job.status === "COMPLETED" && Object.hasOwn(job, "components") &&
            (job.outcome !== "APPLIED" || validateLearningComponents(event.eventType, job.components).status !== "VALID")) {
            return result("FAILED", "INVALID_PROCESSING_STATE");
        }
        if (job.status === "COMPLETED" && ["APPLIED", "IGNORED"].includes(job.outcome)) {
            return result("IGNORED", "DUPLICATE_EVENT");
        }
        if (job.status === "FAILED") return result("VALID", "IDEMPOTENCY_RETRY_ALLOWED");
        if (job.status === "PROCESSING") return result("IGNORED", "EVENT_ALREADY_PROCESSING");
        return result("FAILED", "INVALID_PROCESSING_STATE");
    } catch (error) {
        return result("FAILED", "DATABASE_ERROR", true, error);
    }
}

module.exports = { checkEventIdempotency };
