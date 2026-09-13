const assert = require("assert");
const { ObjectId } = require("mongodb");
const {
    buildExplanationEvidence
} = require("../explanation/explanationEvidenceBuilder");

const ids = {
    activity: new ObjectId("64f000000000000000000001"),
    subcategory: new ObjectId("64f000000000000000000002"),
    siblingSubcategory: new ObjectId("64f000000000000000000003"),
    category: new ObjectId("64f000000000000000000004"),
    goal: new ObjectId("64f000000000000000000005"),
    missingGoal: new ObjectId("64f000000000000000000006"),
    outcomeA: new ObjectId("64f000000000000000000007"),
    outcomeB: new ObjectId("64f000000000000000000008"),
    missingOutcome: new ObjectId("64f000000000000000000009"),
    session: new ObjectId("64f000000000000000000010")
};

function snapshot(value) {
    return JSON.parse(JSON.stringify(value));
}

function factor(available, score) {
    return {
        available,
        score: available ? score : null
    };
}

function makeRecommendationResult(overrides = {}) {
    return {
        activityId: String(ids.activity),
        factors: {
            interest: factor(true, 0.8),
            preference: factor(true, 0.75),
            goal: factor(true, 0),
            exploration: factor(true, 1),
            behavior: factor(true, 0.75),
            session: factor(false, null),
            ...(overrides.factors ?? {})
        },
        eligibleSessionIds: overrides.eligibleSessionIds ?? [
            String(ids.session)
        ],
        evidence: {
            discovery: {
                interests: [],
                goals: [],
                summary: []
            },
            factors: {
                interest: [
                    {
                        type: "exact_subcategory_interest",
                        subcategoryId: String(ids.subcategory),
                        score: 0.8,
                        confidence: 0.9
                    },
                    {
                        type: "category_fallback",
                        categoryId: String(ids.category),
                        excludedSubcategoryId: String(ids.subcategory),
                        siblingCount: 2,
                        siblingScores: [0.7, 0.9],
                        categoryScore: 0.8
                    },
                    {
                        type: "exact_subcategory_interest",
                        subcategoryId: String(ids.subcategory),
                        score: 0.8,
                        confidence: 0.9
                    }
                ],
                preference: [
                    {
                        dimension: "environment",
                        childValue: "Indoor",
                        activityValue: "Indoor",
                        confidence: 1,
                        source: "Onboarding",
                        baseMatch: 1,
                        adjustedScore: 1
                    }
                ],
                goal: [
                    {
                        type: "goal_coverage",
                        goalId: String(ids.goal),
                        priority: "High",
                        status: "Active",
                        goalOutcomeIds: [
                            String(ids.outcomeA),
                            String(ids.outcomeB),
                            String(ids.outcomeA)
                        ],
                        matchedOutcomeIds: [
                            String(ids.outcomeA),
                            String(ids.missingOutcome)
                        ],
                        coverage: 0.5
                    },
                    {
                        type: "missing_goal_document",
                        goalId: String(ids.missingGoal),
                        priority: "Low",
                        status: "Active"
                    }
                ],
                exploration: [
                    {
                        type: "exact_activity_novelty",
                        activityId: String(ids.activity),
                        noveltyState: "new",
                        matchingBookingCount: 0,
                        displayedRecommendationCount: 0,
                        experiencedBookingCount: 0
                    }
                ],
                behavior: [
                    {
                        type: "exact_activity_behavior",
                        activityId: String(ids.activity),
                        behaviorState: "rating",
                        selectedInteractionType: "Rate",
                        selectedInteractionId: "interaction_1",
                        selectedTimestamp: "2026-09-01T00:00:00.000Z",
                        actorType: "Child",
                        score: 0.75,
                        matchingInteractionCount: 2,
                        explicitInteractionCount: 1,
                        passiveInteractionCount: 1,
                        ratingValue: 4
                    }
                ],
                session: [
                    {
                        type: "preferred_day_match",
                        preferredDays: ["Monday"],
                        eligibleSessionCount: 1,
                        checkedSessions: [
                            {
                                sessionId: String(ids.session),
                                weekday: "Monday"
                            }
                        ],
                        matchingSessionIds: [String(ids.session)],
                        matchingWeekdays: ["Monday"],
                        score: 1
                    }
                ],
                ...(overrides.factorEvidence ?? {})
            }
        }
    };
}

function createMockDb() {
    const queryCounts = {};
    const collections = {
        activities: [
            {
                _id: ids.activity,
                basicInformation: {
                    nameAr: "مختبر الروبوتات",
                    nameEn: "Robotics Lab"
                },
                vendorId: "must_not_copy"
            }
        ],
        subcategories: [
            {
                _id: ids.subcategory,
                name: "Robotics"
            },
            {
                _id: ids.siblingSubcategory,
                name: "Coding"
            }
        ],
        categories: [
            {
                _id: ids.category,
                name: "STEM"
            }
        ],
        goal_library: [
            {
                _id: ids.goal,
                name: "Improve Problem Solving"
            }
        ],
        learning_outcomes: [
            {
                _id: ids.outcomeA,
                name: "Problem Solving"
            },
            {
                _id: ids.outcomeB,
                name: "Teamwork"
            }
        ]
    };

    function collection(name) {
        queryCounts[name] = queryCounts[name] ?? {
            findOne: 0,
            find: 0
        };

        return {
            async findOne(query) {
                queryCounts[name].findOne += 1;
                return collections[name].find((document) =>
                    String(document._id) === String(query._id)
                ) ?? null;
            },
            find(query) {
                queryCounts[name].find += 1;
                const requestedIds = new Set(
                    query._id.$in.map((id) => String(id))
                );
                const matched = collections[name].filter((document) =>
                    requestedIds.has(String(document._id))
                );

                return {
                    project() {
                        return this;
                    },
                    async toArray() {
                        return matched;
                    }
                };
            }
        };
    }

    return {
        db: {
            collection
        },
        queryCounts
    };
}

