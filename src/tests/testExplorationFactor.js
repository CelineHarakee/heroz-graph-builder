const assert = require("assert");
const { ObjectId } = require("mongodb");
const {
    calculateExplorationFactor
} = require("../recommendation/explorationFactorService");

function assertClose(label, actual, expected, tolerance = 1e-9) {
    assert(
        typeof actual === "number" &&
        Math.abs(actual - expected) <= tolerance,
        `${label}: expected ${expected}, found ${actual}`
    );
}

function snapshot(value) {
    return JSON.parse(JSON.stringify(value));
}

function booking({
    childId = "child_1",
    activityId = "activity_1",
    status = "Confirmed",
    attendanceStatus = null,
    bookedAt = "2026-01-01T00:00:00.000Z"
} = {}) {
    const document = {
        _id: `booking_${Math.random()}`,
        bookingDetails: {
            childId,
            activityId,
            sessionId: "session_1",
            status,
            bookedAt
        },
        attendance: {}
    };

    if (attendanceStatus !== null) {
        document.attendance.status = attendanceStatus;
    }

    return document;
}

function recommendation({
    childId = "child_1",
    activityId = "activity_1",
    wasDisplayed = true,
    requestedAt = "2026-01-01T00:00:00.000Z",
    clickedActivityIds = [],
    savedActivityIds = [],
    dismissedActivityIds = []
} = {}) {
    return {
        _id: `recommendation_${Math.random()}`,
        childId,
        recommendationContext: {
            requestedAt
        },
        recommendedItems: [
            {
                activityId
            }
        ],
        response: {
            wasDisplayed,
            displayedAt: requestedAt,
            clickedActivityIds,
            savedActivityIds,
            bookedSessionIds: [],
            dismissedActivityIds,
            lastResponseAt: requestedAt
        }
    };
}

function makeContext({
    childId = "child_1",
    bookings = [],
    recommendations = [],
    bookingSource = "available",
    recommendationSource = "available",
    includeHistoryContext = true,
    interestContext = {
        childInterests: [],
        subcategories: []
    },
    goalContext = {
        goals: []
    },
    parentGoals = [],
    developmentProfile = []
} = {}) {
    const context = {
        child: {
            _id: childId,
            parentGoals,
            developmentProfile,
            preferences: {
                environment: {
                    value: "Indoor",
                    confidenceScore: 1
                }
            }
        },
        interestContext,
        goalContext
    };

    if (includeHistoryContext) {
        context.historyContext = {
            bookings,
            recommendations,
            sources: {
                bookings: bookingSource,
                recommendations: recommendationSource
            }
        };
    }

    return context;
}

function makeEvaluation({
    activityId = "activity_1",
    currentActivityId = activityId,
    evidence = {
        interests: [],
        goals: [],
        summary: []
    },
    eligible = true,
    preferences = {}
} = {}) {
    return {
        candidate: {
            activity: {
                activityId,
                title: "Activity 1"
            },
            evidence,
            currentActivity: {
                _id: currentActivityId,
                experience: preferences,
                learningOutcomes: []
            }
        },
        eligibility: {
            eligible,
            failedConstraints: []
        },
        eligibleSessions: [],
        sessionEvaluations: [],
        missingInformation: []
    };
}

function calculate(contextOptions = {}, evaluationOptions = {}) {
    return calculateExplorationFactor(
        makeContext(contextOptions),
        makeEvaluation(evaluationOptions)
    );
}

function assertAvailable(result, expectedScore, expectedState) {
    assert.strictEqual(result.factor, "exploration");
    assert.strictEqual(result.available, true);
    assertClose("Exploration score", result.score, expectedScore);
    assert.strictEqual(result.evidence.length, 1);
    assert.strictEqual(result.evidence[0].noveltyState, expectedState);
}

function assertUnavailable(result, expectedType = null) {
    assert.strictEqual(result.factor, "exploration");
    assert.strictEqual(result.available, false);
    assert.strictEqual(result.score, null);
    assert(Array.isArray(result.evidence), "evidence must be an Array");

    if (expectedType) {
        assert(
            result.evidence.some((item) => item.type === expectedType),
            `Expected evidence type ${expectedType}`
        );
    }
}

function testNew() {
    assertAvailable(calculate(), 1, "new");
}

function testDisplayedRecommendation() {
    assertAvailable(
        calculate({
            recommendations: [
                recommendation()
            ]
        }),
        0.5,
        "exposed"
    );
}

function testGeneratedNotDisplayed() {
    assertAvailable(
        calculate({
            recommendations: [
                recommendation({ wasDisplayed: false })
            ]
        }),
        1,
        "new"
    );
}

function testPreviousBookingNotAttended() {
    assertAvailable(
        calculate({
            bookings: [
                booking()
            ]
        }),
        0.5,
        "exposed"
    );
}

