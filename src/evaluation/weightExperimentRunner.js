const { SCORING_WEIGHTS } = require('../recommendation/scoringContract');
const { runBaseline, runConfiguredEvaluation } = require('./offlineRecommendationEvaluator');

function validateExperiment(input) {
    if (!input || typeof input !== 'object') throw new TypeError('Experiment required');
    for (const key of ['experimentId', 'name']) {
        if (typeof input[key] !== 'string' || !input[key].trim()) throw new TypeError(`${key} must be a non-empty string`);
    }
    const factors = Object.keys(SCORING_WEIGHTS), weights = input.weights;
    if (!weights || typeof weights !== 'object' || Array.isArray(weights) ||
        Reflect.ownKeys(weights).length !== factors.length || factors.some(f => !Object.hasOwn(weights, f)))
        throw new TypeError('Exactly six canonical weight keys required');
    const submittedWeights = Object.fromEntries(factors.map(f => [f, weights[f]]));
    if (Object.values(submittedWeights).some(w => typeof w !== 'number' || !Number.isFinite(w) || w < 0))
        throw new TypeError('Weights must be finite non-negative numbers');
    const total = Object.values(submittedWeights).reduce((a, b) => a + b, 0);
    if (!Object.values(submittedWeights).some(w => w > 0)) throw new TypeError('At least one positive weight required');
    // Avoid overflow in reporting proportions without changing submitted values.
    const max = Math.max(...Object.values(submittedWeights));
    const scaledTotal = Object.values(submittedWeights).reduce((n, w) => n + w / max, 0);
    const normalizedWeights = Object.fromEntries(factors.map(f => [f, Number.isFinite(total)
        ? submittedWeights[f] / total : (submittedWeights[f] / max) / scaledTotal]));
    return { experimentId: input.experimentId.trim(), name: input.name.trim(), submittedWeights, normalizedWeights };
}
function compareValue(baseline, experiment) {
    return { baseline, experiment, delta: baseline === null || experiment === null ? null : experiment - baseline };
}
function compareMetrics(baseline, experiment, ks, aggregate) {
    const value = item => aggregate ? item.value : item;
    return {
        metricsByK: Object.fromEntries(ks.map(k => [k, Object.fromEntries(['relevance', 'ndcg', 'diversity'].map(metric =>
            [metric, compareValue(value(baseline.metricsByK[k][metric]), value(experiment.metricsByK[k][metric]))]))])),
        recommendationCoverage: compareValue(baseline.recommendationCoverage, experiment.recommendationCoverage),
        explorationRelevanceRate: compareValue(value(baseline.explorationRelevanceRate), value(experiment.explorationRelevanceRate))
    };
}
function wrap(result) {
    return { datasetVersion: result.datasetVersion, configuration: result.recommendationConfiguration,
        evaluatedAt: result.evaluatedAt, requestedKs: result.requestedKs, metrics: result.overall,
        byProfileState: result.segments, caseResults: result.cases, execution: result.execution };
}
async function runExperiment(input) {
    // All validation and copying happens before the first worker is started.
    const experiment = validateExperiment(input);
    const baseline = await runBaseline();
    const experimental = await runConfiguredEvaluation({ id: experiment.experimentId, weights: experiment.submittedWeights });
    return { experiment, baseline: wrap(baseline), experimental: wrap(experimental), comparison: {
        overall: compareMetrics(baseline.overall, experimental.overall, baseline.requestedKs, true),
        byProfileState: Object.fromEntries(Object.keys(baseline.segments).map(state =>
            [state, compareMetrics(baseline.segments[state], experimental.segments[state], baseline.requestedKs, true)])),
        byCase: Object.fromEntries(baseline.cases.map((c, i) =>
            [c.caseId, compareMetrics(c, experimental.cases[i], baseline.requestedKs, false)]))
    } };
}
function formatExperiment(result) {
    const show = v => v === null ? 'N/A' : v.toFixed(3);
    const triple = c => [c.baseline, c.experiment, c.delta].map(show).join(' | ');
    const lines = ['HEROZ WEIGHT EXPERIMENT', `Experiment: ${result.experiment.experimentId}`, result.experiment.name,
        `Dataset: ${result.baseline.datasetVersion}`, `Baseline weights: ${JSON.stringify(result.baseline.configuration.weights)}`,
        `Experiment weights: ${JSON.stringify(result.experiment.submittedWeights)}`];
    for (const [name, comparison] of [['OVERALL', result.comparison.overall], ...Object.entries(result.comparison.byProfileState)]) {
        lines.push('', name, 'Metric | Baseline | Experiment | Delta');
        for (const metric of ['relevance', 'ndcg', 'diversity']) for (const k of result.baseline.requestedKs)
            lines.push(`${metric}@${k} | ${triple(comparison.metricsByK[k][metric])}`);
        lines.push(`Coverage | ${triple(comparison.recommendationCoverage)}`, `Exploration Relevance Rate | ${triple(comparison.explorationRelevanceRate)}`);
    }
    lines.push('', 'Case | Relevance@3 baseline / experiment / delta | NDCG@3 baseline / experiment / delta');
    for (const [caseId, c] of Object.entries(result.comparison.byCase)) lines.push(`${caseId} | ${triple(c.metricsByK[3].relevance)} | ${triple(c.metricsByK[3].ndcg)}`);
    lines.push('', 'Controlled execution comparison only; no optimization or configuration selection.', result.experimental.execution.infrastructure);
    return lines.join('\n');
}
module.exports = { validateExperiment, compareValue, runExperiment, formatExperiment };
// JSON input file keeps experiment data separate from shell syntax.
if (require.main === module) {
    Promise.resolve().then(() => JSON.parse(require('node:fs').readFileSync(process.argv[2], 'utf8')))
        .then(runExperiment).then(result => process.stdout.write((process.argv[3] === '--json' ? JSON.stringify(result) : formatExperiment(result)) + '\n'))
        .catch(error => { console.error(error); process.exitCode = 1; });
}
