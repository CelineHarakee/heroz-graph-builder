const {
    D1_COVERAGE,
    D1_EVALUATION_STATUS,
    D1_EXPERIENCE_COMPARISON,
    D1_RESOLVER,
    D1_SUFFICIENCY
} = require("./knowledgeGapConstants");
const {
    evaluateExactScalarDimension,
    evaluateExperienceStyleDimension,
    evaluateFlexibleScalarDimension,
    isUsableScalar,
    isValidConfidence
} = require("../recommendation/preferenceComparisonService");

const DIMENSIONS = Object.freeze([
    {
        key: "environment",
        preferenceKey: "environment",
        activityKey: "environment",
        evaluator: evaluateFlexibleScalarDimension,
        activityAvailable: isUsableScalar
    },
    {
        key: "socialStyle",
        preferenceKey: "socialStyle",
        activityKey: "socialStyle",
        evaluator: evaluateFlexibleScalarDimension,
        activityAvailable: isUsableScalar
    },
    {
        key: "difficulty",
        preferenceKey: "difficulty",
        activityKey: "difficulty",
        evaluator: evaluateExactScalarDimension,
        activityAvailable: isUsableScalar
    },
    {
        key: "experienceStyle",
        preferenceKey: "experienceStyle",
        activityKey: "experienceStyles",
        evaluator: evaluateExperienceStyleDimension,
        activityAvailable: (value) => Array.isArray(value) && value.length > 0
    },
    {
        key: "commitmentPreference",
        preferenceKey: "commitmentPreference",
        activityKey: "commitmentType",
        evaluator: evaluateExactScalarDimension,
        activityAvailable: isUsableScalar
    }
]);

function childPreferenceAvailable(preference) {
    return Boolean(preference) &&
        isUsableScalar(preference.value) &&
        isValidConfidence(preference.confidenceScore);
}

function unique(values) {
    return Array.from(new Set(values));
}

function resolversFor(reason) {
    if (reason === "CHILD_PREFERENCE_MISSING") return [D1_RESOLVER.PARENT];
    if (reason === "ACTIVITY_ATTRIBUTE_MISSING") return [D1_RESOLVER.CATALOG];
    if (reason === "BOTH_MISSING") return [D1_RESOLVER.PARENT, D1_RESOLVER.CATALOG];
    return [];
}

function unavailableDimension(config, childPreference, activityValue, reason) {
    const sufficiencyState = reason === "ACTIVITY_ATTRIBUTE_MISSING"
        ? D1_SUFFICIENCY.BLOCKED
        : D1_SUFFICIENCY.INSUFFICIENT;

    return {
        childPreference: childPreference ?? null,
        activityValue: activityValue ?? null,
        comparisonState: D1_EXPERIENCE_COMPARISON.UNAVAILABLE,
        sufficiencyState,
        reasons: [reason],
        possibleResolvers: resolversFor(reason)
    };
}

function evaluateDimension(config, preferences, experience) {
    const childPreference = preferences?.[config.preferenceKey] ?? null;
    const activityValue = experience?.[config.activityKey] ?? null;
    const hasChildPreference = childPreferenceAvailable(childPreference);
    const hasActivityValue = config.activityAvailable(activityValue);

    if (!hasChildPreference || !hasActivityValue) {
        const reason = !hasChildPreference && !hasActivityValue
            ? "BOTH_MISSING"
            : !hasChildPreference ? "CHILD_PREFERENCE_MISSING" : "ACTIVITY_ATTRIBUTE_MISSING";
        return unavailableDimension(config, childPreference, activityValue, reason);
    }

    const evidence = config.evaluator({
        dimension: config.key,
        preference: childPreference,
        activityValue
    });

    return {
        childPreference,
        activityValue: evidence?.activityValue ?? activityValue,
        comparisonState: evidence?.baseMatch === 1
            ? D1_EXPERIENCE_COMPARISON.MATCH
            : D1_EXPERIENCE_COMPARISON.MISMATCH,
        sufficiencyState: D1_SUFFICIENCY.SUFFICIENT,
        reasons: [],
        possibleResolvers: [],
        evidence
    };
}

function coverageStateFor(availableCount) {
    if (availableCount === DIMENSIONS.length) return D1_COVERAGE.AVAILABLE;
    if (availableCount > 0) return D1_COVERAGE.PARTIAL;
    return D1_COVERAGE.MISSING;
}

function overallSufficiency(availableCount, hasChildGap, hasCatalogGap) {
    if (availableCount === DIMENSIONS.length) return D1_SUFFICIENCY.SUFFICIENT;
    if (availableCount > 0 && hasChildGap) return D1_SUFFICIENCY.UNCERTAIN;
    if (availableCount === 0 && hasChildGap) return D1_SUFFICIENCY.INSUFFICIENT;
    if (hasCatalogGap) return D1_SUFFICIENCY.BLOCKED;
    return D1_SUFFICIENCY.INSUFFICIENT;
}

function evaluateExperienceFit(bundle) {
    if (bundle?.evaluation?.status && bundle.evaluation.status !== D1_EVALUATION_STATUS.RESOLVED) {
        return {
            coverageState: D1_COVERAGE.MISSING,
            sufficiencyState: D1_SUFFICIENCY.BLOCKED,
            dimensions: {},
            reasons: ["EVALUATION_UNRESOLVABLE"],
            possibleResolvers: []
        };
    }

    const preferences = bundle?.child?.preferences;
    const experience = bundle?.activity?.experience;
    const dimensions = {};

    for (const config of DIMENSIONS) {
        dimensions[config.key] = evaluateDimension(config, preferences, experience);
    }

    const values = Object.values(dimensions);
    const availableCount = values.filter((item) =>
        item.comparisonState !== D1_EXPERIENCE_COMPARISON.UNAVAILABLE).length;
    const reasons = unique(values.flatMap((item) => item.reasons));
    const hasChildGap = values.some((item) =>
        item.reasons.includes("CHILD_PREFERENCE_MISSING") || item.reasons.includes("BOTH_MISSING"));
    const hasCatalogGap = values.some((item) =>
        item.reasons.includes("ACTIVITY_ATTRIBUTE_MISSING") || item.reasons.includes("BOTH_MISSING"));

    return {
        coverageState: coverageStateFor(availableCount),
        sufficiencyState: overallSufficiency(availableCount, hasChildGap, hasCatalogGap),
        dimensions,
        reasons,
        possibleResolvers: unique(values.flatMap((item) => item.possibleResolvers))
    };
}

module.exports = {
    evaluateExperienceFit
};
