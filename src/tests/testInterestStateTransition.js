const assert = require("assert");
const { ObjectId } = require("mongodb");
const { getLearningInstruction } = require("../learning/learningRuleEngine");
const { calculateNextInterestState } = require("../learning/interestStateTransition");

const DAY = 86400000;
const START = Date.parse("2026-01-01T00:00:00Z");
const at = (days) => new Date(START + days * DAY);
const close = (actual, expected) => assert(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);

function event(type = "View", days = 0, rating = 5) {
    return { eventId: "event-1", eventType: type, childId: "child-1", activityId: "activity-1",
        subcategoryId: "subcategory-1", occurredAt: at(days), eventData: { ratingValue: rating } };
}

function existing() {
    return {
        childId: "child-1", subcategoryId: "subcategory-1", compatible: { retained: true },
        interestScore: { currentScore: 0.6, previousScore: 0.55, lastCalculatedAt: at(0), lastDecayAt: at(0) },
        confidence: { currentScore: 0.4, evidenceCount: 5, lastCalculatedAt: at(0) },
        evidenceSummary: { other: "preserved", interactionBreakdown: [{ interactionType: "Save", count: 2 }, { interactionType: "View", count: 3 }] },
        scoreHistory: [{ timestamp: at(0), eventType: "View", retained: true }],
        metadata: { version: 7, createdAt: at(-100), createdBy: "Original", updatedAt: at(0), lastSyncedToGraph: at(-1) }
    };
}

function apply(state, input) {
    const instruction = getLearningInstruction(input);
    const beforeState = structuredClone(state);
    const beforeEvent = structuredClone(input);
    const beforeInstruction = structuredClone(instruction);
    const result = calculateNextInterestState(state, instruction, input);
    assert(!(result instanceof Promise));
    assert.strictEqual(result.status, "APPLIED");
    assert.strictEqual(result.reasonCode, "INTEREST_STATE_CALCULATED");
    assert.strictEqual(result.error, null);
    assert.deepStrictEqual(state, beforeState);
    assert.deepStrictEqual(input, beforeEvent);
    assert.deepStrictEqual(instruction, beforeInstruction);
    assert.deepStrictEqual(result, calculateNextInterestState(state, instruction, input));
    return result;
}

function testNewAndIntegration() {
    for (const [type, interest, confidence] of [
        ["View", 0.51, 0.205], ["Click", 0.52, 0.21], ["Attend", 0.60, 0.24],
        ["Dismiss", 0.45, 0.22], ["Rate", 0.60, 0.25]
    ]) {
        const input = event(type);
        const instruction = getLearningInstruction(input);
        const { state, transition } = apply(null, input);
        close(state.interestScore.currentScore, interest);
        close(state.confidence.currentScore, confidence);
        assert.strictEqual(state.confidence.evidenceCount, 1);
        assert.strictEqual(state.interestScore.previousScore, 0.5);
        assert.deepStrictEqual(transition, { isNewInterest: true, decayCycles: 0, ...instruction.learning });
        assert.deepStrictEqual(state.metadata, {
            version: 1, createdBy: "ContinuousLearningEngine", createdAt: at(0), updatedAt: at(0), lastSyncedToGraph: null
        });
        assert.deepStrictEqual(state.interestScore.lastDecayAt, at(0));
        assert.deepStrictEqual(state.interestScore.lastCalculatedAt, at(0));
        assert.deepStrictEqual(state.confidence.lastCalculatedAt, at(0));
        assert.deepStrictEqual(state.evidenceSummary.interactionBreakdown, [{ interactionType: type, count: 1 }]);
        assert.deepStrictEqual(state.scoreHistory, [{
            eventId: input.eventId, eventType: type, activityId: input.activityId,
            previousScore: 0.5, newScore: state.interestScore.currentScore, interestDelta: instruction.learning.interestDelta,
            previousConfidence: 0.2, newConfidence: state.confidence.currentScore,
            confidenceDelta: instruction.learning.confidenceDelta, timestamp: at(0)
        }]);
    }
    apply(undefined, event());
}

