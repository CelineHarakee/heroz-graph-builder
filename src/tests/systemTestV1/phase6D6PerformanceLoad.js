// Controlled in-process benchmarks. No production capacity/SLA claims.
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const fs = require('node:fs');
const { ObjectId } = require('mongodb');
const { fixture, copy, FixedDate, RealDate, tick } = require('./fixtures/phase6LoadFixture');
const { createMetricsCollector } = require('../../observability/runtimeMetrics');
const { runBackground } = require('../../observability/traceContext');
let f;
const graph = new Map();
let graphCalls = 0;
// Existing module substitution convention: only external I/O/discovery replaced.
require.cache[require.resolve('../../config/mongodb')] = { exports: { getDatabase: () => f.db } };
require.cache[require.resolve('../../config/neo4j')] = { exports: { session: () => ({
    async run(query, params) {
        await tick(); graphCalls++;
        assert.match(query, /MERGE \(c\)-\[r:LIKES\]->\(s\)/);
        graph.set(`${params.childId}:${params.subcategoryId}`, copy(params));
        return { records: [{}] };
    }, async close() { await tick(); }
}) } };
require.cache[require.resolve('../../traversal/traversalService')] = { exports: {
    async findCandidateActivities(childId) {
        await tick(); assert.equal(String(childId), String(f.ids.child));
        return f.data.activities.map(activity => ({ activity: { activityId: String(activity._id) },
            evidence: { interests: [], goals: [], summary: [] } }));
    }
} };
const { createRecommendationEngine } = require('../../recommendation/recommendationEngineService');
const { handleRecommendations } = require('../../api/v1/recommendations');
const { handleInteraction } = require('../../api/v1/interactions');
const { handleNextQuestion } = require('../../api/v1/adaptiveQuestions');
const { handleQuestionAnswer } = require('../../api/v1/questionAnswers');
const { processContinuousLearningSource } = require('../../learning/continuousLearningService');
const { processQueue } = require('../../workers/queueWorker');
const { normalizeInteraction } = require('../../learning/eventNormalizer');
const { getLearningInstruction } = require('../../learning/learningRuleEngine');
const { calculateNextInterestState } = require('../../learning/interestStateTransition');
const rows = [];
const ok = response => {
    assert.equal(response.status, 200, JSON.stringify(response));
    assert.equal(response.body.success, true); return response.body.data;
};
const observed = metrics => ({ metrics, logger: { log() {} } });

