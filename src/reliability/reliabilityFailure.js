const FAILURE_CATEGORY = Object.freeze({
    INPUT_FAILURE: "INPUT_FAILURE",
    STATE_FAILURE: "STATE_FAILURE",
    DEPENDENCY_FAILURE: "DEPENDENCY_FAILURE",
    TIMEOUT_FAILURE: "TIMEOUT_FAILURE",
    INTERNAL_FAILURE: "INTERNAL_FAILURE",
    PARTIAL_FAILURE: "PARTIAL_FAILURE"
});

const STATE_STATUS = Object.freeze({
    UNCHANGED: "UNCHANGED",
    COMMITTED: "COMMITTED",
    PARTIAL: "PARTIAL",
    UNKNOWN: "UNKNOWN"
});

// Internal metadata only. Callers establish state and operation-specific replay
// safety. No category, exception message or result is automatically classified.
function createReliabilityFailure({
    category, component, operation, message, stateStatus, retryable = false,
    cause = null, diagnosticContext = null
} = {}) {
    if (!Object.values(FAILURE_CATEGORY).includes(category)) {
        throw new TypeError("Invalid reliability failure category.");
    }
    if (!Object.values(STATE_STATUS).includes(stateStatus)) {
        throw new TypeError("Invalid reliability state status.");
    }
    for (const value of [component, operation, message]) {
        if (typeof value !== "string" || !value.trim()) {
            throw new TypeError("Component, operation and message must be non-empty strings.");
        }
    }
    if (typeof retryable !== "boolean") {
        throw new TypeError("Reliability retryable must be boolean.");
    }
    const failure = { category, component, operation, message, retryable, stateStatus };
    // Preserve original diagnostic/source identity without copying exceptions or
    // executing diagnostic callbacks. These fields are not enumerable. The whole
    // record is still internal: only apiResponse.errorResponse may expose errors.
    Object.defineProperties(failure, {
        cause: { value: cause, enumerable: false },
        diagnosticContext: { value: diagnosticContext, enumerable: false }
    });
    return Object.freeze(failure);
}

module.exports = { FAILURE_CATEGORY, STATE_STATUS, createReliabilityFailure };
