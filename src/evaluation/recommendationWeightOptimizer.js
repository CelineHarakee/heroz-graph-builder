const assert = require('node:assert/strict');
const { SCORING_WEIGHTS } = require('../recommendation/scoringContract');
const { runBaseline } = require('./offlineRecommendationEvaluator');
const { runExperiment, compareValue } = require('./weightExperimentRunner');
const FACTOR_ORDER = Object.freeze(['interest', 'preference', 'goal', 'exploration', 'behavior', 'session']);
const GRID_VALUES = Object.freeze([.05,.10,.15,.20,.25,.30,.35,.40]);
const TOLERANCE = 1e-9;
const PROFILES = ['COLD_START', 'PARTIAL_KNOWLEDGE', 'RICH_KNOWLEDGE'];
const REASONS = Object.freeze(['NO_NDCG3_IMPROVEMENT','RELEVANCE3_REGRESSION','COVERAGE_REGRESSION',
    'EXPLORATION_RELEVANCE_REGRESSION','DIVERSITY3_BELOW_TOLERANCE','COLD_NDCG3_BELOW_TOLERANCE',
    'PARTIAL_NDCG3_BELOW_TOLERANCE','RICH_NDCG3_BELOW_TOLERANCE']);
const SESSION_LIMITATION = 'Session was unavailable across all 60 returned Dataset V1 baseline recommendations. Dataset V1 provides limited evidence for learning the Session weight; benchmark-equivalent configurations do not establish an optimal Session weight.';
function generateCandidates() {
    const units = [];
    function visit(prefix, remaining) {
        if (prefix.length === 6) { if (remaining === 0) units.push(prefix); return; }
        const slots = 5 - prefix.length;
        for (let u=1;u<=8;u++) if (remaining-u>=slots && remaining-u<=8*slots) visit([...prefix,u],remaining-u);
    }
    visit([],20);
    const width = Math.max(4,String(units.length).length);
    return units.map((values,i)=>({candidateId:`D6_CAND_${String(i+1).padStart(width,'0')}`,
        weights:Object.fromEntries(FACTOR_ORDER.map((f,j)=>[f,values[j]/20]))}));
}
function guardrails(metrics, profiles, baselineMetrics, baselineProfiles) {
    const m = (s,k,key) => s.metricsByK[k][key].value;
    const pairs = [
        [m(metrics,3,'ndcg'),m(baselineMetrics,3,'ndcg'),0,true],
        [m(metrics,3,'relevance'),m(baselineMetrics,3,'relevance'),0],
        [metrics.recommendationCoverage,baselineMetrics.recommendationCoverage,0],
        [metrics.explorationRelevanceRate.value,baselineMetrics.explorationRelevanceRate.value,0],
        [m(metrics,3,'diversity'),m(baselineMetrics,3,'diversity'),.05],
        ...PROFILES.map(p=>[m(profiles[p],3,'ndcg'),m(baselineProfiles[p],3,'ndcg'),.05])
    ];
    return pairs.flatMap(([value,base,margin,strict],i)=>
        Number.isFinite(value) && Number.isFinite(base) && (strict ? value>base+TOLERANCE : value>=base-margin-TOLERANCE) ? [] : [REASONS[i]]);
}
function distanceFromBaseline(weights) {
    const total = Object.values(SCORING_WEIGHTS).reduce((a,b)=>a+b,0);
    const candidateTotal = FACTOR_ORDER.reduce((n,f)=>n+weights[f],0);
    return FACTOR_ORDER.reduce((n,f)=>n+Math.abs(weights[f]/candidateTotal-SCORING_WEIGHTS[f]/total),0);
}
function compareCandidates(a,b) {
    const keys = c => [c.metrics.metricsByK[3].ndcg.value,c.metrics.metricsByK[5].ndcg.value,c.metrics.metricsByK[1].ndcg.value,
        Math.min(...PROFILES.map(p=>c.profileMetrics[p].metricsByK[3].ndcg.value)),-c.distanceFromBaseline];
    const av=keys(a),bv=keys(b);
    for(let i=0;i<av.length;i++) if(Math.abs(av[i]-bv[i])>TOLERANCE) return bv[i]-av[i];
    return a.candidateId<b.candidateId?-1:a.candidateId>b.candidateId?1:0;
}
// Compare only benchmark outcomes: configured weights and factor contributions
// may differ even when all ranked outputs and evaluation metrics are equivalent.
function outcomeOf(result) {
    return { metrics:result.metrics, profileMetrics:result.byProfileState,
        cases:result.caseResults.map(c=>({caseId:c.caseId, recommendations:c.recommendations.map(r=>({activityId:r.activityId,score:r.score})),
            metricsByK:c.metricsByK,recommendationCoverage:c.recommendationCoverage,explorationRelevanceRate:c.explorationRelevanceRate})) };
}
function equivalent(a,b) {
    if (a===null || b===null) return a===b;
    if (typeof a==='number' || typeof b==='number') return typeof a==='number' && typeof b==='number' && Number.isFinite(a) && Number.isFinite(b) && Math.abs(a-b)<=TOLERANCE;
    if (typeof a!=='object' || typeof b!=='object') return a===b;
    if (Array.isArray(a)!==Array.isArray(b)) return false;
    const ak=Object.keys(a),bk=Object.keys(b);
    return ak.length===bk.length && ak.every(k=>Object.hasOwn(b,k)&&equivalent(a[k],b[k]));
}
function groupOutcomes(acceptable, outcomes) {
    const groups=[],buckets=new Map();
    for(const candidate of [...acceptable].sort(compareCandidates)) {
        const outcome=outcomes.get(candidate.candidateId);
        // Exact activity-order partitioning only accelerates comparisons; scores
        // and every metric are still compared with the required tolerance.
        const key=JSON.stringify(outcome.cases.map(c=>c.recommendations.map(r=>r.activityId)));
        const bucket=buckets.get(key)??[];
        let group=bucket.find(g=>equivalent(outcome,outcomes.get(g.representativeCandidateId)));
        if(!group) {
            group={equivalenceGroupId:`EQ_${String(groups.length+1).padStart(3,'0')}`,representativeCandidateId:candidate.candidateId,candidateIds:[]};
            groups.push(group);bucket.push(group);buckets.set(key,bucket);
        }
        group.candidateIds.push(candidate.candidateId);
    }
    return groups;
}
function finishSearch(candidates,outcomes,baseline) {
    const acceptable=candidates.filter(c=>c.status==='ACCEPTABLE');
    const equivalenceGroups=groupOutcomes(acceptable,outcomes);
    const byId=new Map(candidates.map(c=>[c.candidateId,c]));
    const topCandidates=equivalenceGroups.slice(0,5).map(g=>{
        const c=byId.get(g.representativeCandidateId),outcome=outcomes.get(c.candidateId);
        return {...c,equivalenceGroupId:g.equivalenceGroupId,caseResults:outcome.cases,
            caseNdcg3Comparison:Object.fromEntries(outcome.cases.map((v,i)=>[v.caseId,compareValue(baseline.cases[i].metricsByK[3].ndcg,v.metricsByK[3].ndcg)]))};
    });
    return { search:{strategy:'DETERMINISTIC_GRID',factorOrder:[...FACTOR_ORDER],gridValues:[...GRID_VALUES],comparisonTolerance:TOLERANCE,
        diversityRegressionTolerance:.05,profileRegressionTolerance:.05},baseline:{baselineId:'BASELINE',...baseline},
        summary:{generatedCount:candidates.length,evaluatedCount:candidates.length,acceptableCount:acceptable.length,rejectedCount:candidates.length-acceptable.length,
            equivalenceGroupCount:equivalenceGroups.length,baselineEvaluationCount:1,candidateEvaluationCount:candidates.length},
        rejectionReasonCounts:Object.fromEntries(REASONS.map(reason=>[reason,candidates.filter(c=>c.rejectionReasons.includes(reason)).length])),
        topCandidates,selectedCandidate:topCandidates[0]??null,equivalenceGroups,candidates,sessionLimitation:SESSION_LIMITATION,
        selectionPurpose:'Selected for D7 benchmarking only. Production SCORING_WEIGHTS remain unchanged.' };
}
async function runOptimization({onProgress=()=>{}}={}) {
    const baseline=await runBaseline(),before=JSON.stringify(baseline),weightsBefore={...SCORING_WEIGHTS};
    const generated=generateCandidates(),candidates=new Array(generated.length),outcomes=new Map();
    let next=0,completed=0;
    // Bounded process concurrency; each D5 evaluation retains a fresh worker.
    await Promise.all(Array.from({length:4},async()=>{
        while(next<generated.length) {
            const index=next++,candidate=generated[index];
            const result=await runExperiment({experimentId:candidate.candidateId,name:'D6 deterministic grid candidate',weights:candidate.weights},{baseline});
            const e=result.experimental;
            assert.equal(e.datasetVersion,baseline.datasetVersion);assert.deepEqual(e.requestedKs,baseline.requestedKs);
            assert.equal(e.evaluatedAt,baseline.evaluatedAt);assert.deepEqual(e.execution.forbiddenOperations,[]);
            assert.equal(e.execution.fixtureStateUnchanged,true);assert.equal(e.execution.engineCalls,12);
            assert.deepEqual(e.caseResults.map(c=>c.caseId),baseline.cases.map(c=>c.caseId));
            e.caseResults.forEach((c,i)=>assert.deepEqual(c.eligibleActivityIds,baseline.cases[i].eligibleActivityIds));
            const rejectionReasons=guardrails(e.metrics,e.byProfileState,baseline.overall,baseline.segments);
            candidates[index]={...candidate,status:rejectionReasons.length?'REJECTED':'ACCEPTABLE',metrics:e.metrics,profileMetrics:e.byProfileState,
                comparisonToBaseline:{overall:result.comparison.overall,byProfileState:result.comparison.byProfileState},
                rejectionReasons,distanceFromBaseline:distanceFromBaseline(candidate.weights)};
            if(!rejectionReasons.length) outcomes.set(candidate.candidateId,outcomeOf(e));
            onProgress(++completed,generated.length);
        }
    }));
    assert.equal(JSON.stringify(baseline),before);assert.deepEqual(SCORING_WEIGHTS,weightsBefore);
    return finishSearch(candidates,outcomes,baseline);
}
function formatOptimization(result) {
    const show=v=>v===null?'N/A':v.toFixed(3), triple=v=>[v.baseline,v.experiment,v.delta].map(show).join(' | ');
    const lines=['HEROZ D6 OPTIMIZATION','SEARCH SUMMARY',...Object.entries(result.summary).map(([k,v])=>`${k}: ${v}`),'','BASELINE'];
    const base=result.baseline.overall;
    for(const [name,value] of [['NDCG@3',base.metricsByK[3].ndcg.value],['NDCG@5',base.metricsByK[5].ndcg.value],['NDCG@1',base.metricsByK[1].ndcg.value],
        ['Relevance@3',base.metricsByK[3].relevance.value],['Diversity@3',base.metricsByK[3].diversity.value],['Coverage',base.recommendationCoverage],['Exploration relevance',base.explorationRelevanceRate.value]]) lines.push(`${name}: ${show(value)}`);
    lines.push('','TOP 5 DISTINCT ACCEPTABLE OUTCOMES','Candidate | Weights | NDCG@3 | NDCG@5 | NDCG@1 | Min profile NDCG@3 | Distance');
    for(const c of result.topCandidates) lines.push(`${c.candidateId} | ${JSON.stringify(c.weights)} | ${[c.metrics.metricsByK[3].ndcg.value,c.metrics.metricsByK[5].ndcg.value,c.metrics.metricsByK[1].ndcg.value,Math.min(...PROFILES.map(p=>c.profileMetrics[p].metricsByK[3].ndcg.value)),c.distanceFromBaseline].map(show).join(' | ')}`);
    const c=result.selectedCandidate;
    if(!c) lines.push('NO ACCEPTABLE OPTIMIZATION CANDIDATE');
    else {
        lines.push('','SELECTED FOR D7',c.candidateId,JSON.stringify(c.weights),'','BASELINE VS SELECTED','Metric | Baseline | Candidate | Delta');
        const m=c.comparisonToBaseline.overall;
        for(const [name,v] of [['Relevance@3',m.metricsByK[3].relevance],['NDCG@1',m.metricsByK[1].ndcg],['NDCG@3',m.metricsByK[3].ndcg],['NDCG@5',m.metricsByK[5].ndcg],['Diversity@3',m.metricsByK[3].diversity],['Coverage',m.recommendationCoverage],['Exploration relevance',m.explorationRelevanceRate]]) lines.push(`${name} | ${triple(v)}`);
        lines.push('','PROFILE NDCG@3');for(const p of PROFILES) lines.push(`${p} | ${triple(c.comparisonToBaseline.byProfileState[p].metricsByK[3].ndcg)}`);
        lines.push('','CASE-LEVEL NDCG@3');for(const [id,v] of Object.entries(c.caseNdcg3Comparison)) lines.push(`${id} | ${triple(v)}`);
    }
    lines.push('','REJECTION SUMMARY',...Object.entries(result.rejectionReasonCounts).map(([k,v])=>`${k}: ${v}`),'','EQUIVALENCE / SESSION LIMITATION',result.sessionLimitation,result.selectionPurpose);
    return lines.join('\n');
}
module.exports={FACTOR_ORDER,GRID_VALUES,REASONS,TOLERANCE,generateCandidates,guardrails,distanceFromBaseline,compareCandidates,outcomeOf,equivalent,groupOutcomes,finishSearch,runOptimization,formatOptimization};
if(require.main===module) {
    const started=Date.now();
    runOptimization({onProgress:(n,total)=>{if(n%250===0||n===total) console.error(`Evaluated ${n}/${total}`);}})
        .then(result=>{console.error(`Runtime seconds: ${(Date.now()-started)/1000}`);process.stdout.write((process.argv[2]==='--json'?JSON.stringify(result):formatOptimization(result))+'\n');})
        .catch(error=>{console.error(error);process.exitCode=1;});
}
