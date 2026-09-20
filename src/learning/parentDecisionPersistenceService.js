const { ObjectId } = require("mongodb");
const { isDeepStrictEqual } = require("util");
const { normalizeParentDecision } = require("./eventNormalizer");
const { validateParentDecisionEvent, canonicalParentDecisionId: id } = require("./parentDecisionContract");
const { validateLearningComponents } = require("./learningComponentContract");
const { calculateNextPreferences } = require("./preferenceDecisionTransition");
const { calculateNextParentGoals } = require("./goalDecisionTransition");
function copy(v) {
    if (v instanceof ObjectId) return new ObjectId(v);
    if (v instanceof Date) return new Date(v);
    if (Array.isArray(v)) return v.map(copy);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, copy(x)]));
    return v;
}
class Guard extends Error { constructor(reasonCode) { super(reasonCode); this.reasonCode = reasonCode; } }
const mongo = (v) => new ObjectId(id(v));
function sourceSnapshot(event) {
    return { decisionId: mongo(event.eventId), parentId: mongo(event.parentId), childId: mongo(event.childId),
        decisionType: event.eventType, decisionData: { ...copy(event.eventData),
            ...(event.eventData.goalId ? { goalId: mongo(event.eventData.goalId) } : {}) }, occurredAt: new Date(event.occurredAt) };
}
function completion(job, event, snapshot) {
    if (!isDeepStrictEqual(job.audit?.sourceSnapshot, snapshot)) throw new Guard("PARENT_DECISION_SOURCE_CONFLICT");
    if (job.status === "FAILED") throw new Guard("RETRY_REQUIRES_ORCHESTRATION");
    if (job.status === "PROCESSING") throw new Guard("EVENT_ALREADY_PROCESSING");
    if (job.status !== "COMPLETED" || job.outcome !== "APPLIED" || job.resultStatus !== "APPLIED" ||
        validateLearningComponents(event.eventType, job.components).status !== "VALID") throw new Guard("INVALID_PROCESSING_STATE");
    throw new Guard("DUPLICATE_EVENT");
}
/** Persistence only. Requires trusted stored source, configured db/client and
 * existing D7 indexes. Verifies (never substitutes) the supplied pure transition.
 * No-op decisions write nothing, including no ordering checkpoint/tombstone.
 */
