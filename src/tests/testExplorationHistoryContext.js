const assert = require("assert");
const { ObjectId } = require("mongodb");

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

        const [root, ...rest] = path.split(".");
        const rootValue = document[root];

        if (Array.isArray(rootValue) && rest.length > 0) {
            projected[root] = rootValue.map((item) =>
                projectDocument(item, {
                    [rest.join(".")]: 1
                })
            );
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

function createFakeDb({
    collections,
    queryLog
}) {
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
                    const childIdPath = collectionName === "bookings"
                        ? "bookingDetails.childId"
                        : "childId";
                    const childId = query[childIdPath];
                    const activityIds = collectionName === "bookings"
                        ? query["bookingDetails.activityId"].$in
                        : query["recommendedItems.activityId"].$in;
                    const matchingDocuments = documents.filter((document) => {
                        const documentChildId =
                            getNestedValue(document, childIdPath);

                        if (!sameId(documentChildId, childId)) {
                            return false;
                        }

                        if (collectionName === "bookings") {
                            return activityIds.some((activityId) =>
                                sameId(
                                    getNestedValue(
                                        document,
                                        "bookingDetails.activityId"
                                    ),
                                    activityId
                                )
                            );
                        }

                        return document.recommendedItems.some((item) =>
                            activityIds.some((activityId) =>
                                sameId(item.activityId, activityId)
                            )
                        );
                    });

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

async function testDataServiceLoaders() {
    const queryLog = [];
    const childId = new ObjectId();
    const otherChildId = new ObjectId();
    const activityAId = new ObjectId();
    const activityBId = new ObjectId();
    const unrelatedActivityId = new ObjectId();
    const sessionId = new ObjectId();
    const recommendationId = new ObjectId();
    const fakeDb = createFakeDb({
        queryLog,
        collections: {
            bookings: [
                {
                    _id: new ObjectId(),
                    bookingDetails: {
                        childId,
                        activityId: activityAId,
                        sessionId,
                        status: "Confirmed",
                        bookedAt: new Date("2026-09-01T10:00:00.000Z")
                    },
                    attendance: {
                        status: "CheckedOut",
                        checkedInAt: new Date("2026-09-02T10:00:00.000Z"),
                        checkedOutAt: new Date("2026-09-02T11:00:00.000Z")
                    },
                    payment: {
                        amount: 999
                    }
                },
                {
                    _id: new ObjectId(),
                    bookingDetails: {
                        childId: otherChildId,
                        activityId: activityAId,
                        status: "Confirmed"
                    },
                    payment: {
                        amount: 111
                    }
                },
                {
                    _id: new ObjectId(),
                    bookingDetails: {
                        childId,
                        activityId: unrelatedActivityId,
                        status: "Confirmed"
                    }
                }
            ],
            recommendations: [
                {
                    _id: recommendationId,
                    childId,
                    recommendationContext: {
                        requestedAt: new Date("2026-09-01T09:00:00.000Z")
                    },
                    recommendedItems: [
                        {
                            activityId: activityAId,
                            score: 0.99
                        },
                        {
                            activityId: activityBId
                        }
                    ],
                    response: {
                        wasDisplayed: false,
                        displayedAt: null,
                        clickedActivityIds: [],
                        savedActivityIds: [activityBId],
                        bookedSessionIds: [sessionId],
                        dismissedActivityIds: [],
                        lastResponseAt: null
                    },
                    internalRanking: {
                        finalScore: 0.99
                    }
                },
                {
                    _id: new ObjectId(),
                    childId: otherChildId,
                    recommendedItems: [
                        {
                            activityId: activityAId
                        }
                    ],
                    response: {
                        wasDisplayed: true
                    }
                },
                {
                    _id: new ObjectId(),
                    childId,
                    recommendedItems: [
                        {
                            activityId: unrelatedActivityId
                        }
                    ],
                    response: {
                        wasDisplayed: true
                    }
                }
            ]
        }
    });
    const mongodbConfig = require("../config/mongodb");
    mongodbConfig.getDatabase = () => fakeDb;
    delete require.cache[
        require.resolve("../recommendation/recommendationDataService")
    ];
    const recommendationDataService =
        require("../recommendation/recommendationDataService");

    const bookingHistory =
        await recommendationDataService.getExplorationBookingHistory(
            childId,
            [
                activityAId,
                activityAId,
                String(activityBId),
                null,
                "not-an-object-id"
            ]
        );
    const recommendationHistory =
        await recommendationDataService.getExplorationRecommendationHistory(
            childId,
            [
                activityAId,
                String(activityBId),
                activityBId
            ]
        );

    assert.strictEqual(bookingHistory.source, "available");
    assert.strictEqual(recommendationHistory.source, "available");
    assert.strictEqual(bookingHistory.bookings.length, 1);
    assert.strictEqual(recommendationHistory.recommendations.length, 1);
    assert.strictEqual(queryLog.length, 2);
    assert.strictEqual(queryLog[0].collectionName, "bookings");
    assert.strictEqual(queryLog[1].collectionName, "recommendations");
    assert.strictEqual(
        queryLog[0].query["bookingDetails.activityId"].$in.length,
        2
    );
    assert.strictEqual(
        queryLog[1].query["recommendedItems.activityId"].$in.length,
        2
    );

    const booking = bookingHistory.bookings[0];
    assert.strictEqual(booking.bookingDetails.status, "Confirmed");
    assert.strictEqual(booking.attendance.status, "CheckedOut");
    assert(booking.attendance.checkedInAt, "checkedInAt must be preserved");
    assert(booking.attendance.checkedOutAt, "checkedOutAt must be preserved");
    assert(
        !Object.prototype.hasOwnProperty.call(booking, "payment"),
        "payment must not leak into booking history context"
    );

    const recommendation = recommendationHistory.recommendations[0];
    assert.strictEqual(recommendation.response.wasDisplayed, false);
    assert(
        !Object.prototype.hasOwnProperty.call(recommendation, "internalRanking"),
        "ranking data must not leak into recommendation history context"
    );
    assert(
        !Object.prototype.hasOwnProperty.call(
            recommendation.recommendedItems[0],
            "score"
        ),
        "recommended item scores must not leak into history context"
    );
}

async function testUnavailableSources() {
    const queryLog = [];
    const childId = new ObjectId();
    const activityId = new ObjectId();
    const fakeDb = createFakeDb({
        queryLog,
        collections: {}
    });
    const mongodbConfig = require("../config/mongodb");
    mongodbConfig.getDatabase = () => fakeDb;
    delete require.cache[
        require.resolve("../recommendation/recommendationDataService")
    ];
    const recommendationDataService =
        require("../recommendation/recommendationDataService");

    const bookings =
        await recommendationDataService.getExplorationBookingHistory(
            childId,
            [activityId]
        );
    const recommendations =
        await recommendationDataService.getExplorationRecommendationHistory(
            childId,
            [activityId]
        );

    assert.strictEqual(bookings.source, "unavailable");
    assert.deepStrictEqual(bookings.bookings, []);
    assert.strictEqual(recommendations.source, "unavailable");
    assert.deepStrictEqual(recommendations.recommendations, []);
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
            wasDisplayed: false
        }
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
            evidence: {
                interests: [],
                goals: [],
                summary: []
            }
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
    let bookingInputIds = null;
    let recommendationInputIds = null;

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
    recommendationDataService.getExplorationBookingHistory =
        async (receivedChildId, activityIds) => {
            bookingLoadCount += 1;
            assert(sameId(receivedChildId, childId));
            bookingInputIds = activityIds;

            return {
                source: "available",
                bookings: [bookingDocument]
            };
        };
    recommendationDataService.getExplorationRecommendationHistory =
        async (receivedChildId, activityIds) => {
            recommendationLoadCount += 1;
            assert(sameId(receivedChildId, childId));
            recommendationInputIds = activityIds;

            return {
                source: "available",
                recommendations: [recommendationDocument]
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

    assert(context.historyContext, "historyContext is required");
    assert.deepStrictEqual(context.historyContext.bookings, [bookingDocument]);
    assert.deepStrictEqual(
        context.historyContext.recommendations,
        [recommendationDocument]
    );
    assert.deepStrictEqual(context.historyContext.sources, {
        bookings: "available",
        recommendations: "available"
    });
    assert.strictEqual(bookingLoadCount, 1);
    assert.strictEqual(recommendationLoadCount, 1);
    assert.strictEqual(bookingInputIds.length, 2);
    assert.strictEqual(recommendationInputIds.length, 2);
    assert(
        bookingInputIds.some((activityId) => sameId(activityId, activityAId)),
        "Activity A must be requested"
    );
    assert(
        bookingInputIds.some((activityId) => sameId(activityId, activityBId)),
        "Activity B must be requested"
    );
    assert(
        !Object.prototype.hasOwnProperty.call(context.historyContext, "score"),
        "historyContext must not include score"
    );
    assert(
        !Object.prototype.hasOwnProperty.call(context.historyContext, "novelty"),
        "historyContext must not include novelty"
    );
    assert.deepStrictEqual(clone(context), contextSnapshot);
}

async function main() {
    await testDataServiceLoaders();
    await testUnavailableSources();
    await testContextComposition();

    console.log("Exploration history context controlled tests: PASSED");
}

main().catch((error) => {
    console.error("Exploration history context controlled tests FAILED");
    console.error(error);
    process.exit(1);
});
