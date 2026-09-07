const assert = require("assert");
const { ObjectId } = require("mongodb");
const { calculateExplorationFactor } =
    require("../recommendation/explorationFactorService");

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function sameId(left, right) {
    return String(left) === String(right);
}

function setNestedValue(target, path, value) {
    const parts = path.split(".");
    let current = target;

    for (let index = 0; index < parts.length - 1; index += 1) {
        const part = parts[index];

        if (!current[part]) {
            current[part] = {};
        }

        current = current[part];
    }

    current[parts[parts.length - 1]] = value;
}

function getNestedValue(source, path) {
    return path.split(".").reduce(
        (current, part) => current?.[part],
        source
    );
}

function projectDocument(document, projection) {
    const projected = {};

    for (const path of Object.keys(projection)) {
        if (projection[path] !== 1) {
            continue;
        }

        const value = getNestedValue(document, path);

        if (value !== undefined) {
            setNestedValue(projected, path, value);
        }
    }

    return projected;
}

function createFindResult(documents, queryLog, collectionName, query) {
    let projection = null;

    return {
        project(projectValue) {
            projection = projectValue;
            return this;
        },

        async toArray() {
            queryLog.push({
                collectionName,
                query: clone(query),
                projection: clone(projection)
            });

            return documents.map((document) =>
                projection
                    ? projectDocument(document, projection)
                    : document
            );
        }
    };
}

function createFakeDb({ collections, queryLog }) {
    return {
        listCollections(filter) {
            return {
                async toArray() {
                    return collections[filter.name]
                        ? [
                            {
                                name: filter.name
                            }
                        ]
                        : [];
                }
            };
        },

        collection(collectionName) {
            return {
                find(query) {
                    const documents = collections[collectionName] ?? [];

                    if (collectionName !== "interactions") {
                        return createFindResult(
                            documents,
                            queryLog,
                            collectionName,
                            query
                        );
                    }

                    const activityIds =
                        query["targetEntity.entityId"].$in;
                    const matchingDocuments = documents.filter((document) =>
                        sameId(document.actor?.childId, query["actor.childId"]) &&
                        document.targetEntity?.entityType ===
                            query["targetEntity.entityType"] &&
                        activityIds.some((activityId) =>
                            sameId(
                                document.targetEntity?.entityId,
                                activityId
                            )
                        )
                    );

                    return createFindResult(
                        matchingDocuments,
                        queryLog,
                        collectionName,
                        query
                    );
                }
            };
        }
    };
}

function loadDataService(fakeDb) {
    const mongodbConfig = require("../config/mongodb");
    mongodbConfig.getDatabase = () => fakeDb;
    delete require.cache[
        require.resolve("../recommendation/recommendationDataService")
    ];

    return require("../recommendation/recommendationDataService");
}

