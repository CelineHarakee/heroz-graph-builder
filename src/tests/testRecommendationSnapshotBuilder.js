const assert = require("assert");
const { ObjectId } = require("mongodb");
const {
    SCORING_FACTORS
} = require("../recommendation/scoringContract");
const {
    RECOMMENDATION_ALGORITHM_VERSION,
    buildRecommendationSnapshot
} = require("../recommendation/recommendationSnapshotBuilder");

const FACTORS = Object.values(SCORING_FACTORS);

function snapshot(value) {
    return JSON.parse(JSON.stringify(value));
}

function assertThrows(label, fn) {
    assert.throws(fn, Error, label);
}

function factor(available, score) {
    return {
        available,
        score: available ? score : null
    };
}

function makeRecommendationResult({
    activityId = "64f000000000000000000011",
    rank = 1,
    score = 0.7123456789123456,
    eligibleSessionIds = [
        "64f000000000000000000021",
        "64f000000000000000000022"
    ],
    factors,
    scoring,
    evidence
} = {}) {
    return {
        activityId,
        rank,
        score,
        factors: factors ?? {
            interest: factor(true, 0.8),
            preference: factor(true, 0.9),
            goal: factor(true, 0),
            exploration: factor(false, null),
            behavior: factor(true, 0.75),
            session: factor(false, null)
        },
        scoring: scoring ?? {
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
            ]
        },
        eligibleSessionIds,
        evidence: evidence ?? {
            discovery: {
                interests: [{ name: "Robotics" }],
                goals: [{ name: "Problem Solving" }],
                summary: ["D4"]
            },
            factors: {
                interest: [{ type: "exact_subcategory_interest", score: 0.8 }],
                preference: [{ dimension: "environment", adjustedScore: 0.9 }],
                goal: [{ type: "goal_coverage", coverage: 0 }],
                exploration: [{ type: "history_source_unavailable" }],
                behavior: [{ type: "exact_activity_behavior", ratingValue: 4 }],
                session: [{ type: "no_preferred_days" }]
            }
        }
    };
}

function build(overrides = {}) {
    return buildRecommendationSnapshot({
        parentId: "64f000000000000000000001",
        childId: new ObjectId("64f000000000000000000002"),
        requestedAt: new Date("2026-09-08T10:00:00.000Z"),
        createdAt: new Date("2026-09-08T10:01:00.000Z"),
        recommendationResults: [
            makeRecommendationResult(),
            makeRecommendationResult({
                activityId: "64f000000000000000000012",
                rank: 2,
                score: 1,
                eligibleSessionIds: []
            })
        ],
        ...overrides
    });
}

function assertNoUndocumentedFields(document) {
    const forbidden = [
        "explanation",
        "reason",
        "reasonText",
        "whyRecommended",
        "expiresAt",
        "expirationTimestamp",
        "cacheTTL",
        "activeUntil",
        "unselectedRanked",
        "unranked",
        "candidate",
        "eligibilityEvaluation",
        "historyContext",
        "parent",
        "child"
    ];

    for (const field of forbidden) {
        assert(!Object.prototype.hasOwnProperty.call(document, field));
    }

    for (const item of document.recommendedItems) {
        assert(!Object.prototype.hasOwnProperty.call(item, "currentActivity"));
        assert(!Object.prototype.hasOwnProperty.call(item, "activity"));
        assert(!Object.prototype.hasOwnProperty.call(item, "sessions"));
        assert(!Object.prototype.hasOwnProperty.call(item, "currentSessions"));
        assert(!Object.prototype.hasOwnProperty.call(item, "vendor"));
        assert(!Object.prototype.hasOwnProperty.call(item.factors, "vendor"));
    }
}

