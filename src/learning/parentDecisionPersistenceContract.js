const { ObjectId } = require("mongodb");
const { isDeepStrictEqual } = require("util");
const { normalizeParentDecision } = require("./eventNormalizer");
const { validateParentDecisionEvent, canonicalParentDecisionId: id } = require("./parentDecisionContract");
const { validateLearningComponents } = require("./learningComponentContract");

// Pure shared contract. No database access; callers own read/transaction scope.
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

function checkSource(storedSource, snapshot) {
    if (!storedSource) throw new Guard("PARENT_DECISION_SOURCE_MISSING");
    const normalized = normalizeParentDecision(storedSource);
    if (validateParentDecisionEvent(normalized).status !== "VALID" ||
        !isDeepStrictEqual(sourceSnapshot(normalized), snapshot)) throw new Guard("PARENT_DECISION_SOURCE_CONFLICT");
}
function sourceJobQuery(snapshot) {
    return { jobType: "ContinuousLearning", "audit.source": "ParentDecision", "audit.decisionId": snapshot.decisionId };
}
function exactJobQuery(event) {
    return { jobType: "ContinuousLearning", idempotencyKey: event.processing.idempotencyKey };
}
function checkExactCompletion(exact, event, snapshot) {
    if (!exact) return;
    // Preserve the existing component-less historical completion contract.
    if (exact.status === "COMPLETED" && !Object.hasOwn(exact, "components") && ["APPLIED", "IGNORED"].includes(exact.outcome)) throw new Guard("DUPLICATE_EVENT");
    if (exact.status === "FAILED") throw new Guard("RETRY_REQUIRES_ORCHESTRATION");
    if (exact.status === "PROCESSING") throw new Guard("EVENT_ALREADY_PROCESSING");
    completion(exact, event, snapshot);
}
function orderingTarget(event) {
    return event.eventType === "PreferenceUpdated" ? { type: "preference", key: event.eventData.dimension }
        : { type: "goal", key: id(event.eventData.goalId) };
}
function checkpointQuery(snapshot, target) {
    return { jobType: "ContinuousLearning", status: "COMPLETED", resultStatus: "APPLIED", outcome: "APPLIED",
        "audit.source": "ParentDecision", "audit.childId": snapshot.childId,
        "audit.target.type": target.type, "audit.target.key": target.key };
}
function checkpointSort() { return { "audit.occurredAt": -1, _id: -1 }; }
function checkOrdering(latest, event) {
    if (!latest) return;
    if (!(latest.audit.occurredAt instanceof Date) || !Number.isFinite(latest.audit.occurredAt.getTime())) throw new Guard("INVALID_PROCESSING_STATE");
    if (event.occurredAt.getTime() <= latest.audit.occurredAt.getTime()) throw new Guard("OUT_OF_ORDER_PARENT_DECISION");
}
module.exports = { Guard, copy, mongo, sourceSnapshot, completion, checkSource, sourceJobQuery, exactJobQuery,
    checkExactCompletion, orderingTarget, checkpointQuery, checkpointSort, checkOrdering };
