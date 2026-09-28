const {
    D1_APPLICABILITY,
    D1_COVERAGE,
    D1_EVALUATION_STATUS,
    D1_RESOLVER,
    D1_SUFFICIENCY
} = require("./knowledgeGapConstants");
const { toGraphId } = require("../utils/idUtils");

const ACTIVE_GOAL_STATUS = "Active";
const REMOVED_GOAL_STATUS = "Removed";

function id(value) {
    return toGraphId(value);
}

function nonblank(value) {
    return typeof value === "string" && value.trim().length > 0;
}

function unique(values) {
    return Array.from(new Set(values.filter(Boolean)));
}

function outcomeIdsFromMappings(mappings) {
    if (!Array.isArray(mappings)) return { status: "INVALID", outcomeIds: [] };

    const outcomeIds = [];
    for (const mapping of mappings) {
        const outcomeId = id(mapping?.outcomeId);
        if (!outcomeId || !nonblank(outcomeId)) return { status: "INVALID", outcomeIds: [] };
        outcomeIds.push(outcomeId);
    }

    return { status: "VALID", outcomeIds: unique(outcomeIds) };
}

function outcomeLookup(bundle) {
    const outcomes = new Map();
    for (const outcome of bundle?.learningOutcomes ?? []) {
        const outcomeId = id(outcome?._id);
        if (outcomeId) outcomes.set(outcomeId, outcome);
    }
    return outcomes;
}

function isActiveOutcome(outcome) {
    return Boolean(outcome) && outcome.isActive !== false;
}

function validActivityOutcomes(bundle) {
    const mapped = outcomeIdsFromMappings(bundle?.activity?.learningOutcomes);
    if (mapped.status !== "VALID") return { status: "BLOCKED", reason: "INVALID_ACTIVITY_OUTCOME_MAPPING", outcomeIds: [] };
    if (!mapped.outcomeIds.length) return { status: "NOT_APPLICABLE", reason: "ACTIVITY_HAS_NO_LEARNING_OUTCOMES", outcomeIds: [] };

    const outcomes = outcomeLookup(bundle);
    const invalid = mapped.outcomeIds.filter((outcomeId) => !isActiveOutcome(outcomes.get(outcomeId)));
    if (invalid.length) return {
        status: "BLOCKED",
        reason: "INVALID_ACTIVITY_OUTCOME_REFERENCE",
        outcomeIds: mapped.outcomeIds,
        invalidOutcomeIds: invalid
    };

    return { status: "APPLICABLE", outcomeIds: mapped.outcomeIds };
}

function goalById(bundle) {
    const goals = new Map();
    for (const goal of bundle?.goalLibrary ?? []) {
        const goalId = id(goal?._id);
        if (goalId) goals.set(goalId, goal);
    }
    return goals;
}

function goalMatch(parentGoal, goal, matchedOutcomeId) {
    return {
        childGoal: parentGoal,
        goalId: id(parentGoal.goalId),
        goalStatus: parentGoal.status ?? null,
        priority: parentGoal.priority ?? null,
        matchedLearningOutcomeId: matchedOutcomeId
    };
}

function evaluateGoalRelevance(bundle, activityOutcomeIds, outcomes) {
    const goalMap = goalById(bundle);
    const activityOutcomeSet = new Set(activityOutcomeIds);
    const matches = [];
    const inactiveContext = [];
    const reasons = [];
    let blocked = false;

    for (const parentGoal of bundle?.parentGoals ?? []) {
        const goalId = id(parentGoal?.goalId);
        if (!goalId) continue;
        if (parentGoal.status === REMOVED_GOAL_STATUS) continue;

        const active = parentGoal.status === ACTIVE_GOAL_STATUS;
        const goal = goalMap.get(goalId);

        if (!goal) {
            if (active) {
                blocked = true;
                reasons.push("GOAL_LIBRARY_REFERENCE_MISSING");
            }
            continue;
        }
        if (goal.isActive === false) {
            if (active) {
                blocked = true;
                reasons.push("GOAL_LIBRARY_REFERENCE_INACTIVE");
            }
            continue;
        }

        const mapped = outcomeIdsFromMappings(goal.relatedOutcomes);
        if (mapped.status !== "VALID" || mapped.outcomeIds.length === 0) {
            if (active) {
                blocked = true;
                reasons.push("INVALID_GOAL_OUTCOME_MAPPING");
            }
            continue;
        }

        const invalid = mapped.outcomeIds.filter((outcomeId) => !isActiveOutcome(outcomes.get(outcomeId)));
        if (invalid.length) {
            if (active) {
                blocked = true;
                reasons.push("INVALID_GOAL_OUTCOME_REFERENCE");
            }
            continue;
        }

        const matched = mapped.outcomeIds.filter((outcomeId) => activityOutcomeSet.has(outcomeId));
        if (!matched.length) continue;

        const details = matched.map((matchedOutcomeId) => goalMatch(parentGoal, goal, matchedOutcomeId));
        if (active) matches.push(...details);
        else inactiveContext.push(...details);
    }

    return {
        status: matches.length ? "PRESENT" : blocked ? "BLOCKED" : "ABSENT",
        matches,
        inactiveContext,
        reasons: unique(reasons)
    };
}

function validDevelopmentEntry(entry) {
    return entry && typeof entry === "object" && !Array.isArray(entry) && id(entry.outcomeId);
}

