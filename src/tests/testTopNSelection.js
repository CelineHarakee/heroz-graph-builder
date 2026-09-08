const assert = require("assert");
const { selectTopN } = require("../recommendation/selectionService");

function snapshot(value) {
    return JSON.parse(JSON.stringify(value));
}

function assertThrows(label, fn) {
    assert.throws(fn, Error, label);
}

function makeRecord({
    id,
    rank,
    score = 1,
    available = true
}) {
    return {
        candidate: {
            activity: {
                activityId: id,
                title: id
            },
            currentActivity: {
                _id: id
            },
            evidence: {
                interests: [],
                goals: [],
                summary: []
            }
        },
        eligibilityEvaluation: {
            eligibility: {
                eligible: true,
                failedConstraints: []
            },
            eligibleSessions: [],
            sessionEvaluations: [],
            missingInformation: []
        },
        scoringState: {
            factors: {
                interest: {
                    factor: "interest",
                    available,
                    score: available ? score : null,
                    evidence: available ? [{ score }] : []
                },
                preference: {
                    factor: "preference",
                    available: false,
                    score: null,
                    evidence: []
                },
                goal: {
                    factor: "goal",
                    available: false,
                    score: null,
                    evidence: []
                },
                exploration: {
                    factor: "exploration",
                    available: false,
                    score: null,
                    evidence: []
                },
                behavior: {
                    factor: "behavior",
                    available: false,
                    score: null,
                    evidence: []
                },
                session: {
                    factor: "session",
                    available: false,
                    score: null,
                    evidence: []
                }
            }
        },
        finalScore: {
            available,
            score: available ? score : null,
            availableWeight: available ? 0.33 : 0,
            availableFactorCount: available ? 1 : 0,
            contributions: available
                ? [{
                    factor: "interest",
                    score,
                    canonicalWeight: 0.33,
                    normalizedWeight: 1,
                    contribution: score
                }]
                : []
        },
        rank
    };
}

function makeRanking({
    rankedCount = 5,
    unrankedCount = 0,
    scores = []
} = {}) {
    return {
        ranked: Array.from({ length: rankedCount }, (_, index) =>
            makeRecord({
                id: `activity_${index + 1}`,
                rank: index + 1,
                score: scores[index] ?? (1 - (index / 10))
            })
        ),
        unranked: Array.from({ length: unrankedCount }, (_, index) =>
            makeRecord({
                id: `unranked_${index + 1}`,
                rank: null,
                available: false
            })
        )
    };
}

function ids(records) {
    return records.map((record) => record.candidate.activity.activityId);
}

function ranks(records) {
    return records.map((record) => record.rank);
}

function assertSelection(result, {
    selected,
    unselectedRanked,
    unranked
}) {
    assert.deepStrictEqual(ids(result.selected), selected);
    assert.deepStrictEqual(ids(result.unselectedRanked), unselectedRanked);
    assert.deepStrictEqual(ids(result.unranked), unranked);
}

function assertPreserved(before, after) {
    assert.deepStrictEqual(snapshot(after), before);
}

function testBasicTop3() {
    const ranking = makeRanking({ rankedCount: 5 });
    const result = selectTopN(ranking, 3);

    assertSelection(result, {
        selected: ["activity_1", "activity_2", "activity_3"],
        unselectedRanked: ["activity_4", "activity_5"],
        unranked: []
    });
    assert.deepStrictEqual(ranks(result.selected), [1, 2, 3]);
    assert.deepStrictEqual(ranks(result.unselectedRanked), [4, 5]);
}

function testTop1() {
    const result = selectTopN(makeRanking({ rankedCount: 5 }), 1);

    assertSelection(result, {
        selected: ["activity_1"],
        unselectedRanked: ["activity_2", "activity_3", "activity_4", "activity_5"],
        unranked: []
    });
}

function testNEqualsCount() {
    const result = selectTopN(makeRanking({ rankedCount: 5 }), 5);

    assertSelection(result, {
        selected: ["activity_1", "activity_2", "activity_3", "activity_4", "activity_5"],
        unselectedRanked: [],
        unranked: []
    });
}

function testNGreaterThanCount() {
    const result = selectTopN(makeRanking({ rankedCount: 3 }), 10);

    assertSelection(result, {
        selected: ["activity_1", "activity_2", "activity_3"],
        unselectedRanked: [],
        unranked: []
    });
}

function testShortfallNoFallback() {
    const result = selectTopN(makeRanking({
        rankedCount: 2,
        unrankedCount: 5
    }), 4);

    assertSelection(result, {
        selected: ["activity_1", "activity_2"],
        unselectedRanked: [],
        unranked: [
            "unranked_1",
            "unranked_2",
            "unranked_3",
            "unranked_4",
            "unranked_5"
        ]
    });
}

function testAllUnranked() {
    const result = selectTopN(makeRanking({
        rankedCount: 0,
        unrankedCount: 3
    }), 2);

    assertSelection(result, {
        selected: [],
        unselectedRanked: [],
        unranked: ["unranked_1", "unranked_2", "unranked_3"]
    });
    assert(result.unranked.every((record) => record.rank === null));
}

function testAvailableZeroCandidate() {
    const ranking = {
        ranked: [
            makeRecord({ id: "activity_a", rank: 1, score: 0.5 }),
            makeRecord({ id: "activity_zero", rank: 2, score: 0 })
        ],
        unranked: []
    };
    const result = selectTopN(ranking, 2);

    assertSelection(result, {
        selected: ["activity_a", "activity_zero"],
        unselectedRanked: [],
        unranked: []
    });
    assert.strictEqual(result.selected[1].finalScore.score, 0);
}

