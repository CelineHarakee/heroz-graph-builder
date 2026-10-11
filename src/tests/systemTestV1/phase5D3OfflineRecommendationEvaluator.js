const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const Module = require('node:module');
const { runBaseline, formatBaseline } = require('../../evaluation/offlineRecommendationEvaluator');
const { createEvaluationDatasetV1 } = require('../../evaluation/datasets/evaluationDatasetV1');
const metrics = require('../../evaluation/evaluationMetrics');
const { SCORING_WEIGHTS } = require('../../recommendation/scoringContract');
const protectedModules = ['../../evaluation/evaluationRunner', '../../evaluation/evaluationMetrics', '../../evaluation/datasets/evaluationDatasetV1',
    '../../recommendation/recommendationEngineService', '../../recommendation/recommendationContextService', '../../recommendation/recommendationDataService',
    '../../recommendation/scoringContract', '../../recommendation/finalScoreService', '../../recommendation/rankingService', '../../recommendation/selectionService'];
const hashes = () => protectedModules.map(name => createHash('sha256').update(readFileSync(require.resolve(name))).digest('hex'));
const ids = ['C1', 'C2', 'C3', 'C4', 'P1', 'P2', 'P3', 'P4', 'R1', 'R2', 'R3', 'R4'];
let passed = 0;
function check(label, fn) { fn(); passed++; console.log(`${label}: PASS`); }
async function main() {
    const beforeFiles = hashes(), weights = { ...SCORING_WEIGHTS }, load = Module._load;
    const result = await runBaseline();
    const repeated = await runBaseline();
    const rawBefore = JSON.stringify(result), report = formatBaseline(result);
    const data = createEvaluationDatasetV1();
    const summaries = [result.overall, ...Object.values(result.segments)];
    check('A. Dataset version', () => assert.equal(result.datasetVersion, 'evaluation-dataset-v1'));
    check('B. Official K values', () => assert.deepEqual(result.requestedKs, [1, 3, 5]));
    check('C. Twelve cases evaluated', () => assert.equal(result.cases.length, 12));
    check('D. Expected case identities', () => assert.deepEqual(result.cases.map(c => c.caseId), ids));
    check('E. Profile split', () => Object.values(result.segments).forEach(s => assert.equal(s.caseCount, 4)));
    check('F. Actual engine and controlled discovery', () => { assert.equal(result.execution.engineCalls, 12); assert.equal(result.execution.discoveryCalls, 12); assert.ok(result.execution.databaseReads > 0); });
    check('G. D1 metric semantics reused', () => {
        for (const c of result.cases) {
            const source = data.cases.find(s => s.caseId === c.caseId);
            const eligible = source.candidates.filter(a => c.eligibleActivityIds.includes(a.activityId));
            for (const k of result.requestedKs) {
                assert.equal(c.metricsByK[k].relevance, metrics.relevanceAtK(c.recommendations, k));
                assert.equal(c.metricsByK[k].ndcg, metrics.ndcgAtK(c.recommendations, eligible, k));
                assert.equal(c.metricsByK[k].diversity, metrics.diversityAtK(c.recommendations, k));
            }
        }
    });
    check('H. Overall result', () => assert.equal(result.overall.caseCount, 12));
    check('I. Profile-state summaries', () => assert.deepEqual(Object.keys(result.segments), ['COLD_START', 'PARTIAL_KNOWLEDGE', 'RICH_KNOWLEDGE']));
    check('J. Individual result detail', () => result.cases.forEach(c => {
        assert.equal(c.recommendations.length, 5);
        c.recommendations.forEach((r, i) => { assert.equal(r.rank, i + 1); assert.equal(typeof r.score, 'number'); assert.ok(r.factors && r.evidence); assert.equal(typeof r.expectedRelevance, 'number'); assert.ok(r.relevanceReason); assert.equal(typeof r.isExploratory, 'boolean'); });
    }));
    for (const [label, key] of [['K. Relevance at each K', 'relevance'], ['L. NDCG at each K', 'ndcg'], ['M. Diversity at each K', 'diversity']]) check(label, () => {
        for (const summary of summaries) for (const k of result.requestedKs) assert.ok(Object.hasOwn(summary.metricsByK[k], key));
    });
    check('N. Diversity@1 N/A', () => result.cases.forEach(c => assert.equal(c.metricsByK[1].diversity, null)));
    check('O. Coverage', () => { result.cases.forEach(c => assert.equal(c.recommendationCoverage, metrics.recommendationCoverage([c]))); assert.equal(result.overall.recommendationCoverage, metrics.recommendationCoverage(result.cases)); });
    check('P. Exploration rate', () => result.cases.forEach(c => assert.equal(c.explorationRelevanceRate, metrics.explorationRelevanceRate(c.recommendations))));
    check('Q. Applicable-only means and null', () => {
        for (const [state, summary] of [['overall', result.overall], ...Object.entries(result.segments)]) {
            const cases = state === 'overall' ? result.cases : result.cases.filter(c => c.profileState === state);
            for (const k of result.requestedKs) for (const metric of ['relevance', 'ndcg', 'diversity']) {
                const values = cases.map(c => c.metricsByK[k][metric]);
                assert.equal(summary.metricsByK[k][metric].value, metrics.applicableMean(values));
                assert.equal(summary.metricsByK[k][metric].applicableCases, values.filter(v => v !== null).length);
            }
            assert.equal(summary.metricsByK[1].diversity.value, null);
        }
    });
    check('R. Raw precision', () => {
        assert.ok(result.cases.some(c => c.metricsByK[3].ndcg !== Number(c.metricsByK[3].ndcg.toFixed(3))));
        assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
    });
    check('S. N/A display', () => assert.match(report, /Diversity\s+N\/A/));
    check('T. Formatter is read-only and rounded', () => { assert.equal(JSON.stringify(result), rawBefore); assert.ok(report.includes(result.overall.metricsByK[3].ndcg.value.toFixed(3))); });
    const p2 = result.cases.find(c => c.caseId === 'P2'), sourceP2 = data.cases.find(c => c.caseId === 'P2');
    check('U. Full-session candidate excluded', () => assert.ok(!p2.recommendations.some(r => r.activityId === sourceP2.candidates[1].activityId)));
    check('V. Eligible ideal ranking through D1', () => {
        assert.equal(p2.eligibleActivityIds.length, 5); assert.ok(!p2.eligibleActivityIds.includes(sourceP2.candidates[1].activityId));
        assert.equal(sourceP2.candidates[1].expectedRelevance, 3);
        const eligible = sourceP2.candidates.filter(a => p2.eligibleActivityIds.includes(a.activityId));
        assert.equal(p2.metricsByK[5].ndcg, metrics.ndcgAtK(p2.recommendations, eligible, 5));
        assert.notEqual(p2.metricsByK[5].ndcg, metrics.ndcgAtK(p2.recommendations, sourceP2.candidates, 5));
    });
    check('W. Case/process isolation', () => { assert.deepEqual(result.execution.caseIds, ids); assert.equal(Module._load, load); assert.equal(result.execution.fixtureStateUnchanged, true); });
    check('X. Repeated complete baseline deterministic', () => assert.deepEqual(repeated, result));
    check('Y. No intelligence mutations', () => { assert.deepEqual(result.execution.forbiddenOperations, []); assert.deepEqual(createEvaluationDatasetV1(), data); });
    check('Z. No external language execution', () => assert.match(result.execution.infrastructure, /external language provider disabled/));
    check('AA. Frozen weights unchanged', () => { assert.deepEqual(SCORING_WEIGHTS, weights); assert.deepEqual(result.recommendationConfiguration.weights, weights); assert.equal(result.execution.configurationUnchanged, true); });
    check('AB. Recommendation/D1/D2 files unchanged', () => assert.deepEqual(hashes(), beforeFiles));
    check('AC. No persistence collections', () => { assert.deepEqual(result.execution.forbiddenOperations, []); assert.ok(data.cases.every(c => !Object.hasOwn(c.fixture, 'evaluation_runs') && !Object.hasOwn(c.fixture, 'benchmark_results') && !Object.hasOwn(c.fixture, 'experiment_results'))); });
    check('AD. Fixed baseline only, no tuning', () => { assert.equal(result.recommendationConfiguration.id, 'FROZEN_V1_SIX_FACTOR'); assert.equal(result.execution.engineCalls, result.cases.length); });
    assert.equal(passed, 30);
    console.log('30/30 D3 validation groups passed. Quality values have no pass/fail thresholds.');
    console.log('PHASE 5 D3 OFFLINE RECOMMENDATION EVALUATOR: PASS');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