async function testEnrichmentAndPreservation() {
    const recommendationResult = makeRecommendationResult();
    const before = snapshot(recommendationResult);
    const { db, queryCounts } = createMockDb();
    const result = await buildExplanationEvidence(recommendationResult, { db });

    assert.deepStrictEqual(snapshot(recommendationResult), before);

    assert.deepStrictEqual(result.activity, {
        activityId: String(ids.activity),
        nameAr: "مختبر الروبوتات",
        nameEn: "Robotics Lab",
        resolved: true
    });
    assert(!Object.prototype.hasOwnProperty.call(result.activity, "vendorId"));

    assert.strictEqual(
        result.factors.interest.evidence[0].subcategory.name,
        "Robotics"
    );
    assert.strictEqual(
        result.factors.interest.evidence[1].category.name,
        "STEM"
    );
    assert.strictEqual(
        result.factors.interest.evidence[1].excludedSubcategory.name,
        "Robotics"
    );

    assert.deepStrictEqual(
        result.factors.preference.evidence,
        recommendationResult.evidence.factors.preference
    );
    assert.notStrictEqual(
        result.factors.preference.evidence,
        recommendationResult.evidence.factors.preference
    );

    assert.strictEqual(
        result.factors.goal.evidence[0].goal.name,
        "Improve Problem Solving"
    );
    assert.deepStrictEqual(
        result.factors.goal.evidence[0].goalOutcomes.map((outcome) =>
            outcome.name
        ),
        ["Problem Solving", "Teamwork", "Problem Solving"]
    );
    assert.deepStrictEqual(
        result.factors.goal.evidence[0].matchedOutcomes.map((outcome) =>
            outcome.name
        ),
        ["Problem Solving", null]
    );
    assert.strictEqual(
        result.factors.goal.evidence[0].matchedOutcomes[1].resolved,
        false
    );
    assert.strictEqual(
        result.factors.goal.evidence[1].goal.name,
        null
    );
    assert.strictEqual(
        result.factors.goal.evidence[1].goal.resolved,
        false
    );

    assert.deepStrictEqual(
        result.factors.exploration.evidence,
        recommendationResult.evidence.factors.exploration
    );
    assert.deepStrictEqual(
        result.factors.behavior.evidence,
        recommendationResult.evidence.factors.behavior
    );
    assert.strictEqual(result.factors.behavior.evidence[0].actorType, "Child");
    assert.strictEqual(result.factors.behavior.evidence[0].ratingValue, 4);
    assert.deepStrictEqual(
        result.factors.session.evidence,
        recommendationResult.evidence.factors.session
    );

    assert.deepStrictEqual(result.eligibleSessionIds, [String(ids.session)]);
    assert.strictEqual(result.practicalEligibility.hasEligibleSession, true);
    assert.strictEqual(result.factors.session.available, false);
    assert.strictEqual(result.factors.session.score, null);
    assert.strictEqual(result.factors.goal.available, true);
    assert.strictEqual(result.factors.goal.score, 0);

    assert.strictEqual(queryCounts.activities.findOne, 1);
    assert.strictEqual(queryCounts.subcategories.find, 1);
    assert.strictEqual(queryCounts.categories.find, 1);
    assert.strictEqual(queryCounts.goal_library.find, 1);
    assert.strictEqual(queryCounts.learning_outcomes.find, 1);
}

async function testEmptyEligibleSessions() {
    const { db } = createMockDb();
    const result = await buildExplanationEvidence(
        makeRecommendationResult({ eligibleSessionIds: [] }),
        { db }
    );

    assert.deepStrictEqual(result.eligibleSessionIds, []);
    assert.strictEqual(result.practicalEligibility.hasEligibleSession, false);
}

async function testQueriesOnlyNeededCollections() {
    const recommendationResult = makeRecommendationResult({
        factorEvidence: {
            interest: [],
            goal: []
        }
    });
    const { db, queryCounts } = createMockDb();

    await buildExplanationEvidence(recommendationResult, { db });

    assert.strictEqual(queryCounts.activities.findOne, 1);
    assert.strictEqual(queryCounts.subcategories, undefined);
    assert.strictEqual(queryCounts.categories, undefined);
    assert.strictEqual(queryCounts.goal_library, undefined);
    assert.strictEqual(queryCounts.learning_outcomes, undefined);
}

async function testValidation() {
    const { db } = createMockDb();

    await assert.rejects(
        () => buildExplanationEvidence(null, { db }),
        /RecommendationResult is required/
    );

    await assert.rejects(
        () => buildExplanationEvidence({
            ...makeRecommendationResult(),
            eligibleSessionIds: {}
        }, { db }),
        /eligibleSessionIds must be an array/
    );
}

async function main() {
    await testEnrichmentAndPreservation();
    await testEmptyEligibleSessions();
    await testQueriesOnlyNeededCollections();
    await testValidation();

    console.log("Explanation evidence builder unit tests: PASSED");
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
