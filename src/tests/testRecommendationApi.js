const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const { ObjectId } = require("mongodb");
const root = path.resolve(__dirname, "..");
const allowed = new Set([
    "api/v1/recommendations.js", "api/v1/index.js", "api/apiError.js",
    "api/apiResponse.js", "api/requestValidation.js", "utils/idUtils.js"
].map(file => path.join(root, file)));
const enginePath = path.join(root, "recommendation/recommendationEngineService.js");
const originalLoad = Module._load;
let defaultEngine;
Module._load = function (request, parent, isMain) {
    if (parent && allowed.has(parent.filename)) {
        const resolved = Module._resolveFilename(request, parent);
        if (resolved === enginePath) return { generateRecommendations: defaultEngine };
        assert.ok(allowed.has(resolved) || request === "mongodb", `Forbidden API dependency: ${request}`);
    }
    return originalLoad.call(this, request, parent, isMain);
};
const { METHOD, PATH, handleRecommendations } = require("../api/v1/recommendations");
const childId = "507f1f77bcf86cd799439011";
let checks = 0;
async function check(label, run) {
    await run(); checks++; console.log(`PASS ${label}`);
}
function dependencies({ exists = true, result, failure, databaseFailure } = {}) {
    const calls = [];
    const guard = value => new Proxy(value, { get(target, key) {
        assert.ok(Object.hasOwn(target, key), `Forbidden DB operation: ${String(key)}`);
        return target[key];
    } });
    return { calls, db: guard({ collection(name) {
        assert.equal(name, "children");
        return guard({ async findOne(query, options) {
            calls.push("existence");
            assert.deepEqual(query, { _id: new ObjectId(childId) });
            assert.deepEqual(options, { projection: { _id: 1 } });
            if (databaseFailure) throw databaseFailure;
            return exists ? { _id: new ObjectId(childId) } : null;
        } });
    } }), async generateRecommendations(id, topN) {
        calls.push({ id, topN });
        if (failure) throw failure;
        return result ?? { childId, recommendations: [] };
    } };
}
const internalError = { status: 500, body: { success: false, error: {
    code: "INTERNAL_ERROR", message: "An unexpected error occurred."
} } };
async function main() {
    await check("endpoint contract", () => {
        assert.equal(METHOD, "GET");
        assert.equal(PATH, "/api/v1/children/{childId}/recommendations");
    });
    await check("exact projection preserves score/rank/order/factors/evidence without pipeline duplication", async () => {
        const factors = Object.freeze({ interest: { available: true, score: 0 },
            goal: { available: false, score: null } });
        const evidence = Object.freeze({ discovery: { interests: ["existing"] }, factors: { goal: [] } });
        const recommendations = Object.freeze([
            Object.freeze({ activityId: "b", score: 0.123456789, rank: 7, factors, evidence,
                explanation: "private", scoring: {}, eligibleSessionIds: [], currentActivity: {} }),
            Object.freeze({ activityId: "a", score: 0.9, rank: 2, factors: {}, evidence: {} })
        ]);
        const result = Object.freeze({ childId, recommendations, recommendationId: "private", requestedAt: new Date() });
        const before = JSON.stringify(result);
        const deps = dependencies({ result });
        const response = await handleRecommendations(childId, 2, deps);
        assert.deepEqual(response, { status: 200, body: { success: true, data: {
            childId, recommendations: recommendations.map(({ activityId, score, rank, factors, evidence }) =>
                ({ activityId, score, rank, factors, evidence }))
        } } });
        assert.equal(response.body.data.recommendations[0].factors, factors);
        assert.equal(response.body.data.recommendations[0].evidence, evidence);
        assert.equal(Object.hasOwn(factors, "preference"), false);
        assert.equal(JSON.stringify(result), before);
        assert.deepEqual(deps.calls, ["existence", { id: childId, topN: 2 }]);
    });
    await check("completed empty engine output succeeds", async () => {
        const deps = dependencies();
        assert.deepEqual(await handleRecommendations(childId, 1, deps), {
            status: 200, body: { success: true, data: { childId, recommendations: [] } }
        });
    });
    await check("missing child is 404 with no engine invocation", async () => {
        const deps = dependencies({ exists: false });
        assert.deepEqual(await handleRecommendations(childId, 1, deps), {
            status: 404, body: { success: false, error: { code: "CHILD_NOT_FOUND", message: "Child not found." } }
        });
        assert.deepEqual(deps.calls, ["existence"]);
    });
    await check("invalid child IDs reject before reads or engine invocation", async () => {
        for (const id of [undefined, null, "", " ", "child_001", "bad", 5, {}, [], new ObjectId(childId)]) {
            const deps = dependencies();
            const response = await handleRecommendations(id, 1, deps);
            assert.equal(response.status, 400);
            assert.equal(response.body.error.code, "BAD_REQUEST");
            assert.deepEqual(deps.calls, []);
        }
    });
    await check("required positive integer limit has no default or permissive coercion", async () => {
        for (const limit of [undefined, null, 0, -1, 1.5, NaN, Infinity, "", "abc", "0", "-1", "1.5", "2junk", false, true, [], {}]) {
            const deps = dependencies();
            const response = await handleRecommendations(childId, limit, deps);
            assert.equal(response.status, 400, String(limit));
            assert.equal(response.body.error.code, "BAD_REQUEST");
            assert.deepEqual(deps.calls, []);
        }
    });
    await check("integer limits and decimal query strings pass through to topN without a cap", async () => {
        for (const limit of [1, 7, 100000, "3"]) {
            const deps = dependencies();
            assert.equal((await handleRecommendations(childId, limit, deps)).status, 200);
            assert.deepEqual(deps.calls, ["existence", { id: childId, topN: Number(limit) }]);
        }
    });
    await check("real engine module is the default call boundary; no additional orchestration", async () => {
        const deps = dependencies();
        defaultEngine = deps.generateRecommendations;
        assert.equal((await handleRecommendations(childId, 4, { db: deps.db })).status, 200);
        assert.deepEqual(deps.calls, ["existence", { id: childId, topN: 4 }]);
    });
    await check("engine and database exceptions are safe 500, never empty success", async () => {
        const secret = new Error("mongodb://user:password@private neo4j://private internal stack");
        for (const failure of [{ failure: secret }, { databaseFailure: secret }]) {
            const deps = dependencies(failure);
            assert.deepEqual(await handleRecommendations(childId, 1, deps), internalError);
        }
        const deps = dependencies({ result: { childId, recommendations: null } });
        assert.deepEqual(await handleRecommendations(childId, 1, deps), internalError);
    });
    console.log(`${checks} grouped D3 checks passed; read-only DB and API dependency guards active throughout.`);
}
main().catch(error => { console.error(error); process.exitCode = 1; })
    .finally(() => { Module._load = originalLoad; });
