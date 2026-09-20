const assert = require("assert");
const { ObjectId } = require("mongodb");
const { resolveOutcomeLearningContext: resolve } = require("../learning/outcomeLearningContextService");
const { getOutcomeLearningInstruction: rule } = require("../learning/outcomeLearningRuleEngine");
async function main() {
    const id = new ObjectId();
    const event = { eventId: "e", childId: "c", activityId: id.toHexString(), bookingId: "b", eventType: "Attend", occurredAt: new Date() };
    async function check(mapping, references, reason, status, missing = false) {
        const activity = { _id: id, ...(missing ? {} : { learningOutcomes: mapping }) };
        const before = require("util").inspect({ activity, references, event }, { depth: null });
        const db = { collection(name) {
            assert(["activities", "learning_outcomes"].includes(name));
            return { async findOne(query) {
                if (name === "activities") { assert(query._id instanceof ObjectId); assert(query._id.equals(id)); return activity; }
                return references.find((r) => String(r._id).toLowerCase() === String(query._id).toLowerCase()) || null;
            } };
        } };
        const result = await resolve(event, { db });
        assert.strictEqual(result.reasonCode, reason);
        assert.strictEqual(result.status, status);
        assert.strictEqual(require("util").inspect({ activity, references, event }, { depth: null }), before);
        return result;
    }
    const refs = [{ _id: "a", isActive: true }, { _id: id, isActive: true }];
    const one = await check([{ outcomeId: "a", weight: 999, evidenceGuidance: "descriptive" }], refs, "VALID_OUTCOME_CONTEXT", "APPLICABLE");
    assert.deepStrictEqual(rule(event, one).learning, { scoreDelta: 0.1, confidenceDelta: 0.05, evidenceIncrement: 1 });
    assert.deepStrictEqual(one.outcomeIds, ["a"]);
    const multi = await check([{ outcomeId: "a" }, { outcomeId: id }], refs, "VALID_OUTCOME_CONTEXT", "APPLICABLE");
    assert.deepStrictEqual(multi.outcomeIds, ["a", id.toHexString()]);
    await check([], refs, "NO_MAPPED_OUTCOMES", "NOT_APPLICABLE");
    for (const mapping of [null, {}, "bad", [{ }], [{ outcomeId: "" }], [{ outcomeId: 4 }]]) await check(mapping, refs, "INVALID_OUTCOME_MAPPING", "REJECTED");
    await check(undefined, refs, "INVALID_OUTCOME_MAPPING", "REJECTED", true);
    for (const ids of [["a", "a"], [id, id.toHexString().toUpperCase()]]) await check(ids.map((outcomeId) => ({ outcomeId })), refs, "DUPLICATE_OUTCOME_MAPPING", "REJECTED");
    await check([{ outcomeId: "missing" }], refs, "INVALID_OUTCOME_MAPPING", "REJECTED");
    for (const isActive of [false, undefined, "true"]) await check([{ outcomeId: "a" }], [{ _id: "a", isActive }], "INVALID_OUTCOME_MAPPING", "REJECTED");
    const forbidden = { collection() { throw Error("unexpected access"); } };
    assert.strictEqual((await resolve({ eventType: "Complete" }, { db: forbidden })).reasonCode, "UNSUPPORTED_OUTCOME_EVENT");
    assert.strictEqual((await resolve(null, { db: forbidden })).reasonCode, "INVALID_EVENT");
    assert.strictEqual((await resolve(event, { db: forbidden })).reasonCode, "DATABASE_ERROR");
    assert.strictEqual((await resolve(event, { db: { collection: () => ({ findOne: async () => null }) } })).reasonCode, "INVALID_OUTCOME_MAPPING");
    console.log("Outcome learning context service unit tests: PASSED");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
