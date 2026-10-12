// Read-only diagnostics over D3. Scoring metadata remains authoritative.
const assert = require('node:assert/strict');
const { SCORING_FACTORS, SCORING_WEIGHTS } = require('../recommendation/scoringContract');
const { runBaseline } = require('./offlineRecommendationEvaluator');
const { createEvaluationDatasetV1 } = require('./datasets/evaluationDatasetV1');
const { PROFILE_STATES } = require('./evaluationRunner');
const { applicableMean } = require('./evaluationMetrics');
const FACTORS = Object.values(SCORING_FACTORS);
const TOLERANCE = 1e-9;
const copy = value => JSON.parse(JSON.stringify(value));
function near(actual, expected, message) {
    assert.ok(Number.isFinite(actual) && Number.isFinite(expected) && Math.abs(actual - expected) <= TOLERANCE, message);
}
function readFactors(recommendation) {
    const { factors, scoring } = recommendation;
    assert.deepEqual(Object.keys(factors).sort(), [...FACTORS].sort());
    assert.ok(Array.isArray(scoring?.contributions), 'Authoritative contributions required');
    const available = FACTORS.filter(f => factors[f].available === true);
    const weight = available.reduce((sum, f) => sum + SCORING_WEIGHTS[f], 0);
    assert.ok(weight > 0);
    near(scoring.availableWeight, weight, 'Available weight mismatch');
    assert.equal(scoring.availableFactorCount, available.length);
    assert.deepEqual(scoring.contributions.map(c => c.factor).sort(), [...available].sort());
    const result = Object.fromEntries(FACTORS.map(f => {
        const source = factors[f];
        assert.equal(typeof source.available, 'boolean');
        if (!source.available) {
            assert.equal(source.score, null);
            return [f, { available: false, score: null, effectiveWeight: null, contribution: null }];
        }
        assert.ok(Number.isFinite(source.score) && source.score >= 0 && source.score <= 1);
        const metadata = scoring.contributions.find(c => c.factor === f);
        near(metadata.score, source.score, 'Factor score mismatch');
        near(metadata.canonicalWeight, SCORING_WEIGHTS[f], 'Configured weight mismatch');
        // Validate the contract; consume metadata rather than replace it.
        near(metadata.normalizedWeight, SCORING_WEIGHTS[f] / weight, 'Normalized weight mismatch');
        near(metadata.contribution, source.score * metadata.normalizedWeight, 'Contribution mismatch');
        return [f, { available: true, score: source.score, effectiveWeight: metadata.normalizedWeight, contribution: metadata.contribution }];
    }));
    near(available.reduce((sum, f) => sum + result[f].contribution, 0), recommendation.score, 'Final score reconciliation failed');
    return result;
}
function aggregate(rows) {
    return Object.fromEntries(FACTORS.map(f => {
        const values = rows.map(r => r.factors[f]).filter(v => v.available === true);
        return [f, { configuredWeight: SCORING_WEIGHTS[f], availableCount: values.length, totalCount: rows.length,
            availabilityRate: rows.length ? values.length / rows.length : null,
            averageEffectiveWeight: applicableMean(values.map(v => v.effectiveWeight)),
            averageContribution: applicableMean(values.map(v => v.contribution)) }];
    }));
}
function issue(caseId, type, left, right) {
    return { caseId, type, left: copy(left), right: copy(right), factorComparison: Object.fromEntries(FACTORS.map(f =>
        [f, { left: { ...left.factors[f] }, right: { ...right.factors[f] } }])) };
}
function analyzeBaseline(baseline, dataset = createEvaluationDatasetV1()) {
    assert.equal(baseline.datasetVersion, dataset.datasetVersion);
    assert.deepEqual(baseline.recommendationConfiguration.weights, SCORING_WEIGHTS);
    assert.deepEqual(baseline.cases.map(c => c.caseId), dataset.cases.map(c => c.caseId));
    assert.ok(baseline.requestedKs.includes(3));
    const cases = baseline.cases.map(c => {
        const source = dataset.cases.find(s => s.caseId === c.caseId);
        assert.equal(c.profileState, source.profileState);
        const labels = new Map(source.candidates.map(a => [a.activityId, a]));
        const eligible = new Set(c.eligibleActivityIds);
        assert.equal(eligible.size, c.eligibleActivityIds.length);
        const recommendations = c.recommendations.map((r, index) => {
            assert.ok(eligible.has(r.activityId), 'Returned candidate must be eligible');
            assert.equal(r.rank, index + 1);
            assert.equal(r.expectedRelevance, labels.get(r.activityId)?.expectedRelevance);
            return { activityId: r.activityId, name: labels.get(r.activityId).activity.basicInformation.nameEn,
                expectedRelevance: r.expectedRelevance, eligible: true, rank: r.rank, score: r.score,
                selection: r.rank <= 3 ? 'inside-top3' : 'returned-outside-top3', factors: readFactors(r) };
        });
        assert.equal(new Set(recommendations.map(r => r.activityId)).size, recommendations.length);
        const returned = new Map(recommendations.map(r => [r.activityId, r]));
        const outside = [...eligible].map(activityId => {
            const label = labels.get(activityId);
            assert.ok(label && Number.isInteger(label.expectedRelevance), 'Eligible candidate label required');
            return returned.get(activityId) ?? { activityId, name: label.activity.basicInformation.nameEn,
                expectedRelevance: label.expectedRelevance, eligible: true, rank: null, score: null, selection: 'not-returned-by-D3',
                factors: Object.fromEntries(FACTORS.map(f => [f, { available: null, score: null, effectiveWeight: null, contribution: null }])) };
        }).filter(r => r.rank === null || r.rank > 3);
        const top = recommendations.slice(0, 3), inversions = [], cutoffMisses = [];
        for (const left of top) {
            for (const right of top) if (left.rank < right.rank && left.expectedRelevance < right.expectedRelevance)
                inversions.push(issue(c.caseId, 'inversion', left, right));
            for (const right of outside) if (left.expectedRelevance < right.expectedRelevance)
                cutoffMisses.push(issue(c.caseId, 'cutoff-miss', left, right));
        }
        return { caseId: c.caseId, profileState: c.profileState, recommendations, inversions, cutoffMisses };
    });
    const rows = cases.flatMap(c => c.recommendations);
    return { datasetVersion: baseline.datasetVersion, baseline: { identity: 'Phase 5 D3', configuration: copy(baseline.recommendationConfiguration),
        requestedKs: [...baseline.requestedKs], evaluatedAt: baseline.evaluatedAt, execution: copy(baseline.execution) }, diagnosticK: 3,
        metadataSource: 'Authoritative scoring.contributions; no derived replacement values', reconciliationTolerance: TOLERANCE,
        factorAnalysis: { overall: aggregate(rows), byProfileState: Object.fromEntries(PROFILE_STATES.map(state =>
            [state, aggregate(cases.filter(c => c.profileState === state).flatMap(c => c.recommendations))])) },
        rankingDiagnostics: { inversionCount: cases.reduce((n, c) => n + c.inversions.length, 0),
            cutoffMissCount: cases.reduce((n, c) => n + c.cutoffMisses.length, 0),
            affectedCases: cases.filter(c => c.inversions.length || c.cutoffMisses.length).map(c => c.caseId),
            perCase: cases.map(c => ({ caseId: c.caseId, inversionCount: c.inversions.length, cutoffMissCount: c.cutoffMisses.length })) }, cases,
        limitations: ['Factor aggregates cover returned Top-5 recommendations only. Diagnostic counts are activity pairs, not unique activities.',
            'Eligible candidates not returned by D3 have unknown ranks, scores and factor metadata (null); eligibility and relevance still support cutoff detection.',
            baseline.execution.infrastructure] };
}
async function runFactorWeightAnalysis() { return analyzeBaseline(await runBaseline()); }
function formatAnalysis(result) {
    const show = v => v === null ? 'N/A' : v.toFixed(3);
    const lines = ['HEROZ FACTOR & WEIGHT ANALYSIS', `Dataset: ${result.datasetVersion}`, 'Baseline: Phase 5 D3', 'Diagnostic depth: Top-3'];
    for (const [name, summary] of [['OVERALL', result.factorAnalysis.overall], ...Object.entries(result.factorAnalysis.byProfileState)]) {
        lines.push('', name, 'Factor | Configured | Availability count/total (rate) | Avg Effective | Avg Contribution');
        for (const [f, v] of Object.entries(summary)) lines.push(`${f} | ${show(v.configuredWeight)} | ${v.availableCount}/${v.totalCount} (${show(v.availabilityRate)}) | ${show(v.averageEffectiveWeight)} | ${show(v.averageContribution)}`);
    }
    const d = result.rankingDiagnostics;
    lines.push('', 'RANKING DIAGNOSTICS', `Returned-list inversions: ${d.inversionCount}`, `Top-3 cutoff misses: ${d.cutoffMissCount}`, `Affected cases: ${d.affectedCases.join(', ')}`);
    for (const c of result.cases) {
        lines.push(`${c.caseId}: ${c.inversions.length} inversions, ${c.cutoffMisses.length} cutoff misses`);
        for (const pair of [...c.inversions, ...c.cutoffMisses]) {
            const describe = r => `${r.name} [${r.activityId}] grade ${r.expectedRelevance}, rank ${r.rank ?? 'N/A'}, score ${show(r.score)} (${r.selection})`;
            lines.push(`  ${pair.type}: ${describe(pair.left)} -> ${describe(pair.right)}`, '  Factor | Left score/weight/contribution | Right score/weight/contribution');
            for (const [f, sides] of Object.entries(pair.factorComparison)) lines.push(`  ${f} | ${['left', 'right'].map(side => ['score', 'effectiveWeight', 'contribution'].map(key => show(sides[side][key])).join('/')).join(' | ')}`);
        }
    }
    lines.push('', 'FACTUAL OBSERVATIONS', `Reconciled ${result.cases.reduce((n, c) => n + c.recommendations.length, 0)} returned scores against authoritative contributions.`);
    for (const [f, v] of Object.entries(result.factorAnalysis.overall)) lines.push(`${f}: available in ${v.availableCount}/${v.totalCount}; mean contribution when available ${show(v.averageContribution)}.`);
    lines.push('', 'LIMITATIONS', ...result.limitations);
    return lines.join('\n');
}
module.exports = { analyzeBaseline, runFactorWeightAnalysis, formatAnalysis };
if (require.main === module) {
    const mode = process.argv[2];
    (!mode || mode === '--json' ? runFactorWeightAnalysis() : Promise.reject(new Error('Use no argument or --json')))
        .then(result => process.stdout.write((mode === '--json' ? JSON.stringify(result) : formatAnalysis(result)) + '\n'))
        .catch(error => { console.error(error); process.exitCode = 1; });
}
