const ELIGIBILITY_SCOPES = Object.freeze({
    REQUEST: "REQUEST",
    CANDIDATE: "CANDIDATE",
    SESSION: "SESSION"
});

function isNonEmptyString(value) {
    return (
        typeof value === "string" &&
        value.trim().length > 0
    );
}

function createEligibilityFailure({
    code,
    scope,
    entityType,
    entityId = null,
    fieldPath = null,
    detail = null
}) {
    if (!isNonEmptyString(code)) {
        throw new Error("Eligibility failure code must be a non-empty string");
    }

    if (!Object.values(ELIGIBILITY_SCOPES).includes(scope)) {
        throw new Error("Eligibility failure scope must be REQUEST, CANDIDATE, or SESSION");
    }

    if (!isNonEmptyString(entityType)) {
        throw new Error("Eligibility failure entityType must be a non-empty string");
    }

    return {
        code,
        scope,
        entityType,
        entityId,
        fieldPath,
        detail
    };
}

function buildEligibilityResult(failedConstraints = []) {
    if (!Array.isArray(failedConstraints)) {
        throw new Error("failedConstraints must be an array");
    }

    return {
        eligible: failedConstraints.length === 0,
        failedConstraints: [...failedConstraints]
    };
}

module.exports = {
    ELIGIBILITY_SCOPES,
    createEligibilityFailure,
    buildEligibilityResult
};
