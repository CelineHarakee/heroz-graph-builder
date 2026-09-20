const { ObjectId } = require("mongodb");
const { toMongoId, toGraphId } = require("../utils/idUtils");
const { getOutcomeLearningInstruction } = require("./outcomeLearningRuleEngine");
const record = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const identity = (v) => v instanceof ObjectId || (typeof v === "string" && v.trim().length > 0);
const key = (v) => toGraphId(toMongoId(v));
const score = (v) => Number.isFinite(v) && v >= 0 && v <= 1;
const time = (v) => v instanceof Date ? v.getTime() : typeof v === "string" ? Date.parse(v) : NaN;
function copy(v) {
    if (v instanceof ObjectId) return new ObjectId(v);
    if (v instanceof Date) return new Date(v.getTime());
    if (Array.isArray(v)) return v.map(copy);
    if (record(v)) return Object.fromEntries(Object.entries(v).map(([k, value]) => [k, copy(value)]));
    return v;
}

/**
 * Pure atomic exposure calculation, with no decay or trend inference.
 * lastUpdated is a deterministic event-time placeholder ONLY. Future persistence
 * must set affected entries' lastUpdated to the actual persistence/update time.
 */
function calculateNextDevelopmentProfile(currentProfile, instruction, event) {
    const reject = (reasonCode) => ({ status: "NOT_APPLIED", reasonCode });
    const expected = getOutcomeLearningInstruction(event, {
        status: "APPLICABLE", activityId: instruction?.activityId, outcomeIds: instruction?.outcomeIds
    });
    if (expected.reasonCode === "INVALID_EVENT" || expected.reasonCode === "UNSUPPORTED_OUTCOME_EVENT") return reject(expected.reasonCode);
    if (expected.status !== "APPLICABLE" || instruction?.status !== "APPLICABLE" ||
        !["eventId", "eventType", "childId", "activityId"].every((field) => identity(instruction[field]) && key(instruction[field]) === expected[field]) ||
        instruction.learning?.scoreDelta !== 0.10 || instruction.learning?.confidenceDelta !== 0.05 || instruction.learning?.evidenceIncrement !== 1 ||
        instruction.rule?.ruleType !== "VERIFIED_ATTENDANCE_EXPOSURE" || instruction.rule?.version !== 1) return reject("INVALID_INSTRUCTION");
    if (!Array.isArray(currentProfile)) return reject("INVALID_EXISTING_DEVELOPMENT_STATE");
    const entries = new Map();
    for (const entry of currentProfile) {
        if (!record(entry) || !identity(entry.outcomeId) || entries.has(key(entry.outcomeId)) ||
            !score(entry.score) || !score(entry.confidenceScore) || !Number.isSafeInteger(entry.evidenceCount) || entry.evidenceCount < 0 ||
            !Array.isArray(entry.history) || ["lastEvidenceAt", "lastUpdated"].some((field) =>
                Object.hasOwn(entry, field) && !Number.isFinite(time(entry[field])))) return reject("INVALID_EXISTING_DEVELOPMENT_STATE");
        entries.set(key(entry.outcomeId), entry);
    }
    const endpoint = time(event.occurredAt);
    for (const id of expected.outcomeIds) {
        const entry = entries.get(id);
        if (entry && Object.hasOwn(entry, "lastEvidenceAt") && endpoint < time(entry.lastEvidenceAt)) return reject("OUT_OF_ORDER_OUTCOME_EVENT");
        if (entry && !Number.isSafeInteger(entry.evidenceCount + 1)) return reject("INVALID_EXISTING_DEVELOPMENT_STATE");
    }
    const developmentProfile = copy(currentProfile);
    const nextEntries = new Map(developmentProfile.map((entry) => [key(entry.outcomeId), entry]));
    const affectedOutcomes = [];
    for (const id of expected.outcomeIds) {
        let entry = nextEntries.get(id);
        if (!entry) {
            entry = { outcomeId: id, score: 0, confidenceScore: 0, evidenceCount: 0, trend: null, history: [] };
            developmentProfile.push(entry);
        }
        const previousScore = entry.score, previousConfidence = entry.confidenceScore;
        entry.score = Math.min(1, previousScore + 0.10);
        entry.confidenceScore = Math.min(1, previousConfidence + 0.05);
        entry.evidenceCount += 1;
        entry.lastEvidenceAt = new Date(endpoint);
        entry.lastUpdated = new Date(endpoint);
        entry.history.push({ eventId: key(event.eventId), eventType: "Attend", activityId: key(event.activityId), bookingId: key(event.bookingId),
            previousScore, newScore: entry.score, scoreDelta: 0.10, previousConfidence,
            newConfidence: entry.confidenceScore, confidenceDelta: 0.05, timestamp: new Date(endpoint) });
        affectedOutcomes.push({ outcomeId: id, previousScore, currentScore: entry.score,
            previousConfidence, currentConfidence: entry.confidenceScore, evidenceCount: entry.evidenceCount });
    }
    return { status: "APPLIED", reasonCode: "DEVELOPMENT_PROFILE_CALCULATED", developmentProfile, affectedOutcomes };
}
module.exports = { calculateNextDevelopmentProfile };
