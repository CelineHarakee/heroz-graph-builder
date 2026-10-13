const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const optimizer = require('../../evaluation/recommendationWeightOptimizer');
const { SCORING_WEIGHTS } = require('../../recommendation/scoringContract');
const { runBaseline } = require('../../evaluation/offlineRecommendationEvaluator');
const { runExperiment } = require('../../evaluation/weightExperimentRunner');
const { createEvaluationDatasetV1 } = require('../../evaluation/datasets/evaluationDatasetV1');
const clone = v => JSON.parse(JSON.stringify(v));
const close = (a,b) => assert.ok(Math.abs(a-b)<=1e-9);
const profiles=['COLD_START','PARTIAL_KNOWLEDGE','RICH_KNOWLEDGE'];
const protectedFiles=['recommendation/scoringContract','recommendation/finalScoreService','recommendation/recommendationEngineService',
    'recommendation/recommendationEligibilityService','recommendation/rankingService','recommendation/selectionService',
    ...['interest','preference','goal','exploration','behavior','session'].map(f=>`recommendation/${f}FactorService`),
    'evaluation/evaluationMetrics','evaluation/datasets/evaluationDatasetV1'];
const hashes=()=>protectedFiles.map(f=>createHash('sha256').update(fs.readFileSync(require.resolve(`../../${f}`))).digest('hex'));
let passed=0;
function check(label,fn){fn();passed++;console.log(`${label}: PASS`);}
async function main(){
    const beforeFiles=hashes(),weightsBefore={...SCORING_WEIGHTS},data=createEvaluationDatasetV1(),dataBefore=JSON.stringify(data);
    const generated=optimizer.generateCandidates();
    check('A. Factor order',()=>assert.deepEqual(optimizer.FACTOR_ORDER,['interest','preference','goal','exploration','behavior','session']));
    check('B. Grid values',()=>assert.deepEqual(optimizer.GRID_VALUES,[.05,.10,.15,.20,.25,.30,.35,.40]));
    check('C. Six factors',()=>generated.forEach(c=>assert.deepEqual(Object.keys(c.weights),optimizer.FACTOR_ORDER)));
    check('D. Grid membership',()=>generated.forEach(c=>Object.values(c.weights).forEach(v=>assert.ok(optimizer.GRID_VALUES.includes(v)))));
    check('E. Sum and exhaustive count',()=>{assert.equal(generated.length,8856);assert.equal(new Set(generated.map(c=>JSON.stringify(c.weights))).size,8856);generated.forEach(c=>assert.equal(Object.values(c.weights).reduce((n,v)=>n+Math.round(v*20),0),20));});
    check('F. Deterministic generation',()=>assert.deepEqual(generated,optimizer.generateCandidates()));
    check('G. Deterministic IDs',()=>generated.forEach((c,i)=>assert.equal(c.candidateId,`D6_CAND_${String(i+1).padStart(4,'0')}`)));
    check('H. Separate baseline',()=>assert.ok(!generated.some(c=>c.candidateId==='BASELINE'||JSON.stringify(c.weights)===JSON.stringify(SCORING_WEIGHTS))));
    const baseline=await runBaseline();
    check('I. Authoritative baseline',()=>assert.deepEqual(baseline.recommendationConfiguration.weights,SCORING_WEIGHTS));
    // A real candidate verifies the new optional baseline-reuse API before search.
    const probe=await runExperiment({experimentId:generated[0].candidateId,name:'Reuse verification',weights:generated[0].weights},{baseline});
    check('J. Baseline reuse',()=>{assert.deepEqual(probe.baseline.caseResults,baseline.cases);assert.deepEqual(probe.baseline.metrics,baseline.overall);});
    check('K. D5 execution',()=>assert.equal(probe.experimental.execution.engineCalls,12));
    check('L. Dataset unchanged',()=>assert.equal(JSON.stringify(createEvaluationDatasetV1()),dataBefore));
    check('M. Twelve cases',()=>assert.deepEqual(probe.experimental.caseResults.map(c=>c.caseId),data.cases.map(c=>c.caseId)));
    check('N. K values',()=>assert.deepEqual(probe.experimental.requestedKs,[1,3,5]));
    const good={metrics:clone(baseline.overall),profileMetrics:clone(baseline.segments),candidateId:'D6_CAND_0001',distanceFromBaseline:.2};
    good.metrics.metricsByK[3].ndcg.value+=.1;
    const reasons=c=>optimizer.guardrails(c.metrics,c.profileMetrics,baseline.overall,baseline.segments);
    assert.deepEqual(reasons(good),[]);
    const guardCases=[['O','NO_NDCG3_IMPROVEMENT',c=>c.metrics.metricsByK[3].ndcg.value=baseline.overall.metricsByK[3].ndcg.value],
        ['P','RELEVANCE3_REGRESSION',c=>c.metrics.metricsByK[3].relevance.value-=.01],
        ['Q','COVERAGE_REGRESSION',c=>c.metrics.recommendationCoverage-=.01],
        ['R','EXPLORATION_RELEVANCE_REGRESSION',c=>c.metrics.explorationRelevanceRate.value-=.01],
        ['S','DIVERSITY3_BELOW_TOLERANCE',c=>c.metrics.metricsByK[3].diversity.value-=.051],
        ...profiles.map((p,i)=>[['T','U','V'][i],['COLD','PARTIAL','RICH'][i]+'_NDCG3_BELOW_TOLERANCE',c=>c.profileMetrics[p].metricsByK[3].ndcg.value-=.051])];
    for(const [label,reason,mutate] of guardCases)check(`${label}. ${reason}`,()=>{const c=clone(good);mutate(c);assert.deepEqual(reasons(c),[reason]);});
    check('W. All failures retained',()=>{const c=clone(good);guardCases.forEach(([, ,f])=>f(c));assert.deepEqual(reasons(c),optimizer.REASONS);});
    check('X. Exact reason codes',()=>assert.deepEqual(optimizer.REASONS,guardCases.map(([,r])=>r)));
    check('Y. Normalized L1 distance',()=>{close(optimizer.distanceFromBaseline(SCORING_WEIGHTS),0);const c=generated[0];const total=Object.values(SCORING_WEIGHTS).reduce((a,b)=>a+b,0);close(optimizer.distanceFromBaseline(c.weights),optimizer.FACTOR_ORDER.reduce((n,f)=>n+Math.abs(c.weights[f]-SCORING_WEIGHTS[f]/total),0));});
    const rankingTests=[['Z',c=>c.metrics.metricsByK[3].ndcg.value+=.01],['AA',c=>c.metrics.metricsByK[5].ndcg.value+=.01],
        ['AB',c=>c.metrics.metricsByK[1].ndcg.value+=.01],['AC',c=>profiles.forEach(p=>c.profileMetrics[p].metricsByK[3].ndcg.value+=.01)],
        ['AD',c=>c.distanceFromBaseline-=.01],['AE',c=>c.candidateId='D6_CAND_0000']];
    for(const [label,improve] of rankingTests)check(`${label}. Ranking precedence`,()=>{const a=clone(good);improve(a);assert.ok(optimizer.compareCandidates(a,good)<0);assert.ok(optimizer.compareCandidates(good,a)>0);});
    check('AF. Comparison tolerance',()=>{const c=clone(good);c.metrics.metricsByK[3].ndcg.value+=.5e-9;assert.equal(optimizer.compareCandidates(c,good),0);const g=clone(good);g.metrics.metricsByK[3].ndcg.value=baseline.overall.metricsByK[3].ndcg.value+.5e-9;assert.ok(reasons(g).includes('NO_NDCG3_IMPROVEMENT'));g.metrics.metricsByK[3].ndcg.value+=2e-9;assert.deepEqual(reasons(g),[]);g.metrics.metricsByK[3].diversity.value-=.05;profiles.forEach(p=>g.profileMetrics[p].metricsByK[3].ndcg.value-=.05);assert.deepEqual(reasons(g),[]);});
    const outcome=optimizer.outcomeOf(probe.experimental);
    const eqTests=[['AH',o=>o.cases[0].recommendations.reverse()],['AI',o=>o.cases[0].recommendations[0].score+=.0001],
        ['AJ',o=>o.metrics.metricsByK[3].ndcg.value+=.0001],['AK',o=>o.profileMetrics.COLD_START.metricsByK[3].ndcg.value+=.0001],
        ['AL',o=>o.cases[0].metricsByK[3].ndcg+=.0001]];
    // Full-search checks below establish evaluation precedes grouping.
    for(const [label,mutate]of eqTests)check(`${label}. Equivalence evidence`,()=>{const o=clone(outcome);mutate(o);assert.equal(optimizer.equivalent(outcome,o),false);});
    check('AM. Null and tolerance equivalence',()=>{assert.equal(optimizer.equivalent(null,null),true);assert.equal(optimizer.equivalent(null,0),false);assert.equal(optimizer.equivalent(.5,.5+.5e-9),true);});
    const a={...clone(good),status:'ACCEPTABLE',weights:generated[0].weights,rejectionReasons:[]},b={...clone(good),candidateId:'D6_CAND_0002',distanceFromBaseline:.1,status:'ACCEPTABLE',weights:generated[1].weights,rejectionReasons:[]};
    const grouped=optimizer.groupOutcomes([a,b],new Map([[a.candidateId,outcome],[b.candidateId,clone(outcome)]]));
    check('AN. Deterministic groups',()=>{assert.equal(grouped[0].equivalenceGroupId,'EQ_001');assert.deepEqual(grouped,optimizer.groupOutcomes([b,a],new Map([[a.candidateId,outcome],[b.candidateId,outcome]])));});
    check('AO. Representative ranking',()=>assert.equal(grouped[0].representativeCandidateId,b.candidateId));
    check('AS. Zero acceptable',()=>{const r=optimizer.finishSearch([{...a,status:'REJECTED',rejectionReasons:['NO_NDCG3_IMPROVEMENT']}],new Map(),baseline);assert.deepEqual(r.topCandidates,[]);assert.equal(r.selectedCandidate,null);assert.match(optimizer.formatOptimization(r),/NO ACCEPTABLE OPTIMIZATION CANDIDATE/);});
    if(process.argv[2]==='--unit-only') { console.log('D6 focused checks passed; full search checks not run.'); return; }
    console.log('Starting full search verification (two complete executions, or saved first execution plus fresh repeat).');
    const started=Date.now();
    const progress=(n,total)=>{if(n%500===0||n===total)console.log(`Search progress ${n}/${total}`);};
    const result=process.argv[2] ? JSON.parse(fs.readFileSync(process.argv[2],'utf8')) : await optimizer.runOptimization({onProgress:progress});
    const repeat=await optimizer.runOptimization({onProgress:progress});
    console.log(`Verification runtime seconds: ${(Date.now()-started)/1000}`);
    check('AG. Every candidate evaluated',()=>{assert.equal(result.summary.generatedCount,8856);assert.equal(result.summary.evaluatedCount,8856);assert.equal(result.summary.candidateEvaluationCount,8856);assert.equal(result.summary.baselineEvaluationCount,1);assert.deepEqual(result.candidates.map(c=>({candidateId:c.candidateId,weights:c.weights})),generated);result.candidates.forEach(c=>assert.deepEqual(c.rejectionReasons,reasons(c)));});
    check('AP. Top five distinct outcomes',()=>{assert.equal(result.topCandidates.length,Math.min(5,result.equivalenceGroups.length));assert.equal(new Set(result.topCandidates.map(c=>c.equivalenceGroupId)).size,result.topCandidates.length);const members=result.equivalenceGroups.flatMap(g=>g.candidateIds);assert.equal(new Set(members).size,result.summary.acceptableCount);assert.equal(members.length,result.summary.acceptableCount);for(let i=0;i<result.topCandidates.length;i++)for(let j=i+1;j<result.topCandidates.length;j++){const outcome=c=>({metrics:c.metrics,profileMetrics:c.profileMetrics,cases:c.caseResults});assert.equal(optimizer.equivalent(outcome(result.topCandidates[i]),outcome(result.topCandidates[j])),false);}});
    check('AQ. Selection matches top',()=>assert.deepEqual(result.selectedCandidate,result.topCandidates[0]??null));
    check('AR. D7 only',()=>assert.match(result.selectionPurpose,/D7 benchmarking only/));
    check('AT. Session limitation',()=>assert.match(result.sessionLimitation,/Session was unavailable across all 60/));
    check('AU. Weights unchanged',()=>assert.deepEqual(SCORING_WEIGHTS,weightsBefore));
    for(const [label,topic]of [['AV','Learning'],['AW','Question'],['AX','Graph'],['AY','Persistence'],['AZ','External language']])check(`${label}. ${topic} isolation`,()=>{assert.deepEqual(result.baseline.execution.forbiddenOperations,[]);assert.deepEqual(hashes(),beforeFiles);assert.equal(JSON.stringify(createEvaluationDatasetV1()),dataBefore);});
    check('BA. Deterministic grid only',()=>assert.equal(result.search.strategy,'DETERMINISTIC_GRID'));
    check('BB. No LLM optimization',()=>assert.match(result.baseline.execution.infrastructure,/external language provider disabled/));
    check('BC. No production promotion',()=>assert.deepEqual(SCORING_WEIGHTS,weightsBefore));
    check('BD. Complete repeated search identical',()=>assert.deepEqual(result,repeat));
    check('BE. Report matches result',()=>{const before=JSON.stringify(result),report=optimizer.formatOptimization(result);assert.equal(JSON.stringify(result),before);assert.match(report,new RegExp(`evaluatedCount: ${result.summary.evaluatedCount}`));if(result.selectedCandidate)assert.ok(report.includes(result.selectedCandidate.candidateId));assert.doesNotMatch(report,/BEST MODEL|OPTIMAL WEIGHTS|PRODUCTION CONFIGURATION/);});
    assert.equal(passed,57);console.log('57/57 D6 validation groups passed.');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
