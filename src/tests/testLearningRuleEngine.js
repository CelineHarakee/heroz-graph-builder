const assert = require("assert");
const { getLearningInstruction } = require("../learning/learningRuleEngine");
const { processLearningSource } = require("../learning/learningEventProcessor");

function event(eventType = "View", ratingValue = null) {
    return {
        eventId: "event-1", eventType, childId: "child-1", activityId: "activity-1",
        subcategoryId: "authoritative-subcategory", sessionId: null,
        bookingId: ["Book", "Attend"].includes(eventType) ? "booking-1" : null,
        source: ["Book", "Attend"].includes(eventType) ? "Booking" : "Interaction",
        eventData: { ratingValue }, context: { recommendationId: null, surface: null },
        occurredAt: new Date("2026-09-16T10:00:00Z"),
        processing: { idempotencyKey: `key:${eventType}` }
    };
}

function expectInstruction(input, interestDelta, confidenceDelta, ruleType) {
    const before = structuredClone(input);
    const result = getLearningInstruction(input);
    assert(!(result instanceof Promise));
    assert.deepStrictEqual(result, {
        status: "APPLICABLE", reasonCode: "LEARNING_RULE_APPLIED",
        eventId: input.eventId, eventType: input.eventType,
        childId: input.childId, activityId: input.activityId, subcategoryId: input.subcategoryId,
        learning: { interestDelta, confidenceDelta, evidenceIncrement: 1 },
        rule: { ruleType, version: 1 }
    });
    assert.deepStrictEqual(input, before);
    assert.deepStrictEqual(getLearningInstruction(input), result);
    // Exact shape above excludes resulting scores, state, history and update operators.
    result.learning.interestDelta = 999;
    result.rule.version = 999;
    assert.strictEqual(getLearningInstruction(input).learning.interestDelta, interestDelta);
    assert.strictEqual(getLearningInstruction(input).rule.version, 1);
}

function testRules() {
    for (const [type, interest, confidence, rule] of [
        ["View", 0.01, 0.005, "PASSIVE_INTERACTION"],
        ["Click", 0.02, 0.01, "PASSIVE_INTERACTION"],
        ["Save", 0.05, 0.02, "EXPLICIT_POSITIVE"],
        ["Unsave", -0.03, 0.015, "EXPLICIT_NEGATIVE"],
        ["Dismiss", -0.05, 0.02, "EXPLICIT_NEGATIVE"],
        ["Book", 0.08, 0.03, "EXPLICIT_POSITIVE"],
        ["Attend", 0.10, 0.04, "EXPLICIT_POSITIVE"]
    ]) expectInstruction(event(type), interest, confidence, rule);
    for (const [rating, interest, confidence] of [
        [1, -0.10, 0.05], [2, -0.05, 0.04], [3, 0, 0.03], [4, 0.05, 0.04], [5, 0.10, 0.05]
    ]) expectInstruction(event("Rate", rating), interest, confidence, "RATING");
}

function testInvalid() {
    function expect(input, reasonCode) {
        assert.deepStrictEqual(getLearningInstruction(input), { status: "NOT_APPLICABLE", reasonCode });
    }
    for (const rating of [undefined, null, 0, 6, 2.5, "5", NaN, Infinity, true, {}, []]) {
        const input = event("Rate");
        input.eventData.ratingValue = rating;
        expect(input, "INVALID_RATING");
    }
    for (const eventData of [undefined, null, {}, "invalid"]) {
        expect({ ...event("Rate"), eventData }, "INVALID_RATING");
    }
    for (const type of ["Complete", "Unknown", "view", "toString", "__proto__", null, undefined]) {
        expect({ ...event(), eventType: type }, "UNSUPPORTED_EVENT_TYPE");
    }
    for (const input of [null, undefined, "event", 0, true, [], () => {}]) {
        expect(input, "INVALID_EVENT");
    }
}

function testNoStateInspectionOrMutation() {
    const input = event("Attend");
    for (const key of ["lastCalculatedAt", "lastDecayAt", "scoreHistory", "confidence", "interestScore"]) {
        Object.defineProperty(input, key, { get() { throw new Error(`Must not read ${key}`); } });
    }
    Object.freeze(input.eventData);
    Object.freeze(input.context);
    Object.freeze(input.processing);
    Object.freeze(input);
    assert.strictEqual(getLearningInstruction(input).learning.interestDelta, 0.10);
    const withScores = { ...event("Attend"), interestScore: { currentScore: 0.97 } };
    assert.strictEqual(getLearningInstruction(withScores).learning.interestDelta, 0.10);
    assert.strictEqual(withScores.interestScore.currentScore, 0.97);
}

async function testD7CIntegration() {
    const records = {
        children: { _id: "child-1" },
        activities: { _id: "activity-1", classification: { subcategoryId: "authoritative-subcategory" } },
        subcategories: { _id: "authoritative-subcategory" }
    };
    const db = { collection(name) {
        assert(name === "ai_jobs" || Object.hasOwn(records, name));
        return { async findOne(query) {
            if (name === "ai_jobs") return null;
            return records[name]._id === query._id ? records[name] : null;
        } };
    } };
    for (const type of ["View", "Rate"]) {
        const [result] = await processLearningSource("Interaction", {
            _id: "event-1", actor: { childId: "child-1" },
            targetEntity: { entityType: "Activity", entityId: "activity-1" },
            interactionDetails: { interactionType: type, ratingValue: 5 },
            timestamp: new Date("2026-09-16T10:00:00Z")
        }, { db });
        assert.strictEqual(result.status, "VALID");
        assert.strictEqual(result.event.subcategoryId, "authoritative-subcategory");
        expectInstruction(result.event, type === "View" ? 0.01 : 0.10,
            type === "View" ? 0.005 : 0.05, type === "View" ? "PASSIVE_INTERACTION" : "RATING");
    }
}

async function main() {
    testRules();
    testInvalid();
    testNoStateInspectionOrMutation();
    await testD7CIntegration();
    console.log("Learning rule engine unit tests: PASSED");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
