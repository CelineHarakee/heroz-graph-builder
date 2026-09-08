const assert = require("assert");
const { ObjectId } = require("mongodb");
const {
    SCORING_FACTORS,
    createFactorResult,
    createCandidateScoringState
} = require("../recommendation/scoringContract");
const { rankCandidates } = require("../recommendation/rankingService");

function snapshot(value) {
    return JSON.parse(JSON.stringify(value));
}

function assertThrows(label, fn) {
    assert.throws(fn, Error, label);
}

function factor(factorName, score = null) {
    return createFactorResult({
        factor: factorName,
        available: score !== null,
        score,
        evidence: score === null ? [] : [{ score }]
    });
}

function makeScoringState(score = 0.8) {
    const eligibilityEvaluation = {
        eligibility: {
            eligible: true,
            failedConstraints: []
        }
    };
    const state = createCandidateScoringState(eligibilityEvaluation);

    return {
        ...state,
        factors: {
            [SCORING_FACTORS.INTEREST]: factor(SCORING_FACTORS.INTEREST, score),
            [SCORING_FACTORS.PREFERENCE]: factor(SCORING_FACTORS.PREFERENCE, null),
            [SCORING_FACTORS.GOAL]: factor(SCORING_FACTORS.GOAL, null),
            [SCORING_FACTORS.EXPLORATION]: factor(SCORING_FACTORS.EXPLORATION, null),
            [SCORING_FACTORS.BEHAVIOR]: factor(SCORING_FACTORS.BEHAVIOR, null),
            [SCORING_FACTORS.SESSION]: factor(SCORING_FACTORS.SESSION, null)
        }
    };
}

function finalScore({
    available = true,
    score = 0.8,
    availableWeight = 0.33,
    availableFactorCount = 1,
    contributions
} = {}) {
    return {
        available,
        score,
        availableWeight: available ? availableWeight : 0,
        availableFactorCount: available ? availableFactorCount : 0,
        contributions: contributions ?? (available
            ? [{
                factor: SCORING_FACTORS.INTEREST,
                score,
                canonicalWeight: 0.33,
                normalizedWeight: 1,
                contribution: score
            }]
            : [])
    };
}

function makeRecord({
    id = "activity_a",
    score = 0.8,
    available = true,
    availableWeight = 0.33,
    availableFactorCount = 1,
    currentActivityId,
    eligibility = true,
    factorsScore = score,
    finalScoreOverrides = {},
    candidateOverrides = {}
} = {}) {
    const eligibilityEvaluation = {
        eligibility: {
            eligible: eligibility,
            failedConstraints: eligibility ? [] : [{ code: "FAILED" }]
        },
        eligibleSessions: [],
        sessionEvaluations: [],
        missingInformation: []
    };
    const scoringState = makeScoringState(factorsScore);
    const candidate = {
        activity: {
            activityId: id,
            title: `Activity ${id}`
        },
        currentActivity: {
            _id: currentActivityId ?? id
        },
        evidence: {
            interests: [],
            goals: [],
            summary: []
        },
        ...candidateOverrides
    };

    return {
        candidate,
        eligibilityEvaluation,
        scoringState,
        finalScore: {
            ...finalScore({
                available,
                score,
                availableWeight,
                availableFactorCount
            }),
            ...finalScoreOverrides
        }
    };
}

function ids(records) {
    return records.map((record) => String(record.candidate.currentActivity._id));
}

function ranks(records) {
    return records.map((record) => record.rank);
}

function testBasicDescending() {
    const result = rankCandidates([
        makeRecord({ id: "activity_a", score: 0.4 }),
        makeRecord({ id: "activity_b", score: 0.9 }),
        makeRecord({ id: "activity_c", score: 0.7 })
    ]);

    assert.deepStrictEqual(ids(result.ranked), [
        "activity_b",
        "activity_c",
        "activity_a"
    ]);
    assert.deepStrictEqual(ranks(result.ranked), [1, 2, 3]);
}

function testScoreOne() {
    const result = rankCandidates([
        makeRecord({ id: "activity_a", score: 0.9 }),
        makeRecord({ id: "activity_b", score: 1 })
    ]);

    assert.deepStrictEqual(ids(result.ranked), ["activity_b", "activity_a"]);
}

