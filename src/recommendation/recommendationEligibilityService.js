const {
    checkRequestOperationalState,
    checkCandidateEntity,
    checkGenderEligibility,
    checkParentHardRequirements,
    checkParentExclusions
} = require("./hardEligibilityService");
const {
    collectMissingEligibilityInformation
} = require("./eligibilityInformationService");
const {
    evaluateActivitySessions
} = require("./activitySessionEligibilityService");
const {
    buildEligibilityResult
} = require("./eligibilityResult");

function isValidDate(value) {
    return value instanceof Date &&
        !Number.isNaN(value.getTime());
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

function evaluateRecommendationEligibility(
    context,
    evaluationTime = new Date()
) {
    if (!isValidDate(evaluationTime)) {
        throw new Error("evaluationTime must be a valid Date");
    }

    const requestEligibility =
        checkRequestOperationalState(context);

    if (!requestEligibility.eligible) {
        return {
            requestEligibility,
            candidateEvaluations: [],
            eligibleCandidates: []
        };
    }

    if (!Array.isArray(context.candidates)) {
        throw new Error("Recommendation context candidates must be an Array");
    }

    const candidateEvaluations = [];
    const eligibleCandidates = [];

    for (const candidate of context.candidates) {
        const entityEligibility =
            checkCandidateEntity(candidate);

        if (!entityEligibility.eligible) {
            candidateEvaluations.push({
                candidate,
                eligibility: entityEligibility,
                eligibleSessions: [],
                sessionEvaluations: [],
                missingInformation: []
            });

            continue;
        }

        const genderEligibility =
            checkGenderEligibility(
                context,
                candidate
            );
        const parentRequirementEligibility =
            checkParentHardRequirements(
                context,
                candidate
            );
        const parentExclusionEligibility =
            checkParentExclusions(
                context,
                candidate
            );
        const activitySessionEvaluation =
            evaluateActivitySessions(
                context,
                candidate,
                evaluationTime
            );
        const missingInformation =
            collectMissingEligibilityInformation(
                context,
                candidate
            );
        const combinedFailures = mergeUniqueFailures(
            genderEligibility.failedConstraints,
            parentRequirementEligibility.failedConstraints,
            parentExclusionEligibility.failedConstraints,
            activitySessionEvaluation.eligibility.failedConstraints
        );
        const eligibility = buildEligibilityResult(combinedFailures);
        const evaluation = {
            candidate,
            eligibility,
            eligibleSessions:
                activitySessionEvaluation.eligibleSessions,
            sessionEvaluations:
                activitySessionEvaluation.sessionEvaluations,
            missingInformation
        };

        candidateEvaluations.push(evaluation);

        if (eligibility.eligible) {
            eligibleCandidates.push(evaluation);
        }
    }

    return {
        requestEligibility,
        candidateEvaluations,
        eligibleCandidates
    };
}

module.exports = {
    evaluateRecommendationEligibility
};
