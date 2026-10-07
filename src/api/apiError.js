const SUPPORTED_STATUSES = new Set([400, 404, 409, 500]);

// Only create this at a trusted API boundary with literal, public-safe text.
// Never pass through a database/service exception message or object.
class ApiError extends Error {
    constructor(status, code, message) {
        if (!SUPPORTED_STATUSES.has(status) ||
            typeof code !== "string" || !code.trim() ||
            typeof message !== "string" || !message.trim()) {
            throw new TypeError("Invalid controlled API error.");
        }
        super(message);
        this.name = "ApiError";
        this.status = status;
        this.code = code;
    }
}

module.exports = { ApiError };
