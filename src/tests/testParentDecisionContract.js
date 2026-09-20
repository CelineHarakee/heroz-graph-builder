const assert = require("assert");
const { ObjectId } = require("mongodb");
const { PREFERENCE_VALUES, validateParentDecisionPayload: validate } = require("../learning/parentDecisionContract");
const goalId = new ObjectId();
for (const [dimension, values] of Object.entries(PREFERENCE_VALUES)) {
    for (const value of values) assert.strictEqual(validate("PreferenceUpdated", { dimension, value }).status, "VALID");
    for (const value of [null, [], "", " ", values[0].toLowerCase(), 1, {}, "Unknown"]) assert.strictEqual(validate("PreferenceUpdated", { dimension, value }).reasonCode, "INVALID_PREFERENCE_VALUE");
}
assert.strictEqual(validate("PreferenceUpdated", { dimension: "environment", value: "Team" }).reasonCode, "INVALID_PREFERENCE_VALUE");
for (const dimension of [null, [], "Environment", "toString", "unknown"]) assert.strictEqual(validate("PreferenceUpdated", { dimension, value: "Indoor" }).reasonCode, "INVALID_PREFERENCE_DIMENSION");
for (const type of ["GoalSelected", "GoalUpdated"]) {
    for (const priority of [1, 2, 3]) assert.strictEqual(validate(type, { goalId, priority }).status, "VALID");
    for (const priority of [0, 4, 1.5, "1", null, undefined, NaN]) assert.strictEqual(validate(type, { goalId, priority }).reasonCode, "INVALID_GOAL_PRIORITY");
}
assert.strictEqual(validate("GoalRemoved", { goalId }).status, "VALID");
for (const type of ["GoalSelected", "GoalRemoved", "GoalUpdated"]) for (const id of [undefined, null, [], {}, "bad", " ", 12]) {
    assert.strictEqual(validate(type, { goalId: id, ...(type === "GoalRemoved" ? {} : { priority: 1 }) }).reasonCode, "INVALID_GOAL_REFERENCE");
}
for (const field of ["confidenceScore", "source", "selectedBy", "status", "selectedAt", "targetDate", "components", "state", "history", "graph"]) {
    for (const [type, payload] of [["PreferenceUpdated", { dimension: "environment", value: "Indoor" }], ["GoalSelected", { goalId, priority: 1 }]]) {
        assert.strictEqual(validate(type, { ...payload, [field]: true }).reasonCode, "INVALID_DECISION_PAYLOAD");
    }
}
for (const payload of [null, [], "bad", undefined]) assert.strictEqual(validate("GoalSelected", payload).reasonCode, "INVALID_DECISION_PAYLOAD");
assert.strictEqual(validate("GoalCompleted", {}).reasonCode, "UNSUPPORTED_DECISION_TYPE");
console.log("Parent decision contract unit tests: PASSED");
