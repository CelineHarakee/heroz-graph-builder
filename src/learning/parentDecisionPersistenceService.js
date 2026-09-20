const { ObjectId } = require("mongodb");
const { isDeepStrictEqual } = require("util");
const { validateParentDecisionEvent, canonicalParentDecisionId: id } = require("./parentDecisionContract");
const { validateLearningComponents } = require("./learningComponentContract");
const { calculateNextPreferences } = require("./preferenceDecisionTransition");
const { calculateNextParentGoals } = require("./goalDecisionTransition");
const { Guard, copy, mongo, sourceSnapshot, completion, checkSource, sourceJobQuery, exactJobQuery,
    checkExactCompletion, orderingTarget, checkpointQuery, checkpointSort, checkOrdering } = require("./parentDecisionPersistenceContract");
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
        checkSource(storedSource, snapshot);
        // Source-wide lookup detects changed type even though it changes the event key.
        const prior = await jobs.findOne(sourceJobQuery(snapshot), options);
        if (prior) completion(prior, event, snapshot);
        const exact = await jobs.findOne(exactJobQuery(event), options);
        checkExactCompletion(exact, event, snapshot);
        const children = db.collection("children");
        const child = await children.findOne({ _id: snapshot.childId }, options);
        const parent = await db.collection("parents").findOne({ _id: snapshot.parentId }, options);
        if (!child || !parent || id(child.parentId) !== event.parentId) throw new Guard("INVALID_PARENT_AUTHORITY");
        const preference = event.eventType === "PreferenceUpdated", dimension = event.eventData.dimension;
        const component = preference ? "preference" : "goals";
        const target = orderingTarget(event);
        const latest = await jobs.findOne(checkpointQuery(snapshot, target), { ...options, sort: checkpointSort() });
        checkOrdering(latest, event);
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
