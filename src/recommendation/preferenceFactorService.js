const {
    SCORING_FACTORS,
    createFactorResult
} = require("./scoringContract");
const { evaluatePreferenceEvidence } = require("./preferenceComparisonService");

function createUnavailablePreferenceResult() {
    return createFactorResult({
        factor: SCORING_FACTORS.PREFERENCE,
        available: false,
        score: null,
        evidence: []
    });
}

function calculatePreferenceFactor(context, eligibilityEvaluation) {
    if (context === null || context === undefined) {
        throw new Error("Recommendation context is required");
    }

    if (eligibilityEvaluation === null || eligibilityEvaluation === undefined) {
        throw new Error("Eligibility evaluation is required");
    }

    if (eligibilityEvaluation.eligibility?.eligible !== true) {
        throw new Error("Preference scoring requires an eligible candidate evaluation");
    }

    const preferences = context.child?.preferences;
    const experience =
        eligibilityEvaluation.candidate?.currentActivity?.experience;

    if (!preferences || typeof preferences !== "object") {
        return createUnavailablePreferenceResult();
    }

    if (!experience || typeof experience !== "object") {
        return createUnavailablePreferenceResult();
    }

    const evidence = evaluatePreferenceEvidence(preferences, experience);

    if (evidence.length === 0) {
        return createUnavailablePreferenceResult();
    }

    const score = evidence.reduce(
        (total, item) => total + item.adjustedScore,
        0
    ) / evidence.length;

    return createFactorResult({
        factor: SCORING_FACTORS.PREFERENCE,
        available: true,
        score,
        evidence
    });
}

module.exports = {
    calculatePreferenceFactor
};
