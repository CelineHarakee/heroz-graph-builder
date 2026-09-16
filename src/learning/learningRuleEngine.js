const EVENT_RULES = new Map([
    ["View", [0.01, 0.005, "PASSIVE_INTERACTION"]],
    ["Click", [0.02, 0.01, "PASSIVE_INTERACTION"]],
    ["Save", [0.05, 0.02, "EXPLICIT_POSITIVE"]],
    ["Unsave", [-0.03, 0.015, "EXPLICIT_NEGATIVE"]],
    ["Dismiss", [-0.05, 0.02, "EXPLICIT_NEGATIVE"]],
    ["Book", [0.08, 0.03, "EXPLICIT_POSITIVE"]],
    ["Attend", [0.10, 0.04, "EXPLICIT_POSITIVE"]]
]);
const RATING_RULES = [
    [-0.10, 0.05], [-0.05, 0.04], [0.00, 0.03], [0.05, 0.04], [0.10, 0.05]
];

/**
 * Pure V1 instruction mapping for one trusted D7C event.
 * Does not read child state, apply deltas, clamp scores, decay or persist.
 * Non-applicable results contain only status and reasonCode.
 */
function getLearningInstruction(event) {
    const notApplicable = (reasonCode) => ({ status: "NOT_APPLICABLE", reasonCode });
    if (event === null || typeof event !== "object" || Array.isArray(event)) {
        return notApplicable("INVALID_EVENT");
    }

    let values;
    if (event.eventType === "Rate") {
        const rating = event.eventData?.ratingValue;
        if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
            return notApplicable("INVALID_RATING");
        }
        values = [...RATING_RULES[rating - 1], "RATING"];
    } else {
        values = EVENT_RULES.get(event.eventType);
        if (!values) return notApplicable("UNSUPPORTED_EVENT_TYPE");
    }

    const [interestDelta, confidenceDelta, ruleType] = values;
    return {
        status: "APPLICABLE",
        reasonCode: "LEARNING_RULE_APPLIED",
        eventId: event.eventId,
        eventType: event.eventType,
        childId: event.childId,
        activityId: event.activityId,
        subcategoryId: event.subcategoryId,
        learning: { interestDelta, confidenceDelta, evidenceIncrement: 1 },
        rule: { ruleType, version: 1 }
    };
}

module.exports = { getLearningInstruction };
