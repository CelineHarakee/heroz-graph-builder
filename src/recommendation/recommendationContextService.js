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

    const candidates =
        await getOperationalCandidates(child._id);

    return {
        child,
        parent,
        candidates,
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
