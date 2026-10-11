const { ObjectId } = require("mongodb");
const { toMongoId } = require("../utils/idUtils");
const { ApiError } = require("../api/apiError");
const { processContinuousLearningSource } = require("../learning/continuousLearningService");

const COMPLETED_SUPPRESSIONS = new Set(["REPEAT_LIMIT_REACHED", "NO_STATE_TRANSITION", "DUPLICATE_EVENT"]);

async function submitInteraction(childId, input, options = {}) {
    const db = options.db || require("../config/mongodb").getDatabase();
    const source = {
        _id: new ObjectId(),
        actor: { childId: toMongoId(childId) },
        targetEntity: { entityId: toMongoId(input.activityId) },
        interactionDetails: {
            interactionType: input.interactionType,
            ...(input.interactionType === "Rate" ? { ratingValue: input.ratingValue } : {})
        },
        timestamp: new Date()
    };
    // Source insertion is outside D7's learning transaction. A rejected/failed
    // evaluation may leave this record stored; no rollback is attempted.
    // Every new submission gets a new ID. We do not retry internally or dedupe
    // payloads; deliberate source reprocessing must reuse this canonical source.
    await db.collection("interactions").insertOne(source);
    const processSource = options.processContinuousLearningSource || processContinuousLearningSource;
    const response = await processSource("Interaction", source, { db, client: options.client ?? db.client });
    if (response?.status !== "COMPLETED" || response.sourceType !== "Interaction" ||
        !Array.isArray(response.results) || response.results.length !== 1) {
        throw new Error("Unexpected learning response");
    }
    const result = response.results[0];
    if (result?.eventId !== String(source._id) || result.eventType !== source.interactionDetails.interactionType) {
        throw new Error("Learning result identity mismatch");
    }
    const applied = result.status === "APPLIED" && result.reasonCode === "INTEREST_LEARNING_PERSISTED";
    const suppressed = result.status === "IGNORED" && COMPLETED_SUPPRESSIONS.has(result.reasonCode);
    if (applied || suppressed) return { interactionId: String(source._id), status: "RECORDED" };
    if (result.reasonCode === "EVENT_ALREADY_PROCESSING" || result.reasonCode === "RETRY_REQUIRES_ORCHESTRATION") {
        throw new ApiError(409, "INTERACTION_STATE_CONFLICT", "Interaction processing is not complete.");
    }
    if (result.status === "REJECTED") {
        throw new ApiError(400, "INTERACTION_REJECTED", "Interaction could not be accepted.");
    }
    throw new Error("Interaction learning did not complete successfully");
}

module.exports = { submitInteraction };
