const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { ObjectId } = require("mongodb");
const { createMetricsCollector, defaultMetrics } = require("../../observability/runtimeMetrics");
const { observeOperation, createLogger, learningOutcome } = require("../../observability/structuredLogger");
const { runRequest, runBackground, currentTrace } = require("../../observability/traceContext");
const { handleChildIntelligence } = require("../../api/v1/childIntelligence");
const { handleRecommendations } = require("../../api/v1/recommendations");
const { handleNextQuestion } = require("../../api/v1/adaptiveQuestions");
const { handleQuestionAnswer } = require("../../api/v1/questionAnswers");
const { handleInteraction } = require("../../api/v1/interactions");
const { handleHealth } = require("../../api/v1/health");
const { processContinuousLearningSource } = require("../../learning/continuousLearningService");
const records = [];
const logger = createLogger({ emit: record => records.push(record) });
const childId = "507f1f77bcf86cd799439010", activityId = "507f1f77bcf86cd799439011";
const parentId = new ObjectId("507f1f77bcf86cd799439012");
const historyId = "507f1f77bcf86cd799439013";
const sentinel = new Error("private credentials mongodb://user:secret@host");
let passed = 0;
async function check(label, task) { await task(); passed++; console.log(`PASS ${label}`); }
function observation(metrics = createMetricsCollector()) {
    let tick = 0;
    return { metrics, logger, metricNow: () => { tick += 2.5; return tick; } };
}
function row(metrics, operation) { return metrics.snapshot().find(item => item.operation === operation); }
const success = data => ({ status: 200, body: { success: true, data } });
const childDb = { collection(name) {
    assert.ok(["children", "child_interests"].includes(name));
    return { findOne: async () => ({ _id: new ObjectId(childId), parentId }), find: () => ({ toArray: async () => [] }) };
} };

// Real handlers/services, with only the operations their business paths require.
// Repeat under broken sinks to prove no replay, extra inserts, or learning.
async function productPaths(obs) {
    assert.deepEqual(await handleChildIntelligence(childId, { db: childDb, observability: obs }), success({
        childId, interests: [], preferences: {}, goals: [], development: []
    }));
    let recommendations = 0;
    const recommendationResult = { childId, recommendations: [{ activityId, score: 0.75, rank: 1, factors: {}, evidence: {} }] };
    const recOptions = { db: childDb, observability: obs, generateRecommendations: async () => {
        recommendations++; return recommendationResult;
    } };
    assert.deepEqual(await handleRecommendations(childId, 1, recOptions), success(recommendationResult));
    recOptions.generateRecommendations = async () => { recommendations++; return { childId, recommendations: [] }; };
    assert.deepEqual(await handleRecommendations(childId, 1, recOptions), success({ childId, recommendations: [] }));
    assert.equal(recommendations, 2);
    let evaluations = 0;
    assert.deepEqual(await handleNextQuestion(childId, { activityId, sessionId: "session" }, {
        db: childDb, observability: obs, services: { evaluateKnowledgeGaps: async () => {
            evaluations++; return { evaluation: { status: "RESOLVED" }, knowledgeGaps: [] };
        } }
    }), success({ childId, question: null }));
    assert.equal(evaluations, 1);

    let inserts = 0, learning = 0;
    const sources = [];
    const interactionOptions = { observability: obs,
        db: { collection(name) { assert.equal(name, "interactions"); return {
            insertOne: async source => { inserts++; sources.push(source); return { insertedId: source._id }; }
        }; } },
        processContinuousLearningSource: (...args) => processContinuousLearningSource(...args.slice(0, 2), {
            dependencies: { processLearningSource: async (type, source) => {
                learning++; return [{ status: "IGNORED", reasonCode: "DUPLICATE_EVENT",
                    event: { eventId: String(source._id), eventType: source.interactionDetails.interactionType } }];
            } }
        })
    };
    const interaction = await handleInteraction(childId, { activityId, interactionType: "Save" }, interactionOptions);
    assert.deepEqual(interaction, success({ interactionId: String(sources[0]._id), status: "RECORDED" }));
    assert.equal(inserts, 1); assert.equal(learning, 1);

    let interpreted = 0, integrated = 0;
    const history = { _id: new ObjectId(historyId), childId: new ObjectId(childId), parentId,
        questionId: "Q_PREF_ENVIRONMENT_001", outcome: "PRESENTED" };
    const answerOptions = { observability: obs,
        db: { collection(name) { assert.equal(name, "question_history"); return { findOne: async () => ({ ...history }) }; } },
        services: {
            interpretQuestionAnswer: async () => { interpreted++; return { status: "VALID", evidence: {} }; },
            integrateQuestionEvidence: async () => { integrated++; history.outcome = "ANSWERED"; return { status: "APPLIED" }; }
        }
    };
    const answer = success({ questionHistoryId: historyId, status: "ANSWERED" });
    assert.deepEqual(await handleQuestionAnswer(historyId, { answer: "Outdoor" }, answerOptions), answer);
    assert.deepEqual(await handleQuestionAnswer(historyId, { answer: "Outdoor" }, answerOptions), answer);
    assert.equal(interpreted, 1); assert.equal(integrated, 1);
}

