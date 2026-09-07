const traversalService =
    require("../traversal/traversalService");
const recommendationDataService =
    require("./recommendationDataService");

async function getDiscoveredCandidates(childId) {
    return await traversalService.findCandidateActivities(
        childId
    );
}

async function getRevalidatedCandidates(childId) {
    const candidates =
        await getDiscoveredCandidates(childId);

    const revalidatedCandidates = [];

    for (const candidate of candidates) {
        const currentActivity =
            await recommendationDataService.getActivity(
                candidate.activity.activityId
            );

        revalidatedCandidates.push({
            ...candidate,
            currentActivity
        });
    }

    return revalidatedCandidates;
}

async function getOperationalCandidates(childId) {
    const candidates =
        await getRevalidatedCandidates(childId);

    const operationalCandidates = [];

    for (const candidate of candidates) {
        const currentActivity =
            candidate.currentActivity;

        if (!currentActivity) {
            operationalCandidates.push({
                ...candidate,
                currentVendor: null,
                currentSessions: []
            });

            continue;
        }

        const currentVendor =
            await recommendationDataService.getVendor(
                currentActivity.vendorId
            );

        const currentSessions =
            await recommendationDataService.getSessions(
                currentActivity._id
            );

        operationalCandidates.push({
            ...candidate,
            currentVendor,
            currentSessions
        });
    }

    return operationalCandidates;
}

async function buildRecommendationContext(childId) {
    const child =
        await recommendationDataService.getChild(childId);

    if (!child) {
        return null;
    }

    const childInterests =
        await recommendationDataService.getChildInterests(
            child._id
        );

    const subcategoryIds = childInterests.map(
        (interest) => interest.subcategoryId
    );

    const subcategories =
        await recommendationDataService.getSubcategoriesByIds(
            subcategoryIds
        );

    const parent =
        child.parentId
            ? await recommendationDataService.getParent(
                child.parentId
            )
            : null;

    const goalIds = Array.isArray(child.parentGoals)
        ? child.parentGoals.map(
            (parentGoal) => parentGoal?.goalId
        )
        : [];

    const goals =
        await recommendationDataService.getGoalsByIds(
            goalIds
        );

    const candidates =
        await getOperationalCandidates(child._id);

    const candidateActivityIdsByKey = new Map();

    for (const candidate of candidates) {
        const activityId =
            candidate.currentActivity?._id ??
            candidate.activity?.activityId;

        if (activityId === null || activityId === undefined) {
            continue;
        }

        candidateActivityIdsByKey.set(
            String(activityId),
            activityId
        );
    }

    const candidateActivityIds =
        Array.from(candidateActivityIdsByKey.values());

    const bookingHistory =
        await recommendationDataService.getExplorationBookingHistory(
            child._id,
            candidateActivityIds
        );

    const recommendationHistory =
        await recommendationDataService.getExplorationRecommendationHistory(
            child._id,
            candidateActivityIds
        );

    const interactionHistory =
        await recommendationDataService.getInteractionsForCandidateActivities(
            child._id,
            candidateActivityIds
        );

    return {
        child,
        parent,
        candidates,
        historyContext: {
            bookings: bookingHistory.bookings,
            recommendations: recommendationHistory.recommendations,
            interactions: interactionHistory.interactions,
            sources: {
                bookings: bookingHistory.source,
                recommendations: recommendationHistory.source,
                interactions: interactionHistory.source
            }
        },
        goalContext: {
            goals
        },
        interestContext: {
            childInterests,
            subcategories
        }
    };
}

module.exports = {
    getDiscoveredCandidates,
    getRevalidatedCandidates,
    getOperationalCandidates,
    buildRecommendationContext
};