async function testInteractionLoader() {
    const queryLog = [];
    const childId = new ObjectId();
    const otherChildId = new ObjectId();
    const activityAId = new ObjectId();
    const activityBId = new ObjectId();
    const unrelatedActivityId = new ObjectId();
    const categoryId = new ObjectId();
    const subcategoryId = new ObjectId();
    const questionId = new ObjectId();
    const sessionId = new ObjectId();
    const recommendationId = new ObjectId();
    const timestamp = new Date("2026-09-06T10:00:00.000Z");
    const rateTimestamp = new Date("2026-09-06T11:00:00.000Z");
    const fakeDb = createFakeDb({
        queryLog,
        collections: {
            interactions: [
                {
                    _id: new ObjectId(),
                    actor: {
                        parentId: new ObjectId(),
                        childId,
                        actorType: "Child"
                    },
                    targetEntity: {
                        entityType: "Activity",
                        entityId: activityAId
                    },
                    interactionDetails: {
                        interactionType: "Click",
                        durationSeconds: 12,
                        ratingValue: null,
                        answerValue: "hidden",
                        position: 1,
                        searchQuery: "robotics"
                    },
                    context: {
                        surface: "Recommendations",
                        recommendationId,
                        sessionId,
                        deviceChannel: "Mobile",
                        platform: "iOS"
                    },
                    processingStatus: "Processed",
                    timestamp,
                    eventMetadata: {
                        userAgent: "hidden"
                    },
                    metadata: {
                        version: 1,
                        createdBy: "System"
                    }
                },
                {
                    _id: new ObjectId(),
                    actor: {
                        childId,
                        actorType: "Child"
                    },
                    targetEntity: {
                        entityType: "Activity",
                        entityId: activityBId
                    },
                    interactionDetails: {
                        interactionType: "Rate",
                        durationSeconds: null,
                        ratingValue: 4
                    },
                    context: {
                        surface: "ActivityDetail"
                    },
                    timestamp: rateTimestamp,
                    metadata: {
                        version: 1
                    }
                },
                {
                    _id: new ObjectId(),
                    actor: {
                        childId: otherChildId,
                        actorType: "Child"
                    },
                    targetEntity: {
                        entityType: "Activity",
                        entityId: activityAId
                    },
                    interactionDetails: {
                        interactionType: "Save"
                    },
                    timestamp: new Date()
                },
                {
                    _id: new ObjectId(),
                    actor: {
                        childId,
                        actorType: "Child"
                    },
                    targetEntity: {
                        entityType: "Activity",
                        entityId: unrelatedActivityId
                    },
                    interactionDetails: {
                        interactionType: "Dismiss"
                    },
                    timestamp: new Date()
                },
                {
                    _id: new ObjectId(),
                    actor: {
                        childId,
                        actorType: "Child"
                    },
                    targetEntity: {
                        entityType: "Category",
                        entityId: categoryId
                    },
                    interactionDetails: {
                        interactionType: "View"
                    },
                    timestamp: new Date()
                },
                {
                    _id: new ObjectId(),
                    actor: {
                        childId,
                        actorType: "Child"
                    },
                    targetEntity: {
                        entityType: "Subcategory",
                        entityId: subcategoryId
                    },
                    interactionDetails: {
                        interactionType: "View"
                    },
                    timestamp: new Date()
                },
                {
                    _id: new ObjectId(),
                    actor: {
                        childId,
                        actorType: "Child"
                    },
                    targetEntity: {
                        entityType: "Question",
                        entityId: questionId
                    },
                    interactionDetails: {
                        interactionType: "QuestionAnswered"
                    },
                    timestamp: new Date()
                }
            ]
        }
    });
    const recommendationDataService = loadDataService(fakeDb);
    const result =
        await recommendationDataService.getInteractionsForCandidateActivities(
            childId,
            [
                activityAId,
                String(activityBId),
                activityAId,
                null,
                "not-an-object-id"
            ]
        );

    assert.strictEqual(result.source, "available");
    assert.strictEqual(result.interactions.length, 2);
    assert.strictEqual(queryLog.length, 1);
    assert.strictEqual(queryLog[0].collectionName, "interactions");
    assert(sameId(queryLog[0].query["actor.childId"], childId));
    assert.strictEqual(queryLog[0].query["targetEntity.entityType"], "Activity");
    assert.strictEqual(
        queryLog[0].query["targetEntity.entityId"].$in.length,
        2
    );
    assert.deepStrictEqual(queryLog[0].projection, {
        _id: 1,
        "actor.childId": 1,
        "actor.actorType": 1,
        "targetEntity.entityType": 1,
        "targetEntity.entityId": 1,
        "interactionDetails.interactionType": 1,
        "interactionDetails.ratingValue": 1,
        "interactionDetails.durationSeconds": 1,
        "context.surface": 1,
        "context.recommendationId": 1,
        "context.sessionId": 1,
        timestamp: 1,
        "metadata.version": 1
    });

    const click = result.interactions.find(
        (interaction) =>
            interaction.interactionDetails.interactionType === "Click"
    );
    const rate = result.interactions.find(
        (interaction) =>
            interaction.interactionDetails.interactionType === "Rate"
    );

    assert(click, "Click interaction must be preserved");
    assert(rate, "Rate interaction must be preserved");
    assert.strictEqual(click.interactionDetails.durationSeconds, 12);
    assert.strictEqual(rate.interactionDetails.ratingValue, 4);
    assert.strictEqual(click.timestamp, timestamp);
    assert.strictEqual(rate.timestamp, rateTimestamp);
    assert.strictEqual(click.actor.actorType, "Child");
    assert.strictEqual(click.targetEntity.entityType, "Activity");
    assert.strictEqual(click.context.surface, "Recommendations");
    assert.strictEqual(click.context.recommendationId, recommendationId);
    assert.strictEqual(click.context.sessionId, sessionId);
    assert.strictEqual(click.metadata.version, 1);
    assert(
        !Object.prototype.hasOwnProperty.call(
            click.interactionDetails,
            "answerValue"
        )
    );
    assert(
        !Object.prototype.hasOwnProperty.call(
            click.interactionDetails,
            "searchQuery"
        )
    );
    assert(
        !Object.prototype.hasOwnProperty.call(click.context, "deviceChannel")
    );
    assert(!Object.prototype.hasOwnProperty.call(click, "eventMetadata"));
}

