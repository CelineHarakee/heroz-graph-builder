const assert = require("node:assert/strict");
const { SCORING_WEIGHTS, createFactorResult } = require("../recommendation/scoringContract");
const { calculateFinalScore } = require("../recommendation/finalScoreService");
const { rankCandidates } = require("../recommendation/rankingService");
const { selectTopN } = require("../recommendation/selectionService");

const factors = Object.keys(SCORING_WEIGHTS);
const before = { ...SCORING_WEIGHTS };
const alternative = Object.freeze({ interest: 0.30, preference: 0.20, goal: 0.15, exploration: 0.15, behavior: 0.10, session: 0.10 });
const scaled = Object.freeze(Object.fromEntries(factors.map(f => [f, SCORING_WEIGHTS[f] * 100])));
const behaviorOnly = Object.freeze(Object.fromEntries(factors.map(f => [f, f === "behavior" ? 1 : 0])));
const close = (actual, expected) => assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) < 1e-12);
function state(scores) {
    return {
        eligibilityEvaluation: { eligibility: { eligible: true } },
        factors: Object.fromEntries(factors.map(f => [f, createFactorResult({
            factor: f, available: Object.hasOwn(scores, f), score: scores[f] ?? null, evidence: []
        })]))
    };
}
const states = [
    state({ interest: 0.8, preference: 0.9, goal: 0.75, exploration: 0.5, behavior: 0.75, session: 1 }),
    state({ interest: 0.88, goal: 1 }), state({ goal: 0.5 }), state({}),
    state({ interest: 0.88, goal: 0 })
];
const stateSnapshot = JSON.stringify(states);
for (const input of states) {
    const baseline = calculateFinalScore(input);
    assert.deepEqual(calculateFinalScore(input, { weights: SCORING_WEIGHTS }), baseline);
    assert.deepEqual(calculateFinalScore(input, {}), baseline);
    const available = factors.filter(f => input.factors[f].available);
    const denominator = available.reduce((n, f) => n + SCORING_WEIGHTS[f], 0);
    const contributions = available.map(f => ({ factor: f, score: input.factors[f].score,
        canonicalWeight: SCORING_WEIGHTS[f], normalizedWeight: SCORING_WEIGHTS[f] / denominator,
        contribution: SCORING_WEIGHTS[f] / denominator * input.factors[f].score }));
    assert.deepEqual(baseline, { available: available.length > 0,
        score: available.length ? contributions.reduce((n, c) => n + c.contribution, 0) : null,
        availableWeight: denominator, availableFactorCount: available.length, contributions });
    const scaleResult = calculateFinalScore(input, { weights: scaled });
    if (baseline.available) {
        close(scaleResult.score, baseline.score);
        scaleResult.contributions.forEach((c, i) => {
            assert.equal(c.canonicalWeight, scaled[c.factor]);
            close(c.normalizedWeight, baseline.contributions[i].normalizedWeight);
            close(c.contribution, baseline.contributions[i].contribution);
        });
    } else assert.deepEqual(scaleResult, baseline);
    const changed = calculateFinalScore(input, { weights: alternative });
    const total = available.reduce((n, f) => n + alternative[f], 0);
    changed.contributions.forEach(c => {
        assert.equal(c.canonicalWeight, alternative[c.factor]);
        close(c.normalizedWeight, alternative[c.factor] / total);
        close(c.contribution, input.factors[c.factor].score * alternative[c.factor] / total);
    });
    if (changed.available) close(changed.score, changed.contributions.reduce((n, c) => n + c.contribution, 0));
    const second = calculateFinalScore(input, { weights: behaviorOnly });
    assert.deepEqual(calculateFinalScore(input), baseline);
    assert.deepEqual(calculateFinalScore(input, { weights: alternative }), changed);
    assert.deepEqual(calculateFinalScore(input, { weights: behaviorOnly }), second);
}
close(calculateFinalScore(states[0]).score, 0.7805);
close(calculateFinalScore(states[1]).score, 0.9191836734693878);
assert.equal(calculateFinalScore(states[2]).score, 0.5);
close(calculateFinalScore(states[0], { weights: alternative }).score, 0.7825);
assert.notEqual(calculateFinalScore(states[0], { weights: alternative }).score, calculateFinalScore(states[0]).score);
const zeroState = state({ interest: 0.8, exploration: 1 });
const unavailable = calculateFinalScore(zeroState, { weights: behaviorOnly });
assert.deepEqual(unavailable, { available: false, score: null, availableWeight: 0, availableFactorCount: 2, contributions: [] });
// Existing ranking/selection already handles unavailable scores; no new policy.
const ranking = rankCandidates([{ candidate: { activity: { activityId: "activity_zero_weight" } },
    eligibilityEvaluation: zeroState.eligibilityEvaluation, finalScore: unavailable }]);
assert.deepEqual(ranking.ranked, []);
assert.equal(ranking.unranked[0].rank, null);
assert.deepEqual(selectTopN(ranking, 1).selected, []);
assert.equal(JSON.stringify(states), stateSnapshot);
assert.deepEqual(SCORING_WEIGHTS, before);
console.log("Weight-injection seam: default, explicit baseline, scale, alternative, zero denominator, isolation and downstream handling PASSED");
