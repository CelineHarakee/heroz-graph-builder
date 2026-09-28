const { buildKnowledgeGapContext } = require("./knowledgeGapContextService");
const { evaluateInterestCoverage } = require("./interestCoverageEvaluator");
const { evaluateExperienceFit } = require("./experienceFitEvaluator");
const { evaluateActivityFamiliarity } = require("./activityFamiliarityEvaluator");
const { evaluateDevelopmentalRelevance } = require("./developmentalRelevanceEvaluator");
const {
    D1_APPLICABILITY,
    D1_EVALUATION_STATUS,
    D1_EXPERIENCE_COMPARISON,
    D1_PROVENANCE_STRENGTH,
    D1_SUFFICIENCY
} = require("./knowledgeGapConstants");

const CONTRACT_VERSION = "D1_V1";
const GAP_STATES = new Set([
    D1_SUFFICIENCY.UNCERTAIN,
    D1_SUFFICIENCY.INSUFFICIENT,
    D1_SUFFICIENCY.BLOCKED
]);

function unique(values) {
    return Array.from(new Set(values.filter(Boolean)));
}

function gap({ key, dimension, targetType, targetId, sufficiencyState, reasons, possibleResolvers, evidence }) {
    return {
        key,
        dimension,
        targetType,
        targetId,
        sufficiencyState,
        reasons: unique(reasons ?? []),
        possibleResolvers: unique(possibleResolvers ?? []),
        evidence: evidence ?? null
    };
}

function addGap(gaps, item) {
    if (!GAP_STATES.has(item.sufficiencyState)) return;
    if (!gaps.has(item.key)) gaps.set(item.key, item);
}

function exposureContext(bundle) {
    if (bundle?.sources?.recommendations === "unavailable") {
        return { status: "UNKNOWN", records: [] };
    }

    const records = Array.isArray(bundle?.recommendationExposure)
        ? bundle.recommendationExposure
        : [];

    if (!records.length) return { status: "NEVER_EXPOSED", records: [] };

    return {
        status: "EXPOSED",
        records: records.map((record) => ({
            recommendationId: record?._id ?? null,
            requestedAt: record?.recommendationContext?.requestedAt ?? null,
            wasDisplayed: record?.response?.wasDisplayed ?? null,
            displayedAt: record?.response?.displayedAt ?? null,
            clickedActivityIds: record?.response?.clickedActivityIds ?? [],
            savedActivityIds: record?.response?.savedActivityIds ?? [],
            bookedSessionIds: record?.response?.bookedSessionIds ?? [],
            dismissedActivityIds: record?.response?.dismissedActivityIds ?? [],
            lastResponseAt: record?.response?.lastResponseAt ?? null
        }))
    };
}

function interestGaps(gaps, bundle, interestCoverage) {
    addGap(gaps, gap({
        key: `interest:${bundle.evaluation.childId}:subcategory:${interestCoverage.target.subcategoryId}`,
        dimension: "interestCoverage",
        targetType: "Subcategory",
        targetId: interestCoverage.target.subcategoryId,
        sufficiencyState: interestCoverage.sufficiencyState,
        reasons: interestCoverage.reasons,
        possibleResolvers: interestCoverage.possibleResolvers,
        evidence: interestCoverage.evidence
    }));
}

function experienceFitGaps(gaps, bundle, experienceFit) {
    const childId = bundle.evaluation.childId;
    const activityId = bundle.evaluation.activityId;

    for (const [dimension, detail] of Object.entries(experienceFit.dimensions ?? {})) {
        if (detail.comparisonState !== D1_EXPERIENCE_COMPARISON.UNAVAILABLE) continue;

        if (detail.reasons.includes("CHILD_PREFERENCE_MISSING") || detail.reasons.includes("BOTH_MISSING")) {
            addGap(gaps, gap({
                key: `preference:${childId}:${dimension}`,
                dimension: "experienceFit",
                targetType: "ChildPreference",
                targetId: `${childId}:${dimension}`,
                sufficiencyState: detail.sufficiencyState,
                reasons: detail.reasons,
                possibleResolvers: detail.possibleResolvers.filter((resolver) => resolver === "PARENT"),
                evidence: { dimension, childPreference: detail.childPreference }
            }));
        }

        if (detail.reasons.includes("ACTIVITY_ATTRIBUTE_MISSING") || detail.reasons.includes("BOTH_MISSING")) {
            addGap(gaps, gap({
                key: `catalog:activity:${activityId}:experience:${dimension}`,
                dimension: "experienceFit",
                targetType: "ActivityExperienceAttribute",
                targetId: `${activityId}:${dimension}`,
                sufficiencyState: D1_SUFFICIENCY.BLOCKED,
                reasons: detail.reasons,
                possibleResolvers: detail.possibleResolvers.filter((resolver) => resolver === "CATALOG"),
                evidence: { dimension, activityValue: detail.activityValue }
            }));
        }
    }
}

function familiarityGaps(gaps, bundle, activityFamiliarity) {
    addGap(gaps, gap({
        key: `familiarity:${bundle.evaluation.childId}:activity:${bundle.evaluation.activityId}`,
        dimension: "activityFamiliarity",
        targetType: "Activity",
        targetId: bundle.evaluation.activityId,
        sufficiencyState: activityFamiliarity.sufficiencyState,
        reasons: activityFamiliarity.reasons,
        possibleResolvers: activityFamiliarity.possibleResolvers,
        evidence: { events: activityFamiliarity.events }
    }));
}

