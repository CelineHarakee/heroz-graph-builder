function calculateInterestRelevance(evidence) {

    if (
        !evidence ||
        !Array.isArray(evidence.interests)
    ) {
        return {
            score: 0,
            available: false
        };
    }

    if (evidence.interests.length === 0) {
        return {
            score: 0,
            available: true
        };
    }

    return {
        score: 1,
        available: true
    };
}


function calculatePreferenceMatch(child, activity) {

    if (!child || !activity) {
        return {
            score: 0,
            available: false
        };
    }

    const childPreferences = child.preferences;
    const activityPreferences = activity.preferences;

    if (!childPreferences || !activityPreferences) {
        return {
            score: 0,
            available: false
        };
    }

    const comparisons = [
        [
            childPreferences.indoorOutdoor,
            activityPreferences.indoorOutdoor
        ],
        [
            childPreferences.activityStyle,
            activityPreferences.activityStyle
        ],
        [
            childPreferences.difficultyPreference,
            activityPreferences.difficulty
        ],
        [
            childPreferences.experiencePreference,
            activityPreferences.experienceType
        ]
    ];

    const availableComparisons =
        comparisons.filter(
            ([childValue, activityValue]) =>
                childValue !== undefined &&
                childValue !== null &&
                activityValue !== undefined &&
                activityValue !== null
        );

    if (availableComparisons.length === 0) {
        return {
            score: 0,
            available: false
        };
    }

    const matches =
        availableComparisons.filter(
            ([childValue, activityValue]) =>
                childValue === activityValue
        ).length;

    return {
        score: matches / availableComparisons.length,
        available: true
    };
}

function calculateGoalRelevance(evidence) {

    if (
        !evidence ||
        !Array.isArray(evidence.goals)
    ) {
        return {
            score: 0,
            available: false
        };
    }

    if (evidence.goals.length === 0) {
        return {
            score: 0,
            available: true
        };
    }

    return {
        score: 1,
        available: true
    };
}

function calculateExplorationNovelty(child, activityId) {

    if (!child) {
        return {
            score: 0,
            available: false
        };
    }

    const history = child.activityHistory;

    // No behavioral/activity history is available
    if (!Array.isArray(history)) {
        return {
            score: 0,
            available: false
        };
    }

    // No previous activity means this candidate is novel
    if (!history.includes(activityId)) {
        return {
            score: 1,
            available: true
        };
    }

    // Previously experienced activity
    return {
        score: 0,
        available: true
    };
}

function calculateBehavioralAffinity(child, activityId) {

    if (!child) {
        return {
            score: 0,
            available: false
        };
    }

    const history = child.behaviorHistory;

    if (!Array.isArray(history)) {
        return {
            score: 0,
            available: false
        };
    }

    const activityBehavior =
        history.find(
            item => item.activityId === activityId
        );

    if (!activityBehavior) {
        return {
            score: 0,
            available: true
        };
    }

    let score = 0;

    if (activityBehavior.liked === true) {
        score += 0.5;
    }

    if (activityBehavior.booked === true) {
        score += 0.3;
    }

    if (activityBehavior.attended === true) {
        score += 0.2;
    }

    if (activityBehavior.dismissed === true) {
        score = 0;
    }

    return {
        score: Math.min(score, 1),
        available: true
    };
}

function calculateVendorReliability(vendor) {

    if (!vendor || !vendor.reliability) {
        return {
            score: 0,
            available: false
        };
    }

    const reliability = vendor.reliability;

    const values = [
        reliability.sessionCompletionRate,
        reliability.cancellationRate !== null &&
        reliability.cancellationRate !== undefined
            ? 1 - reliability.cancellationRate
            : null,
        reliability.noShowRate !== null &&
        reliability.noShowRate !== undefined
            ? 1 - reliability.noShowRate
            : null,
        reliability.capacityAccuracy
    ];

    const availableValues =
        values.filter(
            value =>
                value !== null &&
                value !== undefined
        );

    if (availableValues.length === 0) {
        return {
            score: 0,
            available: false
        };
    }

    const score =
        availableValues.reduce(
            (sum, value) => sum + value,
            0
        ) / availableValues.length;

    return {
        score,
        available: true
    };
}

function calculateSessionSuitability(child, session) {

    if (!child || !session) {
        return {
            score: 0,
            available: false
        };
    }

    const comparisons = [];

    if (
        child.preferences &&
        child.preferences.preferredStartTime &&
        session.startTime
    ) {
        // Time preference can be implemented
        // when Heroz provides the actual preference format.
        comparisons.push(
            child.preferences.preferredStartTime ===
            session.startTime
                ? 1
                : 0
        );
    }

    if (
        child.cityId &&
        session.locationId
    ) {
        comparisons.push(
            child.cityId === session.locationId
                ? 1
                : 0
        );
    }

    if (
        child.preferences &&
        child.preferences.maxPrice !== undefined &&
        session.price !== null &&
        session.price !== undefined
    ) {
        comparisons.push(
            session.price <= child.preferences.maxPrice
                ? 1
                : 0
        );
    }

    if (comparisons.length === 0) {
        return {
            score: 0,
            available: false
        };
    }

    const score =
        comparisons.reduce(
            (sum, value) => sum + value,
            0
        ) / comparisons.length;

    return {
        score,
        available: true
    };
}

function calculateFinalScore(factors) {

    const weights = {
        interest: 0.30,
        preference: 0.15,
        goal: 0.15,
        exploration: 0.12,
        behavior: 0.08,
        vendor: 0.08,
        session: 0.12
    };

    let weightedScore = 0;
    let availableWeight = 0;

    for (const [factorName, weight] of Object.entries(weights)) {

        const factor = factors[factorName];

        if (!factor || factor.available !== true) {
            continue;
        }

        weightedScore += factor.score * weight;
        availableWeight += weight;
    }

    if (availableWeight === 0) {
        return {
            score: 0,
            available: false
        };
    }

    return {
        score: weightedScore / availableWeight,
        available: true
    };
}

module.exports = {
    calculateInterestRelevance,
    calculatePreferenceMatch,
    calculateGoalRelevance,
    calculateExplorationNovelty,
    calculateBehavioralAffinity,
    calculateVendorReliability,
    calculateSessionSuitability,
    calculateFinalScore
};