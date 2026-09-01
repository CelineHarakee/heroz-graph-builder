function getActivityId(candidate) {
    return (
        candidate.currentActivity?._id ??
        candidate.activity?.activityId ??
        null
    );
}

function copyRequiredValues(values) {
    if (!Array.isArray(values)) {
        return [];
    }

    return [...values];
}

function hasConfirmedValues(values) {
    return (
        Array.isArray(values) &&
        values.length > 0
    );
}

function createMissingInformationRecord({
    code,
    entityId,
    fieldPath,
    requiredValues,
    detail
}) {
    return {
        code,
        entityType: "Activity",
        entityId,
        fieldPath,
        requiredValues: copyRequiredValues(requiredValues),
        detail
    };
}

function collectMissingEligibilityInformation(context, candidate) {
    if (
        context === null ||
        context === undefined ||
        candidate === null ||
        candidate === undefined ||
        candidate.currentActivity === null ||
        candidate.currentActivity === undefined
    ) {
        return [];
    }

    const records = [];
    const entityId = getActivityId(candidate);
    const childGender = context.child?.identity?.gender;
    const activity = candidate.currentActivity;
    const allowedGenders = activity.eligibility?.allowedGenders;

    if (!hasConfirmedValues(allowedGenders)) {
        records.push(createMissingInformationRecord({
            code: "ALLOWED_GENDERS_UNCONFIRMED",
            entityId,
            fieldPath: "eligibility.allowedGenders",
            requiredValues:
                childGender === null ||
                childGender === undefined ||
                childGender === ""
                    ? []
                    : [childGender],
            detail: "Allowed gender information has not been confirmed"
        }));
    }

    const hardRequirements = context.parent?.hardRequirements;
    const accessibilityRequirements =
        hardRequirements?.accessibilityRequirements;
    const safetyRequirements =
        hardRequirements?.safetyRequirements;
    const activityConstraints = activity.activityConstraints;

    if (
        hasConfirmedValues(accessibilityRequirements) &&
        !hasConfirmedValues(activityConstraints?.accessibilityFeatures)
    ) {
        records.push(createMissingInformationRecord({
            code: "ACCESSIBILITY_INFO_UNCONFIRMED",
            entityId,
            fieldPath: "activityConstraints.accessibilityFeatures",
            requiredValues: accessibilityRequirements,
            detail: "Accessibility information has not been confirmed"
        }));
    }

    if (
        hasConfirmedValues(safetyRequirements) &&
        !hasConfirmedValues(activityConstraints?.safetyRequirements)
    ) {
        records.push(createMissingInformationRecord({
            code: "SAFETY_INFO_UNCONFIRMED",
            entityId,
            fieldPath: "activityConstraints.safetyRequirements",
            requiredValues: safetyRequirements,
            detail: "Safety information has not been confirmed"
        }));
    }

    return records;
}

module.exports = {
    collectMissingEligibilityInformation
};
