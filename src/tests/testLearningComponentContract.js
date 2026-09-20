const assert = require("assert");
const { getRequiredLearningComponents: required, validateLearningComponents: validate } = require("../learning/learningComponentContract");
const applied = () => ({ status: "APPLIED", completedAt: new Date("2026-09-20") });
for (const type of ["View", "Click", "Save", "Unsave", "Dismiss", "Book", "Rate"]) {
    assert.deepStrictEqual(required(type), ["interest"]);
    assert.strictEqual(validate(type, { interest: applied() }).status, "VALID");
}
assert.deepStrictEqual(required("Attend"), ["interest", "outcomes"]);
for (const outcomes of [applied(), { status: "NOT_APPLICABLE", reasonCode: "NO_MAPPED_OUTCOMES", completedAt: new Date() }]) {
    const components = { interest: applied(), outcomes }, before = structuredClone(components);
    assert.strictEqual(validate("Attend", components).status, "VALID");
    assert.deepStrictEqual(components, before);
}
for (const components of [null, [], {}, { interest: applied() }, { outcomes: applied() },
    { interest: applied(), outcomes: { status: "NOT_APPLICABLE", completedAt: new Date() } },
    { interest: applied(), outcomes: { status: "NOT_APPLICABLE", reasonCode: "OTHER", completedAt: new Date() } },
    { interest: applied(), outcomes: { ...applied(), status: "PENDING" } },
    { interest: applied(), outcomes: { ...applied(), weight: 1 } },
    { interest: applied(), outcomes: applied(), extra: applied() }]) assert.strictEqual(validate("Attend", components).status, "INVALID");
for (const completedAt of [undefined, null, "2026-09-20", 1, new Date(NaN)]) assert.strictEqual(validate("View", { interest: { status: "APPLIED", completedAt } }).status, "INVALID");
for (const type of ["Complete", "Unknown", null, undefined, "toString"]) {
    assert.strictEqual(required(type), null);
    assert.strictEqual(validate(type, {}).reasonCode, "UNSUPPORTED_EVENT_TYPE");
}
assert.strictEqual(validate("View", { interest: applied(), outcomes: applied() }).status, "INVALID");
console.log("Learning component contract unit tests: PASSED");
