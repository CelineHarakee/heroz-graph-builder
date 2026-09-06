const {
    SCORING_FACTORS,
    createFactorResult
} = require("./scoringContract");

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

function createUnavailableExplorationResult(evidence = []) {
    return createFactorResult({
        factor: SCORING_FACTORS.EXPLORATION,
        available: false,
        score: null,
        evidence
    });
}

function createAvailableExplorationResult({
    activityId,
    noveltyState,
    score,
    matchingBookingCount,
    displayedRecommendationCount,
    experiencedBookingCount
}) {
    return createFactorResult({
        factor: SCORING_FACTORS.EXPLORATION,
        available: true,
        score,
        evidence: [
            {
                type: "exact_activity_novelty",
                activityId,
                noveltyState,
                matchingBookingCount,
                displayedRecommendationCount,
                experiencedBookingCount
            }
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

function getUnavailableSourceEvidence(sources) {
    const evidence = [];

    if (sources?.bookings !== "available") {
        evidence.push({
            type: "history_source_unavailable",
            source: "bookings",
            status: sources?.bookings ?? null
        });
    }

    if (sources?.recommendations !== "available") {
        evidence.push({
            type: "history_source_unavailable",
            source: "recommendations",
            status: sources?.recommendations ?? null
        });
    }

    return evidence;
}

function validateHistoryContext(historyContext) {
    if (!historyContext || typeof historyContext !== "object") {
        return {
            valid: false,
            evidence: [
                {
                    type: "missing_history_context"
                }
            ]
        };
    }

    const unavailableEvidence =
        getUnavailableSourceEvidence(historyContext.sources);

    if (unavailableEvidence.length > 0) {
        return {
            valid: false,
            evidence: unavailableEvidence
        };
    }

    const evidence = [];

    if (!Array.isArray(historyContext.bookings)) {
        evidence.push({
            type: "malformed_history",
            source: "bookings"
        });
    }

    if (!Array.isArray(historyContext.recommendations)) {
        evidence.push({
            type: "malformed_history",
            source: "recommendations"
        });
    }

    return {
        valid: evidence.length === 0,
        evidence
    };
}

function bookingMatchesChildAndActivity(booking, childId, activityId) {
    const details = booking?.bookingDetails;

    if (!details || !details.childId || !details.activityId) {
        return {
            malformed: true,
            matches: false
        };
    }

    return {
        malformed: false,
        matches:
            idsEqual(details.childId, childId) &&
            idsEqual(details.activityId, activityId)
    };
}

function recommendationContainsActivity(recommendation, activityId) {
    if (!Array.isArray(recommendation?.recommendedItems)) {
        return {
            malformed: true,
            contains: false
        };
    }

    for (const item of recommendation.recommendedItems) {
        if (!item || !item.activityId) {
            return {
                malformed: true,
                contains: false
            };
        }

        if (idsEqual(item.activityId, activityId)) {
            return {
                malformed: false,
                contains: true
            };
        }
    }

    return {
        malformed: false,
        contains: false
    };
}

function recommendationMatchesChild(recommendation, childId) {
    if (!recommendation?.childId) {
        return {
            malformed: true,
            matches: false
        };
    }

    return {
        malformed: false,
        matches: idsEqual(recommendation.childId, childId)
    };
}

function isExperiencedBooking(booking) {
    return booking?.attendance?.status === "Attended";
}

function calculateExplorationFactor(context, eligibilityEvaluation) {
    if (context === null || context === undefined) {
        throw new Error("Recommendation context is required");
    }

    if (eligibilityEvaluation === null || eligibilityEvaluation === undefined) {
        throw new Error("Eligibility evaluation is required");
    }

    if (eligibilityEvaluation.eligibility?.eligible !== true) {
        throw new Error("Exploration scoring requires an eligible candidate evaluation");
    }

    const childId = context.child?._id;
    const activityId = getCandidateActivityId(eligibilityEvaluation);
    const activityIdKey = toIdKey(activityId);

    if (!childId || !activityId) {
        return createUnavailableExplorationResult([
            {
                type: "missing_exploration_identity",
                childId: toIdKey(childId),
                activityId: activityIdKey
            }
        ]);
    }

    const historyValidation =
        validateHistoryContext(context.historyContext);

    if (!historyValidation.valid) {
        return createUnavailableExplorationResult(
            historyValidation.evidence
        );
    }

    let matchingBookingCount = 0;
    let experiencedBookingCount = 0;

    for (const booking of context.historyContext.bookings) {
        const match =
            bookingMatchesChildAndActivity(booking, childId, activityId);

        if (match.malformed) {
            return createUnavailableExplorationResult([
                {
                    type: "malformed_history_document",
                    source: "bookings"
                }
            ]);
        }

        if (!match.matches) {
            continue;
        }

        matchingBookingCount += 1;

        if (isExperiencedBooking(booking)) {
            experiencedBookingCount += 1;
        }
    }

    let displayedRecommendationCount = 0;

    for (const recommendation of context.historyContext.recommendations) {
        const childMatch =
            recommendationMatchesChild(recommendation, childId);

        if (childMatch.malformed) {
            return createUnavailableExplorationResult([
                {
                    type: "malformed_history_document",
                    source: "recommendations"
                }
            ]);
        }

        if (!childMatch.matches) {
            continue;
        }

        const activityMatch =
            recommendationContainsActivity(recommendation, activityId);

        if (activityMatch.malformed) {
            return createUnavailableExplorationResult([
                {
                    type: "malformed_history_document",
                    source: "recommendations"
                }
            ]);
        }

        if (!activityMatch.contains) {
            continue;
        }

        if (typeof recommendation.response?.wasDisplayed !== "boolean") {
            return createUnavailableExplorationResult([
                {
                    type: "malformed_history_document",
                    source: "recommendations"
                }
            ]);
        }

        if (recommendation.response.wasDisplayed === true) {
            displayedRecommendationCount += 1;
        }
    }

    if (experiencedBookingCount > 0) {
        return createAvailableExplorationResult({
            activityId: activityIdKey,
            noveltyState: "experienced",
            score: 0,
            matchingBookingCount,
            displayedRecommendationCount,
            experiencedBookingCount
        });
    }

    if (
        matchingBookingCount > 0 ||
        displayedRecommendationCount > 0
    ) {
        return createAvailableExplorationResult({
            activityId: activityIdKey,
            noveltyState: "exposed",
            score: 0.5,
            matchingBookingCount,
            displayedRecommendationCount,
            experiencedBookingCount
        });
    }

    return createAvailableExplorationResult({
        activityId: activityIdKey,
        noveltyState: "new",
        score: 1,
        matchingBookingCount,
        displayedRecommendationCount,
        experiencedBookingCount
    });
}

module.exports = {
    calculateExplorationFactor
};
