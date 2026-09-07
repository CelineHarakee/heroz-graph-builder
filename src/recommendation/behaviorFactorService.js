const {
    SCORING_FACTORS,
    createFactorResult
} = require("./scoringContract");

const EXPLICIT_POSITIVE_TYPES = new Set([
    "Save",
    "Book",
    "Attend",
    "Complete"
]);

const EXPLICIT_NEGATIVE_TYPES = new Set([
    "Unsave",
    "Dismiss"
]);

const PASSIVE_TYPES = new Set([
    "View",
    "Click"
]);

const IGNORED_TYPES = new Set([
    "QuestionAnswered",
    "QuestionSkipped",
    "FeedbackSubmitted"
]);

function toIdKey(value) {
    if (value === null || value === undefined) {
        return null;
    }

    return String(value);
}

function idsEqual(left, right) {
    const leftKey = toIdKey(left);
    const rightKey = toIdKey(right);

    return leftKey !== null && rightKey !== null && leftKey === rightKey;
}

function createUnavailableBehaviorResult(evidence = []) {
    return createFactorResult({
        factor: SCORING_FACTORS.BEHAVIOR,
        available: false,
        score: null,
        evidence
    });
}

function createAvailableBehaviorResult({
    activityId,
    selected,
    matchingInteractionCount,
    explicitInteractionCount,
    passiveInteractionCount
}) {
    const evidence = {
        type: "exact_activity_behavior",
        activityId,
        behaviorState: selected.behaviorState,
        selectedInteractionType: selected.interactionType,
        selectedInteractionId: selected.interactionId,
        selectedTimestamp: selected.timestamp,
        actorType: selected.actorType,
        score: selected.score,
        matchingInteractionCount,
        explicitInteractionCount,
        passiveInteractionCount
    };

    if (selected.ratingValue !== null) {
        evidence.ratingValue = selected.ratingValue;
    }

    return createFactorResult({
        factor: SCORING_FACTORS.BEHAVIOR,
        available: true,
        score: selected.score,
        evidence: [
            evidence
        ]
    });
}

function getCandidateActivityId(eligibilityEvaluation) {
    return (
        eligibilityEvaluation.candidate?.currentActivity?._id ??
        eligibilityEvaluation.candidate?.activity?.activityId ??
        null
    );
}

function isValidTimestamp(value) {
    if (value === null || value === undefined || value === "") {
        return false;
    }

    const timestamp = new Date(value);

    return Number.isFinite(timestamp.getTime());
}

function timestampMs(value) {
    return new Date(value).getTime();
}

function isValidRating(value) {
    return (
        typeof value === "number" &&
        Number.isFinite(value) &&
        value >= 1 &&
        value <= 5
    );
}

function exactInteractionMatches(interaction, childId, activityId) {
    return (
        idsEqual(interaction?.actor?.childId, childId) &&
        interaction?.targetEntity?.entityType === "Activity" &&
        idsEqual(interaction?.targetEntity?.entityId, activityId)
    );
}

function classifyInteraction(interaction) {
    const interactionType =
        interaction?.interactionDetails?.interactionType;

    if (EXPLICIT_POSITIVE_TYPES.has(interactionType)) {
        return {
            category: "explicit",
            score: 1,
            behaviorState: "explicit_positive"
        };
    }

    if (EXPLICIT_NEGATIVE_TYPES.has(interactionType)) {
        return {
            category: "explicit",
            score: 0,
            behaviorState: "explicit_negative"
        };
    }

    if (interactionType === "Rate") {
        const ratingValue = interaction?.interactionDetails?.ratingValue;

        if (!isValidRating(ratingValue)) {
            return {
                category: "explicit",
                invalidRating: true,
                behaviorState: "rating"
            };
        }

        return {
            category: "explicit",
            score: (ratingValue - 1) / 4,
            behaviorState: "rating",
            ratingValue
        };
    }

    if (PASSIVE_TYPES.has(interactionType)) {
        return {
            category: "passive",
            score: 0.5,
            behaviorState: "passive"
        };
    }

    if (IGNORED_TYPES.has(interactionType)) {
        return {
            category: "ignored"
        };
    }

    return {
        category: "unsupported"
    };
}

function toCandidate(interaction, classification) {
    return {
        interaction,
        interactionId: toIdKey(interaction?._id),
        interactionType: interaction?.interactionDetails?.interactionType,
        timestamp: interaction.timestamp,
        timestampMs: timestampMs(interaction.timestamp),
        actorType: interaction?.actor?.actorType ?? null,
        score: classification.score,
        behaviorState: classification.behaviorState,
        ratingValue: classification.ratingValue ?? null,
        invalidRating: classification.invalidRating === true
    };
}

function latestByTimestamp(candidates) {
    const latestTime = Math.max(
        ...candidates.map((candidate) => candidate.timestampMs)
    );

    return candidates.filter((candidate) =>
        candidate.timestampMs === latestTime
    );
}

function selectLatestSupported(candidates) {
    const latest = latestByTimestamp(candidates);
    const scores = new Set(latest.map((candidate) => candidate.score));

    if (scores.size > 1) {
        return {
            unavailable: true,
            evidence: [
                {
                    type: "ambiguous_latest_behavior"
                }
            ]
        };
    }

    return {
        selected: latest[0]
    };
}