function testExistingTiedScoresBoundary() {
    const ranking = {
        ranked: [
            makeRecord({ id: "activity_a", rank: 1, score: 1 }),
            makeRecord({ id: "activity_b", rank: 2, score: 1 }),
            makeRecord({ id: "activity_c", rank: 3, score: 0.9 })
        ],
        unranked: []
    };
    const result = selectTopN(ranking, 1);

    assertSelection(result, {
        selected: ["activity_a"],
        unselectedRanked: ["activity_b", "activity_c"],
        unranked: []
    });
}

function testRankScoreFactorAndUnrankedPreservation() {
    const ranking = makeRanking({
        rankedCount: 4,
        unrankedCount: 2
    });
    const before = snapshot(ranking);
    const finalScores = ranking.ranked.map((record) => snapshot(record.finalScore));
    const factors = ranking.ranked.map((record) => snapshot(record.scoringState.factors));
    const unranked = snapshot(ranking.unranked);
    const result = selectTopN(ranking, 2);

    assertPreserved(before, ranking);
    assert.deepStrictEqual(ranks(result.selected), [1, 2]);
    assert.deepStrictEqual(ranks(result.unselectedRanked), [3, 4]);
    assert.deepStrictEqual(
        [...result.selected, ...result.unselectedRanked].map((record) =>
            snapshot(record.finalScore)
        ),
        finalScores
    );
    assert.deepStrictEqual(
        [...result.selected, ...result.unselectedRanked].map((record) =>
            snapshot(record.scoringState.factors)
        ),
        factors
    );
    assert.deepStrictEqual(snapshot(result.unranked), unranked);
}

function testOutputArraysNew() {
    const ranking = makeRanking({
        rankedCount: 3,
        unrankedCount: 1
    });
    const result = selectTopN(ranking, 2);

    assert.notStrictEqual(result, ranking);
    assert.notStrictEqual(result.selected, ranking.ranked);
    assert.notStrictEqual(result.unselectedRanked, ranking.ranked);
    assert.notStrictEqual(result.unranked, ranking.unranked);
    assert.strictEqual(result.selected[0], ranking.ranked[0]);
    assert.strictEqual(result.unselectedRanked[0], ranking.ranked[2]);
    assert.strictEqual(result.unranked[0], ranking.unranked[0]);
}

function testInvalidN() {
    for (const badN of [
        0,
        -1,
        1.5,
        NaN,
        Infinity,
        "5",
        null,
        undefined
    ]) {
        assertThrows(`invalid N ${badN}`, () => {
            selectTopN(makeRanking(), badN);
        });
    }
}

function testMissingRankingArrays() {
    assertThrows("ranking missing", () => {
        selectTopN(null, 1);
    });
    assertThrows("ranked missing", () => {
        selectTopN({ unranked: [] }, 1);
    });
    assertThrows("ranked wrong type", () => {
        selectTopN({ ranked: {}, unranked: [] }, 1);
    });
    assertThrows("unranked missing", () => {
        selectTopN({ ranked: [] }, 1);
    });
    assertThrows("unranked wrong type", () => {
        selectTopN({ ranked: [], unranked: {} }, 1);
    });
}

function testEmptyResult() {
    assert.deepStrictEqual(selectTopN({
        ranked: [],
        unranked: []
    }, 5), {
        selected: [],
        unselectedRanked: [],
        unranked: []
    });
}

function testNoResort() {
    const ranking = {
        ranked: [
            makeRecord({ id: "activity_b", rank: 1, score: 0.9 }),
            makeRecord({ id: "activity_a", rank: 2, score: 1 }),
            makeRecord({ id: "activity_c", rank: 3, score: 0.1 })
        ],
        unranked: []
    };
    const result = selectTopN(ranking, 2);

    assertSelection(result, {
        selected: ["activity_b", "activity_a"],
        unselectedRanked: ["activity_c"],
        unranked: []
    });
}

function testNoLimitSideEffect() {
    const ranking = makeRanking({ rankedCount: 4 });
    const before = snapshot(ranking);
    const first = selectTopN(ranking, 1);
    const second = selectTopN(ranking, 4);

    assertPreserved(before, ranking);
    assert.deepStrictEqual(ids(first.selected), ["activity_1"]);
    assert.deepStrictEqual(ids(second.selected), [
        "activity_1",
        "activity_2",
        "activity_3",
        "activity_4"
    ]);
}

function testDeterminism() {
    const ranking = makeRanking({
        rankedCount: 5,
        unrankedCount: 2
    });
    const first = selectTopN(ranking, 3);

    for (let index = 0; index < 10; index += 1) {
        assert.deepStrictEqual(selectTopN(ranking, 3), first);
    }
}

function main() {
    testBasicTop3();
    testTop1();
    testNEqualsCount();
    testNGreaterThanCount();
    testShortfallNoFallback();
    testAllUnranked();
    testAvailableZeroCandidate();
    testExistingTiedScoresBoundary();
    testRankScoreFactorAndUnrankedPreservation();
    testOutputArraysNew();
    testInvalidN();
    testMissingRankingArrays();
    testEmptyResult();
    testNoResort();
    testNoLimitSideEffect();
    testDeterminism();

    console.log("Top-N selection unit tests: PASSED");
}

main();
