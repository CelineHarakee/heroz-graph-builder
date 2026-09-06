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

function addUniqueId(idsByKey, value) {
    const key = toIdKey(value);

    if (!key) {
        return false;
    }

    if (!idsByKey.has(key)) {
        idsByKey.set(key, key);
    }

    return true;
}

function createUnavailableGoalResult(evidence = []) {
    return createFactorResult({
        factor: SCORING_FACTORS.GOAL,
        available: false,
        score: null,
        evidence
    });
}

function getUniqueActiveParentGoals(parentGoals) {
    if (!Array.isArray(parentGoals)) {
        return [];
    }

    const activeGoalsById = new Map();

    for (const parentGoal of parentGoals) {
        if (
            !parentGoal ||
            parentGoal.status !== "Active" ||
            !parentGoal.goalId
        ) {
            continue;
        }

        const goalId = toIdKey(parentGoal.goalId);

        if (!activeGoalsById.has(goalId)) {
            activeGoalsById.set(goalId, parentGoal);
        }
    }

    return Array.from(activeGoalsById.values());
}

function getGoalById(goals, goalId) {
    if (!Array.isArray(goals)) {
        return null;
    }

    const goalIdKey = toIdKey(goalId);

    return goals.find((goal) =>
        toIdKey(goal?._id) === goalIdKey
    ) ?? null;
}

function getUniqueGoalOutcomeIds(goal) {
    if (!Array.isArray(goal?.relatedOutcomes)) {
        return null;
    }

    const idsByKey = new Map();

    for (const relatedOutcome of goal.relatedOutcomes) {
        addUniqueId(idsByKey, relatedOutcome?.outcomeId);
    }

    return Array.from(idsByKey.values());
}

function getUniqueActivityOutcomeIds(currentActivity) {
    if (!Array.isArray(currentActivity?.learningOutcomes)) {
        return null;
    }

    const idsByKey = new Map();

    for (const learningOutcome of currentActivity.learningOutcomes) {
        if (!learningOutcome?.outcomeId) {
            return null;
        }

        addUniqueId(idsByKey, learningOutcome.outcomeId);
    }

    return Array.from(idsByKey.values());
}

function calculateGoalFactor(context, eligibilityEvaluation) {
    if (context === null || context === undefined) {
        throw new Error("Recommendation context is required");
    }

    if (eligibilityEvaluation === null || eligibilityEvaluation === undefined) {
        throw new Error("Eligibility evaluation is required");
    }

    if (eligibilityEvaluation.eligibility?.eligible !== true) {
        throw new Error("Goal scoring requires an eligible candidate evaluation");
    }

    const activeParentGoals =
        getUniqueActiveParentGoals(context.child?.parentGoals);

    if (activeParentGoals.length === 0) {
        return createUnavailableGoalResult();
    }

    const activityOutcomeIds =
        getUniqueActivityOutcomeIds(
            eligibilityEvaluation.candidate?.currentActivity
        );

    if (activityOutcomeIds === null) {
        return createUnavailableGoalResult([
            {
                type: "malformed_activity_outcomes"
            }
        ]);
    }

    const activityOutcomeIdSet = new Set(activityOutcomeIds);
    const evidence = [];
    const coverages = [];

    for (const parentGoal of activeParentGoals) {
        const goal = getGoalById(
            context.goalContext?.goals,
            parentGoal.goalId
        );

        if (!goal) {
            evidence.push({
                type: "missing_goal_document",
                goalId: toIdKey(parentGoal.goalId),
                priority: parentGoal.priority ?? null,
                status: parentGoal.status ?? null
            });
            continue;
        }

        const goalOutcomeIds = getUniqueGoalOutcomeIds(goal);

        if (goalOutcomeIds === null || goalOutcomeIds.length === 0) {
            evidence.push({
                type: "unusable_goal_outcomes",
                goalId: toIdKey(parentGoal.goalId),
                priority: parentGoal.priority ?? null,
                status: parentGoal.status ?? null
            });
            continue;
        }

        const matchedOutcomeIds = goalOutcomeIds.filter((outcomeId) =>
            activityOutcomeIdSet.has(outcomeId)
        );
        const coverage = matchedOutcomeIds.length / goalOutcomeIds.length;

        coverages.push(coverage);
        evidence.push({
            type: "goal_coverage",
            goalId: toIdKey(parentGoal.goalId),
            priority: parentGoal.priority ?? null,
            status: parentGoal.status ?? null,
            goalOutcomeIds: [...goalOutcomeIds],
            matchedOutcomeIds: [...matchedOutcomeIds],
            coverage
        });
    }

    if (coverages.length === 0) {
        return createUnavailableGoalResult(evidence);
    }

    const score = coverages.reduce(
        (total, coverage) => total + coverage,
        0
    ) / coverages.length;

    return createFactorResult({
        factor: SCORING_FACTORS.GOAL,
        available: true,
        score,
        evidence
    });
}

module.exports = {
    calculateGoalFactor
};
