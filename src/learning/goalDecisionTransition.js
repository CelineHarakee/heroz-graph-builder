const { ObjectId } = require("mongodb");
const { canonicalParentDecisionId: identity, validateParentDecisionEvent } = require("./parentDecisionContract");
const record = (v) => v !== null && typeof v === "object" && !Array.isArray(v) &&
    (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const validDate = (v) => v instanceof Date && Number.isFinite(v.getTime());
const nonblank = (v) => typeof v === "string" && v.trim().length > 0;
function copy(v) {
    if (v instanceof ObjectId) return new ObjectId(v);
    if (v instanceof Date) return new Date(v.getTime());
    if (Array.isArray(v)) return v.map(copy);
    if (record(v)) return Object.fromEntries(Object.entries(v).map(([k, value]) => [k, copy(value)]));
    return v;
}
/** Pure goal changes; selectedAt is only a minimum ordering floor, not the last
 * priority-update timestamp. Ordering after updates/removals needs future audit
 * checkpoints. No tombstone is created for an ignored absent-goal removal.
 */
function calculateNextParentGoals(currentParentGoals, event) {
    const target = { goalId: identity(event?.eventData?.goalId) };
    let previousState = null;
    const stop = (status, reasonCode) => ({ status, reasonCode, target, previousState: copy(previousState),
        nextState: null, nextParentGoals: null, stateChanged: false });
    const validation = validateParentDecisionEvent(event);
    if (validation.status !== "VALID") return stop("NOT_APPLIED", validation.reasonCode);
    if (!["GoalSelected", "GoalRemoved", "GoalUpdated"].includes(event.eventType)) return stop("NOT_APPLIED", "UNSUPPORTED_DECISION_TYPE");
    if (currentParentGoals != null && !Array.isArray(currentParentGoals)) return stop("NOT_APPLIED", "INVALID_EXISTING_GOAL_STATE");
    const goals = currentParentGoals ?? [];
    const seen = new Set();
    for (const entry of goals) {
        if (!record(entry) || !identity(entry.goalId) || seen.has(identity(entry.goalId)) ||
            !Number.isInteger(entry.priority) || ![1, 2, 3].includes(entry.priority) ||
            !nonblank(entry.status) || !nonblank(entry.selectedBy) || !validDate(entry.selectedAt) ||
            !(entry.targetDate === null || validDate(entry.targetDate))) return stop("NOT_APPLIED", "INVALID_EXISTING_GOAL_STATE");
        seen.add(identity(entry.goalId));
    }
    const index = goals.findIndex((entry) => identity(entry.goalId) === target.goalId);
    previousState = index < 0 ? null : goals[index];
    let nextState, nextParentGoals, reasonCode;
    if (event.eventType === "GoalSelected") {
        if (previousState?.status === "Active") return stop("IGNORED", "DUPLICATE_GOAL_SELECTION");
        if (previousState) return stop("NOT_APPLIED", "GOAL_REACTIVATION_UNSUPPORTED");
        nextState = { goalId: new ObjectId(target.goalId), priority: event.eventData.priority,
            status: "Active", selectedBy: "Parent", selectedAt: new Date(event.occurredAt), targetDate: null };
        nextParentGoals = [...copy(goals), copy(nextState)];
        reasonCode = "GOAL_SELECTED";
    } else {
        if (!previousState || previousState.status !== "Active") return stop("IGNORED", "GOAL_NOT_SELECTED");
        if (event.occurredAt.getTime() <= previousState.selectedAt.getTime()) return stop("NOT_APPLIED", "OUT_OF_ORDER_PARENT_DECISION");
        if (event.eventType === "GoalRemoved") {
            nextState = null;
            nextParentGoals = copy(goals.filter((_, i) => i !== index));
            reasonCode = "GOAL_REMOVED";
        } else {
            if (previousState.priority === event.eventData.priority) return stop("IGNORED", "NO_GOAL_CHANGE");
            nextState = { ...copy(previousState), priority: event.eventData.priority };
            nextParentGoals = copy(goals);
            nextParentGoals[index] = copy(nextState);
            reasonCode = "GOAL_UPDATED";
        }
    }
    return { status: "APPLIED", reasonCode, target, previousState: copy(previousState), nextState, nextParentGoals, stateChanged: true };
}
module.exports = { calculateNextParentGoals };
