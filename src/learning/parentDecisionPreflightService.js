const { validateParentDecisionEvent } = require("./parentDecisionContract");
const { Guard, sourceSnapshot, checkSource, sourceJobQuery, exactJobQuery, completion,
    checkExactCompletion, orderingTarget, checkpointQuery, checkpointSort, checkOrdering } = require("./parentDecisionPersistenceContract");

/** Read-only advisory gate, after D7C and before pure transition calculation.
 * No Child reads, writes, sessions or connections. Persistence MUST independently
 * repeat source/replay/order checks transactionally, along with authority and CAS.
 * Ignored state no-ops do not create checkpoints or absent-goal tombstones.
 */
async function checkParentDecisionPreflight({ db, event } = {}) {
    const result = (status, reasonCode, retryable = false) => ({ status, reasonCode, retryable });
    try {
        const validation = validateParentDecisionEvent(event);
        if (validation.status !== "VALID") throw new Guard(validation.reasonCode);
        const snapshot = sourceSnapshot(event);
        const source = await db.collection("parent_decisions").findOne({ _id: snapshot.decisionId });
        checkSource(source, snapshot);
        const jobs = db.collection("ai_jobs");
        const prior = await jobs.findOne(sourceJobQuery(snapshot));
        if (prior) completion(prior, event, snapshot);
        const exact = await jobs.findOne(exactJobQuery(event));
        checkExactCompletion(exact, event, snapshot);
        const latest = await jobs.findOne(checkpointQuery(snapshot, orderingTarget(event)), { sort: checkpointSort() });
        checkOrdering(latest, event);
        return result("ELIGIBLE", "PARENT_DECISION_PREFLIGHT_PASSED");
    } catch (error) {
        if (error instanceof Guard) {
            return result(["DUPLICATE_EVENT", "EVENT_ALREADY_PROCESSING"].includes(error.reasonCode) ? "IGNORED" :
                error.reasonCode === "INVALID_PROCESSING_STATE" ? "FAILED" : "NOT_APPLIED", error.reasonCode);
        }
        return result("FAILED", "DATABASE_ERROR", true);
    }
}
module.exports = { checkParentDecisionPreflight };
