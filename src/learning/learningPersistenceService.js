const { ObjectId } = require("mongodb");
const { isDeepStrictEqual } = require("util");
const { toMongoId, toGraphId } = require("../utils/idUtils");

class PersistenceGuard extends Error {
    constructor(reasonCode) {
        super(reasonCode);
        this.reasonCode = reasonCode;
    }
}

function copy(value) {
    if (value instanceof ObjectId) return new ObjectId(value);
    if (value instanceof Date) return new Date(value.getTime());
    if (Array.isArray(value)) return value.map(copy);
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copy(item)]));
    }
    return value;
}

function date(value) {
    const ms = value instanceof Date ? value.getTime()
        : typeof value === "string" && value.trim() ? Date.parse(value) : NaN;
    if (!Number.isFinite(ms)) throw new PersistenceGuard("INVALID_TIMESTAMP");
    return new Date(ms);
}

function mongoIdentity(value) {
    const id = toMongoId(value);
    if (!(id instanceof ObjectId)) throw new PersistenceGuard("INVALID_IDENTITY");
    return id;
}

function prepareState(nextState, event) {
    if (!nextState || !nextState.interestScore || !nextState.confidence || !nextState.metadata ||
        !Array.isArray(nextState.scoreHistory) || !Array.isArray(nextState.evidenceSummary?.interactionBreakdown)) {
        throw new PersistenceGuard("INVALID_NEXT_STATE");
    }
    const state = copy(nextState);
    for (const key of ["childId", "subcategoryId"]) {
        if (toGraphId(state[key]) !== toGraphId(event[key])) throw new PersistenceGuard("IDENTITY_MISMATCH");
        state[key] = mongoIdentity(event[key]);
    }
    for (const [object, key] of [
        [state.interestScore, "lastCalculatedAt"], [state.interestScore, "lastDecayAt"],
        [state.confidence, "lastCalculatedAt"], [state.metadata, "createdAt"], [state.metadata, "updatedAt"]
    ]) object[key] = date(object[key]);
    if (state.metadata.lastSyncedToGraph != null) state.metadata.lastSyncedToGraph = date(state.metadata.lastSyncedToGraph);
    for (const entry of state.scoreHistory) {
        if (!entry || typeof entry !== "object") throw new PersistenceGuard("INVALID_NEXT_STATE");
        entry.timestamp = date(entry.timestamp);
    }
    for (const value of [state.interestScore.currentScore, state.confidence.currentScore]) {
        if (!Number.isFinite(value) || value < 0 || value > 1) throw new PersistenceGuard("INVALID_NEXT_STATE");
    }
    if (!Number.isSafeInteger(state.confidence.evidenceCount) || state.confidence.evidenceCount < 0) {
        throw new PersistenceGuard("INVALID_NEXT_STATE");
    }
    return state;
}

function uniqueConstraint(error, name, keys) {
    if (error?.code !== 11000) return false;
    return isDeepStrictEqual(error.keyPattern, keys) ||
        (typeof error.message === "string" && error.message.includes(`index: ${name} `));
}

/**
 * Persist one trusted, pre-calculated transition. Requires initialized indexes
 * and a db belonging to client. Does not connect, recalculate or retry.
 * Returns APPLIED, IGNORED, NOT_APPLIED or FAILED with reasonCode/retryable/error;
 * state is returned only after a successful commit.
 * Existing non-COMPLETED jobs are left to later lifecycle/recovery orchestration.
 */
