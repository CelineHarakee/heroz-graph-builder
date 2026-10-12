const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { analyzeBaseline, runFactorWeightAnalysis, formatAnalysis } = require('../../evaluation/factorWeightAnalyzer');
const { runBaseline } = require('../../evaluation/offlineRecommendationEvaluator');
const { createEvaluationDatasetV1 } = require('../../evaluation/datasets/evaluationDatasetV1');
const { SCORING_WEIGHTS } = require('../../recommendation/scoringContract');
const files = ['evaluation/evaluationRunner', 'evaluation/evaluationMetrics', 'evaluation/offlineRecommendationEvaluator', 'evaluation/datasets/evaluationDatasetV1',
    'recommendation/scoringContract', 'recommendation/finalScoreService', 'recommendation/recommendationEngineService', 'recommendation/recommendationEligibilityService', 'recommendation/rankingService', 'recommendation/selectionService'];
const hashes = () => files.map(f => createHash('sha256').update(readFileSync(require.resolve(`../../${f}`))).digest('hex'));
const clone = v => JSON.parse(JSON.stringify(v));
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9);
let passed = 0;
function check(label, fn) { fn(); passed++; console.log(`${label}: PASS`); }
async function main() {
    const before = hashes(), weights = { ...SCORING_WEIGHTS }, dataset = createEvaluationDatasetV1(), datasetBefore = JSON.stringify(dataset);
    const baseline = await runBaseline(), baselineBefore = JSON.stringify(baseline);
    const result = analyzeBaseline(baseline, dataset), repeated = await runFactorWeightAnalysis();
    const rows = result.cases.flatMap(c => c.recommendations), factors = Object.keys(SCORING_WEIGHTS);
    const raw = JSON.stringify(result), report = formatAnalysis(result);
    const summaries = [result.factorAnalysis.overall, ...Object.values(result.factorAnalysis.byProfileState)];
    check('A. Six factors', () => assert.deepEqual(Object.keys(result.factorAnalysis.overall), factors));
    check('B. Authoritative weights', () => summaries.forEach(s => factors.forEach(f => assert.equal(s[f].configuredWeight, SCORING_WEIGHTS[f]))));
    check('C. All twelve cases', () => assert.deepEqual(result.cases.map(c => c.caseId), ['C1','C2','C3','C4','P1','P2','P3','P4','R1','R2','R3','R4']));
    check('D. Overall', () => assert.equal(result.factorAnalysis.overall.interest.totalCount, 60));
    for (const [letter, state] of [['E','COLD_START'],['F','PARTIAL_KNOWLEDGE'],['G','RICH_KNOWLEDGE']]) check(`${letter}. ${state}`, () => assert.equal(result.factorAnalysis.byProfileState[state].interest.totalCount, 20));
    function verifyAggregates(key) {
        for (const [state, summary] of [['overall', result.factorAnalysis.overall], ...Object.entries(result.factorAnalysis.byProfileState)]) {
            const group = state === 'overall' ? rows : result.cases.filter(c => c.profileState === state).flatMap(c => c.recommendations);
            for (const f of factors) {
                const available = group.filter(r => r.factors[f].available);
                if (key === 'availability') { assert.equal(summary[f].availableCount, available.length); close(summary[f].availabilityRate, available.length / group.length); }
                else { const values = available.map(r => r.factors[f][key]); const expected = values.length ? values.reduce((a,b) => a+b,0)/values.length : null;
                    assert.equal(summary[f][key === 'effectiveWeight' ? 'averageEffectiveWeight' : 'averageContribution'], expected); }
            }
        }
    }
    check('H. Availability counts/rates', () => verifyAggregates('availability'));
    check('I. Missing versus genuine zero', () => { assert.ok(rows.some(r => factors.some(f => r.factors[f].available && r.factors[f].score === 0))); rows.forEach(r => factors.forEach(f => { if (!r.factors[f].available) assert.equal(r.factors[f].score, null); })); });
    check('J. Available-factor normalization', () => rows.forEach(r => { const sum = factors.filter(f => r.factors[f].available).reduce((n,f) => n+weights[f],0); factors.forEach(f => { if (r.factors[f].available) close(r.factors[f].effectiveWeight, weights[f]/sum); }); }));
    check('K. Unavailable weights null', () => rows.forEach(r => factors.forEach(f => { if (!r.factors[f].available) assert.equal(r.factors[f].effectiveWeight,null); })));
    check('L. Applicable weight means', () => verifyAggregates('effectiveWeight'));
    check('M. Authoritative metadata consumed', () => result.cases.forEach((c,i) => c.recommendations.forEach((r,j) => baseline.cases[i].recommendations[j].scoring.contributions.forEach(m => { assert.equal(r.factors[m.factor].effectiveWeight,m.normalizedWeight); assert.equal(r.factors[m.factor].contribution,m.contribution); }))));
    check('N. No derivation needed; missing metadata fails', () => { const bad=clone(baseline); delete bad.cases[0].recommendations[0].scoring.contributions; assert.throws(() => analyzeBaseline(bad)); });
    check('O. Reconciliation and corrupted metadata rejection', () => {
        rows.forEach(r => close(factors.reduce((n,f) => n+(r.factors[f].contribution ?? 0),0),r.score));
        for (const field of ['score','normalizedWeight','contribution']) { const bad=clone(baseline); bad.cases[0].recommendations[0].scoring.contributions[0][field] += .01; assert.throws(() => analyzeBaseline(bad)); }
        const bad=clone(baseline); bad.cases[0].recommendations[0].score += .01; assert.throws(() => analyzeBaseline(bad), /reconciliation/);
    });
    check('P. Applicable contribution means', () => verifyAggregates('contribution'));
    check('Q. Top3 depth', () => { assert.equal(result.diagnosticK,3); result.cases.forEach(c => c.inversions.forEach(p => assert.ok(p.left.rank <=3 && p.right.rank<=3))); });
    check('R. Equal grades not inversions', () => { const c=result.cases.find(c => c.caseId==='C4'); assert.equal(c.inversions.length,0); assert.equal(c.cutoffMisses.length,0); });
    // Independent pair enumeration against D3 + labels, including unreturned candidates.
    const expected = baseline.cases.map(c => {
        const top=c.recommendations.slice(0,3), source=dataset.cases.find(s=>s.caseId===c.caseId);
        return { inversions:top.flatMap((a,i)=>top.slice(i+1).filter(b=>a.expectedRelevance<b.expectedRelevance).map(b=>[a.activityId,b.activityId])),
            cutoffs:top.flatMap(a=>source.candidates.filter(b=>c.eligibleActivityIds.includes(b.activityId) && !top.some(t=>t.activityId===b.activityId) && a.expectedRelevance<b.expectedRelevance).map(b=>[a.activityId,b.activityId])) };
    });
    check('S. Strict inversions detected', () => { assert.ok(result.rankingDiagnostics.inversionCount>0); result.cases.forEach((c,i)=>assert.deepEqual(c.inversions.map(p=>[p.left.activityId,p.right.activityId]),expected[i].inversions)); });
    const issues=result.cases.flatMap(c=>[...c.inversions,...c.cutoffMisses]);
    check('T. Eligibility required', () => issues.forEach(p=>{const eligible=baseline.cases.find(c=>c.caseId===p.caseId).eligibleActivityIds; assert.ok(eligible.includes(p.left.activityId)&&eligible.includes(p.right.activityId));}));
    check('U. P2 Full excluded', () => {const full=dataset.cases.find(c=>c.caseId==='P2').candidates[1]; assert.equal(full.expectedRelevance,3); assert.ok(!issues.some(p=>p.left.activityId===full.activityId||p.right.activityId===full.activityId));});
    check('V. Cutoff pairs including unreturned', () => {result.cases.forEach((c,i)=>assert.deepEqual(c.cutoffMisses.map(p=>[p.left.activityId,p.right.activityId]),expected[i].cutoffs)); assert.ok(issues.some(p=>p.right.rank===null));});
    check('W. Comparison evidence and unknown metadata', () => issues.forEach(p=>factors.forEach(f=>{assert.deepEqual(p.factorComparison[f],{left:p.left.factors[f],right:p.right.factors[f]}); if(p.right.rank===null) assert.deepEqual(p.right.factors[f],{available:null,score:null,effectiveWeight:null,contribution:null});})));
    check('X. N/A display', () => assert.ok(report.includes('N/A')));
    check('Y. Read-only rounded display', () => {assert.equal(JSON.stringify(result),raw); assert.ok(report.includes(rows[0].score.toFixed(3))); assert.ok(rows.some(r=>r.score!==Number(r.score.toFixed(3))));});
    check('Z. Complete repeat deterministic', () => assert.deepEqual(result,repeated));
    check('AA. Baseline preserved', () => assert.equal(JSON.stringify(baseline),baselineBefore));
    check('AB. Weights unchanged', () => assert.deepEqual(SCORING_WEIGHTS,weights));
    check('AC. Frozen source files unchanged', () => assert.deepEqual(hashes(),before));
    check('AD. No mutations', () => {assert.equal(JSON.stringify(dataset),datasetBefore); assert.deepEqual(result.baseline.execution.forbiddenOperations,[]); assert.equal(result.baseline.execution.fixtureStateUnchanged,true);});
    check('AE. External language disabled', () => assert.match(result.baseline.execution.infrastructure,/external language provider disabled/));
    check('AF. No persistent writes or collections', () => { assert.deepEqual(result.baseline.execution.forbiddenOperations,[]); assert.deepEqual(createEvaluationDatasetV1(),dataset); });
    check('AG. Fixed baseline no tuning', () => {assert.equal(result.baseline.configuration.id,'FROZEN_V1_SIX_FACTOR'); assert.equal(result.baseline.execution.engineCalls,12);});
    assert.equal(passed,33);
    console.log('33/33 D4 validation groups passed.');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
