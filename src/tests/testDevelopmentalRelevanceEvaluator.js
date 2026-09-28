const assert = require("assert");
const { evaluateDevelopmentalRelevance } = require("../knowledgeGap/developmentalRelevanceEvaluator");
const {
    D1_APPLICABILITY,
    D1_COVERAGE,
    D1_EVALUATION_STATUS,
    D1_SUFFICIENCY
} = require("../knowledgeGap/knowledgeGapConstants");

const ids = {
    activity: "activity-1",
    robotics: "activity-robotics",
    poetry: "activity-poetry",
    goal: "goal-1",
    otherGoal: "goal-2",
    outcome: "outcome-1",
    otherOutcome: "outcome-2",
    missingOutcome: "outcome-missing"
};

function outcome(_id = ids.outcome, overrides = {}) {
    return { _id, isActive: true, ...overrides };
}

function parentGoal(goalId = ids.goal, status = "Active", overrides = {}) {
    return { goalId, status, priority: 1, ...overrides };
}

function goal(_id = ids.goal, outcomeId = ids.outcome, overrides = {}) {
    return { _id, isActive: true, relatedOutcomes: [{ outcomeId }], ...overrides };
}

function development(outcomeId = ids.outcome, overrides = {}) {
    return {
        outcomeId,
        score: 0.4,
        confidenceScore: 0.3,
        evidenceCount: 2,
        trend: "Stable",
        lastUpdated: new Date("2026-01-02T00:00:00Z"),
        history: [{
            eventId: "booking-1",
            eventType: "Attend",
            activityId: ids.robotics,
            bookingId: "booking-1",
            previousScore: 0.3,
            newScore: 0.4,
            previousConfidence: 0.25,
            newConfidence: 0.3,
            timestamp: new Date("2026-01-01T00:00:00Z")
        }],
        ...overrides
    };
}

function bundle(overrides = {}) {
    return {
        evaluation: {
            status: D1_EVALUATION_STATUS.RESOLVED,
            activityId: ids.activity
        },
        activity: {
            _id: ids.activity,
            learningOutcomes: [{ outcomeId: ids.outcome }]
        },
        parentGoals: [],
        goalLibrary: [],
        developmentProfile: [],
        learningOutcomes: [outcome()],
        childInterest: null,
        ...overrides
    };
}

function check(result, coverageState, sufficiencyState, reason = null) {
    assert.strictEqual(result.coverageState, coverageState);
    assert.strictEqual(result.sufficiencyState, sufficiencyState);
    if (reason) assert(result.reasons.includes(reason), `${reason} missing from ${result.reasons}`);
}

function testNoActivityOutcomes() {
    const result = evaluateDevelopmentalRelevance(bundle({
        activity: { _id: ids.activity, learningOutcomes: [] },
        learningOutcomes: []
    }));
    assert.strictEqual(result.applicabilityState, D1_APPLICABILITY.NOT_APPLICABLE);
    assert(result.reasons.includes("ACTIVITY_HAS_NO_LEARNING_OUTCOMES"));
}

function testActiveMatchingGoal() {
    const result = evaluateDevelopmentalRelevance(bundle({
        parentGoals: [parentGoal()],
        goalLibrary: [goal()]
    }));
    assert.strictEqual(result.goalRelevance.status, "PRESENT");
    check(result, D1_COVERAGE.AVAILABLE, D1_SUFFICIENCY.SUFFICIENT);
}

function testNonmatchingGoal() {
    const result = evaluateDevelopmentalRelevance(bundle({
        parentGoals: [parentGoal()],
        goalLibrary: [goal(ids.goal, ids.otherOutcome)],
        learningOutcomes: [outcome(ids.outcome), outcome(ids.otherOutcome)]
    }));
    assert.strictEqual(result.goalRelevance.status, "ABSENT");
}

function testInactiveGoal() {
    const result = evaluateDevelopmentalRelevance(bundle({
        parentGoals: [parentGoal(ids.goal, "Paused")],
        goalLibrary: [goal()]
    }));
    assert.strictEqual(result.goalRelevance.status, "ABSENT");
    assert.strictEqual(result.goalRelevance.inactiveContext.length, 1);
    check(result, D1_COVERAGE.MISSING, D1_SUFFICIENCY.INSUFFICIENT);
}

function testRemovedGoal() {
    const result = evaluateDevelopmentalRelevance(bundle({
        parentGoals: [parentGoal(ids.goal, "Removed")],
        goalLibrary: [goal()]
    }));
    assert.strictEqual(result.goalRelevance.status, "ABSENT");
    assert.deepStrictEqual(result.goalRelevance.inactiveContext, []);
}

function testBrokenGoalLibrary() {
    const result = evaluateDevelopmentalRelevance(bundle({
        parentGoals: [parentGoal()],
        goalLibrary: []
    }));
    assert.strictEqual(result.goalRelevance.status, "BLOCKED");
    check(result, D1_COVERAGE.MISSING, D1_SUFFICIENCY.BLOCKED, "GOAL_LIBRARY_REFERENCE_MISSING");
}

function testInvalidOutcomeReference() {
    const result = evaluateDevelopmentalRelevance(bundle({
        parentGoals: [parentGoal()],
        goalLibrary: [goal(ids.goal, ids.missingOutcome)]
    }));
    assert.strictEqual(result.goalRelevance.status, "BLOCKED");
    check(result, D1_COVERAGE.MISSING, D1_SUFFICIENCY.BLOCKED, "INVALID_GOAL_OUTCOME_REFERENCE");
}

