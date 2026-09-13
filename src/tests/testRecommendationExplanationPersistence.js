const assert = require("assert");
const { ObjectId } = require("mongodb");

function snapshot(value) {
    return JSON.parse(JSON.stringify(value));
}

function factor(available, score) {
    return {
        available,
        score: available ? score : null
    };
}

function makeRecommendationResult(activityId, rank) {
    return {
        activityId,
        rank,
        score: rank === 1 ? 0.9 : 0.7,
        factors: {
            interest: factor(true, 0.8),
            preference: factor(false, null),
            goal: factor(false, null),
            exploration: factor(false, null),
            behavior: factor(false, null),
            session: factor(false, null)
        },
        scoring: {
            availableWeight: 0.33,
            availableFactorCount: 1,
            contributions: [
                {
                    factor: "interest",
                    score: 0.8,
                    canonicalWeight: 0.33,
                    normalizedWeight: 1,
                    contribution: 0.8
                }
            ]
        },
        eligibleSessionIds: [],
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
                        subcategoryId: "64f000000000000000000021",
                        score: 0.8,
                        confidence: 0.9
                    }
                ],
                preference: [],
                goal: [],
                exploration: [],
                behavior: [],
                session: []
            }
        }
    };
}

function createStatefulDb() {
    const documents = {
        recommendations: [],
        activities: [
            {
                _id: new ObjectId("64f000000000000000000011"),
                basicInformation: {
                    nameAr: "نشاط أ",
                    nameEn: "Activity A"
                }
            },
            {
                _id: new ObjectId("64f000000000000000000012"),
                basicInformation: {
                    nameAr: "نشاط ب",
                    nameEn: "Activity B"
                }
            }
        ],
        subcategories: [
            {
                _id: new ObjectId("64f000000000000000000021"),
                name: "Robotics"
            }
        ],
        categories: [],
        goal_library: [],
        learning_outcomes: []
    };

    function collection(name) {
        return {
            async insertOne(document) {
                const inserted = {
                    ...document,
                    _id: new ObjectId("64f000000000000000000099")
                };

                documents[name].push(inserted);

                return {
                    insertedId: inserted._id
                };
            },
            async updateOne(filter, update) {
                const document = documents[name].find((item) =>
                    String(item._id) === String(filter._id)
                );

                if (!document) {
                    return {
                        matchedCount: 0,
                        modifiedCount: 0
                    };
                }

                const item = document.recommendedItems.find((recommendedItem) =>
                    String(recommendedItem.activityId) ===
                    String(filter["recommendedItems.activityId"])
                );

                if (!item) {
                    return {
                        matchedCount: 0,
                        modifiedCount: 0
                    };
                }

                item.explanation = update.$set["recommendedItems.$.explanation"];
                document.metadata.updatedAt = update.$set["metadata.updatedAt"];

                return {
                    matchedCount: 1,
                    modifiedCount: 1
                };
            },
            async findOne(query) {
                return documents[name].find((document) =>
                    String(document._id) === String(query._id)
                ) ?? null;
            },
            find(query) {
                const ids = new Set(query._id.$in.map((id) => String(id)));
                const matched = documents[name].filter((document) =>
                    ids.has(String(document._id))
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
        documents
    };
}

function loadServices(fakeDb) {
    const mongodbConfig = require("../config/mongodb");
    mongodbConfig.getDatabase = () => fakeDb;

    for (const path of [
        "../recommendation/recommendationPersistenceService",
        "../explanation/explanationEvidenceBuilder",
        "../explanation/explanationOrchestrator",
        "../recommendation/recommendationEngineService"
    ]) {
        delete require.cache[require.resolve(path)];
    }

    return {
        ...require("../recommendation/recommendationPersistenceService"),
        ...require("../explanation/explanationOrchestrator"),
        ...require("../recommendation/recommendationEngineService")
    };
}

function factualItemSnapshot(item) {
    const copy = snapshot(item);

    delete copy.explanation;

    return copy;
}

async function testPersistenceThenExplanationAttachment() {
    const { db, documents } = createStatefulDb();
    const {
        persistRecommendationSnapshot,
        attachRecommendationExplanations
    } = loadServices(db);
    const recommendationResults = [
        makeRecommendationResult("64f000000000000000000011", 1),
        makeRecommendationResult("64f000000000000000000012", 2)
    ];
    const persistence = await persistRecommendationSnapshot({
        parentId: "64f000000000000000000001",
        childId: "64f000000000000000000002",
        requestedAt: new Date("2026-09-08T10:00:00.000Z"),
        recommendationResults
    });
    const storedBefore = snapshot(documents.recommendations[0]);
    const response = await attachRecommendationExplanations({
        recommendationId: persistence.recommendationId,
        recommendationResults,
        parent: {
            account: {
                preferredLanguage: "en"
            }
        }
    });
    const storedAfter = documents.recommendations[0];

    assert.strictEqual(response.recommendationId, persistence.recommendationId);
    assert.strictEqual(response.recommendations.length, 2);
    assert.deepStrictEqual(
        storedAfter.recommendedItems.map((item) => String(item.activityId)),
        [
            "64f000000000000000000011",
            "64f000000000000000000012"
        ]
    );
    assert.deepStrictEqual(
        storedAfter.recommendedItems.map((item) => item.explanation.language),
        ["en", "en"]
    );
    assert.deepStrictEqual(
        storedAfter.recommendedItems.map((item) => item.explanation.source),
        ["generated", "generated"]
    );
    assert(storedAfter.recommendedItems[0].explanation.text.includes("Activity A"));
    assert(storedAfter.recommendedItems[1].explanation.text.includes("Activity B"));
    assert.strictEqual(storedAfter.response.wasDisplayed, false);

    for (let index = 0; index < storedAfter.recommendedItems.length; index += 1) {
        assert.deepStrictEqual(
            factualItemSnapshot(storedAfter.recommendedItems[index]),
            storedBefore.recommendedItems[index]
        );
    }

    assert.strictEqual(storedAfter.algorithmVersion, storedBefore.algorithmVersion);
    assert.deepStrictEqual(storedAfter.response, storedBefore.response);
    assert.strictEqual(storedAfter.metadata.version, storedBefore.metadata.version);
}

async function testEngineThroughPersistenceAndExplanation() {
    const { db, documents } = createStatefulDb();
    const {
        createRecommendationEngine
    } = loadServices(db);
    const activityA = new ObjectId("64f000000000000000000011");
    const activityB = new ObjectId("64f000000000000000000012");
    const context = {
        child: {
            _id: new ObjectId("64f000000000000000000002")
        },
        parent: {
            _id: new ObjectId("64f000000000000000000001"),
            account: {
                preferredLanguage: "en"
            }
        },
        candidates: [
            {
                activity: {
                    activityId: activityA,
                    title: "Activity A"
                },
                currentActivity: {
                    _id: activityA
                },
                evidence: {
                    interests: [],
                    goals: [],
                    summary: []
                }
            },
            {
                activity: {
                    activityId: activityB,
                    title: "Activity B"
                },
                currentActivity: {
                    _id: activityB
                },
                evidence: {
                    interests: [],
                    goals: [],
                    summary: []
                }
            }
        ]
    };
    const engine = createRecommendationEngine({
        now: () => new Date("2026-09-08T10:00:00.000Z"),
        async buildRecommendationContext() {
            return context;
        },
        async evaluateRecommendationEligibility() {
            return {
                eligibleCandidates: context.candidates.map((candidate) => ({
                    candidate,
                    eligibility: {
                        eligible: true,
                        failedConstraints: []
                    },
                    eligibleSessions: [],
                    sessionEvaluations: [],
                    missingInformation: []
                }))
            };
        },
        createCandidateScoringState(eligibilityEvaluation) {
            return {
                eligibilityEvaluation,
                factors: {
                    interest: null,
                    preference: null,
                    goal: null,
                    exploration: null,
                    behavior: null,
                    session: null
                }
            };
        },
        calculateInterestFactor(_context, eligibilityEvaluation) {
            return {
                factor: "interest",
                available: true,
                score: 0.8,
                evidence: [
                    {
                        type: "exact_subcategory_interest",
                        subcategoryId: "64f000000000000000000021",
                        score: 0.8,
                        confidence: 0.9,
                        activityId: String(eligibilityEvaluation.candidate.currentActivity._id)
                    }
                ]
            };
        },
        calculatePreferenceFactor() {
            return { factor: "preference", available: false, score: null, evidence: [] };
        },
        calculateGoalFactor() {
            return { factor: "goal", available: false, score: null, evidence: [] };
        },
        calculateExplorationFactor() {
            return { factor: "exploration", available: false, score: null, evidence: [] };
        },
        calculateBehaviorFactor() {
            return { factor: "behavior", available: false, score: null, evidence: [] };
        },
        calculateSessionFactor() {
            return { factor: "session", available: false, score: null, evidence: [] };
        },
        calculateFinalScore(scoringState) {
            const activityId = String(
                scoringState.eligibilityEvaluation.candidate.currentActivity._id
            );
            const score = activityId === String(activityA) ? 0.9 : 0.7;

            return {
                available: true,
                score,
                availableWeight: 0.33,
                availableFactorCount: 1,
                contributions: [
                    {
                        factor: "interest",
                        score: 0.8,
                        canonicalWeight: 0.33,
                        normalizedWeight: 1,
                        contribution: score
                    }
                ]
            };
        },
        rankCandidates(records) {
            return {
                ranked: records.map((record, index) => ({
                    ...record,
                    rank: index + 1
                })),
                unranked: []
            };
        },
        selectTopN(rankingResult, topN) {
            return {
                selected: rankingResult.ranked.slice(0, topN),
                unselectedRanked: rankingResult.ranked.slice(topN),
                unranked: []
            };
        }
    });
    const result = await engine.generateRecommendations(
        "64f000000000000000000002",
        2
    );
    const stored = documents.recommendations[0];

    assert.strictEqual(result.recommendationId, "64f000000000000000000099");
    assert.strictEqual(result.recommendations.length, 2);
    assert(result.recommendations.every((item) => item.explanation));
    assert(stored.recommendedItems.every((item) => item.explanation));
    assert.deepStrictEqual(
        result.recommendations.map((item) => item.activityId),
        stored.recommendedItems.map((item) => String(item.activityId))
    );
    assert.deepStrictEqual(
        stored.recommendedItems.map((item) => item.rank),
        [1, 2]
    );
    assert.deepStrictEqual(
        stored.recommendedItems.map((item) => item.score),
        [0.9, 0.7]
    );
    assert.strictEqual(stored.response.wasDisplayed, false);
}

async function main() {
    await testPersistenceThenExplanationAttachment();
    await testEngineThroughPersistenceAndExplanation();

    console.log("Recommendation explanation persistence integration tests: PASSED");
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