function testCancelledNoShowNotExperienced() {
    for (const attendanceStatus of ["Cancelled", "NoShow"]) {
        assertAvailable(
            calculate({
                bookings: [
                    booking({ attendanceStatus })
                ]
            }),
            0.5,
            "exposed"
        );
    }
}

function testAttended() {
    assertAvailable(
        calculate({
            bookings: [
                booking({ attendanceStatus: "Attended" })
            ]
        }),
        0,
        "experienced"
    );
}

function testExperiencePrecedence() {
    assertAvailable(
        calculate({
            bookings: [
                booking(),
                booking({ attendanceStatus: "Attended" })
            ],
            recommendations: [
                recommendation()
            ]
        }),
        0,
        "experienced"
    );
}

function testBookedAndDisplayed() {
    const result = calculate({
        bookings: [
            booking()
        ],
        recommendations: [
            recommendation()
        ]
    });

    assertAvailable(result, 0.5, "exposed");
    assert.strictEqual(result.evidence[0].matchingBookingCount, 1);
    assert.strictEqual(result.evidence[0].displayedRecommendationCount, 1);
}

function testMultipleExposuresFrequencyIndependence() {
    assertAvailable(
        calculate({
            recommendations: [
                recommendation(),
                recommendation({ requestedAt: "2026-02-01T00:00:00.000Z" }),
                recommendation({ requestedAt: "2026-03-01T00:00:00.000Z" })
            ]
        }),
        0.5,
        "exposed"
    );
}

function testMultipleBookingsFrequencyIndependence() {
    assertAvailable(
        calculate({
            bookings: [
                booking(),
                booking({ status: "Pending" }),
                booking({ status: "Cancelled" })
            ]
        }),
        0.5,
        "exposed"
    );
}

function testRecencyIndependence() {
    const oldResult = calculate({
        bookings: [
            booking({ bookedAt: "2025-01-01T00:00:00.000Z" })
        ],
        recommendations: [
            recommendation({ requestedAt: "2025-01-01T00:00:00.000Z" })
        ]
    });
    const recentResult = calculate({
        bookings: [
            booking({ bookedAt: "2026-09-01T00:00:00.000Z" })
        ],
        recommendations: [
            recommendation({ requestedAt: "2026-09-01T00:00:00.000Z" })
        ]
    });

    assertAvailable(oldResult, 0.5, "exposed");
    assertAvailable(recentResult, 0.5, "exposed");
    assert.strictEqual(oldResult.score, recentResult.score);
}

function testSourceUnavailable() {
    assertUnavailable(
        calculate({ bookingSource: "unavailable" }),
        "history_source_unavailable"
    );
    assertUnavailable(
        calculate({ recommendationSource: "unavailable" }),
        "history_source_unavailable"
    );
    assertUnavailable(
        calculate({
            bookingSource: "unavailable",
            recommendationSource: "unavailable"
        }),
        "history_source_unavailable"
    );
}

function testHistoryContextMissing() {
    assertUnavailable(
        calculate({ includeHistoryContext: false }),
        "missing_history_context"
    );
}

function testMalformedArrays() {
    assertUnavailable(
        calculate({ bookings: null }),
        "malformed_history"
    );
    assertUnavailable(
        calculate({ recommendations: null }),
        "malformed_history"
    );
}

function testDifferentChildActivityIsolation() {
    assertAvailable(
        calculate({
            bookings: [
                booking({ childId: "other_child" }),
                booking({ activityId: "other_activity" })
            ],
            recommendations: [
                recommendation({ childId: "other_child" }),
                recommendation({ activityId: "other_activity" })
            ]
        }),
        1,
        "new"
    );
}

function testDuplicateHistoryRecords() {
    assertAvailable(
        calculate({
            bookings: [
                booking(),
                booking()
            ],
            recommendations: [
                recommendation(),
                recommendation()
            ]
        }),
        0.5,
        "exposed"
    );
}

function testResponseBehaviorIndependence() {
    const first = calculate({
        recommendations: [
            recommendation({
                clickedActivityIds: ["activity_1"],
                savedActivityIds: ["activity_1"],
                dismissedActivityIds: []
            })
        ]
    });
    const second = calculate({
        recommendations: [
            recommendation({
                clickedActivityIds: [],
                savedActivityIds: [],
                dismissedActivityIds: ["activity_1"]
            })
        ]
    });

    assertAvailable(first, 0.5, "exposed");
    assertAvailable(second, 0.5, "exposed");
    assert.strictEqual(first.score, second.score);
}