function testAvailableZero() {
    const result = rankCandidates([
        makeRecord({ id: "activity_a", score: 0 }),
        makeRecord({ id: "activity_b", score: 0.5 })
    ]);

    assert.deepStrictEqual(ids(result.ranked), ["activity_b", "activity_a"]);
    assert.deepStrictEqual(ranks(result.ranked), [1, 2]);
}

function testUnavailableVsZero() {
    const result = rankCandidates([
        makeRecord({ id: "activity_a", score: 0 }),
        makeRecord({ id: "activity_b", available: false, score: null })
    ]);

    assert.deepStrictEqual(ids(result.ranked), ["activity_a"]);
    assert.strictEqual(result.ranked[0].rank, 1);
    assert.deepStrictEqual(ids(result.unranked), ["activity_b"]);
    assert.strictEqual(result.unranked[0].rank, null);
}

function testUnavailableScoreMixed() {
    const result = rankCandidates([
        makeRecord({ id: "activity_a", score: 0.8 }),
        makeRecord({ id: "activity_b", available: false, score: null }),
        makeRecord({ id: "activity_c", score: 0.2 })
    ]);

    assert.deepStrictEqual(ids(result.ranked), ["activity_a", "activity_c"]);
    assert.deepStrictEqual(ids(result.unranked), ["activity_b"]);
}

function testAllUnavailable() {
    const input = [
        makeRecord({ id: "activity_a", available: false, score: null }),
        makeRecord({ id: "activity_b", available: false, score: null })
    ];
    const result = rankCandidates(input);

    assert.deepStrictEqual(result.ranked, []);
    assert.deepStrictEqual(ids(result.unranked), ["activity_a", "activity_b"]);
    assert(result.unranked.every((record) => record.rank === null));
}

function testExactScoreTie() {
    const result = rankCandidates([
        makeRecord({ id: "activity_b", score: 1 }),
        makeRecord({ id: "activity_a", score: 1 })
    ]);

    assert.deepStrictEqual(ids(result.ranked), ["activity_a", "activity_b"]);
    assert.deepStrictEqual(ranks(result.ranked), [1, 2]);
}

function testThreeWayTie() {
    const result = rankCandidates([
        makeRecord({ id: "activity_c", score: 0.7 }),
        makeRecord({ id: "activity_a", score: 0.7 }),
        makeRecord({ id: "activity_b", score: 0.7 })
    ]);

    assert.deepStrictEqual(ids(result.ranked), [
        "activity_a",
        "activity_b",
        "activity_c"
    ]);
    assert.deepStrictEqual(ranks(result.ranked), [1, 2, 3]);
}

function testTieInputReversed() {
    const forward = [
        makeRecord({ id: "activity_a", score: 0.9 }),
        makeRecord({ id: "activity_b", score: 0.9 }),
        makeRecord({ id: "activity_c", score: 0.9 })
    ];
    const reverse = [...forward].reverse();

    assert.deepStrictEqual(
        ids(rankCandidates(forward).ranked),
        ids(rankCandidates(reverse).ranked)
    );
}

function testCoverageDoesNotBreakTie() {
    const lowerCoverageFirst = rankCandidates([
        makeRecord({
            id: "activity_a",
            score: 0.8,
            availableWeight: 0.16,
            availableFactorCount: 1
        }),
        makeRecord({
            id: "activity_b",
            score: 0.8,
            availableWeight: 1,
            availableFactorCount: 6
        })
    ]);
    const lowerCoverageSecond = rankCandidates([
        makeRecord({
            id: "activity_z",
            score: 0.8,
            availableWeight: 0.16,
            availableFactorCount: 1
        }),
        makeRecord({
            id: "activity_b",
            score: 0.8,
            availableWeight: 1,
            availableFactorCount: 6
        })
    ]);

    assert.deepStrictEqual(ids(lowerCoverageFirst.ranked), [
        "activity_a",
        "activity_b"
    ]);
    assert.deepStrictEqual(ids(lowerCoverageSecond.ranked), [
        "activity_b",
        "activity_z"
    ]);
}