async function persistParentDecision({ client, db, event, currentPreferences, currentParentGoals, transition }) {
    let session, snapshot, writingJob = false;
    const result = (status, reasonCode, retryable = false, extra = {}) => ({ status, reasonCode, retryable,
        eventId: event?.eventId ?? null, idempotencyKey: event?.processing?.idempotencyKey ?? null,
        queueIntentCreated: false, ...extra });
    const guardResult = (reason) => result(["DUPLICATE_EVENT", "EVENT_ALREADY_PROCESSING"].includes(reason) ? "IGNORED" :
        reason === "INVALID_PROCESSING_STATE" ? "FAILED" : "NOT_APPLIED", reason, reason === "CONCURRENT_STATE_CHANGE");
    try {
        const validation = validateParentDecisionEvent(event);
        if (validation.status !== "VALID") throw new Guard(validation.reasonCode);
        snapshot = sourceSnapshot(event);
        session = client.startSession();
        session.startTransaction({ readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });
        const options = { session }, jobs = db.collection("ai_jobs");
        const storedSource = await db.collection("parent_decisions").findOne({ _id: snapshot.decisionId }, options);
        if (!storedSource) throw new Guard("PARENT_DECISION_SOURCE_MISSING");
        const normalized = normalizeParentDecision(storedSource);
        if (validateParentDecisionEvent(normalized).status !== "VALID" || !isDeepStrictEqual(sourceSnapshot(normalized), snapshot)) throw new Guard("PARENT_DECISION_SOURCE_CONFLICT");
        // Source-wide lookup detects changed type even though it changes the event key.
        const prior = await jobs.findOne({ jobType: "ContinuousLearning", "audit.source": "ParentDecision", "audit.decisionId": snapshot.decisionId }, options);
        if (prior) completion(prior, event, snapshot);
        const exact = await jobs.findOne({ jobType: "ContinuousLearning", idempotencyKey: event.processing.idempotencyKey }, options);
        if (exact) {
            // Historical component-less successes keep the established duplicate rule.
            if (exact.status === "COMPLETED" && !Object.hasOwn(exact, "components") && ["APPLIED", "IGNORED"].includes(exact.outcome)) throw new Guard("DUPLICATE_EVENT");
            if (exact.status === "FAILED") throw new Guard("RETRY_REQUIRES_ORCHESTRATION");
            if (exact.status === "PROCESSING") throw new Guard("EVENT_ALREADY_PROCESSING");
            completion(exact, event, snapshot);
        }
        const children = db.collection("children");
        const child = await children.findOne({ _id: snapshot.childId }, options);
        const parent = await db.collection("parents").findOne({ _id: snapshot.parentId }, options);
        if (!child || !parent || id(child.parentId) !== event.parentId) throw new Guard("INVALID_PARENT_AUTHORITY");
        const preference = event.eventType === "PreferenceUpdated", dimension = event.eventData.dimension;
        const component = preference ? "preference" : "goals";
        const target = preference ? { type: "preference", key: dimension } : { type: "goal", key: id(event.eventData.goalId) };
        const latest = await jobs.findOne({ jobType: "ContinuousLearning", status: "COMPLETED", resultStatus: "APPLIED", outcome: "APPLIED",
            "audit.source": "ParentDecision", "audit.childId": snapshot.childId,
            "audit.target.type": target.type, "audit.target.key": target.key }, { ...options, sort: { "audit.occurredAt": -1, _id: -1 } });
        if (latest) {
            if (!(latest.audit.occurredAt instanceof Date) || !Number.isFinite(latest.audit.occurredAt.getTime())) throw new Guard("INVALID_PROCESSING_STATE");
            if (event.occurredAt.getTime() <= latest.audit.occurredAt.getTime()) throw new Guard("OUT_OF_ORDER_PARENT_DECISION");
        }
        let filter = { _id: child._id, parentId: child.parentId }, update;
        if (preference) {
            const present = (v) => v != null && Object.hasOwn(v, dimension);
            if (present(child.preferences) !== present(currentPreferences) ||
                !isDeepStrictEqual(child.preferences?.[dimension], currentPreferences?.[dimension])) throw new Guard("CONCURRENT_STATE_CHANGE");
            if (child.preferences != null && (typeof child.preferences !== "object" || Array.isArray(child.preferences))) throw new Guard("INVALID_EXISTING_PREFERENCE_STATE");
            const expected = calculateNextPreferences(currentPreferences, event);
            if (!isDeepStrictEqual(expected, transition)) throw new Guard("INVALID_TRANSITION");
            filter[`preferences.${dimension}`] = present(currentPreferences) ? currentPreferences[dimension] : { $exists: false };
            // Merge changes only the named dimension and safely initializes a null
            // container; unlike dotted $set it works with historical null preferences.
            update = [{ $set: { preferences: { $mergeObjects: [{ $ifNull: ["$preferences", {}] }, { $literal: { [dimension]: copy(transition.nextState) } }] } } }];
        } else {
            if (!isDeepStrictEqual(child.parentGoals, currentParentGoals)) throw new Guard("CONCURRENT_STATE_CHANGE");
            const goal = await db.collection("goal_library").findOne({ _id: mongo(event.eventData.goalId) }, options);
            if (!goal || (event.eventType === "GoalSelected" && goal.isActive !== true)) throw new Guard("INVALID_GOAL_REFERENCE");
            const expected = calculateNextParentGoals(currentParentGoals, event);
            if (!isDeepStrictEqual(expected, transition)) throw new Guard("INVALID_TRANSITION");
            filter.parentGoals = currentParentGoals === undefined ? { $exists: false } : currentParentGoals;
            update = { $set: { parentGoals: copy(transition.nextParentGoals) } };
        }
        if (transition.status !== "APPLIED") {
            await session.abortTransaction();
            return result(transition.status, transition.reasonCode);
        }
        const written = await children.updateOne(filter, update, options);
        if (written.matchedCount !== 1) throw new Guard("CONCURRENT_STATE_CHANGE");
        const now = new Date();
        const audit = { source: "ParentDecision", decisionId: snapshot.decisionId, decisionType: event.eventType,
            parentId: snapshot.parentId, childId: snapshot.childId, target,
            previousState: copy(transition.previousState), nextState: copy(transition.nextState),
            occurredAt: new Date(event.occurredAt), persistedAt: now, sourceSnapshot: snapshot };
        const components = { [component]: { status: "APPLIED", completedAt: now } };
        if (validateLearningComponents(event.eventType, components).status !== "VALID") throw new Guard("INVALID_PROCESSING_STATE");
        // The existing unique _id index also serializes different event types reusing
        // one ParentDecision ID. No second source-identity index is necessary.
        writingJob = true;
        await jobs.insertOne({ _id: snapshot.decisionId, jobType: "ContinuousLearning", idempotencyKey: event.processing.idempotencyKey,
            status: "COMPLETED", resultStatus: "APPLIED", outcome: "APPLIED", components, audit,
            event: { eventType: event.eventType, childId: event.childId, parentId: event.parentId, occurredAt: new Date(event.occurredAt) },
            processing: { completedAt: now }, metadata: { version: 1, createdAt: now, updatedAt: now } }, options);
        writingJob = false;
        if (!preference) await db.collection("graph_sync_queue").insertOne({ _id: new ObjectId(), entityType: "Child",
            entityId: child._id, operation: "UPDATE", status: "PENDING", createdAt: now }, options);
        await session.commitTransaction();
        return result("APPLIED", "PARENT_DECISION_PERSISTED", false, { component, audit: copy(audit), queueIntentCreated: !preference });
    } catch (error) {
        if (session?.inTransaction()) {
            try { await session.abortTransaction(); } catch (_) { return result("FAILED", "DATABASE_ERROR", true); }
        }
        if (error instanceof Guard) return guardResult(error.reasonCode);
        if (error.code === 112) return guardResult("CONCURRENT_STATE_CHANGE");
        if (error.code === 11000 && snapshot && writingJob) {
            try {
                const winner = await db.collection("ai_jobs").findOne({ _id: snapshot.decisionId });
                if (winner?.jobType === "ContinuousLearning") completion(winner, event, snapshot);
                const exact = await db.collection("ai_jobs").findOne({ jobType: "ContinuousLearning", idempotencyKey: event.processing.idempotencyKey });
                if (exact) completion(exact, event, snapshot);
                return result("FAILED", "INVALID_PROCESSING_STATE");
            } catch (raceError) {
                return raceError instanceof Guard ? guardResult(raceError.reasonCode) : result("FAILED", "DATABASE_ERROR", true);
            }
        }
        return result("FAILED", "DATABASE_ERROR", true);
    } finally {
        if (session) { try { await session.endSession(); } catch (_) { /* Never turn a committed mutation into an apparent failure. */ } }
    }
}
module.exports = { persistParentDecision };
