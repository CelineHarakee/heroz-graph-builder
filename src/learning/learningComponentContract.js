const INTEREST_EVENTS = new Set(["View", "Click", "Save", "Unsave", "Dismiss", "Book", "Rate"]);
function getRequiredLearningComponents(eventType) {
    if (eventType === "Attend") return ["interest", "outcomes"];
    if (INTEREST_EVENTS.has(eventType)) return ["interest"];
    return null;
}
/** Completion manifests only, never partial workflow state. Dates are BSON Dates. */
function validateLearningComponents(eventType, components) {
    const required = getRequiredLearningComponents(eventType);
    const invalid = { status: "INVALID", reasonCode: "INVALID_PROCESSING_STATE" };
    if (!required) return { status: "INVALID", reasonCode: "UNSUPPORTED_EVENT_TYPE" };
    if (!components || typeof components !== "object" || Array.isArray(components) ||
        Object.keys(components).length !== required.length) return invalid;
    for (const name of required) {
        const item = components[name];
        if (!Object.hasOwn(components, name) || !item || typeof item !== "object" || Array.isArray(item) ||
            !(item.completedAt instanceof Date) || !Number.isFinite(item.completedAt.getTime())) return invalid;
        const empty = name === "outcomes" && item.status === "NOT_APPLICABLE" && item.reasonCode === "NO_MAPPED_OUTCOMES";
        if (item.status !== "APPLIED" && !empty) return invalid;
        const allowed = empty ? ["status", "reasonCode", "completedAt"] : ["status", "completedAt"];
        if (Object.keys(item).some((key) => !allowed.includes(key))) return invalid;
    }
    return { status: "VALID", reasonCode: "LEARNING_COMPONENTS_COMPLETE" };
}
module.exports = { getRequiredLearningComponents, validateLearningComponents };