function testMatchingDevelopmentEvidence() {
    const result = evaluateDevelopmentalRelevance(bundle({
        developmentProfile: [development()]
    }));
    assert.strictEqual(result.developmentEvidence.status, "PRESENT");
    check(result, D1_COVERAGE.AVAILABLE, D1_SUFFICIENCY.SUFFICIENT);
    assert.strictEqual(result.developmentEvidence.matches[0].history[0].identity, "booking-1:Attend");
}

function testNonmatchingDevelopmentEvidence() {
    const result = evaluateDevelopmentalRelevance(bundle({
        developmentProfile: [development(ids.otherOutcome)],
        learningOutcomes: [outcome(ids.outcome), outcome(ids.otherOutcome)]
    }));
    assert.strictEqual(result.developmentEvidence.status, "ABSENT");
}

function testInvalidDevelopmentEvidence() {
    const result = evaluateDevelopmentalRelevance(bundle({
        developmentProfile: [{ score: 0.3 }]
    }));
    assert.strictEqual(result.developmentEvidence.status, "BLOCKED");
    check(result, D1_COVERAGE.MISSING, D1_SUFFICIENCY.BLOCKED, "INVALID_DEVELOPMENT_PROFILE_ENTRY");
}

function testBothAbsent() {
    const result = evaluateDevelopmentalRelevance(bundle());
    assert.strictEqual(result.goalRelevance.status, "ABSENT");
    assert.strictEqual(result.developmentEvidence.status, "ABSENT");
    check(result, D1_COVERAGE.MISSING, D1_SUFFICIENCY.INSUFFICIENT);
}

function testGoalOnly() {
    const result = evaluateDevelopmentalRelevance(bundle({
        parentGoals: [parentGoal()],
        goalLibrary: [goal()],
        developmentProfile: [development(ids.otherOutcome)],
        learningOutcomes: [outcome(ids.outcome), outcome(ids.otherOutcome)]
    }));
    assert.strictEqual(result.goalRelevance.status, "PRESENT");
    assert.strictEqual(result.developmentEvidence.status, "ABSENT");
    check(result, D1_COVERAGE.AVAILABLE, D1_SUFFICIENCY.SUFFICIENT);
}

function testDevelopmentOnly() {
    const result = evaluateDevelopmentalRelevance(bundle({
        parentGoals: [parentGoal(ids.goal)],
        goalLibrary: [goal(ids.goal, ids.otherOutcome)],
        developmentProfile: [development()],
        learningOutcomes: [outcome(ids.outcome), outcome(ids.otherOutcome)]
    }));
    assert.strictEqual(result.goalRelevance.status, "ABSENT");
    assert.strictEqual(result.developmentEvidence.status, "PRESENT");
    check(result, D1_COVERAGE.AVAILABLE, D1_SUFFICIENCY.SUFFICIENT);
}

function testPresentPlusBlocked() {
    const result = evaluateDevelopmentalRelevance(bundle({
        parentGoals: [parentGoal()],
        goalLibrary: [goal()],
        developmentProfile: [{ score: 0.2 }]
    }));
    assert.strictEqual(result.goalRelevance.status, "PRESENT");
    assert.strictEqual(result.developmentEvidence.status, "BLOCKED");
    check(result, D1_COVERAGE.AVAILABLE, D1_SUFFICIENCY.SUFFICIENT, "INVALID_DEVELOPMENT_PROFILE_ENTRY");
}

function testBlockedWithoutPresent() {
    const result = evaluateDevelopmentalRelevance(bundle({
        parentGoals: [parentGoal()],
        goalLibrary: []
    }));
    assert.strictEqual(result.goalRelevance.status, "BLOCKED");
    assert.strictEqual(result.developmentEvidence.status, "ABSENT");
    check(result, D1_COVERAGE.MISSING, D1_SUFFICIENCY.BLOCKED);
}

function testSharedOutcomeSeparation() {
    const input = bundle({
        evaluation: {
            status: D1_EVALUATION_STATUS.RESOLVED,
            activityId: ids.poetry
        },
        activity: {
            _id: ids.poetry,
            learningOutcomes: [{ outcomeId: ids.outcome }]
        },
        developmentProfile: [development(ids.outcome, { history: [development().history[0]] })],
        childInterest: null
    });
    const result = evaluateDevelopmentalRelevance(input);
    assert.strictEqual(result.developmentEvidence.status, "PRESENT");
    assert.strictEqual(input.childInterest, null);
}

function testSiblingIsolation() {
    const result = evaluateDevelopmentalRelevance(bundle({
        siblingGoals: [parentGoal()],
        siblingDevelopmentProfile: [development()]
    }));
    check(result, D1_COVERAGE.MISSING, D1_SUFFICIENCY.INSUFFICIENT);
}

function main() {
    testNoActivityOutcomes();
    testActiveMatchingGoal();
    testNonmatchingGoal();
    testInactiveGoal();
    testRemovedGoal();
    testBrokenGoalLibrary();
    testInvalidOutcomeReference();
    testMatchingDevelopmentEvidence();
    testNonmatchingDevelopmentEvidence();
    testInvalidDevelopmentEvidence();
    testBothAbsent();
    testGoalOnly();
    testDevelopmentOnly();
    testPresentPlusBlocked();
    testBlockedWithoutPresent();
    testSharedOutcomeSeparation();
    testSiblingIsolation();
    console.log("Developmental relevance evaluator tests: PASSED");
}

main();