async function testAvailableEmptySource() {
    const queryLog = [];
    const childId = new ObjectId();
    const activityId = new ObjectId();
    const fakeDb = createFakeDb({
        queryLog,
        collections: {
            interactions: []
        }
    });
    const recommendationDataService = loadDataService(fakeDb);
    const result =
        await recommendationDataService.getInteractionsForCandidateActivities(
            childId,
            [activityId]
        );

    assert.strictEqual(result.source, "available");
    assert.deepStrictEqual(result.interactions, []);
    assert.strictEqual(queryLog.length, 1);
}

async function testUnavailableSource() {
    const queryLog = [];
    const childId = new ObjectId();
    const activityId = new ObjectId();
    const fakeDb = createFakeDb({
        queryLog,
        collections: {}
    });
    const recommendationDataService = loadDataService(fakeDb);
    const result =
        await recommendationDataService.getInteractionsForCandidateActivities(
            childId,
            [activityId]
        );

    assert.strictEqual(result.source, "unavailable");
    assert.deepStrictEqual(result.interactions, []);
    assert.strictEqual(queryLog.length, 0);
}

async function testContextComposition() {
    const childId = new ObjectId();
    const parentId = new ObjectId();
    const activityAId = new ObjectId();
    const activityBId = new ObjectId();
    const vendorId = new ObjectId();
    const bookingDocument = {
        _id: new ObjectId(),
        bookingDetails: {
            childId,
            activityId: activityAId,
            status: "Confirmed"
        },
        attendance: {
            status: "NotCheckedIn"
        }
    };
    const recommendationDocument = {
        _id: new ObjectId(),
        childId,
        recommendedItems: [
            {
                activityId: activityAId
            }
        ],
        response: {
            wasDisplayed: true
        }
    };
    const interactionDocument = {
        _id: new ObjectId(),
        actor: {
            childId,
            actorType: "Child"
        },
        targetEntity: {
            entityType: "Activity",
            entityId: activityAId
        },
        interactionDetails: {
            interactionType: "Save"
        },
        timestamp: new Date("2026-09-06T12:00:00.000Z")
    };
    const candidateEvidence = {
        interests: [],
        goals: [],
        summary: []
    };
    const traversalService = require("../traversal/traversalService");
    delete require.cache[
        require.resolve("../recommendation/recommendationDataService")
    ];
    const recommendationDataService =
        require("../recommendation/recommendationDataService");

    traversalService.findCandidateActivities = async () => [
        {
            activity: {
                activityId: String(activityAId),
                title: "Activity A"
            },
            evidence: candidateEvidence
        },
        {
            activity: {
                activityId: String(activityAId),
                title: "Activity A Duplicate"
            },
            evidence: {
                interests: [],
                goals: [],
                summary: []
            }
        },
        {
            activity: {
                activityId: String(activityBId),
                title: "Activity B"
            },
            evidence: {
                interests: [],
                goals: [],
                summary: []
            }
        }
    ];

    let bookingLoadCount = 0;
    let recommendationLoadCount = 0;
    let interactionLoadCount = 0;
    let interactionInputIds = null;

    recommendationDataService.getChild = async () => ({
        _id: childId,
        parentId,
        parentGoals: [],
        preferences: {}
    });
    recommendationDataService.getChildInterests = async () => [];
    recommendationDataService.getSubcategoriesByIds = async () => [];
    recommendationDataService.getParent = async () => ({
        _id: parentId
    });
    recommendationDataService.getGoalsByIds = async () => [];
    recommendationDataService.getActivity = async (activityId) => ({
        _id: activityId,
        vendorId,
        learningOutcomes: []
    });
    recommendationDataService.getVendor = async () => ({
        _id: vendorId
    });
    recommendationDataService.getSessions = async () => [];
    recommendationDataService.getExplorationBookingHistory = async () => {
        bookingLoadCount += 1;

        return {
            source: "available",
            bookings: [bookingDocument]
        };
    };
    recommendationDataService.getExplorationRecommendationHistory = async () => {
        recommendationLoadCount += 1;

        return {
            source: "available",
            recommendations: [recommendationDocument]
        };
    };
    recommendationDataService.getInteractionsForCandidateActivities =
        async (receivedChildId, activityIds) => {
            interactionLoadCount += 1;
            assert(sameId(receivedChildId, childId));
            interactionInputIds = activityIds;

            return {
                source: "available",
                interactions: [interactionDocument]
            };
        };

    delete require.cache[
        require.resolve("../recommendation/recommendationContextService")
    ];
    const {
        buildRecommendationContext
    } = require("../recommendation/recommendationContextService");

    const context = await buildRecommendationContext(childId);
    const contextSnapshot = clone(context);

    assert.deepStrictEqual(context.historyContext.bookings, [bookingDocument]);
    assert.deepStrictEqual(
        context.historyContext.recommendations,
        [recommendationDocument]
    );
    assert.deepStrictEqual(
        context.historyContext.interactions,
        [interactionDocument]
    );
    assert.deepStrictEqual(context.historyContext.sources, {
        bookings: "available",
        recommendations: "available",
        interactions: "available"
    });
    assert.strictEqual(bookingLoadCount, 1);
    assert.strictEqual(recommendationLoadCount, 1);
    assert.strictEqual(interactionLoadCount, 1);
    assert.strictEqual(interactionInputIds.length, 2);
    assert(
        interactionInputIds.some((activityId) =>
            sameId(activityId, activityAId)
        )
    );
    assert(
        interactionInputIds.some((activityId) =>
            sameId(activityId, activityBId)
        )
    );
    assert.deepStrictEqual(context.interestContext, {
        childInterests: [],
        subcategories: []
    });
    assert.deepStrictEqual(context.goalContext, {
        goals: []
    });
    assert.deepStrictEqual(context.candidates[0].evidence, candidateEvidence);
    assert(!Object.prototype.hasOwnProperty.call(context.historyContext, "score"));
    assert(
        !Object.prototype.hasOwnProperty.call(
            context.historyContext,
            "behaviorScore"
        )
    );
    assert.deepStrictEqual(clone(context), contextSnapshot);
}

