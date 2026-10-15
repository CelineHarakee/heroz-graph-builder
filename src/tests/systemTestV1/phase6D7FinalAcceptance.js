// Deterministic final acceptance: accepted suites + one cross-layer story.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { fixture, copy, FixedDate, RealDate, tick } = require('./fixtures/phase6LoadFixture');
const { createLogger } = require('../../observability/structuredLogger');
const { createMetricsCollector } = require('../../observability/runtimeMetrics');
const { currentTrace, runRequest } = require('../../observability/traceContext');
const { createReliabilityFailure, FAILURE_CATEGORY, STATE_STATUS } = require('../../reliability/reliabilityFailure');
const root = path.resolve(__dirname, '../../..');

function run(file) {
    const result = spawnSync(process.execPath, [file], { cwd: root, encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
    assert.equal(result.status, 0, `${file}: ${result.error ?? result.signal ?? ''}\n${result.stdout}\n${result.stderr}`);
    assert(!/^.*: FAIL\s*$/m.test(result.stdout), `${file} reported FAIL`);
    console.log(`PASS ${file}`);
}

async function story(mode) {
    const f = fixture(), records = [], graph = new Map(), traces = [];
    const collector = createMetricsCollector();
    let calls = 0, failing = true, clock = 0, traceId = 0;
    const broken = mode === 'broken-logger' || mode === 'broken-both';
    const observation = {
        logger: broken ? { log() { throw Error('sink unavailable'); } } : createLogger({ emit: record => records.push(record) }),
        metrics: mode === 'broken-metrics' || mode === 'broken-both'
            ? { record() { throw Error('collector unavailable'); } } : collector,
        metricNow: () => ++clock,
        idFactory: () => `acceptance_${++traceId}`
    };
    // Use stable adapters captured by the real modules; each story gets a fresh
    // fixture through these delegates, without touching production implementations.
    activeFixture = f;
    activeGraph = async (query, params) => {
        await tick(); calls++; traces.push(currentTrace());
        assert.match(query, /MERGE \(c\)-\[r:LIKES\]->\(s\)/);
        graph.set(`${params.childId}:${params.subcategoryId}`, copy(params));
        if (failing) throw createReliabilityFailure({
            category: FAILURE_CATEGORY.TIMEOUT_FAILURE, stateStatus: STATE_STATUS.UNKNOWN,
            component: 'GraphSync', operation: 'processJob', message: 'Graph response lost after projection', retryable: true
        });
        return { records: [{}] };
    };
    {
        const { handleInteraction } = require('../../api/v1/interactions');
        const { processQueue } = require('../../workers/queueWorker');
        const beforeCount = f.data.child_interests[0].confidence.evidenceCount;
        const response = await handleInteraction(String(f.ids.child), {
            activityId: String(f.ids.activity), interactionType: 'Rate', ratingValue: 5
        }, { db: f.db, observability: observation });
        assert.equal(response.status, 200); assert.equal(response.body.success, true);
        const sourceId = response.body.data.interactionId;
        assert.equal(f.data.interactions.length, 1); assert.equal(String(f.data.interactions[0]._id), sourceId);
        assert.equal(f.data.ai_jobs.length, 1); assert.equal(f.data.ai_jobs[0].source.documentId, sourceId);
        assert.equal(f.data.child_interests[0].confidence.evidenceCount, beforeCount + 1);
        assert.equal(f.data.graph_sync_queue.length, 1);
        const jobId = String(f.data.graph_sync_queue[0]._id);
        const committed = copy(f.data); committed.graph_sync_queue = [];
        const writes = f.writes.length;
        const correlationId = records[0]?.correlationId ?? 'acceptance_correlation';
        // A background worker clears any active requestId. Correlation is passed
        // through the existing observation seam, not written into business data.
        const execute = options => runRequest(() => processQueue(options, { ...observation, correlationId }), observation);
        await execute({ jobIds: [jobId] });
        assert.equal(calls, 1); assert.equal(f.data.graph_sync_queue[0].status, 'FAILED');
        assert.equal(graph.size, 1); // uncertain outcome: graph write already applied
        let after = copy(f.data); after.graph_sync_queue = [];
        assert.deepEqual(after, committed);
        await execute({ jobIds: [jobId] });
        assert.equal(calls, 1); // normal PENDING consumption never retries FAILED
        failing = false;
        await execute({ jobIds: [jobId], retryFailed: true });
        assert.equal(calls, 2); assert.equal(f.data.graph_sync_queue[0].status, 'PROCESSED');
        await execute({ jobIds: [jobId], retryFailed: true });
        assert.equal(calls, 2); // completed jobs remain excluded
        assert.equal(f.data.graph_sync_queue.length, 1); assert.equal(String(f.data.graph_sync_queue[0]._id), jobId);
        assert.equal(graph.size, 1); assert.equal(graph.values().next().value.evidenceCount, beforeCount + 1);
        after = copy(f.data); after.graph_sync_queue = []; assert.deepEqual(after, committed);
        assert.deepEqual(f.writes.slice(writes).map(row => [row.name, row.op]),
            [['graph_sync_queue', 'update'], ['graph_sync_queue', 'update']]);
        assert(traces.every(trace => trace.correlationId === correlationId && trace.requestId === undefined));
        f.assertClosed();
        if (!broken) {
            const api = records.filter(record => record.component === 'ProductAPI');
            assert.equal(api.length, 2); assert(api.every(record => record.requestId && record.correlationId));
            const events = records.filter(record => record.component === 'GraphSync');
            assert.deepEqual(events.map(record => record.event), ['OPERATION_STARTED', 'OPERATION_FAILED', 'OPERATION_STARTED', 'OPERATION_COMPLETED']);
            assert.equal(events[1].failureCategory, FAILURE_CATEGORY.TIMEOUT_FAILURE);
            assert.equal(events[1].stateStatus, STATE_STATUS.UNKNOWN);
            assert(events.every(record => record.correlationId === correlationId && record.requestId === undefined && record.context.jobId === jobId));
        }
        if (!['broken-metrics', 'broken-both'].includes(mode)) {
            const metrics = collector.snapshot();
            const worker = metrics.find(row => row.component === 'GraphSync');
            assert.equal(worker.total, 2); assert.deepEqual(worker.outcomes, { SUCCESS: 1, FAILURE: 1, DEGRADED: 0 });
            assert.equal(worker.durationMs.count, 2); assert(worker.durationMs.total > 0);
            assert.equal(metrics.find(row => row.component === 'ProductAPI').outcomes.SUCCESS, 1);
            assert.equal(metrics.find(row => row.component === 'ContinuousLearning').outcomes.SUCCESS, 1);
        }
        return { apiStatus: response.status, learningJobs: f.data.ai_jobs.length, interactions: f.data.interactions.length,
            queueJobs: f.data.graph_sync_queue.length, queueStatus: f.data.graph_sync_queue[0].status,
            graphEdges: graph.size, graphCalls: calls, evidenceDelta: f.data.child_interests[0].confidence.evidenceCount - beforeCount,
            interestScore: f.data.child_interests[0].interestScore.currentScore,
            confidence: f.data.child_interests[0].confidence.currentScore,
            preferences: copy(f.data.children[0].preferences), developmentProfile: copy(f.data.children[0].developmentProfile) };
    }
}
let activeFixture, activeGraph;
async function main() {
    assert.equal(process.argv.length, 2, 'Run without live flags or extra arguments');
    const phase6 = ['phase6D1ReliabilityFailureModel', 'phase6D2StructuredLoggingTracing', 'phase6D3HealthChecks',
        'phase6D4RuntimeMetrics', 'phase6D5ResilienceRecovery', 'phase6D6PerformanceLoad'];
    for (const file of phase6) run(`src/tests/systemTestV1/${file}.js`);
    const mongoKey = require.resolve('../../config/mongodb'), graphKey = require.resolve('../../config/neo4j');
    const savedMongo = require.cache[mongoKey], savedGraph = require.cache[graphKey];
    require.cache[mongoKey] = { exports: { getDatabase: () => activeFixture.db } };
    require.cache[graphKey] = { exports: { session: () => ({ run: (...args) => activeGraph(...args), async close() {} }) } };
    const originalLog = console.log;
    global.Date = FixedDate;
    try {
        console.log = () => {}; // suppress existing builder output only
        const normal = await story('normal');
        for (const mode of ['broken-logger', 'broken-metrics', 'broken-both']) assert.deepEqual(await story(mode), normal);
    } finally {
        global.Date = RealDate; console.log = originalLog;
        if (savedMongo) require.cache[mongoKey] = savedMongo; else delete require.cache[mongoKey];
        if (savedGraph) require.cache[graphKey] = savedGraph; else delete require.cache[graphKey];
    }
    console.log('PASS integrated committed learning / graph failure / explicit recovery / observer isolation');
    // Existing product aggregate plus focused gaps; D1–D5 already execute API,
    // replay and learning regression suites, so no artificial A–Z duplication.
    run('src/tests/systemTestV1/phase4D7ProductClosedLoop.js');
    for (const file of ['testChildIntelligenceApi', 'testScoringContract', 'testFullScoringIntegration', 'testRanking',
        'testFullRankingIntegration', 'testParentDecisionContinuousLearning', 'testPreferenceDecisionTransition',
        'testGoalDecisionTransition', 'testAnswerInterpretationService', 'testOutcomeLearningRuleEngine']) run(`src/tests/${file}.js`);
    console.log('LIVE MongoDB/Neo4j/Gemini coverage: SKIPPED (not required for deterministic acceptance)');
    console.log('Known concurrency/recovery limitations remain; no production capacity or SLA claim.');
    console.log('PHASE 6 D7 RELIABILITY & SCALE FINAL ACCEPTANCE: PASS');
    console.log('PHASE 6 RELIABILITY, OBSERVABILITY & SCALE: COMPLETE');
}
main().catch(error => {
    global.Date = RealDate; console.error(error);
    console.log('PHASE 6 D7 RELIABILITY & SCALE FINAL ACCEPTANCE: FAIL');
    console.log('PHASE 6 RELIABILITY, OBSERVABILITY & SCALE: NOT COMPLETE');
    process.exitCode = 1;
});