function testRawFactorsDoNotBreakTie() {
    const result = rankCandidates([
        makeRecord({ id: "activity_b", score: 0.8, factorsScore: 1 }),
        makeRecord({ id: "activity_a", score: 0.8, factorsScore: 0 })
    ]);

    assert.deepStrictEqual(ids(result.ranked), ["activity_a", "activity_b"]);
}

function testExplorationDoesNotBreakTie() {
    const highExploration = makeRecord({ id: "activity_b", score: 0.8 });
    const lowExploration = makeRecord({ id: "activity_a", score: 0.8 });

    highExploration.scoringState.factors.exploration = factor(
        SCORING_FACTORS.EXPLORATION,
        1
    );
    lowExploration.scoringState.factors.exploration = factor(
        SCORING_FACTORS.EXPLORATION,
        0
    );

    assert.deepStrictEqual(
        ids(rankCandidates([highExploration, lowExploration]).ranked),
        ["activity_a", "activity_b"]
    );
}

function testNearButNotEqual() {
    const result = rankCandidates([
        makeRecord({ id: "activity_a", score: 0.9 }),
        makeRecord({ id: "activity_b", score: 0.9000000000000001 })
    ]);

    assert.deepStrictEqual(ids(result.ranked), ["activity_b", "activity_a"]);
}

function testNoRounding() {
    const result = rankCandidates([
        makeRecord({ id: "activity_a", score: 0.123454 }),
        makeRecord({ id: "activity_b", score: 0.123455 })
    ]);

    assert.deepStrictEqual(ids(result.ranked), ["activity_b", "activity_a"]);
}

function testDeterminism() {
    const input = [
        makeRecord({ id: "activity_c", score: 0.8 }),
        makeRecord({ id: "activity_a", score: 0.8 }),
        makeRecord({ id: "activity_b", score: 0.5 })
    ];
    const first = rankCandidates(input);

    for (let index = 0; index < 10; index += 1) {
        assert.deepStrictEqual(rankCandidates(input), first);
    }
}

function testInputArrayImmutability() {
    const input = [
        makeRecord({ id: "activity_a", score: 0.4 }),
        makeRecord({ id: "activity_b", score: 0.9 })
    ];
    const before = snapshot(input);
    const originalOrder = ids(input);

    rankCandidates(input);

    assert.deepStrictEqual(snapshot(input), before);
    assert.deepStrictEqual(ids(input), originalOrder);
}

function testRecordImmutability() {
    const input = [
        makeRecord({ id: "activity_a", score: 0.4 }),
        makeRecord({ id: "activity_b", score: 0.9 })
    ];
    const snapshots = input.map((record) => ({
        candidate: snapshot(record.candidate),
        eligibilityEvaluation: snapshot(record.eligibilityEvaluation),
        scoringState: snapshot(record.scoringState),
        finalScore: snapshot(record.finalScore)
    }));

    rankCandidates(input);

    input.forEach((record, index) => {
        assert.deepStrictEqual(snapshot(record.candidate), snapshots[index].candidate);
        assert.deepStrictEqual(
            snapshot(record.eligibilityEvaluation),
            snapshots[index].eligibilityEvaluation
        );
        assert.deepStrictEqual(snapshot(record.scoringState), snapshots[index].scoringState);
        assert.deepStrictEqual(snapshot(record.finalScore), snapshots[index].finalScore);
    });
}

function testOutputIsNew() {
    const input = [
        makeRecord({ id: "activity_a", score: 0.4 }),
        makeRecord({ id: "activity_b", score: 0.9 })
    ];
    const result = rankCandidates(input);

    assert.notStrictEqual(result.ranked, input);
    assert.notStrictEqual(result.ranked[0], input[1]);
    assert.notStrictEqual(result.ranked[1], input[0]);
    assert.strictEqual(result.ranked[0].candidate, input[1].candidate);
}

function testFinalScoreExactlyPreserved() {
    const record = makeRecord({
        id: "activity_a",
        score: 0.8,
        finalScoreOverrides: {
            contributions: [{
                factor: "interest",
                score: 0.8,
                canonicalWeight: 0.33,
                normalizedWeight: 1,
                contribution: 0.8
            }]
        }
    });
    const before = snapshot(record.finalScore);
    const result = rankCandidates([record]);

    assert.deepStrictEqual(snapshot(result.ranked[0].finalScore), before);
}