function testInterestPreferenceGoalD4Independence() {
    const baseline = calculate();
    const changed = calculate(
        {
            interestContext: {
                childInterests: [
                    {
                        confidence: {
                            currentScore: 0
                        }
                    }
                ],
                subcategories: [
                    {
                        _id: "changed"
                    }
                ]
            },
            goalContext: {
                goals: [
                    {
                        _id: "changed"
                    }
                ]
            },
            parentGoals: [
                {
                    goalId: "changed",
                    status: "Active"
                }
            ]
        },
        {
            evidence: {
                interests: [
                    {
                        name: "Changed"
                    }
                ],
                goals: [
                    {
                        name: "Changed"
                    }
                ],
                summary: [
                    "Changed"
                ]
            },
            preferences: {
                environment: "Outdoor",
                socialStyle: "Team"
            }
        }
    );

    assertAvailable(baseline, 1, "new");
    assertAvailable(changed, 1, "new");
    assert.deepStrictEqual(changed, baseline);
}

function testMalformedDocuments() {
    assertUnavailable(
        calculate({
            bookings: [
                {
                    _id: "bad_booking"
                }
            ]
        }),
        "malformed_history_document"
    );
    assertUnavailable(
        calculate({
            recommendations: [
                {
                    _id: "bad_recommendation"
                }
            ]
        }),
        "malformed_history_document"
    );
    assertUnavailable(
        calculate({
            recommendations: [
                {
                    _id: "missing_display_state",
                    childId: "child_1",
                    recommendedItems: [
                        {
                            activityId: "activity_1"
                        }
                    ],
                    response: {}
                }
            ]
        }),
        "malformed_history_document"
    );
}

function testEvidenceCorrectness() {
    const result = calculate({
        bookings: [
            booking(),
            booking({ attendanceStatus: "Attended" }),
            booking({ activityId: "other_activity" })
        ],
        recommendations: [
            recommendation(),
            recommendation({ wasDisplayed: false }),
            recommendation({ activityId: "other_activity" })
        ]
    });

    assertAvailable(result, 0, "experienced");
    assert.deepStrictEqual(result.evidence[0], {
        type: "exact_activity_novelty",
        activityId: "activity_1",
        noveltyState: "experienced",
        matchingBookingCount: 2,
        displayedRecommendationCount: 1,
        experiencedBookingCount: 1
    });
}

function testInputImmutabilityAndEvidenceIsolation() {
    const context = makeContext({
        bookings: [
            booking()
        ],
        recommendations: [
            recommendation()
        ]
    });
    const evaluation = makeEvaluation();
    const contextSnapshot = snapshot(context);
    const evaluationSnapshot = snapshot(evaluation);
    const result = calculateExplorationFactor(context, evaluation);

    result.evidence.push({ type: "mutated" });
    result.evidence[0].activityId = "changed";

    assert.deepStrictEqual(snapshot(context), contextSnapshot);
    assert.deepStrictEqual(snapshot(evaluation), evaluationSnapshot);
    assert.strictEqual(context.historyContext.bookings.length, 1);
    assert.strictEqual(context.historyContext.recommendations.length, 1);
}

function testObjectIdMatching() {
    const childId = new ObjectId();
    const activityId = new ObjectId();
    const result = calculateExplorationFactor(
        makeContext({
            childId,
            bookings: [
                booking({
                    childId: String(childId),
                    activityId
                })
            ]
        }),
        makeEvaluation({
            activityId: String(activityId),
            currentActivityId: activityId
        })
    );

    assertAvailable(result, 0.5, "exposed");
    assert.strictEqual(result.evidence[0].activityId, String(activityId));
}

function testEligibilityGuards() {
    assert.throws(() =>
        calculateExplorationFactor(null, makeEvaluation())
    );
    assert.throws(() =>
        calculateExplorationFactor(makeContext(), null)
    );
    assert.throws(() =>
        calculateExplorationFactor(
            makeContext(),
            makeEvaluation({ eligible: false })
        )
    );
}

function main() {
    testNew();
    testDisplayedRecommendation();
    testGeneratedNotDisplayed();
    testPreviousBookingNotAttended();
    testCancelledNoShowNotExperienced();
    testAttended();
    testExperiencePrecedence();
    testBookedAndDisplayed();
    testMultipleExposuresFrequencyIndependence();
    testMultipleBookingsFrequencyIndependence();
    testRecencyIndependence();
    testSourceUnavailable();
    testHistoryContextMissing();
    testMalformedArrays();
    testDifferentChildActivityIsolation();
    testDuplicateHistoryRecords();
    testResponseBehaviorIndependence();
    testInterestPreferenceGoalD4Independence();
    testMalformedDocuments();
    testEvidenceCorrectness();
    testInputImmutabilityAndEvidenceIsolation();
    testObjectIdMatching();
    testEligibilityGuards();

    console.log("Exploration factor unit tests: PASSED");
}

main();
