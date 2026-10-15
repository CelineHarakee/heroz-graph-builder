const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { ObjectId } = require('mongodb');
const { createMetricsCollector } = require('../../observability/runtimeMetrics');
const { currentTrace } = require('../../observability/traceContext');
const { createReliabilityFailure, FAILURE_CATEGORY, STATE_STATUS } = require('../../reliability/reliabilityFailure');

async function main() {
    const id = () => new ObjectId();
    const childId = id(), subcategoryId = id(), interestId = id();
    const job = { _id: id(), entityType: 'ChildInterest', entityId: interestId, status: 'FAILED', correlationId: 'original-correlation' };
    const unrelated = { ...job, _id: id() };
    const pending = { ...job, _id: id(), status: 'PENDING' };
    const processed = { ...job, _id: id(), status: 'PROCESSED' };
    const jobs = [job, unrelated, pending, processed];
    const interest = { _id: interestId, childId, subcategoryId, interestScore: { currentScore: 0.7 }, confidence: { currentScore: 0.8, evidenceCount: 4 } };
    const graph = new Map();
    let calls = 0, fail = false, accesses = 0;
    const queries = [], traces = [];
    const db = { collection(name) {
        accesses++;
        if (name === 'graph_sync_queue') return {
            find(filter) { queries.push(filter); return { toArray: async () => jobs.filter(row => row.status === filter.status &&
                (!filter._id || filter._id.$in.some(value => value.equals(row._id)))).map(row => ({ ...row })) }; },
            async updateOne(filter, update) {
                const row = jobs.find(value => value._id.equals(filter._id));
                Object.assign(row, update.$set); return { matchedCount: 1 };
            }
        };
        return { async findOne() {
            if (name === 'child_interests') return interest;
            if (name === 'children') return { _id: childId };
            if (name === 'subcategories') return { _id: subcategoryId };
            throw Error(`Unexpected read ${name}`);
        } };
    } };
    // Real worker, graph service and LIKES builder; only dependency I/O is replaced.
    require.cache[require.resolve('../../config/mongodb')] = { exports: { getDatabase: () => db } };
    require.cache[require.resolve('../../config/neo4j')] = { exports: { session: () => ({
        async run(query, params) {
            calls++; traces.push(currentTrace());
            assert.match(query, /MERGE \(c\)-\[r:LIKES\]->\(s\)/);
            graph.set(`${params.childId}:${params.subcategoryId}`, { ...params });
            // Model server-side success followed by a lost response.
            if (fail) throw createReliabilityFailure({
                category: FAILURE_CATEGORY.TIMEOUT_FAILURE, stateStatus: STATE_STATUS.UNKNOWN,
                component: 'GraphSync', operation: 'processJob', message: 'uncertain graph response', retryable: true
            });
            return { records: [{}] };
        }, async close() {}
    }) } };
    const { processQueue } = require('../../workers/queueWorker');
    const metrics = createMetricsCollector();
    const observation = { logger: { log() {} }, metrics };
    const recover = () => processQueue({ jobIds: [job._id, job._id], retryFailed: true }, observation);
    for (const options of [{ retryFailed: true }, { jobIds: [job._id], retryFailed: 'yes' }, { jobIds: ['bad'], retryFailed: true }]) {
        await assert.rejects(processQueue(options), TypeError);
    }
    assert.equal(accesses, 0);
    const authoritativeBefore = JSON.stringify(interest);
    fail = true;
    await recover();
    assert.equal(calls, 1); // no automatic retry even after uncertain write
    assert.equal(job.status, 'FAILED');
    assert.equal(graph.size, 1); // partial graph write retained
    assert.equal(JSON.stringify(interest), authoritativeBefore);
    fail = false;
    await recover();
    assert.equal(calls, 2);
    assert.equal(job.status, 'PROCESSED');
    assert.equal(graph.size, 1); // same logical edge, same queue ID
    assert.equal(graph.values().next().value.evidenceCount, 4);
    assert.equal(JSON.stringify(interest), authoritativeBefore);
    await recover();
    assert.equal(calls, 2); // completed jobs cannot be replayed by recovery
    assert.equal(unrelated.status, 'FAILED');
    assert.equal(pending.status, 'PENDING');
    assert.equal(processed.status, 'PROCESSED');
    assert(queries.every(query => query.status === 'FAILED' && query._id.$in.length === 1 && query._id.$in[0].equals(job._id)));
    assert(traces.every(trace => trace.correlationId === job.correlationId && trace.requestId === undefined));
    const row = metrics.snapshot().find(row => row.component === 'GraphSync');
    assert.equal(row.total, 2); assert.equal(row.outcomes.FAILURE, 1); assert.equal(row.outcomes.SUCCESS, 1);
    // A later recovery reads CURRENT Mongo state; broken observers cannot affect it.
    job.status = 'FAILED'; interest.interestScore.currentScore = 0.9;
    await processQueue({ jobIds: [job._id], retryFailed: true }, {
        logger: { log() { throw Error('logger'); } }, metrics: { record() { throw Error('metrics'); } }
    });
    assert.equal(job.status, 'PROCESSED'); assert.equal(calls, 3);
    assert.equal(graph.values().next().value.score, 0.9); assert.equal(graph.size, 1);

    // Actual traversal failure must propagate, with no fabricated candidate set.
    const activityQueries = require('../../traversal/queries/activityQueries');
    const goalQueries = require('../../traversal/queries/goalQueries');
    const failure = new Error('Neo4j discovery unavailable');
    let goalCalls = 0;
    activityQueries.findActivitiesByInterest = async () => { throw failure; };
    goalQueries.findActivitiesByGoal = async () => { goalCalls++; return []; };
    const traversal = require('../../traversal/traversalService');
    await assert.rejects(traversal.findCandidateActivities(childId), error => error === failure);
    assert.equal(goalCalls, 0);
    const { createRecommendationEngine } = require('../../recommendation/recommendationEngineService');
    const engine = createRecommendationEngine({
        buildRecommendationContext: () => traversal.findCandidateActivities(childId),
        evaluateRecommendationEligibility: () => assert.fail('eligibility after failed discovery'),
        persistRecommendationSnapshot: () => assert.fail('snapshot after failed discovery'),
        attachRecommendationExplanations: () => assert.fail('explanation after failed discovery')
    });
    await assert.rejects(engine.generateRecommendations(childId, 5), error => error === failure);

    // Existing deterministic fixtures exercise actual transactional guards,
    // stable source replay, bounded conflict retries and public safe failures.
    for (const file of ['testQueueWorker', 'testContinuousLearningService', 'testLearningPersistenceService',
        'testD7InterestLearningPipeline', 'testParentDecisionPersistenceService', 'testParentDecisionContinuousLearning',
        'testQuestionLearningIntegrationService', 'testQuestionAnswerApi', 'testInteractionApi', 'testRecommendationEngine']) {
        const result = spawnSync(process.execPath, [path.resolve(__dirname, '..', `${file}.js`)], { encoding: 'utf8', timeout: 30000 });
        assert.equal(result.status, 0, `${file}\n${result.stdout}\n${result.stderr}`);
        console.log(`PASS ${file}`);
    }
    console.log('PHASE 6 D5 RESILIENCE & RECOVERY: PASS');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
