const traversalService =
    require("../traversal/traversalService");

const recommendationDataService =
    require("../recommendation/recommendationDataService");

const {
    checkActivityEligibility
} = require("../recommendation/eligibilityService");

const {
    calculateInterestRelevance,
    calculatePreferenceMatch,
    calculateGoalRelevance,
    calculateExplorationNovelty,
    calculateBehavioralAffinity,
    calculateVendorReliability,
    calculateSessionSuitability,
    calculateFinalScore
} = require("../recommendation/scoringService");

async function generateRecommendations(childId, limit = 5) {

    if (!childId) {
        throw new Error("childId is required");
    }

    const child =
        await recommendationDataService.getChild(childId);

    if (!child) {
        throw new Error(`Child not found: ${childId}`);
    }

    const candidates =
        await traversalService.findCandidateActivities(childId);

    const eligibleCandidates = [];

    for (const candidate of candidates) {

        const activity =
            await recommendationDataService.getActivity(
                candidate.activity.activityId
            );

        if (!activity) {
            continue;
        }

        const eligibility =
            checkActivityEligibility(
                child,
                activity
            );

        if (!eligibility.eligible) {
            continue;
        }

        const vendor =
    await recommendationDataService.getVendor(
        activity.vendorId
    );

const sessions =
    await recommendationDataService.getSessions(
        activity._id
    );

const session =
    sessions.length > 0
        ? sessions[0]
        : null;


const factors = {

    interest:
        calculateInterestRelevance(
            candidate.evidence
        ),

    preference:
        calculatePreferenceMatch(
            child,
            activity
        ),

    goal:
        calculateGoalRelevance(
            candidate.evidence
        ),

    exploration:
        calculateExplorationNovelty(
            child,
            activity._id
        ),

    behavior:
        calculateBehavioralAffinity(
            child,
            activity._id
        ),

    vendor:
        calculateVendorReliability(
            vendor
        ),

    session:
        calculateSessionSuitability(
            child,
            session
        )
};


const finalScore =
    calculateFinalScore(
        factors
    );


eligibleCandidates.push({

    ...candidate,

    currentActivity: activity,

    factors,

    score: finalScore.score

});
    }

    eligibleCandidates.sort(
    (a, b) => b.score - a.score
    );

    eligibleCandidates.forEach(
    (candidate, index) => {
        candidate.rank = index + 1;
    }
    );

    const recommendations =
    eligibleCandidates.slice(0, limit);

    return {
        child,
        recommendations
    };
}

module.exports = {
    generateRecommendations
};