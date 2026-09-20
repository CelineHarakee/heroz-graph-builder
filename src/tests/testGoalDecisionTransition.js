const assert = require("assert");
const { ObjectId } = require("mongodb");
const { inspect } = require("util");
const { normalizeParentDecision } = require("../learning/eventNormalizer");
const { calculateNextParentGoals: calculate } = require("../learning/goalDecisionTransition");
const goalId = new ObjectId(), otherId = new ObjectId();
function event(type = "GoalSelected", priority = 1, time = "2026-09-20") {
    return normalizeParentDecision({ _id: new ObjectId(), parentId: new ObjectId(), childId: new ObjectId(), decisionType: type,
        decisionData: { goalId, ...(type === "GoalRemoved" ? {} : { priority }) }, occurredAt: new Date(time) });
}
const entry = (extra = {}) => ({ goalId, priority: 1, status: "Active", selectedBy: "HistoricalParent",
    selectedAt: new Date("2026-09-19"), targetDate: new Date("2027-01-01"), extra: { preserved: true }, ...extra });
function run(state, e = event()) {
    const before = inspect({ state, e }, { depth: null });
    const result = calculate(state, e);
    assert(!(result instanceof Promise)); assert.deepStrictEqual(calculate(state, e), result);
    assert.strictEqual(inspect({ state, e }, { depth: null }), before);
    if (result.status !== "APPLIED") { assert.strictEqual(result.nextParentGoals, null); assert(!result.stateChanged); }
    return result;
}
for (const state of [undefined, null, []]) {
    const e = event(), result = run(state, e);
    assert.strictEqual(result.reasonCode, "GOAL_SELECTED");
    assert.deepStrictEqual(result.nextState, { goalId, priority: 1, status: "Active", selectedBy: "Parent", selectedAt: e.occurredAt, targetDate: null });
    assert(result.nextState.goalId instanceof ObjectId); assert.strictEqual(result.nextParentGoals.length, 1);
}
const unrelated = entry({ goalId: otherId });
const additional = run([unrelated]); assert.deepStrictEqual(additional.nextParentGoals[0], unrelated); assert.strictEqual(additional.nextParentGoals.length, 2);
assert.strictEqual(run([entry()], event("GoalSelected", 3, "2020-01-01")).reasonCode, "DUPLICATE_GOAL_SELECTION");
assert.strictEqual(run([entry({ status: "Inactive" })]).reasonCode, "GOAL_REACTIVATION_UNSUPPORTED");
const removed = run([unrelated, entry()], event("GoalRemoved"));
assert.strictEqual(removed.status, "APPLIED"); assert.strictEqual(removed.nextState, null);
assert.deepStrictEqual(removed.previousState, entry()); assert.deepStrictEqual(removed.nextParentGoals, [unrelated]);
for (const type of ["GoalRemoved", "GoalUpdated"]) {
    for (const state of [[], [entry({ status: "Inactive" })]]) assert.strictEqual(run(state, event(type, 2)).reasonCode, "GOAL_NOT_SELECTED");
    for (const time of ["2026-09-18", "2026-09-19"]) assert.strictEqual(run([entry()], event(type, 2, time)).reasonCode, "OUT_OF_ORDER_PARENT_DECISION");
}
for (const [from, to] of [[1, 2], [2, 3]]) {
    const old = entry({ priority: from }), result = run([old, unrelated], event("GoalUpdated", to));
    assert.strictEqual(result.status, "APPLIED"); assert.deepStrictEqual(result.nextState, { ...old, priority: to });
    assert.deepStrictEqual(result.nextParentGoals[1], unrelated);
}
assert.strictEqual(run([entry()], event("GoalUpdated", 1)).reasonCode, "NO_GOAL_CHANGE");
for (const state of ["bad", {}, 1, [entry(), entry({ goalId: String(goalId).toUpperCase() })], [null]]) {
    assert.strictEqual(run(state).reasonCode, "INVALID_EXISTING_GOAL_STATE");
}
for (const [field, values] of Object.entries({ goalId: [undefined, "bad", null], priority: [undefined, 0, 4, 1.5, "1", NaN],
    status: [undefined, "", null, 1], selectedBy: [undefined, " ", null], selectedAt: [undefined, "2026-09-19", new Date(NaN)],
    targetDate: [undefined, "2027-01-01", new Date(NaN)] })) {
    for (const value of values) assert.strictEqual(run([entry({ [field]: value })]).reasonCode, "INVALID_EXISTING_GOAL_STATE");
}
assert.strictEqual(run([entry({ goalId: otherId, priority: 9 })]).reasonCode, "INVALID_EXISTING_GOAL_STATE");
const old = entry(), e = event("GoalUpdated", 2), result = run([old], e);
result.nextState.extra.preserved = false; result.nextParentGoals[0].selectedAt.setFullYear(2000); result.previousState.targetDate.setFullYear(2000);
assert(old.extra.preserved); assert.strictEqual(old.selectedAt.getFullYear(), 2026); assert.strictEqual(old.targetDate.getFullYear(), 2027);
assert.strictEqual(e.occurredAt.getFullYear(), 2026);
const storedString = entry({ goalId: String(goalId) });
assert.strictEqual(run([storedString], event("GoalUpdated", 2)).nextState.goalId, String(goalId));
console.log("Goal decision transition unit tests: PASSED");
