const {
    buildEligibilityResult,
    createEligibilityFailure,
    ELIGIBILITY_SCOPES
} = require("./eligibilityResult");
const {
    checkSessionOperationalEligibility
} = require("./sessionEligibilityService");
const {
    checkSessionAgeEligibility
} = require("./sessionAgeEligibilityService");
const {
    checkRequestContext,
    checkCandidateEntity
} = require("./hardEligibilityService");

function isValidDate(value) {
    return value instanceof Date &&
        !Number.isNaN(value.getTime());
}

function makeEmptyAggregation(eligibility) {
    return {
        eligibility,
        eligibleSessions: [],
        sessionEvaluations: []
    };
}

function getActivityId(candidate) {
    return candidate.currentActivity?._id ??
        candidate.activity?.activityId ??
        null;
}

function createNoEligibleSessionFailure(candidate) {
    return createEligibilityFailure({
        code: "NO_ELIGIBLE_SESSION",
        scope: ELIGIBILITY_SCOPES.CANDIDATE,
        entityType: "Activity",
        entityId: getActivityId(candidate),
        fieldPath: "currentSessions",
        detail: "Activity has no eligible session"
    });
}

function createMissingSessionsFailure(candidate) {
    return createEligibilityFailure({
        code: "CONTEXT_MISSING",
        scope: ELIGIBILITY_SCOPES.CANDIDATE,
        entityType: "Activity",
        entityId: getActivityId(candidate),
        fieldPath: "currentSessions",
        detail: "Current Session context is missing or invalid"
    });
}

function createMissingChildFailure() {
    return createEligibilityFailure({
        code: "CONTEXT_MISSING",
        scope: ELIGIBILITY_SCOPES.REQUEST,
        entityType: "Child",
        entityId: null,
        fieldPath: "child",
        detail: "Child context is missing"
    });
}

function mergeUniqueFailures(...failureArrays) {
    const merged = [];

    for (const failures of failureArrays) {
        for (const failure of failures) {
            const duplicate = merged.some(existing => (
                existing.code === failure.code &&
                existing.scope === failure.scope &&
                existing.entityType === failure.entityType &&
                existing.entityId === failure.entityId &&
                existing.fieldPath === failure.fieldPath
            ));

            if (!duplicate) {
                merged.push(failure);
            }
        }
    }

    return merged;
}

function evaluateActivitySessions(
    context,
    candidate,
    evaluationTime = new Date()
) {
    if (!isValidDate(evaluationTime)) {
        throw new Error("evaluationTime must be a valid Date");
    }

    const contextResult = checkRequestContext(context);

    if (!contextResult.eligible) {
        return makeEmptyAggregation(contextResult);
    }

    if (
        context.child === null ||
        context.child === undefined
    ) {
        return makeEmptyAggregation(
            buildEligibilityResult([
                createMissingChildFailure()
            ])
        );
    }

    const candidateResult = checkCandidateEntity(candidate);

    if (!candidateResult.eligible) {
        return makeEmptyAggregation(candidateResult);
    }

    const currentSessions = candidate.currentSessions;

    if (!Array.isArray(currentSessions)) {
        return makeEmptyAggregation(
            buildEligibilityResult([
                createMissingSessionsFailure(candidate)
            ])
        );
    }

    if (currentSessions.length === 0) {
        return makeEmptyAggregation(
            buildEligibilityResult([
                createNoEligibleSessionFailure(candidate)
            ])
        );
    }

    const eligibleSessions = [];
    const sessionEvaluations = [];

    for (const session of currentSessions) {
        const operationalEligibility =
            checkSessionOperationalEligibility(
                session,
                evaluationTime
            );
        const ageEligibility =
            checkSessionAgeEligibility(
                context,
                candidate,
                session
            );
        const combinedFailures = mergeUniqueFailures(
            operationalEligibility.failedConstraints,
            ageEligibility.failedConstraints
        );
        const eligibility = buildEligibilityResult(combinedFailures);

        sessionEvaluations.push({
            session,
            operationalEligibility,
            ageEligibility,
            eligibility
        });

        if (eligibility.eligible) {
            eligibleSessions.push(session);
        }
    }

    if (eligibleSessions.length > 0) {
        return {
            eligibility: buildEligibilityResult([]),
            eligibleSessions,
            sessionEvaluations
        };
    }

    return {
        eligibility: buildEligibilityResult([
            createNoEligibleSessionFailure(candidate)
        ]),
        eligibleSessions,
        sessionEvaluations
    };
}

module.exports = {
    evaluateActivitySessions
};
