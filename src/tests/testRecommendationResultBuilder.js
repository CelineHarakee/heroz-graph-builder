const assert = require("assert");
const { ObjectId } = require("mongodb");
const {
    SCORING_FACTORS,
    createFactorResult
} = require("../recommendation/scoringContract");
const {
    buildRecommendationResults
} = require("../recommendation/recommendationResultBuilder");

const FACTORS = Object.values(SCORING_FACTORS);

function snapshot(value) {
    return JSON.parse(JSON.stringify(value));
}

function assertThrows(label, fn) {
    assert.throws(fn, Error, label);
}

function factor(factorName, {
    available = true,
    score = 0.8,
    evidence = [{ type: `${factorName}_evidence`, score }]
} = {}) {
    return createFactorResult({
        factor: factorName,
        available,
        score: available ? score : null,
        evidence
    });
}

function makeFactors(overrides = {}) {
    return {
        [SCORING_FACTORS.INTEREST]: factor(SCORING_FACTORS.INTEREST, {
            score: 0.8,
            evidence: [{ type: "exact_subcategory_interest", score: 0.8 }]
        }),
        [SCORING_FACTORS.PREFERENCE]: factor(SCORING_FACTORS.PREFERENCE, {
            score: 0.9,
            evidence: [{ dimension: "environment", adjustedScore: 0.9 }]
        }),
        [SCORING_FACTORS.GOAL]: factor(SCORING_FACTORS.GOAL, {
            score: 0,
            evidence: [{ type: "goal_coverage", coverage: 0 }]
        }),
        [SCORING_FACTORS.EXPLORATION]: factor(SCORING_FACTORS.EXPLORATION, {
            available: false,
            score: null,
            evidence: [{ type: "history_source_unavailable" }]
        }),
        [SCORING_FACTORS.BEHAVIOR]: factor(SCORING_FACTORS.BEHAVIOR, {
            score: 0.75,
            evidence: [{ type: "exact_activity_behavior", ratingValue: 4 }]
        }),
        [SCORING_FACTORS.SESSION]: factor(SCORING_FACTORS.SESSION, {
            available: false,
            score: null,
            evidence: [{ type: "no_preferred_days" }]
        }),
        ...overrides
    };
}

function makeFinalScore(overrides = {}) {
    return {
        available: true,
        score: 0.7123456789123456,
        availableWeight: 0.78,
        availableFactorCount: 4,
        contributions: [
            {
                factor: "interest",
                score: 0.8,
                canonicalWeight: 0.33,
                normalizedWeight: 0.4230769230769231,
                contribution: 0.3384615384615385
            },
            {
                factor: "preference",
                score: 0.9,
                canonicalWeight: 0.16,
                normalizedWeight: 0.20512820512820515,
                contribution: 0.18461538461538465
            },
            {
                factor: "goal",
                score: 0,
                canonicalWeight: 0.16,
                normalizedWeight: 0.20512820512820515,
                contribution: 0
            },
            {
                factor: "behavior",
                score: 0.75,
                canonicalWeight: 0.13,
                normalizedWeight: 0.16666666666666669,
                contribution: 0.125
            }
        ],
        ...overrides
    };
}

function makeRecord({
    activityId = "activity_a",
    currentActivityId = activityId,
    rank = 1,
    finalScore = makeFinalScore(),
    factors = makeFactors(),
    eligibleSessions = [
        { _id: "session_1", rejected: false },
        { _id: new ObjectId("64f000000000000000000001") },
        { name: "missing id ignored" }
    ],
    evidence = {
        interests: [{ name: "Robotics" }],
        goals: [{ name: "Problem Solving" }],
        summary: ["D4 evidence"]
    }
} = {}) {
    return {
        candidate: {
            activity: {
                activityId,
                title: `Activity ${activityId}`
            },
            currentActivity: currentActivityId === undefined
                ? undefined
                : {
                    _id: currentActivityId,
                    metadata: { shouldNotLeak: true }
                },
            currentVendor: {
                _id: "vendor_1"
            },
            currentSessions: [
                { _id: "rejected_session" }
            ],
            evidence
        },
        eligibilityEvaluation: {
            eligibility: {
                eligible: true,
                failedConstraints: []
            },
            eligibleSessions,
            sessionEvaluations: [
                { session: { _id: "rejected_session" } }
            ],
            missingInformation: []
        },
        scoringState: {
            eligibilityEvaluation: {},
            factors
        },
        finalScore,
        rank
    };
}