function calculateBehaviorFactor(context, eligibilityEvaluation) {
    if (context === null || context === undefined) {
        throw new Error("Recommendation context is required");
    }

    if (eligibilityEvaluation === null || eligibilityEvaluation === undefined) {
        throw new Error("Eligibility evaluation is required");
    }

    if (eligibilityEvaluation.eligibility?.eligible !== true) {
        throw new Error("Behavior scoring requires an eligible candidate evaluation");
    }

    const childId = context.child?._id;
    const activityId = getCandidateActivityId(eligibilityEvaluation);
    const activityIdKey = toIdKey(activityId);

    if (!childId || !activityId) {
        return createUnavailableBehaviorResult([
            {
                type: "missing_behavior_identity",
                childId: toIdKey(childId),
                activityId: activityIdKey
            }
        ]);
    }

    const historyContext = context.historyContext;

    if (!historyContext || typeof historyContext !== "object") {
        return createUnavailableBehaviorResult([
            {
                type: "missing_history_context"
            }
        ]);
    }

    if (historyContext.sources?.interactions !== "available") {
        return createUnavailableBehaviorResult([
            {
                type: "interaction_source_unavailable",
                source: "interactions",
                status: historyContext.sources?.interactions ?? null
            }
        ]);
    }

    if (!Array.isArray(historyContext.interactions)) {
        return createUnavailableBehaviorResult([
            {
                type: "malformed_history",
                source: "interactions"
            }
        ]);
    }

    if (historyContext.interactions.length === 0) {
        return createUnavailableBehaviorResult([
            {
                type: "no_behavior_history",
                source: "interactions"
            }
        ]);
    }

    const exactInteractions = historyContext.interactions.filter(
        (interaction) =>
            exactInteractionMatches(interaction, childId, activityId)
    );

    if (exactInteractions.length === 0) {
        return createUnavailableBehaviorResult([
            {
                type: "no_exact_activity_behavior",
                activityId: activityIdKey
            }
        ]);
    }

    const explicitCandidates = [];
    const passiveCandidates = [];
    const unsupportedCandidates = [];

    for (const interaction of exactInteractions) {
        const classification = classifyInteraction(interaction);

        if (classification.category === "ignored") {
            continue;
        }

        if (!isValidTimestamp(interaction.timestamp)) {
            return createUnavailableBehaviorResult([
                {
                    type: "malformed_history",
                    source: "interactions",
                    fieldPath: "timestamp"
                }
            ]);
        }

        const candidate = toCandidate(interaction, classification);

        if (classification.category === "explicit") {
            explicitCandidates.push(candidate);
        } else if (classification.category === "passive") {
            passiveCandidates.push(candidate);
        } else {
            unsupportedCandidates.push(candidate);
        }
    }

    const meaningfulCandidates = [
        ...explicitCandidates,
        ...passiveCandidates
    ];

    if (
        meaningfulCandidates.length === 0 &&
        unsupportedCandidates.length === 0
    ) {
        return createUnavailableBehaviorResult([
            {
                type: "no_exact_activity_behavior",
                activityId: activityIdKey
            }
        ]);
    }

    if (explicitCandidates.length > 0) {
        const explicitLatestTime = Math.max(
            ...explicitCandidates.map((candidate) => candidate.timestampMs)
        );
        const newerUnsupported = unsupportedCandidates.some((candidate) =>
            candidate.timestampMs > explicitLatestTime
        );

        if (newerUnsupported) {
            return createUnavailableBehaviorResult([
                {
                    type: "unsupported_latest_behavior",
                    activityId: activityIdKey
                }
            ]);
        }

        const latestExplicit = explicitCandidates.filter((candidate) =>
            candidate.timestampMs === explicitLatestTime
        );
        const invalidLatestRating = latestExplicit.some(
            (candidate) => candidate.invalidRating
        );

        if (invalidLatestRating) {
            return createUnavailableBehaviorResult([
                {
                    type: "invalid_rating",
                    activityId: activityIdKey
                }
            ]);
        }

        const selection = selectLatestSupported(latestExplicit);

        if (selection.unavailable) {
            return createUnavailableBehaviorResult(selection.evidence);
        }

        return createAvailableBehaviorResult({
            activityId: activityIdKey,
            selected: selection.selected,
            matchingInteractionCount: exactInteractions.length,
            explicitInteractionCount: explicitCandidates.length,
            passiveInteractionCount: passiveCandidates.length
        });
    }

    if (passiveCandidates.length > 0) {
        const passiveLatestTime = Math.max(
            ...passiveCandidates.map((candidate) => candidate.timestampMs)
        );
        const newerUnsupported = unsupportedCandidates.some((candidate) =>
            candidate.timestampMs > passiveLatestTime
        );

        if (newerUnsupported) {
            return createUnavailableBehaviorResult([
                {
                    type: "unsupported_latest_behavior",
                    activityId: activityIdKey
                }
            ]);
        }

        const selection = selectLatestSupported(passiveCandidates);

        if (selection.unavailable) {
            return createUnavailableBehaviorResult(selection.evidence);
        }

        return createAvailableBehaviorResult({
            activityId: activityIdKey,
            selected: selection.selected,
            matchingInteractionCount: exactInteractions.length,
            explicitInteractionCount: explicitCandidates.length,
            passiveInteractionCount: passiveCandidates.length
        });
    }

    return createUnavailableBehaviorResult([
        {
            type: "unsupported_latest_behavior",
            activityId: activityIdKey
        }
    ]);
}

module.exports = {
    calculateBehaviorFactor
};
