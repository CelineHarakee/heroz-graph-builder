const metrics = require('./evaluationMetrics');
const { SCORING_WEIGHTS } = require('../recommendation/scoringContract');
const PROFILE_STATES = Object.freeze(['COLD_START', 'PARTIAL_KNOWLEDGE', 'RICH_KNOWLEDGE']);
const id = value => value == null ? null : String(value);

function aggregate(cases, ks) {
    const mean = values => ({ value: metrics.applicableMean(values), applicableCases: values.filter(v => v !== null).length });
    return {
        caseCount: cases.length,
        recommendationCoverage: metrics.recommendationCoverage(cases),
        metricsByK: Object.fromEntries(ks.map(k => [k, Object.fromEntries(['relevance', 'ndcg', 'diversity']
            .map(metric => [metric, mean(cases.map(c => c.metricsByK[k][metric]))]))])),
        explorationRelevanceRate: mean(cases.map(c => c.explorationRelevanceRate))
    };
}
/**
 * cases: [{caseId, profileState, childId, fixture, candidates:[{activity,
 *   expectedRelevance?:0|1|2|3, relevanceReason?:string, isExploratory?:boolean}]}]
 * withCaseEnvironment(case, execute) must install fresh, read-only controlled
 * Mongo/discovery adapters, invoke/await execute once, and restore them in finally.
 * Use a separate process for benchmarks: existing production modules cache imports.
 * No live/default environment is silently selected. Fixture data belongs to the
 * caller; this module neither creates ground truth nor changes profile state.
 */
async function evaluateCases({ cases, ks, datasetVersion, evaluatedAt, withCaseEnvironment }) {
    if (!Array.isArray(cases) || !Array.isArray(ks) || !ks.length || ks.some(k => !Number.isInteger(k) || k <= 0)) throw new TypeError('Cases and positive K values are required');
    if (typeof datasetVersion !== 'string' || !datasetVersion.trim()) throw new TypeError('Dataset version is required');
    if (!(evaluatedAt instanceof Date) || !Number.isFinite(evaluatedAt.getTime())) throw new TypeError('Controlled evaluation time is required');
    if (typeof withCaseEnvironment !== 'function') throw new TypeError('An isolated case environment is required');
    const seen = new Set();
    for (const c of cases) {
        if (typeof c.caseId !== 'string' || !c.caseId.trim() || seen.has(c.caseId)) throw new TypeError('Case IDs must be unique nonempty strings');
        seen.add(c.caseId);
        if (!PROFILE_STATES.includes(c.profileState) || !Array.isArray(c.candidates)) throw new TypeError('Invalid case profile/candidates');
        const ids = new Set();
        for (const candidate of c.candidates) {
            const activityId = id(candidate.activity?._id);
            if (!activityId || ids.has(activityId)) throw new TypeError('Candidate IDs must be unique');
            ids.add(activityId); metrics.grade(candidate.expectedRelevance);
            if (candidate.isExploratory != null && typeof candidate.isExploratory !== 'boolean') throw new TypeError('Invalid exploration annotation');
        }
    }
    const requestedKs = [...new Set(ks)].sort((a, b) => a - b);
    const results = [];
    for (const c of cases) {
        let executions = 0, result;
        await withCaseEnvironment(c, async () => {
            if (++executions !== 1) throw new Error('Case must execute once');
            const { createRecommendationEngine } = require('../recommendation/recommendationEngineService');
            const { evaluateRecommendationEligibility } = require('../recommendation/recommendationEligibilityService');
            const { attachRecommendationExplanations } = require('../explanation/explanationOrchestrator');
            const { buildRecommendationSnapshot } = require('../recommendation/recommendationSnapshotBuilder');
            const labels = new Map(c.candidates.map(candidate => [id(candidate.activity._id), candidate]));
            const associate = activityId => {
                const candidate = labels.get(id(activityId));
                if (!candidate) throw new Error(`Engine returned an activity outside the controlled universe: ${activityId}`);
                return { expectedRelevance: candidate.expectedRelevance ?? null, relevanceReason: candidate.relevanceReason ?? null,
                    isExploratory: candidate.isExploratory ?? null, categoryId: id(candidate.activity.classification?.categoryId),
                    subcategoryId: id(candidate.activity.classification?.subcategoryId) };
            };
            let eligible;
            // Outputs live only in this invocation; they cannot feed later context
            // history. Preserve snapshot construction and real local explanations.
            const outputs = [];
            const engine = createRecommendationEngine({
                now: () => new Date(evaluatedAt), languageProvider: null,
                evaluateRecommendationEligibility(context) {
                    const evaluation = evaluateRecommendationEligibility(context, new Date(evaluatedAt));
                    eligible = evaluation.eligibleCandidates.map(item => {
                        const activityId = id(item.candidate.currentActivity._id);
                        return { activityId, ...associate(activityId) };
                    });
                    return evaluation;
                },
                async persistRecommendationSnapshot(input) {
                    outputs.push(buildRecommendationSnapshot({ ...input, createdAt: new Date(evaluatedAt) }));
                    return { recommendationId: 'offline-output' };
                },
                attachRecommendationExplanations(input) {
                    return attachRecommendationExplanations({ ...input, languageProvider: null, dependencies: {
                        async attachRecommendationItemExplanation(explanation) { outputs.push(explanation); }
                    } });
                }
            });
            const response = await engine.generateRecommendations(c.childId, Math.max(...requestedKs));
            if (!eligible) throw new Error('Existing eligibility was not evaluated');
            const recommendations = response.recommendations.map(item => ({ ...item, ...associate(item.activityId) }));
            result = { caseId: c.caseId, profileState: c.profileState, requestedKs, eligibleActivityIds: eligible.map(item => item.activityId),
                recommendations, metricsByK: Object.fromEntries(requestedKs.map(k => [k, {
                    effectiveK: Math.min(k, recommendations.length), relevance: metrics.relevanceAtK(recommendations, k),
                    ndcg: metrics.ndcgAtK(recommendations, eligible, k), diversity: metrics.diversityAtK(recommendations, k)
                }])), explorationRelevanceRate: metrics.explorationRelevanceRate(recommendations), isolatedOutputCount: outputs.length };
        });
        if (executions !== 1 || !result) throw new Error('Case environment did not complete execution');
        results.push(result);
    }
    return { datasetVersion, recommendationConfiguration: { id: 'FROZEN_V1_SIX_FACTOR', weights: { ...SCORING_WEIGHTS } },
        requestedKs, overall: aggregate(results, requestedKs), segments: Object.fromEntries(PROFILE_STATES.map(state =>
            [state, aggregate(results.filter(c => c.profileState === state), requestedKs)])), cases: results };
}
module.exports = { evaluateCases, PROFILE_STATES };
