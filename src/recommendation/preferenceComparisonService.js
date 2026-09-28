function isUsableScalar(value) {
    return (
        value !== undefined &&
        value !== null &&
        !(typeof value === "string" && value.trim().length === 0)
    );
}

function isValidConfidence(value) {
    return (
        typeof value === "number" &&
        Number.isFinite(value) &&
        value >= 0 &&
        value <= 1
    );
}

function calculateAdjustedScore(baseMatch, confidence) {
    return 0.5 + (confidence * (baseMatch - 0.5));
}

function createEvidence({
    dimension,
    childValue,
    activityValue,
    confidence,
    source,
    baseMatch,
    adjustedScore
}) {
    return {
        dimension,
        childValue,
        activityValue,
        confidence,
        source,
        baseMatch,
        adjustedScore
    };
}

function evaluateFlexibleScalarDimension({
    dimension,
    preference,
    activityValue
}) {
    if (
        !preference ||
        !isUsableScalar(preference.value) ||
        !isUsableScalar(activityValue) ||
        !isValidConfidence(preference.confidenceScore)
    ) {
        return null;
    }

    const baseMatch =
        preference.value === activityValue ||
        preference.value === "Mixed" ||
        activityValue === "Mixed"
            ? 1
            : 0;
    const adjustedScore = calculateAdjustedScore(
        baseMatch,
        preference.confidenceScore
    );

    return createEvidence({
        dimension,
        childValue: preference.value,
        activityValue,
        confidence: preference.confidenceScore,
        source: preference.source,
        baseMatch,
        adjustedScore
    });
}

function evaluateExactScalarDimension({
    dimension,
    preference,
    activityValue
}) {
    if (
        !preference ||
        !isUsableScalar(preference.value) ||
        !isUsableScalar(activityValue) ||
        !isValidConfidence(preference.confidenceScore)
    ) {
        return null;
    }

    const baseMatch = preference.value === activityValue ? 1 : 0;
    const adjustedScore = calculateAdjustedScore(
        baseMatch,
        preference.confidenceScore
    );

    return createEvidence({
        dimension,
        childValue: preference.value,
        activityValue,
        confidence: preference.confidenceScore,
        source: preference.source,
        baseMatch,
        adjustedScore
    });
}

function evaluateExperienceStyleDimension({
    dimension,
    preference,
    activityValue
}) {
    if (
        !preference ||
        !isUsableScalar(preference.value) ||
        !Array.isArray(activityValue) ||
        activityValue.length === 0 ||
        !isValidConfidence(preference.confidenceScore)
    ) {
        return null;
    }

    // Activity experienceStyles currently has no Mixed enum; Child Mixed is flexible across any non-empty style set.
    const baseMatch =
        preference.value === "Mixed" ||
        activityValue.includes(preference.value)
            ? 1
            : 0;
    const adjustedScore = calculateAdjustedScore(
        baseMatch,
        preference.confidenceScore
    );

    return createEvidence({
        dimension,
        childValue: preference.value,
        activityValue: [...activityValue],
        confidence: preference.confidenceScore,
        source: preference.source,
        baseMatch,
        adjustedScore
    });
}

function evaluatePreferenceEvidence(preferences, experience) {
    if (!preferences || typeof preferences !== "object") return [];
    if (!experience || typeof experience !== "object") return [];

    return [
        evaluateFlexibleScalarDimension({
            dimension: "environment",
            preference: preferences.environment,
            activityValue: experience.environment
        }),
        evaluateFlexibleScalarDimension({
            dimension: "socialStyle",
            preference: preferences.socialStyle,
            activityValue: experience.socialStyle
        }),
        evaluateExactScalarDimension({
            dimension: "difficulty",
            preference: preferences.difficulty,
            activityValue: experience.difficulty
        }),
        evaluateExperienceStyleDimension({
            dimension: "experienceStyle",
            preference: preferences.experienceStyle,
            activityValue: experience.experienceStyles
        }),
        evaluateExactScalarDimension({
            dimension: "commitmentPreference",
            preference: preferences.commitmentPreference,
            activityValue: experience.commitmentType
        })
    ].filter(Boolean);
}

module.exports = {
    isUsableScalar,
    isValidConfidence,
    calculateAdjustedScore,
    evaluateFlexibleScalarDimension,
    evaluateExactScalarDimension,
    evaluateExperienceStyleDimension,
    evaluatePreferenceEvidence
};
