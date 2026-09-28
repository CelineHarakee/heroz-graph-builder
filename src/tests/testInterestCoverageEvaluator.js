const assert = require("assert");
const { evaluateInterestCoverage } = require("../knowledgeGap/interestCoverageEvaluator");
const {
    D1_COVERAGE,
    D1_EVALUATION_STATUS,
    D1_SUFFICIENCY
} = require("../knowledgeGap/knowledgeGapConstants");

const subcategoryId = "subcategory-1";

function bundle(childInterest) {
    return {
        evaluation: {
            status: D1_EVALUATION_STATUS.RESOLVED,
            subcategoryId
        },
        childInterest: childInterest ?? null
    };
}

function interest(overrides = {}) {
    return {
        interestScore: {
            currentScore: 0.7,
            lastCalculatedAt: new Date("2026-01-01T00:00:00Z"),
            lastDecayAt: new Date("2026-01-01T00:00:00Z")
        },
        confidence: {
            currentScore: 0.4,
            evidenceCount: 1,
            lastCalculatedAt: new Date("2026-01-01T00:00:00Z")
        },
        evidenceSummary: {
            interactionBreakdown: []
        },
        scoreHistory: [],
        metadata: {
            updatedAt: new Date("2026-01-01T00:00:00Z")
        },
        ...overrides
    };
}

function history(eventType, eventId, interestDelta, timestamp = "2026-01-01T00:00:00Z") {
    return {
        eventId,
        eventType,
        activityId: "activity-1",
        interestDelta,
        timestamp
    };
}

function check(result, coverageState, sufficiencyState, reason) {
    assert.strictEqual(result.coverageState, coverageState);
    assert.strictEqual(result.sufficiencyState, sufficiencyState);
    if (reason) assert(result.reasons.includes(reason), `${reason} missing from ${result.reasons}`);
}

function testNoInterest() {
    check(evaluateInterestCoverage(bundle(null)),
        D1_COVERAGE.MISSING, D1_SUFFICIENCY.INSUFFICIENT, "NO_INTEREST_EVIDENCE");
}

function testBaseline() {
    const result = evaluateInterestCoverage(bundle(interest({
        interestScore: { currentScore: 0.5 },
        confidence: { currentScore: 0.2, evidenceCount: 0 },
        evidenceSummary: { interactionBreakdown: [] },
        scoreHistory: []
    })));

    check(result, D1_COVERAGE.AVAILABLE, D1_SUFFICIENCY.INSUFFICIENT, "INITIAL_BASELINE_ONLY");
    assert.strictEqual(result.atInitialBaseline, true);
}

function testLegacyProvenanceUnavailable() {
    check(evaluateInterestCoverage(bundle(interest({
        confidence: { currentScore: 0.82, evidenceCount: 12 },
        evidenceSummary: { interactionBreakdown: [] },
        scoreHistory: []
    }))), D1_COVERAGE.AVAILABLE, D1_SUFFICIENCY.UNCERTAIN, "EVIDENCE_PROVENANCE_UNAVAILABLE");
}

function testPassiveOnly() {
    check(evaluateInterestCoverage(bundle(interest({
        confidence: { currentScore: 0.21, evidenceCount: 1 },
        scoreHistory: [history("View", "event-1", 0.01)]
    }))), D1_COVERAGE.AVAILABLE, D1_SUFFICIENCY.UNCERTAIN, "PASSIVE_EVIDENCE_ONLY");

    check(evaluateInterestCoverage(bundle(interest({
        confidence: { currentScore: 0.215, evidenceCount: 2 },
        scoreHistory: [
            history("View", "event-1", 0.01),
            history("Click", "event-2", 0.02)
        ]
    }))), D1_COVERAGE.AVAILABLE, D1_SUFFICIENCY.UNCERTAIN, "PASSIVE_EVIDENCE_ONLY");
}

function testOneNonPassive() {
    const result = evaluateInterestCoverage(bundle(interest({
        confidence: { currentScore: 0.22, evidenceCount: 1 },
        scoreHistory: [history("Save", "event-1", 0.05)]
    })));

    check(result, D1_COVERAGE.AVAILABLE, D1_SUFFICIENCY.UNCERTAIN, "LIMITED_CORROBORATION");
}