function build(selectionResult) {
    return buildRecommendationResults(selectionResult);
}

function assertNoInternalLeak(result) {
    const forbidden = [
        "candidate",
        "eligibilityEvaluation",
        "scoringState",
        "currentActivity",
        "currentVendor",
        "currentSessions",
        "sessionEvaluations",
        "failedConstraints",
        "historyContext",
        "interestContext",
        "goalContext",
        "parent",
        "child",
        "unselectedRanked",
        "unranked",
        "reason",
        "reasonText",
        "explanation",
        "whyRecommended",
        "message",
        "algorithmVersion",
        "modelVersion",
        "scoringVersion",
        "requestedAt",
        "generatedAt",
        "createdAt"
    ];

    for (const field of forbidden) {
        assert(
            !Object.prototype.hasOwnProperty.call(result, field),
            `${field} leaked into RecommendationResult`
        );
    }

    assert(!Object.prototype.hasOwnProperty.call(result.factors, "vendor"));
    assert(!Object.prototype.hasOwnProperty.call(result, "vendor"));
}

function testOneSelectedRecord() {
    const record = makeRecord();
    const before = snapshot(record);
    const result = build({
        selected: [record],
        unselectedRanked: [makeRecord({ activityId: "unselected", rank: 2 })],
        unranked: [makeRecord({ activityId: "unranked", rank: 3 })]
    });

    assert.strictEqual(result.length, 1);
    assert.deepStrictEqual(snapshot(record), before);

    const item = result[0];

    assert.deepStrictEqual(Object.keys(item), [
        "activityId",
        "rank",
        "score",
        "factors",
        "scoring",
        "eligibleSessionIds",
        "evidence"
    ]);
    assert.strictEqual(item.activityId, "activity_a");
    assert.strictEqual(item.rank, 1);
    assert.strictEqual(item.score, record.finalScore.score);
    assert.deepStrictEqual(Object.keys(item.factors), FACTORS);
    assert.deepStrictEqual(Object.keys(item.evidence.factors), FACTORS);
    assert.deepStrictEqual(item.eligibleSessionIds, [
        "session_1",
        "64f000000000000000000001"
    ]);
    assert.deepStrictEqual(item.evidence.discovery, record.candidate.evidence);
    assertNoInternalLeak(item);
}

function testMultipleSelectedOrderPreserved() {
    const records = [
        makeRecord({ activityId: "activity_c", rank: 3 }),
        makeRecord({ activityId: "activity_a", rank: 1 }),
        makeRecord({ activityId: "activity_b", rank: 2 })
    ];
    const result = build({ selected: records });

    assert.deepStrictEqual(
        result.map((item) => item.activityId),
        ["activity_c", "activity_a", "activity_b"]
    );
    assert.deepStrictEqual(result.map((item) => item.rank), [3, 1, 2]);
}

function testActivityIdNormalizationAndFallback() {
    const id = new ObjectId("64f000000000000000000002");
    const current = build({
        selected: [makeRecord({ currentActivityId: id })]
    })[0];
    const fallback = build({
        selected: [
            makeRecord({
                activityId: "fallback_activity",
                currentActivityId: undefined
            })
        ]
    })[0];

    assert.strictEqual(current.activityId, "64f000000000000000000002");
    assert.strictEqual(fallback.activityId, "fallback_activity");
}

function testFactorStatesAndEvidence() {
    const record = makeRecord();
    const result = build({ selected: [record] })[0];

    for (const factorName of FACTORS) {
        assert.deepStrictEqual(result.factors[factorName], {
            available: record.scoringState.factors[factorName].available,
            score: record.scoringState.factors[factorName].score
        });
        assert.deepStrictEqual(
            result.evidence.factors[factorName],
            record.scoringState.factors[factorName].evidence
        );
        assert.notStrictEqual(
            result.evidence.factors[factorName],
            record.scoringState.factors[factorName].evidence
        );
    }

    assert.strictEqual(result.factors.goal.available, true);
    assert.strictEqual(result.factors.goal.score, 0);
    assert.strictEqual(result.factors.exploration.available, false);
    assert.strictEqual(result.factors.exploration.score, null);
}

