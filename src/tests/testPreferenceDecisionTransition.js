const assert = require("assert");
const { ObjectId } = require("mongodb");
const { inspect } = require("util");
const { normalizeParentDecision } = require("../learning/eventNormalizer");
const { calculateNextPreferences: calculate } = require("../learning/preferenceDecisionTransition");
function event(value = "Outdoor", time = "2026-09-20") {
    return normalizeParentDecision({ _id: new ObjectId(), parentId: new ObjectId(), childId: new ObjectId(),
        decisionType: "PreferenceUpdated", decisionData: { dimension: "environment", value }, occurredAt: new Date(time) });
}
const historical = () => ({ value: "OldCategory", confidenceScore: 0.65, source: "Onboarding", updatedAt: new Date("2027-01-01") });
function run(state, e = event()) {
    const before = inspect({ state, e }, { depth: null });
    const result = calculate(state, e);
    assert(!(result instanceof Promise));
    assert.strictEqual(inspect({ state, e }, { depth: null }), before);
    assert.strictEqual(inspect(calculate(state, e), { depth: null }), inspect(result, { depth: null }));
    return result;
}
for (const state of [undefined, null, {}, { difficulty: { value: "HistoricalOther" } }]) {
    const e = event(), result = run(state, e);
    assert.strictEqual(result.status, "APPLIED"); assert.strictEqual(result.previousState, null);
    assert.deepStrictEqual(result.nextState, { value: "Outdoor", confidenceScore: 1, source: "Parent", updatedAt: e.occurredAt });
    assert.deepStrictEqual(Object.keys(result.nextPreferences).sort(), [...Object.keys(state ?? {}), "environment"].sort());
    if (state?.difficulty) assert.deepStrictEqual(result.nextPreferences.difficulty, state.difficulty);
}
for (const source of ["Onboarding", "Migration", "HistoricalOther"]) {
    const old = { ...historical(), source }, result = run({ environment: old });
    assert.strictEqual(result.status, "APPLIED"); assert.deepStrictEqual(result.previousState, old);
}
const same = run({ environment: { ...historical(), value: "Indoor" } }, event("Indoor"));
assert.strictEqual(same.status, "APPLIED"); assert.strictEqual(same.nextState.confidenceScore, 1);
const parent = { value: "Indoor", confidenceScore: 1, source: "Parent", updatedAt: new Date("2026-09-19") };
for (const value of ["Indoor", "Outdoor"]) assert.strictEqual(run({ environment: parent }, event(value)).status, "APPLIED");
for (const time of ["2026-09-18", "2026-09-19"]) {
    const r = run({ environment: parent }, event("Outdoor", time));
    assert.strictEqual(r.reasonCode, "OUT_OF_ORDER_PARENT_DECISION"); assert.strictEqual(r.nextPreferences, null); assert(!r.stateChanged);
}
for (const field of ["value", "confidenceScore", "source", "updatedAt"]) {
    const badValues = field === "value" ? [null, undefined, "", " ", [], {}, 1] :
        field === "confidenceScore" ? [undefined, -1, 1.1, NaN, Infinity, "1"] :
        field === "source" ? [undefined, "", " ", null, {}] : [undefined, null, "2026-09-01", new Date(NaN)];
    for (const value of badValues) assert.strictEqual(run({ environment: { ...historical(), [field]: value } }).reasonCode, "INVALID_EXISTING_PREFERENCE_STATE");
}
for (const state of [[], "bad", 1, new Date(), { environment: null }, { environment: [] }]) {
    assert.strictEqual(run(state).reasonCode, "INVALID_EXISTING_PREFERENCE_STATE");
}
const state = { environment: historical(), socialStyle: { arbitrary: { old: true }, updatedAt: new Date("2020-01-01") } };
const e = event(), result = run(state, e);
assert.deepStrictEqual(result.nextPreferences.socialStyle, state.socialStyle);
result.nextPreferences.socialStyle.arbitrary.old = false;
result.previousState.updatedAt.setFullYear(2000);
result.nextState.updatedAt.setFullYear(2000);
assert.strictEqual(state.socialStyle.arbitrary.old, true);
assert.strictEqual(state.environment.updatedAt.getFullYear(), 2027);
assert.strictEqual(e.occurredAt.getFullYear(), 2026);
assert.strictEqual(run({}, { ...event(), occurredAt: "bad" }).reasonCode, "INVALID_TIMESTAMP");
console.log("Preference decision transition unit tests: PASSED");