function testExistingAndClamps() {
    for (const [type, expectedScore, expectedConfidence] of [["Save", 0.65, 0.42], ["Unsave", 0.57, 0.415], ["Rate", 0.6, 0.43]]) {
        const current = existing();
        const { state } = apply(current, event(type, 1, 3));
        close(state.interestScore.currentScore, expectedScore);
        close(state.confidence.currentScore, expectedConfidence);
        assert.strictEqual(state.confidence.evidenceCount, 6);
        assert.strictEqual(state.scoreHistory.length, 2);
        assert.deepStrictEqual(state.scoreHistory[0], current.scoreHistory[0]);
        assert.deepStrictEqual(state.compatible, current.compatible);
        assert.deepStrictEqual(state.metadata, { ...current.metadata, updatedAt: at(1) });
        assert.deepStrictEqual(state.interestScore.lastDecayAt, current.interestScore.lastDecayAt);
        assert.deepStrictEqual(state.evidenceSummary.interactionBreakdown,
            type === "Save" ? [{ interactionType: "Save", count: 3 }, { interactionType: "View", count: 3 }]
                : [...current.evidenceSummary.interactionBreakdown, { interactionType: type, count: 1 }]);
    }
    const high = existing();
    high.interestScore.currentScore = 0.97;
    high.confidence.currentScore = 0.98;
    assert.strictEqual(apply(high, event("Attend")).state.interestScore.currentScore, 1);
    assert.strictEqual(apply(high, event("Rate")).state.confidence.currentScore, 1);
    const low = existing();
    low.interestScore.currentScore = 0.02;
    assert.strictEqual(apply(low, event("Dismiss")).state.interestScore.currentScore, 0);
}

function testDecay() {
    for (const [days, cycles] of [[30, 0], [59, 0], [60, 1], [89, 1], [90, 2], [120, 3]]) {
        const result = apply(existing(), event("View", days));
        const s = result.state;
        assert.strictEqual(result.transition.decayCycles, cycles);
        close(s.interestScore.previousScore, 0.6 * 0.98 ** cycles);
        close(s.interestScore.currentScore, 0.6 * 0.98 ** cycles + 0.01);
        close(s.scoreHistory.at(-1).previousConfidence, 0.4 * 0.99 ** cycles);
        close(s.confidence.currentScore, 0.4 * 0.99 ** cycles + 0.005);
        assert.strictEqual(s.confidence.evidenceCount, 6);
        assert.deepStrictEqual(s.interestScore.lastDecayAt, at(cycles ? (cycles + 1) * 30 : 0));
    }
    const low = existing();
    low.interestScore.currentScore = 0.10;
    low.confidence.currentScore = 0.10;
    const { state } = apply(low, event("Dismiss", 120));
    assert.strictEqual(state.interestScore.previousScore, 0.10);
    close(state.interestScore.currentScore, 0.05);
    assert.strictEqual(state.scoreHistory.at(-1).previousConfidence, 0.10);
    close(state.confidence.currentScore, 0.12);

    const priorDecay = existing();
    priorDecay.interestScore.currentScore *= 0.98;
    priorDecay.confidence.currentScore *= 0.99;
    priorDecay.interestScore.lastDecayAt = at(60);
    const outstanding = apply(priorDecay, event("View", 90));
    assert.strictEqual(outstanding.transition.decayCycles, 1);
    close(outstanding.state.interestScore.previousScore, 0.6 * 0.98 ** 2);
    assert.deepStrictEqual(outstanding.state.interestScore.lastDecayAt, at(90));
    assert.strictEqual(apply(priorDecay, event("View", 60)).transition.decayCycles, 0);

    const latest = existing();
    latest.scoreHistory = [{ timestamp: at(10) }, { timestamp: "bad" }, { timestamp: at(0) }];
    latest.metadata.updatedAt = at(500);
    latest.interestScore.lastCalculatedAt = at(100);
    assert.strictEqual(apply(latest, event("View", 60)).transition.decayCycles, 0);
    const fallback = existing();
    fallback.scoreHistory = [{ timestamp: "bad" }];
    assert.strictEqual(apply(fallback, event("View", 60)).transition.decayCycles, 1);
}