async function graphJobs(obs) {
    const mongoPath = require.resolve("../../config/mongodb");
    const builderPath = require.resolve("../../services/graphBuilderService");
    const workerPath = require.resolve("../../workers/queueWorker");
    const saved = [mongoPath, builderPath, workerPath].map(key => [key, require.cache[key]]);
    const jobs = [new ObjectId(), new ObjectId()].map(_id => ({ _id, status: "PENDING" }));
    const processed = [], updates = [], traces = [];
    try {
        require.cache[mongoPath] = { exports: { getDatabase: () => ({ collection(name) {
            assert.equal(name, "graph_sync_queue");
            return { find: () => ({ toArray: async () => jobs }), updateOne: async (filter, update) => {
                updates.push({ filter, update }); return { matchedCount: 1 };
            } };
        } }) } };
        require.cache[builderPath] = { exports: { process: async job => {
            processed.push(job._id); traces.push(currentTrace()); if (job === jobs[1]) throw sentinel;
        } } };
        delete require.cache[workerPath];
        const { processQueue } = require(workerPath);
        await runRequest(() => processQueue(), obs);
        assert.deepEqual(processed, jobs.map(job => job._id));
        assert.equal(updates.length, 2);
        assert.equal(updates[0].update.$set.status, "PROCESSED");
        assert.equal(updates[1].update.$set.status, "FAILED");
        assert.deepEqual(updates.map(item => item.filter._id), jobs.map(job => job._id));
        assert.ok(traces.every(trace => !Object.hasOwn(trace, "requestId")));
        // Also exercise the worker's existing explicit observation argument.
        await processQueue({}, obs);
        assert.equal(processed.length, 4); assert.equal(updates.length, 4);
    } finally {
        for (const [key, value] of saved) { if (value) require.cache[key] = value; else delete require.cache[key]; }
    }
}