function developmentMatch(entry) {
    return {
        learningOutcomeId: id(entry.outcomeId),
        score: entry.score ?? null,
        confidence: entry.confidenceScore ?? null,
        evidenceCount: entry.evidenceCount ?? null,
        trend: entry.trend ?? null,
        lastUpdated: entry.lastUpdated ?? null,
        lastEvidenceAt: entry.lastEvidenceAt ?? null,
        history: Array.isArray(entry.history) ? entry.history.map((item) => ({
            eventId: id(item?.eventId),
            eventType: item?.eventType ?? null,
            activityId: id(item?.activityId),
            bookingId: id(item?.bookingId),
            previousScore: item?.previousScore ?? null,
            newScore: item?.newScore ?? null,
            previousConfidence: item?.previousConfidence ?? null,
            newConfidence: item?.newConfidence ?? null,
            timestamp: item?.timestamp ?? null,
            identity: item?.eventId && item?.eventType ? `${id(item.eventId)}:${item.eventType}` : null
        })) : []
    };
}

function evaluateDevelopmentEvidence(bundle, activityOutcomeIds, outcomes) {
    const activityOutcomeSet = new Set(activityOutcomeIds);
    const matches = [];
    const reasons = [];
    let blocked = false;

    for (const entry of bundle?.developmentProfile ?? []) {
        if (!validDevelopmentEntry(entry)) {
            blocked = true;
            reasons.push("INVALID_DEVELOPMENT_PROFILE_ENTRY");
            continue;
        }

        const outcomeId = id(entry.outcomeId);
        if (!activityOutcomeSet.has(outcomeId)) continue;
        if (!isActiveOutcome(outcomes.get(outcomeId))) {
            blocked = true;
            reasons.push("INVALID_DEVELOPMENT_OUTCOME_REFERENCE");
            continue;
        }

        matches.push(developmentMatch(entry));
    }

    return {
        status: matches.length ? "PRESENT" : blocked ? "BLOCKED" : "ABSENT",
        matches,
        reasons: unique(reasons)
    };
}

function possibleResolvers(goalRelevance, developmentEvidence, present) {
    if (present) {
        const resolvers = [];
        if (goalRelevance.status === "BLOCKED" || developmentEvidence.status === "BLOCKED") {
            resolvers.push(D1_RESOLVER.CATALOG, D1_RESOLVER.SYSTEM_DATA);
        }
        return unique(resolvers);
    }
    if (goalRelevance.status === "BLOCKED" || developmentEvidence.status === "BLOCKED") {
        return [D1_RESOLVER.CATALOG, D1_RESOLVER.SYSTEM_DATA];
    }
    return [D1_RESOLVER.CHILD_BEHAVIOR];
}

function evaluateDevelopmentalRelevance(bundle) {
    const target = {
        type: "Activity",
        activityId: bundle?.evaluation?.activityId ?? null
    };

    if (bundle?.evaluation?.status && bundle.evaluation.status !== D1_EVALUATION_STATUS.RESOLVED) {
        return {
            target,
            applicabilityState: D1_APPLICABILITY.NOT_APPLICABLE,
            coverageState: D1_COVERAGE.MISSING,
            sufficiencyState: D1_SUFFICIENCY.BLOCKED,
            reasons: ["EVALUATION_UNRESOLVABLE"],
            goalRelevance: { status: "BLOCKED", matches: [], inactiveContext: [], reasons: ["EVALUATION_UNRESOLVABLE"] },
            developmentEvidence: { status: "BLOCKED", matches: [], reasons: ["EVALUATION_UNRESOLVABLE"] },
            possibleResolvers: []
        };
    }

    const activityOutcomes = validActivityOutcomes(bundle);
    if (activityOutcomes.status === "NOT_APPLICABLE") {
        return {
            target,
            applicabilityState: D1_APPLICABILITY.NOT_APPLICABLE,
            coverageState: D1_COVERAGE.MISSING,
            sufficiencyState: D1_SUFFICIENCY.INSUFFICIENT,
            reasons: [activityOutcomes.reason],
            goalRelevance: { status: "ABSENT", matches: [], inactiveContext: [], reasons: [] },
            developmentEvidence: { status: "ABSENT", matches: [], reasons: [] },
            possibleResolvers: []
        };
    }
    if (activityOutcomes.status === "BLOCKED") {
        return {
            target,
            applicabilityState: D1_APPLICABILITY.APPLICABLE,
            coverageState: D1_COVERAGE.MISSING,
            sufficiencyState: D1_SUFFICIENCY.BLOCKED,
            reasons: [activityOutcomes.reason],
            goalRelevance: { status: "BLOCKED", matches: [], inactiveContext: [], reasons: [activityOutcomes.reason] },
            developmentEvidence: { status: "BLOCKED", matches: [], reasons: [activityOutcomes.reason] },
            possibleResolvers: [D1_RESOLVER.CATALOG, D1_RESOLVER.SYSTEM_DATA]
        };
    }

    const outcomes = outcomeLookup(bundle);
    const goalRelevance = evaluateGoalRelevance(bundle, activityOutcomes.outcomeIds, outcomes);
    const developmentEvidence = evaluateDevelopmentEvidence(bundle, activityOutcomes.outcomeIds, outcomes);
    const present = goalRelevance.status === "PRESENT" || developmentEvidence.status === "PRESENT";
    const blocked = goalRelevance.status === "BLOCKED" || developmentEvidence.status === "BLOCKED";
    const reasons = unique([...goalRelevance.reasons, ...developmentEvidence.reasons]);

    return {
        target,
        applicabilityState: D1_APPLICABILITY.APPLICABLE,
        coverageState: present ? D1_COVERAGE.AVAILABLE : D1_COVERAGE.MISSING,
        sufficiencyState: present ? D1_SUFFICIENCY.SUFFICIENT
            : blocked ? D1_SUFFICIENCY.BLOCKED : D1_SUFFICIENCY.INSUFFICIENT,
        reasons,
        goalRelevance,
        developmentEvidence,
        possibleResolvers: possibleResolvers(goalRelevance, developmentEvidence, present)
    };
}

module.exports = {
    evaluateDevelopmentalRelevance
};
