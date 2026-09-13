const { SCORING_FACTORS } = require("../recommendation/scoringContract");

const CANONICAL_REASON_ORDER = Object.freeze(Object.values(SCORING_FACTORS));
const MAX_MAIN_REASONS = 3;

function isPlainObject(value) {
    return (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value)
    );
}

function clone(value) {
    if (value === undefined) {
        return undefined;
    }

    return JSON.parse(JSON.stringify(value));
}

function isResolvedLabel(reference) {
    return (
        isPlainObject(reference) &&
        reference.resolved === true &&
        typeof reference.name === "string" &&
        reference.name.trim().length > 0
    );
}

function hasPositiveFactorState(factor) {
    return (
        isPlainObject(factor) &&
        factor.available === true &&
        typeof factor.score === "number" &&
        Number.isFinite(factor.score) &&
        factor.score > 0 &&
        Array.isArray(factor.evidence)
    );
}

function firstSupportedInterestEvidence(evidence) {
    return evidence.find((item) =>
        isPlainObject(item) &&
        item.type === "exact_subcategory_interest" &&
        isResolvedLabel(item.subcategory)
    ) ?? evidence.find((item) =>
        isPlainObject(item) &&
        item.type === "category_fallback" &&
        isResolvedLabel(item.category)
    ) ?? null;
}

function buildInterestReason(factor) {
    const evidence = firstSupportedInterestEvidence(factor.evidence);

    if (!evidence) {
        return null;
    }

    if (evidence.type === "exact_subcategory_interest") {
        return {
            type: SCORING_FACTORS.INTEREST,
            supportType: "exact_subcategory_interest",
            subcategory: clone(evidence.subcategory),
            sourceEvidence: {
                type: evidence.type,
                subcategoryId: evidence.subcategoryId,
                score: evidence.score,
                confidence: evidence.confidence
            }
        };
    }

    return {
        type: SCORING_FACTORS.INTEREST,
        supportType: "category_fallback",
        category: clone(evidence.category),
        excludedSubcategory: clone(evidence.excludedSubcategory),
        sourceEvidence: {
            type: evidence.type,
            categoryId: evidence.categoryId,
            excludedSubcategoryId: evidence.excludedSubcategoryId,
            siblingCount: evidence.siblingCount,
            siblingScores: clone(evidence.siblingScores),
            categoryScore: evidence.categoryScore
        }
    };
}

function firstSupportedPreferenceEvidence(evidence) {
    return evidence.find((item) =>
        isPlainObject(item) &&
        typeof item.adjustedScore === "number" &&
        Number.isFinite(item.adjustedScore) &&
        item.adjustedScore > 0
    ) ?? null;
}

function buildPreferenceReason(factor) {
    const evidence = firstSupportedPreferenceEvidence(factor.evidence);

    if (!evidence) {
        return null;
    }

    return {
        type: SCORING_FACTORS.PREFERENCE,
        dimension: evidence.dimension,
        childValue: clone(evidence.childValue),
        activityValue: clone(evidence.activityValue),
        source: evidence.source,
        sourceEvidence: {
            dimension: evidence.dimension,
            childValue: clone(evidence.childValue),
            activityValue: clone(evidence.activityValue),
            confidence: evidence.confidence,
            source: evidence.source,
            baseMatch: evidence.baseMatch,
            adjustedScore: evidence.adjustedScore
        }
    };
}

function hasMatchedOutcome(item) {
    return (
        Array.isArray(item.matchedOutcomeIds) &&
        item.matchedOutcomeIds.length > 0
    ) || (
        Array.isArray(item.matchedOutcomes) &&
        item.matchedOutcomes.length > 0
    );
}

function firstSupportedGoalEvidence(evidence) {
    return evidence.find((item) =>
        isPlainObject(item) &&
        item.type === "goal_coverage" &&
        typeof item.coverage === "number" &&
        Number.isFinite(item.coverage) &&
        item.coverage > 0 &&
        hasMatchedOutcome(item)
    ) ?? null;
}

function buildGoalReason(factor) {
    const evidence = firstSupportedGoalEvidence(factor.evidence);

    if (!evidence) {
        return null;
    }

    return {
        type: SCORING_FACTORS.GOAL,
        goalId: evidence.goalId,
        goal: clone(evidence.goal),
        priority: evidence.priority,
        status: evidence.status,
        goalOutcomeIds: clone(evidence.goalOutcomeIds),
        matchedOutcomeIds: clone(evidence.matchedOutcomeIds),
        goalOutcomes: clone(evidence.goalOutcomes),
        matchedOutcomes: clone(evidence.matchedOutcomes),
        sourceEvidence: {
            type: evidence.type,
            goalId: evidence.goalId,
            priority: evidence.priority,
            status: evidence.status,
            goalOutcomeIds: clone(evidence.goalOutcomeIds),
            matchedOutcomeIds: clone(evidence.matchedOutcomeIds),
            coverage: evidence.coverage
        }
    };
}

function firstSupportedExplorationEvidence(evidence) {
    return evidence.find((item) =>
        isPlainObject(item) &&
        item.type === "exact_activity_novelty" &&
        (item.noveltyState === "new" || item.noveltyState === "exposed")
    ) ?? null;
}

