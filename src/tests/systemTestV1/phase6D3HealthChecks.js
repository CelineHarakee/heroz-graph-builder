const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const root = path.resolve(__dirname, "../..");
const allowed = new Set([
    "api/v1/health.js", "api/v1/index.js", "api/apiResponse.js", "api/apiError.js",
    "services/healthService.js", "observability/runtimeMetrics.js", "observability/structuredLogger.js",
    "observability/traceContext.js", "reliability/reliabilityFailure.js"
].map(file => path.join(root, file)));
const originalLoad = Module._load;
let defaults;
// Guard every import from the health execution tree, including lazy imports.
// No intelligence, persistence, queue, or real database client may execute.
Module._load = function(request, parent, isMain) {
    if (parent && allowed.has(parent.filename) && !request.startsWith("node:")) {
        const resolved = Module._resolveFilename(request, parent);
        if (resolved === path.join(root, "config/mongodb.js")) return { getDatabase: () => defaults.db };
        if (resolved === path.join(root, "config/neo4j.js")) return defaults.driver;
        assert.ok(allowed.has(resolved), `Forbidden health dependency: ${request}`);
    }
    return originalLoad.call(this, request, parent, isMain);
};
const { METHOD, PATH, handleHealth } = require("../../api/v1/health");
const { createLogger } = require("../../observability/structuredLogger");
const { createReliabilityFailure } = require("../../reliability/reliabilityFailure");
const records = [];
const logger = createLogger({ now: () => new Date("2026-10-15T00:00:00Z"), emit: r => records.push(r) });
let ids = 0, passed = 0;
const observability = { logger, idFactory: () => `health_${++ids}` };
const secret = new Error("mongodb://user:secret@private neo4j://user:secret@private password=secret");
function fixture(mongo = "ok", neo = "ok") {
    const calls = [];
    const run = value => {
        if (value === "hang") return new Promise(() => {});
        if (value !== "ok") throw value;
        return Promise.resolve({ privateDriverResult: "secret" });
    };
    const guard = object => new Proxy(object, { get(target, key) {
        assert.ok(Object.hasOwn(target, key), `Forbidden dependency operation: ${String(key)}`);
        return target[key];
    } });
    return { calls, observability, timeoutMs: 25,
        db: guard({ command(command, options) {
            calls.push("mongodb"); assert.deepEqual(command, { ping: 1 });
            assert.deepEqual(options, { timeoutMS: 25 }); return run(mongo);
        } }),
        driver: guard({ verifyConnectivity(...args) {
            calls.push("neo4j"); assert.deepEqual(args, []); return run(neo);
        } }) };
}
function expected(mongo, neo) {
    return { status: 200, body: { success: true, data: {
        status: mongo === "UNHEALTHY" ? "UNHEALTHY" : neo === "UNHEALTHY" ? "DEGRADED" : "HEALTHY",
        dependencies: { mongodb: { status: mongo }, neo4j: { status: neo } }
    } } };
}
async function check(label, fn) { await fn(); passed++; console.log(`PASS ${label}`); }
async function main() {
    await check("V1 mounting contract", () => {
        assert.equal(METHOD, "GET"); assert.equal(PATH, "/api/v1/health");
    });
    for (const mongo of ["ok", secret]) for (const neo of ["ok", secret]) {
        await check(`Independent checks and exact aggregation: ${mongo === "ok"}/${neo === "ok"}`, async () => {
            records.length = 0;
            const f = fixture(mongo, neo);
            assert.deepEqual(await handleHealth(f), expected(mongo === "ok" ? "HEALTHY" : "UNHEALTHY", neo === "ok" ? "HEALTHY" : "UNHEALTHY"));
            assert.deepEqual(f.calls, ["mongodb", "neo4j"]);
            assert.equal(records.length, 6);
            assert.equal(new Set(records.map(r => r.requestId)).size, 1);
            assert.equal(new Set(records.map(r => r.correlationId)).size, 1);
            assert.ok(!JSON.stringify(records).includes("secret"));
            assert.ok(records.every(r => !Object.hasOwn(r, "failureCategory")));
        });
    }
    await check("Production dependency resolution uses existing utilities", async () => {
        defaults = fixture();
        assert.deepEqual(await handleHealth({ timeoutMs: 25, observability }), expected("HEALTHY", "HEALTHY"));
        assert.deepEqual(defaults.calls, ["mongodb", "neo4j"]);
    });
    for (const [mongo, neo] of [["hang", "ok"], ["ok", "hang"], ["hang", "hang"]]) {
        await check(`Deterministic bounded timeout: ${mongo}/${neo}`, async () => {
            const f = fixture(mongo, neo), pending = new Map();
            let timerId = 0, settled = false;
            f.setTimer = (callback, ms) => { assert.equal(ms, 25); pending.set(++timerId, callback); return timerId; };
            f.clearTimer = id => pending.delete(id);
            const request = handleHealth(f).then(result => { settled = true; return result; });
            for (let i = 0; i < 20; i++) await Promise.resolve();
            assert.equal(settled, false);
            assert.deepEqual(f.calls, ["mongodb", "neo4j"]);
            assert.equal(pending.size, mongo === "hang" && neo === "hang" ? 2 : 1);
            for (const callback of [...pending.values()]) callback();
            assert.deepEqual(await request, expected(mongo === "hang" ? "UNHEALTHY" : "HEALTHY", neo === "hang" ? "UNHEALTHY" : "HEALTHY"));
            assert.equal(pending.size, 0);
        });
    }
    await check("Late rejection after timeout is consumed without retry", async () => {
        const f = fixture(), callbacks = [];
        let rejectLate;
        f.driver = { verifyConnectivity: () => new Promise((_, reject) => { rejectLate = reject; }) };
        f.setTimer = callback => { callbacks.push(callback); return callbacks.length; };
        f.clearTimer = () => {};
        const request = handleHealth(f);
        for (let i = 0; i < 20; i++) await Promise.resolve();
        callbacks[1]();
        assert.deepEqual(await request, expected("HEALTHY", "UNHEALTHY"));
        rejectLate(secret);
        await new Promise(resolve => setImmediate(resolve));
    });
    await check("D1 explicit metadata retained internally only", async () => {
        const failure = createReliabilityFailure({ category: "DEPENDENCY_FAILURE", stateStatus: "UNCHANGED",
            component: "Mongo", operation: "ping", message: "secret", diagnosticContext: { secret: true } });
        records.length = 0;
        assert.deepEqual(await handleHealth(fixture(failure)), expected("UNHEALTHY", "HEALTHY"));
        assert.equal(records.find(r => r.operation === "mongodb" && r.event === "OPERATION_FAILED").failureCategory, "DEPENDENCY_FAILURE");
        assert.ok(!JSON.stringify(records).includes("secret"));
    });
    await check("Logger and emitter failures never change health", async () => {
        for (const broken of [{ log() { throw secret; } }, { log: async () => { throw secret; } },
            createLogger({ emit() { throw secret; } }), createLogger({ emit: async () => { throw secret; } })]) {
            for (const neo of ["ok", secret]) {
                const f = fixture("ok", neo); f.observability = { ...observability, logger: broken };
                assert.deepEqual(await handleHealth(f), expected("HEALTHY", neo === "ok" ? "HEALTHY" : "UNHEALTHY"));
            }
        }
        await new Promise(resolve => setImmediate(resolve));
    });
    await check("Invalid timeout configuration is safely rejected", async () => {
        for (const timeoutMs of [0, -1, Infinity, NaN, "25", 2147483648]) {
            const f = fixture(); f.timeoutMs = timeoutMs;
            assert.deepEqual(await handleHealth(f), { status: 500, body: { success: false,
                error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred." } } });
            assert.deepEqual(f.calls, []);
        }
    });
    console.log(`${passed} focused D3 checks passed; business imports and writes excluded by guards.`);
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { Module._load = originalLoad; });