async function main() {
    await check("Counts, accumulation, outcomes and deterministic millisecond summaries", async () => {
        const obs = observation();
        for (const outcome of ["SUCCESS", "SUCCESS", "FAILURE", "DEGRADED"]) {
            await runRequest(() => observeOperation({ component: "ContinuousLearning", operation: "processSource",
                outcomeOf: () => outcome }, async () => null), obs);
        }
        assert.deepEqual(row(obs.metrics, "processSource"), { component: "ContinuousLearning", operation: "processSource",
            total: 4, outcomes: { SUCCESS: 2, FAILURE: 1, DEGRADED: 1 }, durationMs: { count: 4, total: 10, min: 2.5, max: 2.5 } });
        const copy = obs.metrics.snapshot(); copy[0].outcomes.SUCCESS = 999;
        assert.equal(row(obs.metrics, "processSource").outcomes.SUCCESS, 2);
    });
    await check("All product boundaries, empty recommendations, No Question, suppression and replay", async () => {
        const obs = observation(); await productPaths(obs);
        for (const [operation, total] of [["handleChildIntelligence", 1], ["handleRecommendations", 2],
            ["handleNextQuestion", 1], ["handleQuestionAnswer", 2], ["handleInteraction", 1], ["processSource", 1]]) {
            const metric = row(obs.metrics, operation);
            assert.equal(metric.total, total); assert.equal(metric.outcomes.SUCCESS, total);
            assert.equal(metric.durationMs.count, total);
        }
    });
    await check("Controlled API failure and thrown operation preserve existing results/errors", async () => {
        const obs = observation();
        assert.equal((await handleRecommendations("bad", 1, { observability: obs })).status, 400);
        assert.equal(row(obs.metrics, "handleRecommendations").outcomes.FAILURE, 1);
        await assert.rejects(runRequest(() => observeOperation({ component: "GraphSync", operation: "processJob" },
            async () => { throw sentinel; }), obs), error => error === sentinel);
        assert.equal(row(obs.metrics, "processJob").outcomes.FAILURE, 1);
    });
    await check("Existing mixed learning outcome maps to DEGRADED; suppressed learning maps to SUCCESS", async () => {
        const obs = observation();
        const mixed = { results: [{ status: "APPLIED" }, { status: "FAILED" }] };
        assert.equal(await runRequest(() => observeOperation({ component: "ContinuousLearning", operation: "processSource",
            outcomeOf: learningOutcome }, async () => mixed), obs), mixed);
        assert.equal(row(obs.metrics, "processSource").outcomes.DEGRADED, 1);
        const failed = await runRequest(() => processContinuousLearningSource("Interaction", {}, {
            dependencies: { processLearningSource: async () => { throw sentinel; } }
        }), obs);
        assert.equal(failed.results[0].status, "FAILED");
        assert.equal(row(obs.metrics, "processSource").outcomes.FAILURE, 1);
    });
    await check("D3 checks observed exactly once, with unchanged public health aggregation", async () => {
        const obs = observation(); let mongo = 0, neo = 0;
        for (const mongoHealthy of [true, false]) for (const neoHealthy of [true, false]) {
            const response = await handleHealth({ observability: obs,
                db: { command: async command => { mongo++; assert.deepEqual(command, { ping: 1 }); if (!mongoHealthy) throw sentinel; } },
                driver: { verifyConnectivity: async () => { neo++; if (!neoHealthy) throw sentinel; } }
            });
            assert.deepEqual(response, success({ status: !mongoHealthy ? "UNHEALTHY" : !neoHealthy ? "DEGRADED" : "HEALTHY",
                dependencies: { mongodb: { status: mongoHealthy ? "HEALTHY" : "UNHEALTHY" }, neo4j: { status: neoHealthy ? "HEALTHY" : "UNHEALTHY" } } }));
        }
        assert.equal(mongo, 4); assert.equal(neo, 4);
        for (const operation of ["mongodb", "neo4j"]) {
            assert.equal(row(obs.metrics, operation).total, 4);
            assert.deepEqual(row(obs.metrics, operation).outcomes, { SUCCESS: 2, FAILURE: 2, DEGRADED: 0 });
        }
        assert.equal(row(obs.metrics, "handleHealth").outcomes.SUCCESS, 4);
    });
    await check("Graph worker success/failure measured via inherited and explicit background settings", async () => {
        const obs = observation(); await graphJobs(obs);
        assert.deepEqual(row(obs.metrics, "processJob").outcomes, { SUCCESS: 2, FAILURE: 2, DEGRADED: 0 });
    });
    await check("Synchronous, rejected and pending collectors cannot change results or repeat business effects", async () => {
        for (const metrics of [{ record() { throw sentinel; } }, { record: async () => { throw sentinel; } },
            { record: () => new Promise(() => {}) }]) {
            const obs = observation(metrics); await productPaths(obs); await graphJobs(obs);
            const response = await handleHealth({ observability: obs, db: { command: async () => {} },
                driver: { verifyConnectivity: async () => { throw sentinel; } } });
            assert.equal(response.body.data.status, "DEGRADED");
        }
        await new Promise(resolve => setImmediate(resolve));
    });
    await check("Broken clocks preserve counters and results; negative/nonfinite durations are excluded", async () => {
        for (const metricNow of [() => { throw sentinel; }, () => NaN, () => Infinity,
            (() => { let value = 5; return () => value--; })()]) {
            const obs = { ...observation(), metricNow };
            await handleChildIntelligence(childId, { db: childDb, observability: obs });
            assert.equal(row(obs.metrics, "handleChildIntelligence").total, 1);
            assert.equal(row(obs.metrics, "handleChildIntelligence").durationMs.count, 0);
        }
    });
    await check("Privacy, fixed cardinality, no business imports or database writes in metrics", async () => {
        const metrics = createMetricsCollector(), emitted = [];
        for (let i = 0; i < 100; i++) metrics.record({ component: "ProductAPI", operation: `child_${i}`, outcome: "SUCCESS" });
        metrics.record({ component: "constructor", operation: "private", outcome: "SUCCESS" });
        assert.deepEqual(metrics.snapshot(), []);
        const obs = observation({ record: value => emitted.push(value) });
        await runRequest(() => observeOperation({ component: "GraphSync", operation: "processJob",
            context: { childId, parentId: "parent", activityId, answer: "private", profile: "private", token: "secret" } }, async () => null), obs);
        assert.deepEqual(emitted, [{ component: "GraphSync", operation: "processJob", outcome: "SUCCESS", durationMs: 2.5 }]);
        metrics.record({ ...emitted[0], childId, parentId, answer: "private", requestId: "trace", correlationId: "trace" });
        assert.deepEqual(Object.keys(metrics.snapshot()[0]), ["component", "operation", "total", "outcomes", "durationMs"]);
        assert.ok(!JSON.stringify(metrics.snapshot()).includes(childId));
        const script = `const Module=require('node:module');const load=Module._load;Module._load=function(name,...args){if(/mongodb|neo4j|config|services|workers|learning/i.test(name))throw Error('Business dependency');return load.call(this,name,...args);};const m=require(${JSON.stringify(require.resolve("../../observability/runtimeMetrics"))});m.createMetricsCollector().record({component:'Health',operation:'mongodb',outcome:'SUCCESS',durationMs:1});`;
        const result = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 10000 });
        assert.equal(result.status, 0, result.stderr);
    });
    await check("Default collector uses monotonic milliseconds and keeps bounded summaries", async () => {
        const before = row(defaultMetrics, "handleChildIntelligence")?.total ?? 0;
        await handleChildIntelligence(childId, { db: childDb, observability: { logger } });
        const metric = row(defaultMetrics, "handleChildIntelligence");
        assert.equal(metric.total, before + 1); assert.ok(metric.durationMs.min >= 0);
        assert.ok(defaultMetrics.snapshot().length <= 10);
    });
    await check("Zero and large durations are successful observations without thresholds", async () => {
        for (const elapsed of [0, 1000000]) {
            let calls = 0;
            const obs = { ...observation(), metricNow: () => calls++ === 0 ? 0 : elapsed };
            assert.equal((await handleChildIntelligence(childId, { db: childDb, observability: obs })).status, 200);
            const metric = row(obs.metrics, "handleChildIntelligence");
            assert.equal(metric.outcomes.SUCCESS, 1); assert.equal(metric.durationMs.total, elapsed);
        }
    });
    await check("Metric configuration failures leave D2 tracing intact; broken logging leaves metrics intact", async () => {
        const obs = { logger, idFactory: () => "owned_trace" };
        Object.defineProperty(obs, "metrics", { get() { throw sentinel; } });
        records.length = 0;
        assert.equal((await handleChildIntelligence(childId, { db: childDb, observability: obs })).status, 200);
        assert.equal(records.length, 2);
        assert.ok(records.every(record => record.requestId === "owned_trace"));
        await runRequest(() => runBackground(async () => {
            assert.equal(currentTrace().correlationId, "owned_trace");
            assert.ok(!Object.hasOwn(currentTrace(), "requestId"));
        }, obs), obs);
        const brokenLogger = { ...observation(), logger: { log() { throw sentinel; } } };
        assert.equal((await handleChildIntelligence(childId, { db: childDb, observability: brokenLogger })).status, 200);
        assert.equal(row(brokenLogger.metrics, "handleChildIntelligence").outcomes.SUCCESS, 1);
    });
    await check("Concurrent request collectors and D2 traces stay independent; background inherits metrics only", async () => {
        const a = observation(), b = observation();
        await Promise.all([productPaths(a), productPaths(b)]);
        assert.equal(row(a.metrics, "handleRecommendations").total, 2);
        assert.equal(row(b.metrics, "handleRecommendations").total, 2);
        await runRequest(() => runBackground(() => observeOperation({ component: "GraphSync", operation: "processJob" },
            async () => { assert.ok(!Object.hasOwn(currentTrace(), "requestId")); })), a);
        assert.equal(row(a.metrics, "processJob").total, 1);
        assert.ok(records.some(record => record.operation === "handleRecommendations" && record.event === "OPERATION_COMPLETED" && record.requestId));
    });
    console.log(`${passed} focused D4 validation groups passed.`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
