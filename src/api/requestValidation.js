const { ApiError } = require("./apiError");

function requireValue(value) {
    if (value === undefined || value === null) {
        throw new ApiError(400, "BAD_REQUEST", "A required value is missing.");
    }
    return value;
}

function requireType(value, expectedType) {
    const supported = ["string", "number", "boolean", "object", "array"];
    if (!supported.includes(expectedType)) {
        throw new TypeError("Unsupported structural validation type.");
    }
    requireValue(value);
    const valid = expectedType === "array"
        ? Array.isArray(value)
        : expectedType === "object"
            ? typeof value === "object" && !Array.isArray(value) &&
                [Object.prototype, null].includes(Object.getPrototypeOf(value))
            : typeof value === expectedType &&
                (expectedType !== "number" || Number.isFinite(value));
    if (!valid) {
        throw new ApiError(400, "BAD_REQUEST", "A required value has an invalid type.");
    }
    return value;
}

// JSON identifiers preserve existing IDs; no format inference or normalization.
function requireIdentifier(value) {
    requireType(value, "string");
    if (!value.trim()) {
        throw new ApiError(400, "BAD_REQUEST", "A non-empty identifier is required.");
    }
    return value;
}

module.exports = { requireValue, requireType, requireIdentifier };