function buildExplorationReason(factor) {
    const evidence = firstSupportedExplorationEvidence(factor.evidence);

    if (!evidence) {
        return null;
    }

    return {
        type: SCORING_FACTORS.EXPLORATION,
        activityId: evidence.activityId,
        noveltyState: evidence.noveltyState,
        matchingBookingCount: evidence.matchingBookingCount,
        displayedRecommendationCount: evidence.displayedRecommendationCount,
        experiencedBookingCount: evidence.experiencedBookingCount,
        sourceEvidence: clone(evidence)
    };
}

function actorAttributionFor(actorType) {
    if (actorType === "Child") {
        return "child";
    }

    if (actorType === "Parent") {
        return "parent";
    }

    return "neutral";
}

function firstSupportedBehaviorEvidence(evidence) {
    return evidence.find((item) =>
        isPlainObject(item) &&
        item.type === "exact_activity_behavior" &&
        typeof item.selectedInteractionType === "string" &&
        item.selectedInteractionType.trim().length > 0
    ) ?? null;
}

function buildBehaviorReason(factor) {
    const evidence = firstSupportedBehaviorEvidence(factor.evidence);

    if (!evidence) {
        return null;
    }

    const reason = {
        type: SCORING_FACTORS.BEHAVIOR,
        activityId: evidence.activityId,
        behaviorState: evidence.behaviorState,
        selectedInteractionType: evidence.selectedInteractionType,
        selectedInteractionId: evidence.selectedInteractionId,
        selectedTimestamp: evidence.selectedTimestamp,
        actorType: evidence.actorType,
        actorAttribution: actorAttributionFor(evidence.actorType),
        matchingInteractionCount: evidence.matchingInteractionCount,
        explicitInteractionCount: evidence.explicitInteractionCount,
        passiveInteractionCount: evidence.passiveInteractionCount,
        sourceEvidence: clone(evidence)
    };

    if (Object.prototype.hasOwnProperty.call(evidence, "ratingValue")) {
        reason.ratingValue = evidence.ratingValue;
    }

    return reason;
}

function firstSupportedSessionEvidence(evidence) {
    return evidence.find((item) =>
        isPlainObject(item) &&
        item.type === "preferred_day_match" &&
        Array.isArray(item.matchingSessionIds) &&
        item.matchingSessionIds.length > 0 &&
        Array.isArray(item.matchingWeekdays) &&
        item.matchingWeekdays.length > 0
    ) ?? null;
}

function buildSessionReason(factor) {
    const evidence = firstSupportedSessionEvidence(factor.evidence);

    if (!evidence) {
        return null;
    }

    return {
        type: SCORING_FACTORS.SESSION,
        preferredDays: clone(evidence.preferredDays),
        eligibleSessionCount: evidence.eligibleSessionCount,
        matchingSessionIds: clone(evidence.matchingSessionIds),
        matchingWeekdays: clone(evidence.matchingWeekdays),
        sourceEvidence: {
            type: evidence.type,
            preferredDays: clone(evidence.preferredDays),
            eligibleSessionCount: evidence.eligibleSessionCount,
            matchingSessionIds: clone(evidence.matchingSessionIds),
            matchingWeekdays: clone(evidence.matchingWeekdays),
            score: evidence.score
        }
    };
}

function buildSupportedReason(type, factor) {
    if (!hasPositiveFactorState(factor)) {
        return null;
    }

    if (type === SCORING_FACTORS.INTEREST) {
        return buildInterestReason(factor);
    }

    if (type === SCORING_FACTORS.PREFERENCE) {
        return buildPreferenceReason(factor);
    }

    if (type === SCORING_FACTORS.GOAL) {
        return buildGoalReason(factor);
    }

    if (type === SCORING_FACTORS.EXPLORATION) {
        return buildExplorationReason(factor);
    }

    if (type === SCORING_FACTORS.BEHAVIOR) {
        return buildBehaviorReason(factor);
    }

    if (type === SCORING_FACTORS.SESSION) {
        return buildSessionReason(factor);
    }

    return null;
}

function validateExplanationEvidence(explanationEvidence) {
    if (!isPlainObject(explanationEvidence)) {
        throw new Error("Explanation evidence is required");
    }

    if (!isPlainObject(explanationEvidence.factors)) {
        throw new Error("Explanation evidence factors are required");
    }

    for (const factor of CANONICAL_REASON_ORDER) {
        if (!isPlainObject(explanationEvidence.factors[factor])) {
            throw new Error(`Explanation evidence factor is required for ${factor}`);
        }
    }
}

function selectExplanationReasons(explanationEvidence) {
    validateExplanationEvidence(explanationEvidence);

    const reasons = [];

    for (const type of CANONICAL_REASON_ORDER) {
        const reason = buildSupportedReason(
            type,
            explanationEvidence.factors[type]
        );

        if (reason) {
            reasons.push(reason);
        }

        if (reasons.length === MAX_MAIN_REASONS) {
            break;
        }
    }

    return reasons;
}

module.exports = {
    CANONICAL_REASON_ORDER,
    MAX_MAIN_REASONS,
    selectExplanationReasons
};