function testCompleteValidSnapshot() {
    const document = build();

    assert(document.parentId instanceof ObjectId);
    assert.strictEqual(String(document.parentId), "64f000000000000000000001");
    assert(document.childId instanceof ObjectId);
    assert.strictEqual(String(document.childId), "64f000000000000000000002");
    assert(document.recommendationContext.requestedAt instanceof Date);
    assert.strictEqual(
        document.recommendationContext.requestedAt.toISOString(),
        "2026-09-08T10:00:00.000Z"
    );
    assert(document.metadata.createdAt instanceof Date);
    assert(document.metadata.updatedAt instanceof Date);
    assert.strictEqual(
        document.metadata.createdAt.getTime(),
        document.metadata.updatedAt.getTime()
    );
    assert.strictEqual(document.algorithmVersion, RECOMMENDATION_ALGORITHM_VERSION);
    assert.strictEqual(document.algorithmVersion, 1);
    assert.strictEqual(document.metadata.version, 1);
    assert.strictEqual(document.recommendedItems.length, 2);
    assert.deepStrictEqual(
        document.recommendedItems.map((item) => String(item.activityId)),
        [
            "64f000000000000000000011",
            "64f000000000000000000012"
        ]
    );
    assert.deepStrictEqual(
        document.recommendedItems[0].eligibleSessionIds.map(String),
        [
            "64f000000000000000000021",
            "64f000000000000000000022"
        ]
    );
    assert.deepStrictEqual(
        document.recommendedItems.map((item) => item.rank),
        [1, 2]
    );
    assert.strictEqual(document.recommendedItems[0].score, 0.7123456789123456);
    assert.strictEqual(document.recommendedItems[1].score, 1);
    assert.deepStrictEqual(Object.keys(document.recommendedItems[0].factors), FACTORS);
    assert.strictEqual(document.recommendedItems[0].factors.goal.available, true);
    assert.strictEqual(document.recommendedItems[0].factors.goal.score, 0);
    assert.strictEqual(document.recommendedItems[0].factors.exploration.available, false);
    assert.strictEqual(document.recommendedItems[0].factors.exploration.score, null);
    assert.strictEqual(document.recommendedItems[0].scoring.availableWeight, 0.78);
    assert.strictEqual(document.recommendedItems[0].scoring.availableFactorCount, 4);
    assert.deepStrictEqual(
        document.recommendedItems[0].scoring.contributions,
        makeRecommendationResult().scoring.contributions
    );
    assert.deepStrictEqual(
        document.recommendedItems[0].evidence,
        makeRecommendationResult().evidence
    );
    assert.deepStrictEqual(document.response, {
        wasDisplayed: false,
        displayedAt: null,
        clickedActivityIds: [],
        savedActivityIds: [],
        bookedSessionIds: [],
        dismissedActivityIds: [],
        lastResponseAt: null
    });
    assertNoUndocumentedFields(document);
}

function testValidation() {
    assertThrows("empty results", () => build({ recommendationResults: [] }));
    assertThrows("bad parent", () => build({ parentId: "not-an-id" }));
    assertThrows("bad child", () => build({ childId: "not-an-id" }));
    assertThrows("bad requestedAt", () => build({ requestedAt: "2026-09-08" }));
    assertThrows("bad createdAt", () => build({ createdAt: "2026-09-08" }));
    assertThrows("bad activity", () => build({
        recommendationResults: [
            makeRecommendationResult({ activityId: "not-an-id" })
        ]
    }));
    assertThrows("bad session", () => build({
        recommendationResults: [
            makeRecommendationResult({ eligibleSessionIds: ["not-an-id"] })
        ]
    }));
    assertThrows("bad result", () => build({
        recommendationResults: [null]
    }));
    assertThrows("missing factor", () => {
        const result = makeRecommendationResult();
        delete result.factors.session;
        build({ recommendationResults: [result] });
    });
    assertThrows("unknown factor", () => {
        const result = makeRecommendationResult();
        result.factors.vendor = factor(true, 1);
        build({ recommendationResults: [result] });
    });
    assertThrows("bad score", () => build({
        recommendationResults: [
            makeRecommendationResult({ score: 2 })
        ]
    }));
    assertThrows("bad scoring", () => {
        const result = makeRecommendationResult();
        result.scoring.contributions = {};
        build({ recommendationResults: [result] });
    });
}

function testInputImmutabilityAndReferenceIsolation() {
    const recommendationResults = [
        makeRecommendationResult()
    ];
    const before = snapshot(recommendationResults);
    const document = build({ recommendationResults });

    assert.deepStrictEqual(snapshot(recommendationResults), before);
    assert.notStrictEqual(
        document.recommendedItems[0].scoring.contributions,
        recommendationResults[0].scoring.contributions
    );
    assert.notStrictEqual(
        document.recommendedItems[0].evidence,
        recommendationResults[0].evidence
    );
    assert.notStrictEqual(
        document.recommendedItems[0].evidence.factors.interest,
        recommendationResults[0].evidence.factors.interest
    );

    document.recommendedItems[0].scoring.contributions[0].score = 0;
    document.recommendedItems[0].evidence.factors.interest[0].score = 0;

    assert.strictEqual(recommendationResults[0].scoring.contributions[0].score, 0.8);
    assert.strictEqual(recommendationResults[0].evidence.factors.interest[0].score, 0.8);
}

function main() {
    testCompleteValidSnapshot();
    testValidation();
    testInputImmutabilityAndReferenceIsolation();

    console.log("Recommendation snapshot builder unit tests: PASSED");
}

main();
