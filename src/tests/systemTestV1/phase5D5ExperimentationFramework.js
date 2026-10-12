const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { validateExperiment, compareValue, runExperiment, formatExperiment } = require('../../evaluation/weightExperimentRunner');
const { runBaseline } = require('../../evaluation/offlineRecommendationEvaluator');
const { SCORING_WEIGHTS } = require('../../recommendation/scoringContract');
const { createEvaluationDatasetV1 } = require('../../evaluation/datasets/evaluationDatasetV1');
const metrics = require('../../evaluation/evaluationMetrics');
const CONTROL = { experimentId: 'D5_CONTROL_001', name: 'Controlled Weight Plumbing Verification',
    weights: { interest: .30, preference: .20, goal: .15, exploration: .15, behavior: .10, session: .10 } };
const factors = Object.keys(SCORING_WEIGHTS);
const input = weights => ({ experimentId: 'CHECK', name: 'Safety verification', weights });
const close = (a, b) => assert.ok(Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 1e-9);
const protectedFiles = ['recommendation/scoringContract', 'recommendation/finalScoreService', 'recommendation/recommendationEngineService',
    'recommendation/recommendationEligibilityService', 'recommendation/rankingService', 'recommendation/selectionService',
    ...['interest','preference','goal','exploration','behavior','session'].map(f => `recommendation/${f}FactorService`),
    'evaluation/evaluationMetrics', 'evaluation/datasets/evaluationDatasetV1', 'evaluation/factorWeightAnalyzer'];