function reject(state, instruction, input, reasonCode) {
    const result = calculateNextInterestState(state, instruction, input);
    assert.deepStrictEqual(result, { status: "NOT_APPLIED", reasonCode, state: state || null, transition: null, error: null });
    assert.strictEqual(result.state, state || null);
}

function testSafety() {
    const current = existing();
    current.scoreHistory.push({ timestamp: at(2) });
    reject(current, getLearningInstruction(event()), event(), "OUT_OF_ORDER_EVENT");
    apply(current, event("View", 2));
    for (const occurredAt of [null, undefined, "bad", new Date("bad"), 0]) {
        const input = { ...event(), occurredAt };
        reject(null, getLearningInstruction(input), input, "INVALID_TIMESTAMP");
    }
    for (const field of ["interestScore", "confidence"]) {
        for (const value of [-1, 1.1, NaN, Infinity, "0.5", null, undefined]) {
            const state = existing();
            state[field].currentScore = value;
            reject(state, getLearningInstruction(event()), event(), "INVALID_CURRENT_STATE");
        }
    }
    for (const evidenceCount of [-1, 1.5, NaN, "2", undefined]) {
        const state = existing();
        state.confidence.evidenceCount = evidenceCount;
        reject(state, getLearningInstruction(event()), event(), "INVALID_CURRENT_STATE");
    }
    for (const key of ["childId", "subcategoryId"]) {
        const state = existing();
        state[key] = "different";
        reject(state, getLearningInstruction(event()), event(), "IDENTITY_MISMATCH");
    }
    for (const key of ["eventId", "eventType", "childId", "activityId", "subcategoryId"]) {
        const instruction = getLearningInstruction(event());
        instruction[key] = "different";
        reject(null, instruction, event(), "IDENTITY_MISMATCH");
    }
    for (const instruction of [null, {}, { status: "NOT_APPLICABLE" }, { status: "APPLICABLE", learning: {} }]) {
        reject(null, instruction, event(), "INVALID_INSTRUCTION");
    }
    for (const input of [null, undefined, "event", [], {}]) {
        reject(null, getLearningInstruction(event()), input, "INVALID_EVENT");
    }
    const missingTime = existing();
    missingTime.scoreHistory = [];
    delete missingTime.interestScore.lastCalculatedAt;
    reject(missingTime, getLearningInstruction(event()), event(), "INVALID_CURRENT_STATE");
}

function testIsolationAndObjectIds() {
    const current = existing();
    const input = event();
    const instruction = getLearningInstruction(input);
    const result = calculateNextInterestState(current, instruction, input);
    result.state.scoreHistory[0].retained = false;
    result.state.metadata.createdAt.setUTCFullYear(2000);
    result.state.interestScore.lastCalculatedAt.setUTCFullYear(2000);
    result.state.evidenceSummary.interactionBreakdown[0].count = 100;
    assert.strictEqual(current.scoreHistory[0].retained, true);
    assert.deepStrictEqual(current.metadata.createdAt, at(-100));
    assert.deepStrictEqual(input.occurredAt, at(0));
    assert.strictEqual(current.evidenceSummary.interactionBreakdown[0].count, 2);
    current.childId = new ObjectId("64f000000000000000000001");
    current.subcategoryId = new ObjectId("64f000000000000000000002");
    input.childId = String(current.childId);
    input.subcategoryId = String(current.subcategoryId);
    const next = calculateNextInterestState(current, getLearningInstruction(input), input);
    assert.strictEqual(next.status, "APPLIED");
    assert(next.state.childId instanceof ObjectId);
    assert.deepStrictEqual(next.state.childId, current.childId);
    assert.notStrictEqual(next.state.childId, current.childId);
}

function main() {
    testNewAndIntegration();
    testExistingAndClamps();
    testDecay();
    testSafety();
    testIsolationAndObjectIds();
    console.log("Interest state transition unit tests: PASSED");
}

main();
