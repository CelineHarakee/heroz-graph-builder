const assert = require("assert");
const { ObjectId } = require("mongodb");
const { getOutcomeLearningInstruction: rule } = require("../learning/outcomeLearningRuleEngine");
const { calculateNextDevelopmentProfile: calculate } = require("../learning/developmentProfileTransition");
const event = { eventId: "e", eventType: "Attend", childId: "c", activityId: "a", bookingId: "b", occurredAt: new Date("2026-09-20T00:00:00Z") };
const instruction = (ids = ["x"]) => rule(event, { status: "APPLICABLE", activityId: "a", outcomeIds: ids });
const entry = (outcomeId = "x", extra = {}) => ({ outcomeId, score: 0.3, confidenceScore: 0.2, evidenceCount: 2, trend: "Stable", history: [{ old: true }], lastEvidenceAt: new Date("2020-01-01"), lastUpdated: "2020-01-02", ...extra });
function run(profile, ids = ["x"], ev = event, ins = instruction(ids)) {
    const inspect = (v) => require("util").inspect(v, { depth: null });
    const before = inspect({ profile, ins, ev });
    const result = calculate(profile, ins, ev);
    assert(!(result instanceof Promise));
    assert.strictEqual(inspect({ profile, ins, ev }), before);
    return result;
}
const first = run([]);
assert.strictEqual(first.status, "APPLIED");
assert.deepStrictEqual(first.developmentProfile[0], { outcomeId: "x", score: 0.1, confidenceScore: 0.05, evidenceCount: 1, trend: null,
    history: [{ eventId: "e", eventType: "Attend", activityId: "a", bookingId: "b", previousScore: 0, newScore: 0.1, scoreDelta: 0.1, previousConfidence: 0, newConfidence: 0.05, confidenceDelta: 0.05, timestamp: event.occurredAt }], lastEvidenceAt: event.occurredAt, lastUpdated: event.occurredAt });
const child = { parentGoals: [{ goalId: "goal", status: "Active" }], developmentProfile: [entry(), entry("unrelated")] };
const before = structuredClone(child);
const existing = run(child.developmentProfile).developmentProfile;
assert.deepStrictEqual(child, before);
assert.strictEqual(existing[0].score, 0.4);
assert.strictEqual(existing[0].confidenceScore, 0.25);
assert.strictEqual(existing[0].evidenceCount, 3);
assert.strictEqual(existing[0].trend, "Stable");
assert.deepStrictEqual(existing[0].history[0], { old: true });
assert.strictEqual(existing[0].history.length, 2);
assert.deepStrictEqual(existing[1], child.developmentProfile[1]);
existing[1].history[0].old = false;
assert.strictEqual(child.developmentProfile[1].history[0].old, true);
const multi = run([entry()], ["x", "y", "z"]);
assert.strictEqual(multi.affectedOutcomes.length, 3);
assert.deepStrictEqual(multi.developmentProfile.map((e) => e.score), [0.4, 0.1, 0.1]);
assert.notStrictEqual(multi.developmentProfile[1].history[0], multi.developmentProfile[2].history[0]);
const saturated = run([entry("x", { score: 0.95, confidenceScore: 0.98 })]).developmentProfile[0];
assert.strictEqual(saturated.score, 1);
assert.strictEqual(saturated.confidenceScore, 1);
assert.strictEqual(saturated.evidenceCount, 3);
assert.strictEqual(saturated.history[1].scoreDelta, 0.1);
assert.strictEqual(saturated.history[1].confidenceDelta, 0.05);
assert.strictEqual(run([entry("x", { lastEvidenceAt: event.occurredAt })]).status, "APPLIED");
const stale = run([entry(), entry("y", { lastEvidenceAt: "2027-01-01" })], ["x", "y", "z"]);
assert.deepStrictEqual(stale, { status: "NOT_APPLIED", reasonCode: "OUT_OF_ORDER_OUTCOME_EVENT" });
const oid = new ObjectId();
const invalid = [undefined, null, {}, [entry(), entry()], [entry(oid), entry(oid.toHexString().toUpperCase())]];
for (const field of ["score", "confidenceScore"]) for (const value of [NaN, Infinity, -0.1, 1.1, "0.3", undefined]) invalid.push([entry("x", { [field]: value })]);
for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1"]) invalid.push([entry("x", { evidenceCount: value })]);
for (const extra of [{ outcomeId: null }, { history: null }, { lastEvidenceAt: "bad" }, { lastUpdated: "bad" }, { lastEvidenceAt: null }, { lastUpdated: new Date(NaN) }]) invalid.push([entry("x", extra)]);
invalid.push([entry(), entry("unrelated", { score: -1 })]);
for (const profile of invalid) assert.deepStrictEqual(run(profile), { status: "NOT_APPLIED", reasonCode: "INVALID_EXISTING_DEVELOPMENT_STATE" });
assert.strictEqual(run([entry("x", { evidenceCount: Number.MAX_SAFE_INTEGER })]).status, "NOT_APPLIED");
for (const trend of [null, "Improving", "custom"]) assert.strictEqual(run([entry("x", { trend })]).developmentProfile[0].trend, trend);
const noDates = entry(); delete noDates.lastEvidenceAt; delete noDates.lastUpdated;
assert.strictEqual(run([noDates]).status, "APPLIED");
assert.strictEqual(run([entry(oid)], [oid.toHexString()]).developmentProfile[0].outcomeId.equals(oid), true);
for (const learning of [{ scoreDelta: -0.1, confidenceDelta: 0.05, evidenceIncrement: 1 }, { scoreDelta: 0.1, confidenceDelta: -0.05, evidenceIncrement: 1 }]) assert.strictEqual(run([], ["x"], event, { ...instruction(), learning }).reasonCode, "INVALID_INSTRUCTION");
assert.strictEqual(run([], ["x"], { ...event, eventType: "Complete" }).reasonCode, "UNSUPPORTED_OUTCOME_EVENT");
assert.strictEqual(run([], ["x"], { ...event, occurredAt: "bad" }).reasonCode, "INVALID_EVENT");
// Pure modules may only depend on identity helpers, BSON types, and the pure rule.
// This excludes configuration, database clients, graph, D5 and D6 dependencies.
for (const file of ["outcomeLearningRuleEngine", "developmentProfileTransition"]) {
    const modulePath = require.resolve(`../learning/${file}`);
    const dependencies = require.cache[modulePath].children.map((m) => m.id);
    assert(dependencies.every((id) => /node_modules\/mongodb\/lib\/index\.js$|\/utils\/idUtils\.js$|\/learning\/outcomeLearningRuleEngine\.js$/.test(id)));
}
console.log("Development profile transition unit tests: PASSED");
