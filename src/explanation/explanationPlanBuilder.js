const {
    selectExplanationReasons
} = require("./reasonSelector");

function clone(value) {
    if (value === undefined) {
        return undefined;
    }

    return JSON.parse(JSON.stringify(value));
}

function buildExplanationPlan(explanationEvidence) {
    const reasons = selectExplanationReasons(explanationEvidence);

    return {
        activity: clone(explanationEvidence.activity),
        reasonTypes: reasons.map((reason) => reason.type),
        reasons,
        practicalSupport: {
            hasEligibleSession:
                explanationEvidence.practicalEligibility?.hasEligibleSession === true
        },
        neutralFallbackRequired: reasons.length === 0
    };
}

module.exports = {
    buildExplanationPlan
};