function testScoringMetadataAndContributions() {
    const record = makeRecord();
    const result = build({ selected: [record] })[0];

    assert.strictEqual(result.scoring.availableWeight, record.finalScore.availableWeight);
    assert.strictEqual(
        result.scoring.availableFactorCount,
        record.finalScore.availableFactorCount
    );
    assert.deepStrictEqual(
        result.scoring.contributions,
        record.finalScore.contributions
    );
    assert.notStrictEqual(
        result.scoring.contributions,
        record.finalScore.contributions
    );
    assert.deepStrictEqual(
        result.scoring.contributions.map((item) => item.factor),
        ["interest", "preference", "goal", "behavior"]
    );
}

function testEmptySelectedAndIgnoredGroups() {
    assert.deepStrictEqual(build({ selected: [] }), []);

    const result = build({
        selected: [makeRecord({ activityId: "selected" })],
        unselectedRanked: [makeRecord({ activityId: "unselected", rank: 2 })],
        unranked: [makeRecord({ activityId: "unranked", rank: 3 })]
    });

    assert.deepStrictEqual(result.map((item) => item.activityId), ["selected"]);
}

function testValidation() {
    assertThrows("missing selection", () => build(null));
    assertThrows("missing selected", () => build({}));
    assertThrows("selected not array", () => build({ selected: {} }));
    assertThrows("missing finalScore", () => build({
        selected: [makeRecord({ finalScore: null })]
    }));
    assertThrows("unavailable finalScore", () => build({
        selected: [
            makeRecord({
                finalScore: makeFinalScore({
                    available: false,
                    score: null,
                    availableWeight: 0,
                    availableFactorCount: 0,
                    contributions: []
                })
            })
        ]
    }));
    assertThrows("bad rank", () => build({
        selected: [makeRecord({ rank: 0 })]
    }));
    assertThrows("missing activity id", () => build({
        selected: [
            makeRecord({
                activityId: "",
                currentActivityId: undefined
            })
        ]
    }));
    assertThrows("missing factor", () => {
        const factors = makeFactors();
        delete factors.session;
        build({ selected: [makeRecord({ factors })] });
    });
    assertThrows("unknown factor", () => build({
        selected: [
            makeRecord({
                factors: {
                    ...makeFactors(),
                    vendor: factor(SCORING_FACTORS.INTEREST, { score: 1 })
                }
            })
        ]
    }));
    assertThrows("malformed factor", () => build({
        selected: [
            makeRecord({
                factors: {
                    ...makeFactors(),
                    interest: {
                        factor: "interest",
                        available: true,
                        score: 1
                    }
                }
            })
        ]
    }));
    assertThrows("bad contributions", () => build({
        selected: [
            makeRecord({
                finalScore: makeFinalScore({
                    contributions: {}
                })
            })
        ]
    }));
}

function testOutputReferenceIsolation() {
    const record = makeRecord();
    const result = build({ selected: [record] })[0];

    result.scoring.contributions[0].score = 0;
    result.evidence.discovery.interests.push({ name: "mutated" });
    result.evidence.factors.interest[0].score = 0;

    assert.strictEqual(record.finalScore.contributions[0].score, 0.8);
    assert.strictEqual(record.candidate.evidence.interests.length, 1);
    assert.strictEqual(record.scoringState.factors.interest.evidence[0].score, 0.8);
}

function testInputImmutability() {
    const selectionResult = {
        selected: [makeRecord()],
        unselectedRanked: [makeRecord({ activityId: "unselected", rank: 2 })],
        unranked: [makeRecord({ activityId: "unranked", rank: 3 })]
    };
    const before = snapshot(selectionResult);

    build(selectionResult);

    assert.deepStrictEqual(snapshot(selectionResult), before);
}

function main() {
    testOneSelectedRecord();
    testMultipleSelectedOrderPreserved();
    testActivityIdNormalizationAndFallback();
    testFactorStatesAndEvidence();
    testScoringMetadataAndContributions();
    testEmptySelectedAndIgnoredGroups();
    testValidation();
    testOutputReferenceIsolation();
    testInputImmutability();

    console.log("STEP 22B Recommendation Result Builder controlled tests passed");
}

main();
