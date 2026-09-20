const { ObjectId } = require("mongodb");
const { validateParentDecisionEvent } = require("./parentDecisionContract");
const record = (v) => v !== null && typeof v === "object" && !Array.isArray(v) &&
    (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const validDate = (v) => v instanceof Date && Number.isFinite(v.getTime());
const nonblank = (v) => typeof v === "string" && v.trim().length > 0;
function copy(v) {
    if (v instanceof ObjectId) return new ObjectId(v);
    if (v instanceof Date) return new Date(v.getTime());
    if (Array.isArray(v)) return v.map(copy);
    if (record(v)) return Object.fromEntries(Object.entries(v).map(([k, value]) => [k, copy(value)]));
    return v;
}
/** Pure replacement. V1 trusts source === Parent as explicit ordering provenance.
 * Other historical sources' timestamps are not parent-decision ordering evidence.
 * No persistence, decay, behavioral inference or embedded history.
 */
function calculateNextPreferences(currentPreferences, event) {
    const dimension = event?.eventData?.dimension;
    const target = { dimension: typeof dimension === "string" ? dimension : null };
    let previousState = null;
    const reject = (reasonCode) => ({ status: "NOT_APPLIED", reasonCode, target,
        previousState: copy(previousState), nextState: null, nextPreferences: null, stateChanged: false });
    const validation = validateParentDecisionEvent(event);
    if (validation.status !== "VALID") return reject(validation.reasonCode);
    if (event.eventType !== "PreferenceUpdated") return reject("UNSUPPORTED_DECISION_TYPE");
    if (currentPreferences != null && !record(currentPreferences)) return reject("INVALID_EXISTING_PREFERENCE_STATE");
    const preferences = currentPreferences ?? {};
    if (Object.hasOwn(preferences, dimension)) {
        previousState = preferences[dimension];
        if (!record(previousState) || !nonblank(previousState.value) ||
            !Number.isFinite(previousState.confidenceScore) || previousState.confidenceScore < 0 || previousState.confidenceScore > 1 ||
            !nonblank(previousState.source) || !validDate(previousState.updatedAt)) return reject("INVALID_EXISTING_PREFERENCE_STATE");
        if (previousState.source === "Parent" && event.occurredAt.getTime() <= previousState.updatedAt.getTime()) {
            return reject("OUT_OF_ORDER_PARENT_DECISION");
        }
    }
    const nextState = { value: event.eventData.value, confidenceScore: 1, source: "Parent", updatedAt: new Date(event.occurredAt) };
    return { status: "APPLIED", reasonCode: "PREFERENCE_UPDATED", target, previousState: copy(previousState),
        nextState, nextPreferences: { ...copy(preferences), [dimension]: copy(nextState) }, stateChanged: true };
}
module.exports = { calculateNextPreferences };