const hashes = () => protectedFiles.map(f => createHash('sha256').update(readFileSync(require.resolve(`../../${f}`))).digest('hex'));
let passed = 0;
function check(label, fn) { fn(); passed++; console.log(`${label}: PASS`); }
function metricValues(summary, aggregate) {
    const value = v => aggregate ? v.value : v;
    return [...[1,3,5].flatMap(k => ['relevance','ndcg','diversity'].map(m => value(summary.metricsByK[k][m]))),
        summary.recommendationCoverage, value(summary.explorationRelevanceRate)];
}
function comparisons(c) {
    return [...[1,3,5].flatMap(k => ['relevance','ndcg','diversity'].map(m => c.metricsByK[k][m])), c.recommendationCoverage, c.explorationRelevanceRate];
}
function assertComparison(c, b, e, aggregate) {
    const bv = metricValues(b, aggregate), ev = metricValues(e, aggregate);
    comparisons(c).forEach((v,i) => assert.deepEqual(v, { baseline: bv[i], experiment: ev[i], delta: bv[i] === null || ev[i] === null ? null : ev[i]-bv[i] }));
}
async function main() {
    const beforeFiles = hashes(), weightsBefore = { ...SCORING_WEIGHTS }, data = createEvaluationDatasetV1(), dataBefore = JSON.stringify(data);
    const invalid = [];
    const reject = value => { assert.throws(() => validateExperiment(value), TypeError); invalid.push(value); };
    check('A. Exact canonical keys', () => { assert.deepEqual(Object.keys(validateExperiment(input(SCORING_WEIGHTS)).submittedWeights), factors); reject(input({ ...SCORING_WEIGHTS, vendor: 1 })); });
    check('B. Six required weights', () => factors.forEach(f => { const w = { ...SCORING_WEIGHTS }; delete w[f]; reject(input(w)); }));
    check('C. Numeric values', () => reject(input({ ...SCORING_WEIGHTS, interest: '0.33' })));
    check('D. Finite values', () => [NaN,Infinity,-Infinity].forEach(v => reject(input({ ...SCORING_WEIGHTS, interest: v }))));
    check('E. Non-negative', () => reject(input({ ...SCORING_WEIGHTS, interest: -1 })));
    check('F. Positive weight required', () => reject(input(Object.fromEntries(factors.map(f => [f,0])))));
    check('G. Identity required', () => [undefined,'','   ',2].forEach(v => reject({ ...input(SCORING_WEIGHTS), experimentId: v })));
    check('H. Name required', () => [undefined,'','   ',2].forEach(v => reject({ ...input(SCORING_WEIGHTS), name: v })));
    // Invalid inputs must not even launch a worker. execFile's implementation
    // resolves spawn dynamically; this test trap is restored before valid runs.
    const childProcess = require('node:child_process'), savedSpawn = childProcess.spawn;
    let spawned = 0;
    childProcess.spawn = () => { spawned++; throw new Error('Unexpected worker launch'); };
    try { for (const value of invalid) await assert.rejects(runExperiment(value), TypeError); }
    finally { childProcess.spawn = savedSpawn; }
    assert.equal(spawned,0);
    const first = await runBaseline();
    const equivalent = await runExperiment(input(SCORING_WEIGHTS));
    const scaledWeights = Object.fromEntries(factors.map(f => [f,SCORING_WEIGHTS[f]*100]));
    const scaled = await runExperiment(input(scaledWeights));
    const control = await runExperiment(CONTROL);
    const onlyBehavior = input(Object.fromEntries(factors.map(f => [f, f === 'behavior' ? 1 : 0])));
    const zero = await runExperiment(onlyBehavior);
    const final = await runBaseline();
    const repeatedZero = await runExperiment(onlyBehavior);
    const repeated = await runExperiment(CONTROL);
    const original = JSON.stringify(control), report = formatExperiment(control);
    check('I. Submitted weights copied', () => { const w = { ...CONTROL.weights }, validated = validateExperiment(input(w)); w.interest=99; assert.deepEqual(validated.submittedWeights,CONTROL.weights); });
    check('J. Normalized proportions', () => factors.forEach(f => close(scaled.experiment.normalizedWeights[f],equivalent.experiment.normalizedWeights[f])));
    check('K. Sum one not required', () => assert.deepEqual(scaled.experiment.submittedWeights,scaledWeights));
    check('L. Authoritative baseline', () => assert.deepEqual(control.baseline.configuration.weights,SCORING_WEIGHTS));
    check('M. Default D3 path', () => {assert.deepEqual(control.baseline.caseResults,first.cases);assert.deepEqual(control.baseline.metrics,first.overall);});
    check('N. Dataset preserved', () => {assert.equal(control.experimental.datasetVersion,data.datasetVersion);assert.equal(JSON.stringify(data),dataBefore);});
    check('O. Twelve cases', () => assert.deepEqual(control.experimental.caseResults.map(c=>c.caseId),data.cases.map(c=>c.caseId)));
    check('P. Reference time', () => assert.equal(control.experimental.evaluatedAt,first.evaluatedAt));
    check('Q. K values', () => assert.deepEqual(control.experimental.requestedKs,[1,3,5]));
    check('R. D1 metrics reused', () => {
        for (const result of [control,zero]) for (const side of [result.baseline,result.experimental]) {
            for (const c of side.caseResults) {
                const eligible=data.cases.find(s=>s.caseId===c.caseId).candidates.filter(a=>c.eligibleActivityIds.includes(a.activityId));
                for (const k of [1,3,5]) {
                    assert.equal(c.metricsByK[k].relevance,metrics.relevanceAtK(c.recommendations,k));
                    assert.equal(c.metricsByK[k].ndcg,metrics.ndcgAtK(c.recommendations,eligible,k));
                    assert.equal(c.metricsByK[k].diversity,metrics.diversityAtK(c.recommendations,k));
                }
            }
            assert.equal(side.metrics.recommendationCoverage,metrics.recommendationCoverage(side.caseResults));
        }
    });
    check('S. Same frozen pipeline', () => {assert.deepEqual(hashes(),beforeFiles);control.experimental.caseResults.forEach((c,i)=>assert.deepEqual(c.eligibleActivityIds,first.cases[i].eligibleActivityIds));});
    check('T. Factor values unchanged for shared activities', () => control.experimental.caseResults.forEach((c,i)=>c.recommendations.forEach(r=>{const old=first.cases[i].recommendations.find(a=>a.activityId===r.activityId);if(old) {assert.deepEqual(r.factors,old.factors);assert.deepEqual(r.evidence,old.evidence);}})));
    check('U. Experimental metadata', () => {assert.equal(control.experimental.configuration.id,CONTROL.experimentId);assert.deepEqual(control.experimental.configuration.weights,CONTROL.weights);control.experimental.caseResults.forEach(c=>c.recommendations.forEach(r=>r.scoring.contributions.forEach(v=>assert.equal(v.canonicalWeight,CONTROL.weights[v.factor]))));});
    check('V. Baseline metadata', () => assert.equal(control.baseline.configuration.id,'FROZEN_V1_SIX_FACTOR'));
    check('W. Overall comparison', () => assertComparison(control.comparison.overall,control.baseline.metrics,control.experimental.metrics,true));
    check('X. Profile comparisons', () => Object.keys(first.segments).forEach(s=>assertComparison(control.comparison.byProfileState[s],control.baseline.byProfileState[s],control.experimental.byProfileState[s],true)));
    check('Y. Case comparisons', () => control.baseline.caseResults.forEach((c,i)=>assertComparison(control.comparison.byCase[c.caseId],c,control.experimental.caseResults[i],false)));
    check('Z. Delta subtraction', () => assert.deepEqual(compareValue(.7,.9),{baseline:.7,experiment:.9,delta:.9-.7}));
    check('AA. Null and zero-weight coverage', () => {
        for (const [b,e] of [[null,.5],[.7,null],[null,null]]) assert.equal(compareValue(b,e).delta,null);
        assert.ok(zero.experimental.metrics.recommendationCoverage<1);
        const empty=zero.experimental.caseResults.find(c=>c.recommendations.length===0);
        assert.ok(empty);assert.equal(zero.comparison.byCase[empty.caseId].metricsByK[3].ndcg.delta,null);
        assertComparison(zero.comparison.overall,zero.baseline.metrics,zero.experimental.metrics,true);
    });
    check('AB. Ranked outputs retained', () => [control.baseline,control.experimental].forEach(s=>s.caseResults.forEach(c=>c.recommendations.forEach((r,i)=>{assert.equal(r.rank,i+1);assert.ok(r.activityId&&r.factors&&r.scoring);assert.equal(typeof r.score,'number');}))));
    check('AC. Baseline-equivalent complete experiment', () => {
        assert.deepEqual(equivalent.baseline.caseResults,equivalent.experimental.caseResults);
        assert.deepEqual(equivalent.baseline.metrics,equivalent.experimental.metrics);
        for (const c of [equivalent.comparison.overall,...Object.values(equivalent.comparison.byProfileState),...Object.values(equivalent.comparison.byCase)]) comparisons(c).forEach(v=>assert.equal(v.delta,v.baseline===null?null:0));
    });
    check('AD. Scale-equivalent complete experiment', () => {
        scaled.experimental.caseResults.forEach((c,i)=>{const b=scaled.baseline.caseResults[i];assert.deepEqual(c.recommendations.map(r=>r.activityId),b.recommendations.map(r=>r.activityId));c.recommendations.forEach((r,j)=>{close(r.score,b.recommendations[j].score);assert.deepEqual(r.factors,b.recommendations[j].factors);});});
        for (const c of [scaled.comparison.overall,...Object.values(scaled.comparison.byProfileState),...Object.values(scaled.comparison.byCase)]) comparisons(c).forEach(v=>v.delta===null?assert.equal(v.baseline,null):close(v.delta,0));
    });
    check('AE. Experiment isolation', () => assert.deepEqual(zero,repeatedZero));
    check('AF. Baseline before/after', () => assert.deepEqual(first,final));
    check('AG. Weights immutable', () => assert.deepEqual(SCORING_WEIGHTS,weightsBefore));
    check('AH. Invalid configs before execution', () => {assert.ok(invalid.length>=18);assert.equal(spawned,0);});
    check('AI. Failure followed by clean valid run', () => assert.deepEqual(equivalent.baseline.caseResults,first.cases));
    check('AJ. Real engine execution', () => assert.equal(control.experimental.execution.engineCalls,12));
    check('AK. Alternative changes scores', () => assert.ok(control.experimental.caseResults.some((c,i)=>c.recommendations.some(r=>{const b=first.cases[i].recommendations.find(a=>a.activityId===r.activityId);return b&&Math.abs(r.score-b.score)>1e-9;}))));
    for (const [label,topic] of [['AL','Learning'],['AM','Question'],['AN','Graph']]) check(`${label}. ${topic} isolation`, () => {assert.deepEqual(control.experimental.execution.forbiddenOperations,[]);assert.equal(control.experimental.execution.fixtureStateUnchanged,true);});
    check('AO. External language disabled', () => assert.match(control.experimental.execution.infrastructure,/external language provider disabled/));
    check('AP. No persistence collections', () => {assert.deepEqual(control.experimental.execution.forbiddenOperations,[]);assert.equal(JSON.stringify(createEvaluationDatasetV1()),dataBefore);});
    check('AQ. No search loop', () => {assert.equal(control.baseline.execution.engineCalls,12);assert.equal(control.experimental.execution.engineCalls,12);});
    check('AR. No winner/promotion; pure display', () => {assert.doesNotMatch(report,/WINNER|OPTIMAL|PROMOTE|BEST MODEL|RECOMMENDED WEIGHTS/);assert.ok(report.includes('N/A'));assert.equal(JSON.stringify(control),original);});
    check('AS. Repeat deterministic', () => assert.deepEqual(control,repeated));
    assert.equal(passed,45);
    console.log('45/45 D5 validation groups passed.');
    console.log(formatExperiment(control));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