function testFactorResultsPreserved() {
    const record = makeRecord({ id: "activity_a", score: 0.8 });
    const before = snapshot(record.scoringState.factors);
    const result = rankCandidates([record]);

    assert.deepStrictEqual(snapshot(result.ranked[0].scoringState.factors), before);
}

function testNoTopN() {
    const input = Array.from({ length: 10 }, (_, index) =>
        makeRecord({
            id: `activity_${index}`,
            score: index / 10
        })
    );
    const result = rankCandidates(input);

    assert.strictEqual(result.ranked.length, 10);
    assert.deepStrictEqual(ranks(result.ranked), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
}

function testMalformedScoreRejection() {
    assertThrows("missing final score", () => {
        const record = makeRecord();
        delete record.finalScore;
        rankCandidates([record]);
    });
    assertThrows("available score null", () => {
        rankCandidates([
            makeRecord({
                finalScoreOverrides: {
                    available: true,
                    score: null
                }
            })
        ]);
    });
    assertThrows("unavailable numeric score", () => {
        rankCandidates([
            makeRecord({
                finalScoreOverrides: {
                    available: false,
                    score: 0.4
                }
            })
        ]);
    });

    for (const badScore of [NaN, Infinity, -0.1, 1.1]) {
        assertThrows(`bad score ${badScore}`, () => {
            rankCandidates([
                makeRecord({
                    finalScoreOverrides: {
                        available: true,
                        score: badScore
                    }
                })
            ]);
        });
    }
}

function testMissingActivityIdRejection() {
    assertThrows("missing activity id", () => {
        rankCandidates([
            makeRecord({
                candidateOverrides: {
                    activity: {},
                    currentActivity: {}
                }
            })
        ]);
    });
}

function testDuplicateActivityRejection() {
    assertThrows("duplicate ranked activity", () => {
        rankCandidates([
            makeRecord({ id: "activity_a", score: 0.8 }),
            makeRecord({ id: "activity_a", score: 0.7 })
        ]);
    });
    assertThrows("duplicate unranked activity", () => {
        rankCandidates([
            makeRecord({ id: "activity_a", score: 0.8 }),
            makeRecord({ id: "activity_a", available: false, score: null })
        ]);
    });
}

function testIneligibleInputRejection() {
    assertThrows("ineligible input", () => {
        rankCandidates([
            makeRecord({
                id: "activity_a",
                eligibility: false
            })
        ]);
    });
}

function testObjectIdActivityId() {
    const idA = new ObjectId("64f000000000000000000001");
    const idB = new ObjectId("64f000000000000000000002");
    const result = rankCandidates([
        makeRecord({ id: "fallback_b", currentActivityId: idB, score: 1 }),
        makeRecord({ id: "fallback_a", currentActivityId: idA, score: 1 })
    ]);

    assert.deepStrictEqual(ids(result.ranked), [
        String(idA),
        String(idB)
    ]);
}

function testEmptyInput() {
    assert.deepStrictEqual(rankCandidates([]), {
        ranked: [],
        unranked: []
    });
}

function main() {
    testBasicDescending();
    testScoreOne();
    testAvailableZero();
    testUnavailableVsZero();
    testUnavailableScoreMixed();
    testAllUnavailable();
    testExactScoreTie();
    testThreeWayTie();
    testTieInputReversed();
    testCoverageDoesNotBreakTie();
    testRawFactorsDoNotBreakTie();
    testExplorationDoesNotBreakTie();
    testNearButNotEqual();
    testNoRounding();
    testDeterminism();
    testInputArrayImmutability();
    testRecordImmutability();
    testOutputIsNew();
    testFinalScoreExactlyPreserved();
    testFactorResultsPreserved();
    testNoTopN();
    testMalformedScoreRejection();
    testMissingActivityIdRejection();
    testDuplicateActivityRejection();
    testIneligibleInputRejection();
    testObjectIdActivityId();
    testEmptyInput();

    console.log("Ranking unit tests: PASSED");
}

main();