async function load(scenario, concurrency, task, metrics, verify) {
    const latencies = [], outcomes = [];
    let active = 0, maxInFlight = 0;
    const start = performance.now();
    // Exactly one bounded cohort; no scheduler, sleeps, or unbounded retries.
    await Promise.all(Array.from({ length: concurrency }, async (_, index) => {
        active++; maxInFlight = Math.max(maxInFlight, active);
        const begin = performance.now();
        try { outcomes[index] = await task(index); }
        finally { latencies[index] = performance.now() - begin; active--; }
    }));
    const elapsedMs = performance.now() - start;
    await verify(outcomes);
    f.assertClosed();
    const success = outcomes.filter(result => result.success).length;
    const metricRows = metrics.snapshot();
    assert(metricRows.length > 0);
    for (const row of metricRows) {
        assert.equal(row.total, scenario === 'question-answer-first' && row.component === 'ContinuousLearning' ? 1 : concurrency,
            `${scenario}: D4 operation count`);
        assert.equal(row.total, Object.values(row.outcomes).reduce((a, b) => a + b, 0));
        assert.equal(row.total, row.durationMs.count);
    }
    const boundary = metricRows.find(row => row.component === 'ProductAPI') ?? metricRows[0];
    assert.equal(boundary.outcomes.SUCCESS, success);
    assert.equal(boundary.outcomes.FAILURE, outcomes.length - success);
    const result = { scenario, concurrency, operations: concurrency, completed: outcomes.length,
        success, failure: outcomes.length - success, maxInFlight,
        elapsedMs, latencyMs: { min: Math.min(...latencies), mean: latencies.reduce((a, b) => a + b, 0) / latencies.length, max: Math.max(...latencies) },
        throughputOpsPerSecond: concurrency / (elapsedMs / 1000),
        successfulOpsPerSecond: success / (elapsedMs / 1000),
        outcomes: outcomes.map(value => value.outcome), transactionConflicts: f.stats.conflicts,
        duplicateInsertFailures: f.stats.duplicateInserts,
        maxActiveTransactions: f.stats.maxActive, metrics: metricRows };
    assert.equal(result.maxInFlight, concurrency);
    for (const number of [elapsedMs, result.throughputOpsPerSecond, ...Object.values(result.latencyMs)]) assert(Number.isFinite(number) && number > 0);
    rows.push(result);
}
function fresh() { f = fixture(); graph.clear(); graphCalls = 0; return createMetricsCollector(); }
function apiResult(response) { return { success: response.status === 200, outcome: String(response.status), response }; }
function learningResult(response) {
    const result = response.results[0];
    return { success: ['APPLIED', 'IGNORED'].includes(result.status), outcome: result.reasonCode, result };
}
function assertLearning(count, before) {
    const interest = f.data.child_interests[0];
    const applied = f.data.ai_jobs.filter(job => job.outcome === 'APPLIED');
    assert.equal(applied.length, count);
    assert.equal(new Set(applied.map(job => job.idempotencyKey)).size, count);
    assert.equal(interest.confidence.evidenceCount, before.confidence.evidenceCount + count);
    assert.equal(interest.scoreHistory.length, before.scoreHistory.length + count);
    assert.equal(new Set(interest.scoreHistory.map(item => item.eventId)).size, interest.scoreHistory.length);
    assert.equal(f.data.graph_sync_queue.length, count);
    assert.equal(new Set(f.data.graph_sync_queue.map(job => String(job._id))).size, count);
    // Recompute the committed sequence with the existing rule/transition modules.
    let expected = before;
    for (const entry of interest.scoreHistory.slice(before.scoreHistory.length)) {
        const source = f.data.interactions.find(source => String(source._id) === entry.eventId);
        assert(source); const event = { ...normalizeInteraction(source), subcategoryId: String(f.ids.subcategory) };
        expected = calculateNextInterestState(expected, getLearningInstruction(event), event).state;
    }
    assert.equal(interest.interestScore.currentScore, expected.interestScore.currentScore);
    assert.equal(interest.confidence.currentScore, expected.confidence.currentScore);
}
async function recommendations(n) {
    const metrics = fresh();
    const low = copy(f.data.activities[0]); low._id = new ObjectId(); low.experience.socialStyle = 'Individual';
    const blocked = copy(f.data.activities[0]); blocked._id = new ObjectId(); blocked.eligibility.allowedGenders = ['Male'];
    f.data.activities.push(low, blocked);
    for (const activity of [low, blocked]) f.data.sessions.push({ ...copy(f.data.sessions[0]), _id: new ObjectId(), activityId: activity._id });
    const engine = createRecommendationEngine({ languageProvider: null });
    const options = { db: f.db, observability: observed(metrics), generateRecommendations: engine.generateRecommendations };
    const call = () => handleRecommendations(String(f.ids.child), 3, options);
    const reference = ok(await call());
    assert.equal(reference.recommendations.length, 2);
    assert.equal(reference.recommendations[0].activityId, String(f.ids.activity));
    assert(reference.recommendations[0].score > reference.recommendations[1].score);
    f.data.recommendations.length = 0;
    const before = copy(f.data);
    const measuredMetrics = createMetricsCollector(); options.observability = observed(measuredMetrics);
    await load('recommendations', n, async () => apiResult(await call()), measuredMetrics, outcomes => {
        outcomes.forEach(({ response }) => assert.deepEqual(ok(response), reference));
        assert.equal(f.data.recommendations.length, n);
        assert.equal(new Set(f.data.recommendations.map(row => String(row._id))).size, n);
        const after = copy(f.data); after.recommendations = [];
        assert.deepEqual(after, before); // only original snapshot/explanation writes
    });
}
async function interactions(n, replay) {
    const metrics = fresh(), before = copy(f.data.child_interests[0]);
    const source = { _id: new ObjectId(), actor: { childId: f.ids.child }, targetEntity: { entityId: f.ids.activity },
        interactionDetails: { interactionType: 'Rate', ratingValue: 5 }, timestamp: new Date() };
    if (replay) f.data.interactions.push(source);
    const children = copy(f.data.children);
    const learning = new Map();
    await load(replay ? 'interaction-replay' : 'interaction-submission', n, async () => replay
        ? runBackground(async () => learningResult(await processContinuousLearningSource('Interaction', source, { db: f.db })), observed(metrics))
        : apiResult(await handleInteraction(String(f.ids.child), { activityId: String(f.ids.activity), interactionType: 'Rate', ratingValue: 5 },
            { db: f.db, observability: observed(metrics), async processContinuousLearningSource(type, source, options) {
                const response = await processContinuousLearningSource(type, source, options);
                learning.set(String(source._id), response.results[0]); return response;
            } })), metrics, outcomes => {
        const applied = f.data.ai_jobs.length;
        assert.equal(f.stats.maxActive, n, 'overlapping real persistence transactions');
        assertLearning(replay ? 1 : applied, before);
        assert.deepEqual(f.data.children, children);
        assert.equal(f.data.interactions.length, replay ? 1 : n);
        assert.equal(new Set(f.data.interactions.map(source => String(source._id))).size, replay ? 1 : n);
        if (replay) {
            assert.equal(outcomes.filter(value => value.result.status === 'APPLIED').length, 1);
            assert(outcomes.every(value => value.success));
            assert(f.data.ai_jobs.every(job => job.source.documentId === String(source._id)));
        } else {
            assert.equal(applied, Math.min(n, 3), 'existing three-attempt conflict bound');
            assert.equal(outcomes.filter(value => value.success).length, applied);
            assert(outcomes.every(value => value.success || value.response.status === 500));
            assert.equal(learning.size, n);
            for (const result of learning.values()) {
                assert(result.status === 'APPLIED' || (result.status === 'FAILED' && result.reasonCode === 'CONCURRENT_RETRY_EXHAUSTED'));
            }
            for (const { response } of outcomes.filter(value => value.success)) {
                const identity = ok(response).interactionId;
                assert(f.data.interactions.some(source => String(source._id) === identity));
            }
        }
    });
}
async function questions(n) {
    const metrics = fresh(), before = copy(f.data.children);
    await load('adaptive-question', n, async () => apiResult(await handleNextQuestion(String(f.ids.child),
        { activityId: String(f.ids.activity), sessionId: String(f.ids.session) }, { db: f.db, observability: observed(metrics) })), metrics, outcomes => {
        outcomes.forEach(value => {
            const data = ok(value.response); assert.equal(data.question.questionId, 'Q_PREF_ENVIRONMENT_001');
            assert(f.data.question_history.some(row => String(row._id) === data.questionHistoryId && row.outcome === 'PRESENTED'));
        });
        assert.equal(f.data.question_history.length, n); // documented check/insert race
        assert.equal(new Set(f.data.question_history.map(row => String(row._id))).size, n);
        assert.deepEqual(f.data.children, before); assert.equal(f.data.ai_jobs.length, 0);
    });
}
async function answers(n, replay) {
    const metrics = fresh();
    const history = { _id: new ObjectId(), childId: f.ids.child, parentId: f.ids.parent, questionId: 'Q_PREF_ENVIRONMENT_001',
        askedAt: new Date(), outcome: 'PRESENTED', sessionId: String(f.ids.session) };
    f.data.question_history.push(history);
    const options = { db: f.db, observability: observed(metrics) };
    const call = () => handleQuestionAnswer(String(history._id), { answer: 'Outdoor' }, options);
    if (replay) ok(await call());
    const before = copy(f.data), measuredMetrics = createMetricsCollector(); options.observability = observed(measuredMetrics);
    await load(replay ? 'question-answer-replay' : 'question-answer-first', n, async () => apiResult(await call()), measuredMetrics, outcomes => {
        assert(outcomes.some(value => value.success));
        assert(outcomes.every(value => value.success || value.response.status === 500));
        assert.equal(outcomes.filter(value => !value.success).length, replay ? 0 : n - 1);
        assert.equal(f.stats.duplicateInserts, replay ? 0 : n - 1);
        assert.equal(f.data.parent_decisions.length, 1); assert.equal(f.data.ai_jobs.length, 1);
        assert.equal(f.data.children[0].preferences.environment.value, 'Outdoor');
        assert.equal(f.data.question_history[0].outcome, 'ANSWERED');
        assert.equal(f.data.ai_jobs[0]._id.toString(), f.data.parent_decisions[0]._id.toString());
        assert.equal(f.data.graph_sync_queue.length, 0); // preference does not need graph work
        assert.deepEqual(f.data.child_interests, before.child_interests);
        for (const name of Object.keys(before).filter(name => !['children', 'question_history', 'parent_decisions', 'ai_jobs'].includes(name))) {
            assert.deepEqual(f.data[name], before[name], `question answer leaves ${name} unchanged`);
        }
        if (replay) { assert(outcomes.every(value => value.success)); assert.deepEqual(f.data, before); }
    });
}
async function workers(n, overlap) {
    const metrics = fresh(), before = copy(f.data.child_interests);
    const jobs = Array.from({ length: overlap ? 1 : n }, () => ({ _id: new ObjectId(), entityType: 'ChildInterest',
        entityId: f.ids.interest, operation: 'UPDATE', status: overlap ? 'FAILED' : 'PENDING' }));
    f.data.graph_sync_queue.push(...jobs);
    const authoritative = copy(f.data); authoritative.graph_sync_queue = [];
    await load(overlap ? 'graph-failed-job-recovery-overlap' : 'graph-worker-disjoint', n, async index => {
        const job = jobs[overlap ? 0 : index];
        await processQueue({ jobIds: [job._id], ...(overlap ? { retryFailed: true } : {}) }, observed(metrics));
        return { success: true, outcome: 'PROCESSED' };
    }, metrics, () => {
        assert.equal(f.data.graph_sync_queue.length, jobs.length);
        assert(f.data.graph_sync_queue.every(job => job.status === 'PROCESSED'));
        assert.equal(graph.size, 1); assert.equal(graphCalls, n); // no worker claim/lease
        assert.equal(graph.values().next().value.evidenceCount, before[0].confidence.evidenceCount);
        assert.deepEqual(f.data.child_interests, before); assert.equal(f.data.ai_jobs.length, 0);
        const after = copy(f.data); after.graph_sync_queue = [];
        assert.deepEqual(after, authoritative);
    });
    const calls = graphCalls;
    await processQueue({ jobIds: jobs.map(job => job._id), retryFailed: true }, observed(metrics));
    assert.equal(graphCalls, calls); // D5 excludes completed work
}
async function main() {
    assert(process.argv.length === 2 || (process.argv.length === 4 && process.argv[2] === '--report'), 'Usage: node phase6D6PerformanceLoad.js [--report path]');
    global.Date = FixedDate;
    const output = console.log; console.log = () => {}; // suppress builder output, no parallel sink architecture
    try {
        for (const n of [1, 4, 8]) {
            await recommendations(n); await interactions(n, false); await interactions(n, true);
            await questions(n); await answers(n, false); await answers(n, true);
            await workers(n, false); await workers(n, true);
        }
    } finally { global.Date = RealDate; console.log = output; }
    const report = { scope: 'Deterministic in-process fixture; NOT production capacity or an SLA',
        loadLevels: [1, 4, 8], scenarios: rows,
        limitations: ['No live MongoDB/Neo4j/LLM/network measurements', 'Optimistic transaction fixture models document write conflicts only',
            'Concurrent first answers can fail safely on duplicate source insert', 'Concurrent question presentation can create multiple history records',
            'Overlapping workers can process one job multiple times; MERGE keeps one logical edge',
            'Three-attempt D7 conflict exhaustion can leave stored interactions requiring explicit identity-preserving recovery'] };
    if (process.argv[2] === '--report') fs.writeFileSync(process.argv[3], JSON.stringify(report, null, 2) + '\n');
    console.table(rows.map(row => ({ path: row.scenario, concurrency: row.concurrency, operations: row.operations,
        success: row.success, failure: row.failure, elapsedMs: +row.elapsedMs.toFixed(3), meanLatencyMs: +row.latencyMs.mean.toFixed(3),
        opsPerSecond: +row.throughputOpsPerSecond.toFixed(1), conflicts: row.transactionConflicts })));
    console.log('Measurements describe the controlled fixture, NOT production capacity. No speed thresholds.');
    console.log('PHASE 6 D6 PERFORMANCE & LOAD TESTING: PASS');
}
main().catch(error => { global.Date = RealDate; console.error(error); process.exitCode = 1; });