function testExplorationIgnoresInteractions() {
    const childId = new ObjectId();
    const activityId = new ObjectId();
    const eligibilityEvaluation = {
        candidate: {
            activity: {
                activityId,
                title: "Activity A"
            },
            currentActivity: {
                _id: activityId
            }
        },
        eligibility: {
            eligible: true,
            failedConstraints: []
        }
    };
    const baseContext = {
        child: {
            _id: childId
        },
        historyContext: {
            bookings: [],
            recommendations: [],
            sources: {
                bookings: "available",
                recommendations: "available",
                interactions: "unavailable"
            },
            interactions: []
        }
    };
    const withInteractions = {
        child: {
            _id: childId
        },
        historyContext: {
            bookings: [],
            recommendations: [],
            interactions: [
                {
                    actor: {
                        childId
                    },
                    targetEntity: {
                        entityType: "Activity",
                        entityId: activityId
                    },
                    interactionDetails: {
                        interactionType: "Click"
                    }
                }
            ],
            sources: {
                bookings: "available",
                recommendations: "available",
                interactions: "available"
            }
        }
    };

    assert.deepStrictEqual(
        calculateExplorationFactor(withInteractions, eligibilityEvaluation),
        calculateExplorationFactor(baseContext, eligibilityEvaluation)
    );
}

async function main() {
    await testInteractionLoader();
    await testAvailableEmptySource();
    await testUnavailableSource();
    await testContextComposition();
    testExplorationIgnoresInteractions();

    console.log("Behavior history context controlled tests: PASSED");
}

main().catch((error) => {
    console.error("Behavior history context controlled tests FAILED");
    console.error(error);
    process.exit(1);
});
