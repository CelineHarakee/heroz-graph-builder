const {
    ELIGIBILITY_SCOPES,
    createEligibilityFailure,
    buildEligibilityResult
} = require("./eligibilityResult");

function checkRequestContext(context) {
    if (context === null || context === undefined) {
        const failure = createEligibilityFailure({
            code: "CONTEXT_MISSING",
            scope: ELIGIBILITY_SCOPES.REQUEST,
            entityType: "Child",
            entityId: null,
            fieldPath: null,
            detail: "Recommendation context could not be established"
        });

        return buildEligibilityResult([failure]);
    }

    return buildEligibilityResult([]);
}

function checkCandidateEntity(candidate) {
    if (
        candidate === null ||
        candidate === undefined ||
        candidate.currentActivity === null ||
        candidate.currentActivity === undefined
    ) {
        const failure = createEligibilityFailure({
            code: "ACTIVITY_MISSING",
            scope: ELIGIBILITY_SCOPES.CANDIDATE,
            entityType: "Activity",
            entityId: candidate?.activity?.activityId ?? null,
            fieldPath: "currentActivity",
            detail: "Current Mongo Activity document is missing"
        });

        return buildEligibilityResult([failure]);
    }

    return buildEligibilityResult([]);
}

function checkRequestOperationalState(context) {
    const contextResult = checkRequestContext(context);

    if (!contextResult.eligible) {
        return contextResult;
    }

    const failures = [];
    const child = context.child;
    const parent = context.parent;

    if (child === null || child === undefined) {
        failures.push(createEligibilityFailure({
            code: "CONTEXT_MISSING",
            scope: ELIGIBILITY_SCOPES.REQUEST,
            entityType: "Child",
            entityId: null,
            fieldPath: "child",
            detail: "Child context is missing"
        }));
    } else if (child.status !== "Active") {
        failures.push(createEligibilityFailure({
            code: "CHILD_INACTIVE",
            scope: ELIGIBILITY_SCOPES.REQUEST,
            entityType: "Child",
            entityId: child._id ?? null,
            fieldPath: "status",
            detail: "Child is not active"
        }));
    }

    if (parent === null || parent === undefined) {
        failures.push(createEligibilityFailure({
            code: "CONTEXT_MISSING",
            scope: ELIGIBILITY_SCOPES.REQUEST,
            entityType: "Parent",
            entityId: child?.parentId ?? null,
            fieldPath: "parent",
            detail: "Parent context is missing"
        }));
    } else if (parent.account?.status !== "Active") {
        failures.push(createEligibilityFailure({
            code: "PARENT_INACTIVE",
            scope: ELIGIBILITY_SCOPES.REQUEST,
            entityType: "Parent",
            entityId: parent._id ?? null,
            fieldPath: "account.status",
            detail: "Parent is not active"
        }));
    }

    if (
        child !== null &&
        child !== undefined &&
        parent !== null &&
        parent !== undefined &&
        (
            child.parentId === null ||
            child.parentId === undefined ||
            String(child.parentId) !== String(parent._id)
        )
    ) {
        failures.push(createEligibilityFailure({
            code: "PARENT_CHILD_MISMATCH",
            scope: ELIGIBILITY_SCOPES.REQUEST,
            entityType: "Child",
            entityId: child._id ?? null,
            fieldPath: "parentId",
            detail: "Child parentId does not match the loaded Parent"
        }));
    }

    return buildEligibilityResult(failures);
}

function checkGenderEligibility(context, candidate) {
    const contextResult = checkRequestContext(context);

    if (!contextResult.eligible) {
        return contextResult;
    }

    const candidateResult = checkCandidateEntity(candidate);

    if (!candidateResult.eligible) {
        return candidateResult;
    }

    const childGender = context.child?.identity?.gender;

    if (
        childGender === null ||
        childGender === undefined ||
        childGender === ""
    ) {
        return buildEligibilityResult([]);
    }

    const allowedGenders =
        candidate.currentActivity
            ?.eligibility
            ?.allowedGenders;

    if (
        !Array.isArray(allowedGenders) ||
        allowedGenders.length === 0
    ) {
        return buildEligibilityResult([]);
    }

    if (!allowedGenders.includes(childGender)) {
        const failure = createEligibilityFailure({
            code: "GENDER_NOT_ELIGIBLE",
            scope: ELIGIBILITY_SCOPES.CANDIDATE,
            entityType: "Activity",
            entityId:
                candidate.currentActivity?._id ??
                candidate.activity?.activityId ??
                null,
            fieldPath: "eligibility.allowedGenders",
            detail: "Child gender is not allowed for this activity"
        });

        return buildEligibilityResult([failure]);
    }

    return buildEligibilityResult([]);
}