async function persistAppliedInterestLearning({ client, db, event, instruction, currentState, nextState }) {
    let session;
    const result = (status, reasonCode, retryable = false, error = null, state = null) =>
        ({ status, reasonCode, retryable, state, error });
    try {
        if (!event || typeof event.processing?.idempotencyKey !== "string" || !event.processing.idempotencyKey.trim()) {
            throw new PersistenceGuard("INVALID_EVENT");
        }
        if (instruction?.status !== "APPLICABLE") throw new PersistenceGuard("INVALID_INSTRUCTION");
        for (const key of ["eventId", "eventType", "childId", "activityId", "subcategoryId"]) {
            if (typeof event[key] !== "string" || !event[key].trim()) throw new PersistenceGuard("INVALID_EVENT");
            if (instruction[key] !== event[key]) throw new PersistenceGuard("IDENTITY_MISMATCH");
        }
        const occurredAt = date(event.occurredAt);
        const state = prepareState(nextState, event);
        const identity = { childId: state.childId, subcategoryId: state.subcategoryId };
        const exactKey = { jobType: "ContinuousLearning", idempotencyKey: event.processing.idempotencyKey };
        session = client.startSession();
        session.startTransaction({ readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });
        const options = { session };
        const jobs = db.collection("ai_jobs");
        const previousJob = await jobs.findOne(exactKey, options);
        if (previousJob) {
            if (previousJob.status === "COMPLETED") throw new PersistenceGuard("DUPLICATE_EVENT");
            if (previousJob.status === "PROCESSING") throw new PersistenceGuard("EVENT_ALREADY_PROCESSING");
            if (previousJob.status === "FAILED") throw new PersistenceGuard("RETRY_REQUIRES_ORCHESTRATION");
            throw new PersistenceGuard("INVALID_PROCESSING_STATE");
        }
        const interests = db.collection("child_interests");
        const stored = await interests.findOne(identity, options);
        if (!isDeepStrictEqual(stored ?? null, currentState ?? null)) {
            throw new PersistenceGuard("CONCURRENT_STATE_CHANGE");
        }
        const now = new Date();
        if (!stored) {
            state._id = new ObjectId();
            await interests.insertOne(state, options);
        } else {
            state._id = copy(stored._id);
            // Preserve unrelated stored fields; only replace the calculated fields.
            const fields = {
                interestScore: { ...copy(stored.interestScore), ...state.interestScore },
                confidence: { ...copy(stored.confidence), ...state.confidence },
                evidenceSummary: { ...copy(stored.evidenceSummary), ...state.evidenceSummary },
                scoreHistory: state.scoreHistory,
                metadata: { ...copy(stored.metadata), updatedAt: state.metadata.updatedAt }
            };
            fields.metadata.createdAt = date(fields.metadata.createdAt);
            if (fields.metadata.lastSyncedToGraph != null) fields.metadata.lastSyncedToGraph = date(fields.metadata.lastSyncedToGraph);
            const filter = {
                _id: stored._id, ...identity,
                "interestScore.currentScore": currentState.interestScore.currentScore,
                "confidence.currentScore": currentState.confidence.currentScore,
                "confidence.evidenceCount": currentState.confidence.evidenceCount,
                interestScore: stored.interestScore, confidence: stored.confidence,
                scoreHistory: stored.scoreHistory ?? { $exists: false },
                evidenceSummary: stored.evidenceSummary ?? { $exists: false },
                metadata: stored.metadata ?? { $exists: false }
            };
            const update = await interests.updateOne(filter, { $set: fields }, options);
            if (update.matchedCount !== 1) throw new PersistenceGuard("CONCURRENT_STATE_CHANGE");
            Object.assign(state, copy(stored), fields);
        }
        await jobs.insertOne({
            _id: new ObjectId(), ...exactKey,
            source: { collection: event.source, documentId: event.eventId, eventType: event.eventType },
            status: "COMPLETED", outcome: "APPLIED",
            event: {
                eventType: event.eventType, childId: event.childId, activityId: event.activityId,
                subcategoryId: event.subcategoryId, bookingId: toGraphId(event.bookingId),
                sessionId: toGraphId(event.sessionId), occurredAt
            },
            processing: { completedAt: now },
            metadata: { version: 1, createdAt: now, updatedAt: now }
        }, options);
        await db.collection("graph_sync_queue").insertOne({
            _id: new ObjectId(), entityType: "ChildInterest", entityId: state._id,
            operation: stored ? "UPDATE" : "CREATE", status: "PENDING", createdAt: now
        }, options);
        await session.commitTransaction();
        return result("APPLIED", "INTEREST_LEARNING_PERSISTED", false, null, state);
    } catch (error) {
        if (session?.inTransaction()) {
            try { await session.abortTransaction(); } catch (abortError) {
                return result("FAILED", "DATABASE_ERROR", true, new AggregateError([error, abortError], "Persistence and abort failed"));
            }
        }
        if (uniqueConstraint(error, "uniq_learning_idempotency", { jobType: 1, idempotencyKey: 1 }) ||
            error.reasonCode === "DUPLICATE_EVENT") return result("IGNORED", "DUPLICATE_EVENT");
        if (uniqueConstraint(error, "uniq_child_interest", { childId: 1, subcategoryId: 1 }) ||
            error.code === 112 || error.reasonCode === "CONCURRENT_STATE_CHANGE") {
            return result("NOT_APPLIED", "CONCURRENT_STATE_CHANGE", true);
        }
        if (error instanceof PersistenceGuard) {
            return result(error.reasonCode === "EVENT_ALREADY_PROCESSING" ? "IGNORED" : "NOT_APPLIED", error.reasonCode);
        }
        return result("FAILED", "DATABASE_ERROR", true, error);
    } finally {
        if (session) await session.endSession();
    }
}

module.exports = { persistAppliedInterestLearning };
