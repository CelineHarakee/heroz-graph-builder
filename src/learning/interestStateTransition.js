const { ObjectId } = require("mongodb");
const { toGraphId } = require("../utils/idUtils");

const CYCLE_MS = 30 * 24 * 60 * 60 * 1000;
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const score = (value) => Number.isFinite(value) && value >= 0 && value <= 1;
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const usableId = (value) => value instanceof ObjectId || (typeof value === "string" && value.trim().length > 0);
const clamp = (value) => Math.min(1, Math.max(0, value));

function time(value) {
    if (value instanceof Date) return value.getTime();
    return typeof value === "string" && value.trim() ? Date.parse(value) : NaN;
}

// Preserve BSON identities as well as Dates when copying compatible state fields.
function copy(value) {
    if (value instanceof ObjectId) return new ObjectId(value);
    if (value instanceof Date) return new Date(value.getTime());
    if (Array.isArray(value)) return value.map(copy);
    if (record(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copy(item)]));
    return value;
}

/** Pure calculation only. lastDecayAt tracks applied cycles, never inactivity. */
function calculateNextInterestState(currentState, instruction, event) {
    const reject = (reasonCode) => ({
        status: "NOT_APPLIED", reasonCode, state: currentState || null, transition: null, error: null
    });
    if (!record(event) || !["eventId", "eventType", "childId", "activityId", "subcategoryId"].every((key) => usableId(event[key]))) {
        return reject("INVALID_EVENT");
    }
    const learning = instruction?.learning;
    if (!record(instruction) || instruction.status !== "APPLICABLE" || !record(learning) ||
        !Number.isFinite(learning.interestDelta) || !Number.isFinite(learning.confidenceDelta) ||
        learning.confidenceDelta < 0 || !count(learning.evidenceIncrement) || learning.evidenceIncrement === 0) {
        return reject("INVALID_INSTRUCTION");
    }
    for (const key of ["eventId", "eventType", "childId", "activityId", "subcategoryId"]) {
        if (toGraphId(instruction[key]) !== toGraphId(event[key])) return reject("IDENTITY_MISMATCH");
    }
    const endpoint = time(event.occurredAt);
    if (!Number.isFinite(endpoint)) return reject("INVALID_TIMESTAMP");

    const isNewInterest = currentState == null;
    let interest = 0.50, confidence = 0.20, evidence = 0;
    let decayCycles = 0, checkpoint;
    if (!isNewInterest) {
        if (!record(currentState) || !score(currentState.interestScore?.currentScore) ||
            !score(currentState.confidence?.currentScore) || !count(currentState.confidence?.evidenceCount) ||
            (currentState.scoreHistory != null && !Array.isArray(currentState.scoreHistory)) ||
            (currentState.metadata != null && !record(currentState.metadata)) ||
            (currentState.evidenceSummary != null && !record(currentState.evidenceSummary))) {
            return reject("INVALID_CURRENT_STATE");
        }
        for (const key of ["childId", "subcategoryId"]) {
            if (currentState[key] != null && toGraphId(currentState[key]) !== toGraphId(event[key])) {
                return reject("IDENTITY_MISMATCH");
            }
        }
        const breakdown = currentState.evidenceSummary?.interactionBreakdown;
        if (breakdown != null && (!Array.isArray(breakdown) || breakdown.some((item) =>
            !record(item) || typeof item.interactionType !== "string" || !count(item.count)))) {
            return reject("INVALID_CURRENT_STATE");
        }
        const timestamps = (currentState.scoreHistory ?? []).map((item) => time(item?.timestamp)).filter(Number.isFinite);
        const prior = timestamps.length ? timestamps.reduce((a, b) => Math.max(a, b)) : time(currentState.interestScore.lastCalculatedAt);
        if (!Number.isFinite(prior)) return reject("INVALID_CURRENT_STATE");
        if (endpoint < prior) return reject("OUT_OF_ORDER_EVENT");
        const lastDecay = time(currentState.interestScore.lastDecayAt);
        if (Number.isFinite(lastDecay) && lastDecay > endpoint) return reject("OUT_OF_ORDER_EVENT");
        const dueCycles = Math.max(0, Math.floor((endpoint - prior) / CYCLE_MS) - 1);
        const appliedCycles = Number.isFinite(lastDecay)
            ? Math.max(0, Math.floor((lastDecay - prior) / CYCLE_MS) - 1) : 0;
        decayCycles = Math.max(0, dueCycles - appliedCycles);
        interest = currentState.interestScore.currentScore;
        confidence = currentState.confidence.currentScore;
        evidence = currentState.confidence.evidenceCount;
        if (decayCycles > 0) {
            interest = Math.max(0.10, interest * 0.98 ** decayCycles);
            confidence = Math.max(0.10, confidence * 0.99 ** decayCycles);
            checkpoint = new Date(prior + (dueCycles + 1) * CYCLE_MS);
        }
    }
    if (!count(evidence + learning.evidenceIncrement)) return reject("INVALID_CURRENT_STATE");
    const state = isNewInterest ? {
        childId: copy(event.childId), subcategoryId: copy(event.subcategoryId),
        interestScore: { lastDecayAt: copy(event.occurredAt) }, confidence: {},
        evidenceSummary: { interactionBreakdown: [] }, scoreHistory: [],
        metadata: { version: 1, createdBy: "ContinuousLearningEngine", createdAt: copy(event.occurredAt), lastSyncedToGraph: null }
    } : copy(currentState);
    state.interestScore = {
        ...state.interestScore, previousScore: interest,
        currentScore: clamp(interest + learning.interestDelta), lastCalculatedAt: copy(event.occurredAt)
    };
    if (checkpoint) state.interestScore.lastDecayAt = checkpoint;
    state.confidence = {
        ...state.confidence, currentScore: clamp(confidence + learning.confidenceDelta),
        evidenceCount: evidence + learning.evidenceIncrement, lastCalculatedAt: copy(event.occurredAt)
    };
    state.evidenceSummary ??= {};
    state.evidenceSummary.interactionBreakdown ??= [];
    const entry = state.evidenceSummary.interactionBreakdown.find((item) => item.interactionType === event.eventType);
    if (entry) {
        if (!count(entry.count + learning.evidenceIncrement)) return reject("INVALID_CURRENT_STATE");
        entry.count += learning.evidenceIncrement;
    } else {
        state.evidenceSummary.interactionBreakdown.push({ interactionType: event.eventType, count: learning.evidenceIncrement });
    }
    state.scoreHistory ??= [];
    state.scoreHistory.push({
        eventId: copy(event.eventId), eventType: event.eventType, activityId: copy(event.activityId),
        previousScore: interest, newScore: state.interestScore.currentScore, interestDelta: learning.interestDelta,
        previousConfidence: confidence, newConfidence: state.confidence.currentScore,
        confidenceDelta: learning.confidenceDelta, timestamp: copy(event.occurredAt)
    });
    state.metadata = { ...state.metadata, updatedAt: copy(event.occurredAt) };
    return {
        status: "APPLIED", reasonCode: "INTEREST_STATE_CALCULATED", state,
        transition: { isNewInterest, decayCycles, ...learning }, error: null
    };
}

module.exports = { calculateNextInterestState };