function hasExplicitMismatch(parentRequirements, activityValues) {
    if (
        !Array.isArray(parentRequirements) ||
        parentRequirements.length === 0
    ) {
        return false;
    }

    if (
        !Array.isArray(activityValues) ||
        activityValues.length === 0
    ) {
        return false;
    }

    return parentRequirements.some(
        requirement => !activityValues.includes(requirement)
    );
}

function checkParentHardRequirements(context, candidate) {
    const contextResult = checkRequestContext(context);

    if (!contextResult.eligible) {
        return contextResult;
    }

    const candidateResult = checkCandidateEntity(candidate);

    if (!candidateResult.eligible) {
        return candidateResult;
    }

    const requestStateResult = checkRequestOperationalState(context);

    if (!requestStateResult.eligible) {
        return requestStateResult;
    }

    const hardRequirements = context.parent?.hardRequirements;

    if (
        hardRequirements === null ||
        hardRequirements === undefined
    ) {
        return buildEligibilityResult([]);
    }

    const failures = [];
    const activityConstraints =
        candidate.currentActivity?.activityConstraints;

    if (hasExplicitMismatch(
        hardRequirements.accessibilityRequirements,
        activityConstraints?.accessibilityFeatures
    )) {
        failures.push(createEligibilityFailure({
            code: "REQUIREMENT_NOT_MET",
            scope: ELIGIBILITY_SCOPES.CANDIDATE,
            entityType: "Activity",
            entityId:
                candidate.currentActivity?._id ??
                candidate.activity?.activityId ??
                null,
            fieldPath: "activityConstraints.accessibilityFeatures",
            detail: "Activity does not satisfy the Parent accessibility requirements"
        }));
    }

    if (hasExplicitMismatch(
        hardRequirements.safetyRequirements,
        activityConstraints?.safetyRequirements
    )) {
        failures.push(createEligibilityFailure({
            code: "REQUIREMENT_NOT_MET",
            scope: ELIGIBILITY_SCOPES.CANDIDATE,
            entityType: "Activity",
            entityId:
                candidate.currentActivity?._id ??
                candidate.activity?.activityId ??
                null,
            fieldPath: "activityConstraints.safetyRequirements",
            detail: "Activity does not satisfy the Parent safety requirements"
        }));
    }

    return buildEligibilityResult(failures);
}

function idsEqual(left, right) {
    if (
        left === null ||
        left === undefined ||
        right === null ||
        right === undefined
    ) {
        return false;
    }

    if (typeof left.equals === "function") {
        return left.equals(right);
    }

    if (typeof right.equals === "function") {
        return right.equals(left);
    }

    return String(left) === String(right);
}

function listContainsId(values, id) {
    if (!Array.isArray(values)) {
        return false;
    }

    return values.some(value => idsEqual(value, id));
}

function checkParentExclusions(context, candidate) {
    const contextResult = checkRequestContext(context);

    if (!contextResult.eligible) {
        return contextResult;
    }

    const candidateResult = checkCandidateEntity(candidate);

    if (!candidateResult.eligible) {
        return candidateResult;
    }

    const requestStateResult = checkRequestOperationalState(context);

    if (!requestStateResult.eligible) {
        return requestStateResult;
    }

    const excludedActivityIds =
        context.parent
            ?.recommendationPreferences
            ?.excludedActivityIds;
    const excludedVendorIds =
        context.parent
            ?.recommendationPreferences
            ?.excludedVendorIds;
    const activityId =
        candidate.currentActivity._id ??
        candidate.activity?.activityId ??
        null;
    const vendorId = candidate.currentActivity.vendorId ?? null;
    const failures = [];

    if (listContainsId(excludedActivityIds, activityId)) {
        failures.push(createEligibilityFailure({
            code: "PARENT_EXCLUDED",
            scope: ELIGIBILITY_SCOPES.CANDIDATE,
            entityType: "Activity",
            entityId: activityId,
            fieldPath: "recommendationPreferences.excludedActivityIds",
            detail: "Parent excluded this activity"
        }));
    }

    if (listContainsId(excludedVendorIds, vendorId)) {
        failures.push(createEligibilityFailure({
            code: "PARENT_EXCLUDED",
            scope: ELIGIBILITY_SCOPES.CANDIDATE,
            entityType: "Vendor",
            entityId: vendorId,
            fieldPath: "recommendationPreferences.excludedVendorIds",
            detail: "Parent excluded this vendor"
        }));
    }

    return buildEligibilityResult(failures);
}

module.exports = {
    checkRequestContext,
    checkCandidateEntity,
    checkRequestOperationalState,
    checkGenderEligibility,
    checkParentHardRequirements,
    checkParentExclusions
};
