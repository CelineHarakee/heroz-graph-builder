const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const { ObjectId } = require("mongodb");

const root = path.resolve(__dirname, "..");
const allowed = new Set([
    "api/v1/childIntelligence.js", "api/v1/index.js", "api/apiError.js",
    "api/apiResponse.js", "api/requestValidation.js",
    "services/childIntelligenceService.js", "utils/idUtils.js"
].map(file => path.join(root, file)));
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (parent && allowed.has(parent.filename)) {
        const resolved = Module._resolveFilename(request, parent);
        assert.ok(allowed.has(resolved) || request === "mongodb",
            `Unexpected dependency: ${request}`);
    }
    return originalLoad.call(this, request, parent, isMain);
};
const { METHOD, PATH, handleChildIntelligence } = require("../api/v1/childIntelligence");
let passed = 0;
async function check(name, run) {
    await run();
    passed++;
    console.log(`PASS ${name}`);
}
const childId = new ObjectId("507f1f77bcf86cd799439011");
const subcategoryId = new ObjectId("507f1f77bcf86cd799439012");
const goalId = new ObjectId("507f1f77bcf86cd799439013");
const outcomeId = new ObjectId("507f1f77bcf86cd799439014");
const time = new Date("2026-01-02T00:00:00Z");
function freeze(value) {
    if (value && typeof value === "object" && !(value instanceof ObjectId)) {
        Object.freeze(value);
        Object.values(value).forEach(freeze);
    }
    return value;
}
// Only the two permitted reads exist. Any collection, write, session, queue,
// or other database operation fails immediately, including property access.
function readOnlyDb(child, interests = []) {
    const calls = [];
    const guard = object => new Proxy(object, {
        get(target, key) {
            assert.ok(Object.hasOwn(target, key), `Forbidden database operation: ${String(key)}`);
            return target[key];
        }
    });
    const db = guard({ collection(name) {
        calls.push(name);
        if (name === "children") return guard({ async findOne(query) {
            assert.deepEqual(query, { _id: child ? child._id : childId });
            return child;
        } });
        assert.equal(name, "child_interests");
        return guard({ find(query) {
            assert.deepEqual(query, { childId: child._id });
            return guard({ async toArray() { return interests; } });
        } });
    } });
    return { db, calls };
}
async function main() {
    await check("GET endpoint mounting contract", () => {
        assert.equal(METHOD, "GET");
        assert.equal(PATH, "/api/v1/children/{childId}/intelligence");
    });
    await check("authoritative mapping, exact envelope, serialization, and read-only isolation", async () => {
        const preferences = Object.fromEntries([
            ["environment", "Indoor"], ["socialStyle", "Team"], ["difficulty", "Beginner"],
            ["experienceStyle", "Structured"], ["commitmentPreference", "Weekly"]
        ].map(([dimension, value]) => [dimension, { value, confidenceScore: 1, source: "Parent", updatedAt: time }]));
        const child = freeze({ _id: childId, preferences,
            parentGoals: [
                { goalId, priority: 2, status: "Active", selectedBy: "Parent" },
                { goalId: "inactive", priority: 1, status: "Inactive" }
            ],
            developmentProfile: [{ outcomeId, score: 0.2, confidenceScore: 0.1,
                evidenceCount: 2, trend: null, lastUpdated: time, history: [{ internal: true }] }],
            privateData: "not public"
        });
        const interests = freeze([{ childId, subcategoryId,
            interestScore: { currentScore: 0.63, lastCalculatedAt: new Date("2026-01-01") },
            confidence: { currentScore: 0.27, evidenceCount: 3 },
            metadata: { updatedAt: time }, scoreHistory: [{ internal: true }] }]);
        const before = JSON.stringify({ child, interests });
        const { db, calls } = readOnlyDb(child, interests);
        const result = await handleChildIntelligence(String(childId), { db });
        assert.deepEqual(result, { status: 200, body: { success: true, data: {
            childId: String(childId),
            interests: [{ subcategoryId: String(subcategoryId), score: 0.63, confidence: 0.27,
                evidenceCount: 3, lastUpdated: time.toISOString() }],
            preferences: JSON.parse(JSON.stringify(preferences)),
            goals: [{ goalId: String(goalId), priority: 2 }],
            development: [{ learningOutcomeId: String(outcomeId), score: 0.2, confidence: 0.1,
                evidenceCount: 2, trend: null, lastUpdated: time.toISOString() }]
        } } });
        assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
        assert.equal(JSON.stringify({ child, interests }), before);
        assert.deepEqual(calls, ["children", "child_interests"]);
    });
    await check("absent/null/empty state creates no intelligence defaults", async () => {
        for (const fields of [{}, { preferences: null, parentGoals: null, developmentProfile: null },
            { preferences: {}, parentGoals: [], developmentProfile: [] }]) {
            const { db } = readOnlyDb({ _id: "child_001", ...fields });
            assert.deepEqual(await handleChildIntelligence("child_001", { db }), {
                status: 200, body: { success: true, data: {
                    childId: "child_001", interests: [], preferences: {}, goals: [], development: []
                } }
            });
        }
    });
    await check("partial preferences preserved without defaults or allowed-value checks", async () => {
        const state = { value: "StoredValue", confidenceScore: 0, source: "Parent", updatedAt: time };
        const { db } = readOnlyDb({ _id: childId, preferences: { environment: state },
            parentGoals: [{ goalId, priority: 3, status: "Inactive" }] });
        const result = await handleChildIntelligence(String(childId), { db });
        assert.deepEqual(result.body.data.preferences, { environment: { ...state, updatedAt: time.toISOString() } });
        assert.deepEqual(result.body.data.goals, []);
    });
    await check("stored zeros and trends preserved; missing evidence not manufactured", async () => {
        const { db } = readOnlyDb({ _id: childId, developmentProfile: [
            { outcomeId, score: 0, confidenceScore: 0, evidenceCount: 0, trend: "Stable", lastUpdated: time }
        ] }, [{ subcategoryId, interestScore: { currentScore: 0 }, confidence: { currentScore: 0, evidenceCount: 0 } }]);
        const result = await handleChildIntelligence(String(childId), { db });
        assert.equal(result.status, 200);
        assert.equal(result.body.data.interests[0].score, 0);
        assert.equal(result.body.data.interests[0].lastUpdated, undefined);
        assert.equal(result.body.data.development[0].score, 0);
        assert.equal(result.body.data.development[0].trend, "Stable");
    });
    await check("missing child returns 404 and stops retrieval", async () => {
        const { db, calls } = readOnlyDb(null);
        assert.deepEqual(await handleChildIntelligence(String(childId), { db }), {
            status: 404, body: { success: false, error: { code: "CHILD_NOT_FOUND", message: "Child not found." } }
        });
        assert.deepEqual(calls, ["children"]);
    });
    await check("structurally invalid IDs return D1 400 before database access", async () => {
        const db = { collection() { throw new Error("Must not access DB"); } };
        for (const id of [undefined, null, "", " \t", 0, false, {}, [], childId]) {
            const result = await handleChildIntelligence(id, { db });
            assert.equal(result.status, 400);
            assert.equal(result.body.success, false);
            assert.equal(result.body.error.code, "BAD_REQUEST");
        }
    });
    await check("database failures safely map to 500 at either read", async () => {
        for (const failAt of ["children", "child_interests"]) {
            const db = { collection(name) {
                if (name === failAt) throw new Error("mongodb://user:secret@private bolt://private stack");
                return { async findOne() { return { _id: childId }; } };
            } };
            assert.deepEqual(await handleChildIntelligence(String(childId), { db }), {
                status: 500, body: { success: false, error: {
                    code: "INTERNAL_ERROR", message: "An unexpected error occurred."
                } }
            });
        }
    });
    console.log(`${passed} D2 checks passed; database writes and unrelated dependencies prohibited throughout.`);
}
main().catch(error => { console.error(error); process.exitCode = 1; })
    .finally(() => { Module._load = originalLoad; });