function developmentalGaps(gaps, bundle, developmentalRelevance) {
    if (developmentalRelevance.applicabilityState === D1_APPLICABILITY.NOT_APPLICABLE) return;

    addGap(gaps, gap({
        key: developmentalRelevance.sufficiencyState === D1_SUFFICIENCY.BLOCKED
            ? `development:activity:${bundle.evaluation.activityId}:blocked:${unique(developmentalRelevance.reasons).join("+")}`
            : `development:${bundle.evaluation.childId}:activity:${bundle.evaluation.activityId}`,
        dimension: "developmentalRelevance",
        targetType: developmentalRelevance.sufficiencyState === D1_SUFFICIENCY.BLOCKED
            ? "DevelopmentReference"
            : "Activity",
        targetId: bundle.evaluation.activityId,
        sufficiencyState: developmentalRelevance.sufficiencyState,
        reasons: developmentalRelevance.reasons,
        possibleResolvers: developmentalRelevance.possibleResolvers,
        evidence: {
            goalRelevance: developmentalRelevance.goalRelevance,
            developmentEvidence: developmentalRelevance.developmentEvidence
        }
    }));
}

function knowledgeGaps(bundle, results) {
    const gaps = new Map();
    interestGaps(gaps, bundle, results.interestCoverage);
    experienceFitGaps(gaps, bundle, results.experienceFit);
    familiarityGaps(gaps, bundle, results.activityFamiliarity);
    developmentalGaps(gaps, bundle, results.developmentalRelevance);
    return Array.from(gaps.values());
}

function addOverlap(map, identity, dimension, evidence) {
    if (!identity) return;
    if (!map.has(identity)) map.set(identity, []);
    map.get(identity).push({ dimension, evidence });
}

function overlapGroups(interestCoverage, activityFamiliarity, developmentalRelevance) {
    const overlaps = new Map();

    for (const event of activityFamiliarity.events ?? []) {
        addOverlap(overlaps, event.eventId && event.eventType ? `${event.eventId}:${event.eventType}` : null,
            "activityFamiliarity", event);
    }
    for (const event of interestCoverage.evidenceSemantics?.meaningfulNonPassiveEvents ?? []) {
        addOverlap(overlaps, event.identity, "interestCoverage", event);
    }
    for (const match of developmentalRelevance.developmentEvidence?.matches ?? []) {
        for (const history of match.history ?? []) {
            addOverlap(overlaps, history.identity, "developmentalRelevance", history);
        }
    }

    return Array.from(overlaps.entries())
        .filter(([, items]) => new Set(items.map((item) => item.dimension)).size > 1)
        .map(([identity, items]) => ({
            identity,
            provenanceStrength: D1_PROVENANCE_STRENGTH.ID_PROVEN,
            observations: items
        }));
}

function preferenceBehaviorTension(experienceFit, activityFamiliarity) {
    const mismatches = Object.entries(experienceFit.dimensions ?? {})
        .filter(([, detail]) => detail.comparisonState === D1_EXPERIENCE_COMPARISON.MISMATCH)
        .map(([dimension, detail]) => ({ dimension, childPreference: detail.childPreference, activityValue: detail.activityValue }));

    if (!mismatches.length) return { status: "UNAVAILABLE", reasons: ["NO_EXPLICIT_PREFERENCE_MISMATCH"] };

    const strongBehavior = (activityFamiliarity.events ?? []).filter((event) =>
        ["Save", "Book", "Attend"].includes(event.eventType) ||
        (event.eventType === "Rate" && event.ratingValue >= 4));

    if (!strongBehavior.length) {
        return { status: "NOT_OBSERVED", mismatches, behavior: [] };
    }

    return { status: "PRESENT", mismatches, behavior: strongBehavior };
}

function metadata(evaluatedAt) {
    return {
        evaluatedAt,
        contractVersion: CONTRACT_VERSION
    };
}

function composeKnowledgeGapResult(bundle, options = {}) {
    const evaluatedAt = options.evaluatedAt ?? new Date();

    if (bundle?.evaluation?.status !== D1_EVALUATION_STATUS.RESOLVED) {
        return {
            evaluation: bundle?.evaluation ?? null,
            exposureContext: { status: "UNKNOWN", records: [] },
            annotations: {
                preferenceBehaviorTension: { status: "UNAVAILABLE", reasons: ["EVALUATION_UNRESOLVABLE"] }
            },
            overlapGroups: [],
            knowledgeGaps: [],
            metadata: metadata(evaluatedAt)
        };
    }

    const results = {
        interestCoverage: evaluateInterestCoverage(bundle),
        experienceFit: evaluateExperienceFit(bundle),
        activityFamiliarity: evaluateActivityFamiliarity(bundle),
        developmentalRelevance: evaluateDevelopmentalRelevance(bundle)
    };

    return {
        evaluation: bundle.evaluation,
        ...results,
        exposureContext: exposureContext(bundle),
        annotations: {
            preferenceBehaviorTension: preferenceBehaviorTension(results.experienceFit, results.activityFamiliarity)
        },
        overlapGroups: overlapGroups(results.interestCoverage, results.activityFamiliarity, results.developmentalRelevance),
        knowledgeGaps: knowledgeGaps(bundle, results),
        metadata: metadata(evaluatedAt)
    };
}

async function evaluateKnowledgeGaps(childId, activityId, options = {}) {
    const bundle = await buildKnowledgeGapContext(childId, activityId, options);
    return composeKnowledgeGapResult(bundle, options);
}

module.exports = {
    evaluateKnowledgeGaps,
    composeKnowledgeGapResult
};