function testCorroborated() {
    const result = evaluateInterestCoverage(bundle(interest({
        confidence: { currentScore: 0.26, evidenceCount: 2 },
        scoreHistory: [
            history("Save", "event-1", 0.05),
            history("Attend", "event-2", 0.10)
        ]
    })));

    check(result, D1_COVERAGE.AVAILABLE, D1_SUFFICIENCY.SUFFICIENT);
    assert.deepStrictEqual(result.reasons, []);
    assert.strictEqual(result.possibleResolvers.length, 0);
}

function testSaveUnsave() {
    const result = evaluateInterestCoverage(bundle(interest({
        confidence: { currentScore: 0.235, evidenceCount: 2 },
        scoreHistory: [
            history("Save", "event-1", 0.05),
            history("Unsave", "event-2", -0.03)
        ]
    })));

    check(result, D1_COVERAGE.AVAILABLE, D1_SUFFICIENCY.UNCERTAIN, "LIMITED_CORROBORATION");
    assert.strictEqual(result.evidenceSemantics.reversalEvents.length, 1);
}

function testConflict() {
    const result = evaluateInterestCoverage(bundle(interest({
        confidence: { currentScore: 0.24, evidenceCount: 2 },
        scoreHistory: [
            history("Save", "event-1", 0.05),
            history("Dismiss", "event-2", -0.05)
        ]
    })));

    check(result, D1_COVERAGE.AVAILABLE, D1_SUFFICIENCY.UNCERTAIN, "CONFLICTING_INTEREST_EVIDENCE");
    assert.strictEqual(result.conflict.detected, true);
}

function testBookAttendSharedEventId() {
    const result = evaluateInterestCoverage(bundle(interest({
        confidence: { currentScore: 0.27, evidenceCount: 2 },
        scoreHistory: [
            history("Book", "booking-1", 0.08),
            history("Attend", "booking-1", 0.10)
        ]
    })));

    check(result, D1_COVERAGE.AVAILABLE, D1_SUFFICIENCY.SUFFICIENT);
}

function testAggregateOnlyDoesNotProveDistinct() {
    const result = evaluateInterestCoverage(bundle(interest({
        confidence: { currentScore: 0.24, evidenceCount: 2 },
        evidenceSummary: { interactionBreakdown: [{ interactionType: "Save", count: 2 }] },
        scoreHistory: []
    })));

    check(result, D1_COVERAGE.AVAILABLE, D1_SUFFICIENCY.UNCERTAIN, "CORROBORATION_NOT_VERIFIABLE");
}

function testScorePointFiveWithEvidence() {
    const result = evaluateInterestCoverage(bundle(interest({
        interestScore: { currentScore: 0.5 },
        confidence: { currentScore: 0.25, evidenceCount: 1 },
        scoreHistory: [history("Rate", "event-1", 0.0)]
    })));

    assert.strictEqual(result.atInitialBaseline, false);
    check(result, D1_COVERAGE.AVAILABLE, D1_SUFFICIENCY.UNCERTAIN, "LIMITED_CORROBORATION");
}

function testFreshness() {
    const result = evaluateInterestCoverage(bundle(interest({
        confidence: { currentScore: 0.26, evidenceCount: 2 },
        scoreHistory: [
            history("Save", "event-1", 0.05, "2026-01-01T00:00:00Z"),
            history("Attend", "event-2", 0.10, "2026-02-01T00:00:00Z")
        ]
    })));

    assert.strictEqual(result.freshness.latestObservedEvidenceAt.toISOString(), "2026-02-01T00:00:00.000Z");
}

function main() {
    testNoInterest();
    testBaseline();
    testLegacyProvenanceUnavailable();
    testPassiveOnly();
    testOneNonPassive();
    testCorroborated();
    testSaveUnsave();
    testConflict();
    testBookAttendSharedEventId();
    testAggregateOnlyDoesNotProveDistinct();
    testScorePointFiveWithEvidence();
    testFreshness();
    console.log("Interest coverage evaluator tests: PASSED");
}

main();
