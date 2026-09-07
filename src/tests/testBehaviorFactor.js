const assert = require("assert");
const { ObjectId } = require("mongodb");
const {
    calculateBehaviorFactor
} = require("../recommendation/behaviorFactorService");

function assertClose(label, actual, expected, tolerance = 1e-9) {
    assert(
        typeof actual === "number" &&
        Math.abs(actual - expected) <= tolerance,
        `${label}: expected ${expected}, found ${actual}`
    );
}

function snapshot(value) {
    if (value === undefined) {
        return undefined;
    }

    return JSON.parse(JSON.stringify(value));
}

function interaction({
    id = new ObjectId(),
    childId = "child_1",
    activityId = "activity_1",
    entityType = "Activity",
    interactionType = "Save",
    ratingValue = null,
    durationSeconds = 12,
    timestamp = "2026-09-01T10:00:00.000Z",
    actorType = "Child"
} = {}) {
    return {
        _id: id,
        actor: {
            childId,
            actorType
        },
        targetEntity: {
            entityType,
            entityId: activityId
        },
        interactionDetails: {
            interactionType,
            ratingValue,
            durationSeconds
        },
        context: {
            surface: "ActivityDetail",
            recommendationId: "recommendation_1",
            sessionId: "session_1"
        },
        timestamp
    };
}

function booking({
    childId = "child_1",
    activityId = "activity_1",
    attendanceStatus = "Attended"
} = {}) {
    return {
        _id: "booking_1",
        bookingDetails: {
            childId,
            activityId,
            sessionId: "session_1",
            status: "Confirmed",
            bookedAt: "2026-09-01T00:00:00.000Z"
        },
        attendance: {
            status: attendanceStatus
        }
    };
}

function recommendation({
    childId = "child_1",
    activityId = "activity_1",
    wasDisplayed = true
} = {}) {
    return {
        _id: "recommendation_1",
        childId,
        recommendedItems: [
            {
                activityId
            }
        ],
        response: {
            wasDisplayed
        }
    };
}

function makeContext({
    childId = "child_1",
    interactions = [
        interaction()
    ],
    interactionSource = "available",
    includeHistoryContext = true,
    bookings = [],
    recommendations = [],
    bookingSource = "available",
    recommendationSource = "available",
    interestContext = {
        childInterests: [],
        subcategories: []
    },
    goalContext = {
        goals: []
    },
    parentGoals = [],
    preferences = {
        environment: {
            value: "Indoor",
            confidenceScore: 1
        }
    },
    developmentProfile = []
} = {}) {
    const context = {
        child: {
            _id: childId,
            parentGoals,
            preferences,
            developmentProfile
        },
        interestContext,
        goalContext
    };

    if (includeHistoryContext) {
        context.historyContext = {
            bookings,
            recommendations,
            interactions,
            sources: {
                bookings: bookingSource,
                recommendations: recommendationSource,
                interactions: interactionSource
            }
        };
    }

    return context;
}

function makeEvaluation({
    activityId = "activity_1",
    currentActivityId = activityId,
    childId = "child_1",
    evidence = {
        interests: [],
        goals: [],
        summary: []
    },
    eligible = true
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
                classification: {
                    categoryId: "category_1",
                    subcategoryId: "subcategory_1"
                },
                experience: {
                    environment: "Indoor",
                    socialStyle: "Team",
                    difficulty: "Beginner",
                    experienceStyles: ["Structured"],
                    commitmentType: "Weekly"
                },
                learningOutcomes: [
                    {
                        outcomeId: "outcome_1"
                    }
                ]
            }
        },
        childId,
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
    const context = makeContext(contextOptions);
    const eligibilityEvaluation = makeEvaluation(evaluationOptions);
    const contextSnapshot = snapshot(context);
    const historyContextSnapshot = snapshot(context.historyContext);
    const candidateSnapshot = snapshot(eligibilityEvaluation.candidate);
    const currentActivitySnapshot =
        snapshot(eligibilityEvaluation.candidate.currentActivity);
    const d4EvidenceSnapshot = snapshot(eligibilityEvaluation.candidate.evidence);
    const evaluationSnapshot = snapshot(eligibilityEvaluation);
    const result = calculateBehaviorFactor(context, eligibilityEvaluation);

    assert.deepStrictEqual(snapshot(context), contextSnapshot);
    assert.deepStrictEqual(snapshot(context.historyContext), historyContextSnapshot);
    assert.deepStrictEqual(
        snapshot(eligibilityEvaluation.candidate),
        candidateSnapshot
    );
    assert.deepStrictEqual(
        snapshot(eligibilityEvaluation.candidate.currentActivity),
        currentActivitySnapshot
    );
    assert.deepStrictEqual(
        snapshot(eligibilityEvaluation.candidate.evidence),
        d4EvidenceSnapshot
    );
    assert.deepStrictEqual(snapshot(eligibilityEvaluation), evaluationSnapshot);

    return result;
}

function assertAvailable(result, expectedScore, expectedState, expectedType) {
    assert.strictEqual(result.factor, "behavior");
    assert.strictEqual(result.available, true);
    assertClose("Behavior score", result.score, expectedScore);
    assert.strictEqual(result.evidence.length, 1);
    assert.strictEqual(result.evidence[0].behaviorState, expectedState);
    assert.strictEqual(
        result.evidence[0].selectedInteractionType,
        expectedType
    );
    assertClose("Evidence score", result.evidence[0].score, expectedScore);
}

function assertUnavailable(result, expectedType = null) {
    assert.strictEqual(result.factor, "behavior");
    assert.strictEqual(result.available, false);
    assert.strictEqual(result.score, null);
    assert(Array.isArray(result.evidence));

    if (expectedType) {
        assert(
            result.evidence.some((item) => item.type === expectedType),
            `Expected unavailable evidence type ${expectedType}`
        );
    }
}

function testExplicitPositive() {
    for (const type of ["Save", "Book", "Attend", "Complete"]) {
        assertAvailable(
            calculate({
                interactions: [
                    interaction({ interactionType: type })
                ]
            }),
            1,
            "explicit_positive",
            type
        );
    }
}

function testExplicitNegative() {
    for (const type of ["Unsave", "Dismiss"]) {
        assertAvailable(
            calculate({
                interactions: [
                    interaction({ interactionType: type })
                ]
            }),
            0,
            "explicit_negative",
            type
        );
    }
}

function testRatings() {
    for (const [ratingValue, expectedScore] of [
        [1, 0],
        [2, 0.25],
        [3, 0.5],
        [4, 0.75],
        [5, 1]
    ]) {
        const result = calculate({
            interactions: [
                interaction({
                    interactionType: "Rate",
                    ratingValue
                })
            ]
        });

        assertAvailable(result, expectedScore, "rating", "Rate");
        assert.strictEqual(result.evidence[0].ratingValue, ratingValue);
    }
}

function testPassive() {
    assertAvailable(
        calculate({
            interactions: [
                interaction({ interactionType: "View" })
            ]
        }),
        0.5,
        "passive",
        "View"
    );
    assertAvailable(
        calculate({
            interactions: [
                interaction({ interactionType: "Click" })
            ]
        }),
        0.5,
        "passive",
        "Click"
    );
    assertAvailable(
        calculate({
            interactions: [
                interaction({
                    interactionType: "View",
                    timestamp: "2026-09-01T10:00:00.000Z"
                }),
                interaction({
                    interactionType: "Click",
                    timestamp: "2026-09-01T11:00:00.000Z"
                })
            ]
        }),
        0.5,
        "passive",
        "Click"
    );
}

function testExplicitPrecedenceAndLatestState() {
    assertAvailable(
        calculate({
            interactions: [
                interaction({
                    interactionType: "Save",
                    timestamp: "2026-09-01T10:00:00.000Z"
                }),
                interaction({
                    interactionType: "View",
                    timestamp: "2026-09-02T10:00:00.000Z"
                })
            ]
        }),
        1,
        "explicit_positive",
        "Save"
    );
    assertAvailable(
        calculate({
            interactions: [
                interaction({
                    interactionType: "Save",
                    timestamp: "2026-09-01T10:00:00.000Z"
                }),
                interaction({
                    interactionType: "Dismiss",
                    timestamp: "2026-09-02T10:00:00.000Z"
                })
            ]
        }),
        0,
        "explicit_negative",
        "Dismiss"
    );
    assertAvailable(
        calculate({
            interactions: [
                interaction({
                    interactionType: "Dismiss",
                    timestamp: "2026-09-01T10:00:00.000Z"
                }),
                interaction({
                    interactionType: "Save",
                    timestamp: "2026-09-02T10:00:00.000Z"
                })
            ]
        }),
        1,
        "explicit_positive",
        "Save"
    );
    assertAvailable(
        calculate({
            interactions: [
                interaction({
                    interactionType: "Save",
                    timestamp: "2026-09-01T10:00:00.000Z"
                }),
                interaction({
                    interactionType: "Rate",
                    ratingValue: 4,
                    timestamp: "2026-09-02T10:00:00.000Z"
                })
            ]
        }),
        0.75,
        "rating",
        "Rate"
    );
    assertAvailable(
        calculate({
            interactions: [
                interaction({
                    interactionType: "Click",
                    timestamp: "2026-09-01T10:00:00.000Z"
                }),
                interaction({
                    interactionType: "Save",
                    timestamp: "2026-09-02T10:00:00.000Z"
                })
            ]
        }),
        1,
        "explicit_positive",
        "Save"
    );
}

function testFrequencyIndependence() {
    assertAvailable(
        calculate({
            interactions: [
                interaction({
                    interactionType: "Click",
                    timestamp: "2026-09-01T10:00:00.000Z"
                }),
                interaction({
                    interactionType: "Click",
                    timestamp: "2026-09-02T10:00:00.000Z"
                }),
                interaction({
                    interactionType: "Click",
                    timestamp: "2026-09-03T10:00:00.000Z"
                })
            ]
        }),
        0.5,
        "passive",
        "Click"
    );
    assertAvailable(
        calculate({
            interactions: [
                interaction({
                    interactionType: "Save",
                    timestamp: "2026-09-01T10:00:00.000Z"
                }),
                interaction({
                    interactionType: "Save",
                    timestamp: "2026-09-02T10:00:00.000Z"
                }),
                interaction({
                    interactionType: "Save",
                    timestamp: "2026-09-03T10:00:00.000Z"
                })
            ]
        }),
        1,
        "explicit_positive",
        "Save"
    );
}

function testRecencyValueIndependence() {
    const oldResult = calculate({
        interactions: [
            interaction({
                interactionType: "Dismiss",
                timestamp: "2025-01-01T10:00:00.000Z"
            }),
            interaction({
                interactionType: "Save",
                timestamp: "2025-01-02T10:00:00.000Z"
            })
        ]
    });
    const newResult = calculate({
        interactions: [
            interaction({
                interactionType: "Dismiss",
                timestamp: "2026-09-01T10:00:00.000Z"
            }),
            interaction({
                interactionType: "Save",
                timestamp: "2026-09-02T10:00:00.000Z"
            })
        ]
    });

    assert.strictEqual(newResult.score, oldResult.score);
}

function testUnavailableInputs() {
    assertUnavailable(
        calculate({ interactionSource: "unavailable" }),
        "interaction_source_unavailable"
    );
    assertUnavailable(
        calculate({
            includeHistoryContext: false
        }),
        "missing_history_context"
    );
    assertUnavailable(
        calculate({
            interactions: null
        }),
        "malformed_history"
    );
    assertUnavailable(
        calculate({
            interactions: []
        }),
        "no_behavior_history"
    );
}

function testExactActivityFiltering() {
    assertUnavailable(
        calculate({
            interactions: [
                interaction({ childId: "other_child" })
            ]
        }),
        "no_exact_activity_behavior"
    );
    assertUnavailable(
        calculate({
            interactions: [
                interaction({ activityId: "other_activity" })
            ]
        }),
        "no_exact_activity_behavior"
    );
    assertUnavailable(
        calculate({
            interactions: [
                interaction({
                    entityType: "Subcategory",
                    activityId: "subcategory_1"
                }),
                interaction({
                    entityType: "Category",
                    activityId: "category_1"
                })
            ]
        }),
        "no_exact_activity_behavior"
    );
}

function testIgnoredTypesOnly() {
    assertUnavailable(
        calculate({
            interactions: [
                interaction({ interactionType: "QuestionAnswered" }),
                interaction({ interactionType: "QuestionSkipped" }),
                interaction({ interactionType: "FeedbackSubmitted" })
            ]
        }),
        "no_exact_activity_behavior"
    );
}

function testInvalidRating() {
    for (const ratingValue of [0, 6, null, "5", NaN]) {
        assertUnavailable(
            calculate({
                interactions: [
                    interaction({
                        interactionType: "Save",
                        timestamp: "2026-09-01T10:00:00.000Z"
                    }),
                    interaction({
                        interactionType: "Rate",
                        ratingValue,
                        timestamp: "2026-09-02T10:00:00.000Z"
                    })
                ]
            }),
            "invalid_rating"
        );
    }
}

function testMalformedTimestamp() {
    assertUnavailable(
        calculate({
            interactions: [
                interaction({
                    interactionType: "Save",
                    timestamp: null
                })
            ]
        }),
        "malformed_history"
    );
    assertUnavailable(
        calculate({
            interactions: [
                interaction({
                    interactionType: "Save",
                    timestamp: "2026-09-01T10:00:00.000Z"
                }),
                interaction({
                    interactionType: "Dismiss",
                    timestamp: "not-a-date"
                })
            ]
        }),
        "malformed_history"
    );
}

function testSameTimestampRules() {
    const sameTimestamp = "2026-09-01T10:00:00.000Z";

    assertAvailable(
        calculate({
            interactions: [
                interaction({
                    interactionType: "Save",
                    timestamp: sameTimestamp
                }),
                interaction({
                    interactionType: "Attend",
                    timestamp: sameTimestamp
                })
            ]
        }),
        1,
        "explicit_positive",
        "Save"
    );
    assertUnavailable(
        calculate({
            interactions: [
                interaction({
                    interactionType: "Save",
                    timestamp: sameTimestamp
                }),
                interaction({
                    interactionType: "Dismiss",
                    timestamp: sameTimestamp
                })
            ]
        }),
        "ambiguous_latest_behavior"
    );
    assertAvailable(
        calculate({
            interactions: [
                interaction({
                    interactionType: "View",
                    timestamp: sameTimestamp
                }),
                interaction({
                    interactionType: "Click",
                    timestamp: sameTimestamp
                })
            ]
        }),
        0.5,
        "passive",
        "View"
    );
}

function testActorTypeIndependence() {
    const parentActor = calculate({
        interactions: [
            interaction({
                actorType: "Parent"
            })
        ]
    });
    const childActor = calculate({
        interactions: [
            interaction({
                actorType: "Child"
            })
        ]
    });

    assert.strictEqual(parentActor.score, childActor.score);
    assert.strictEqual(parentActor.evidence[0].actorType, "Parent");
    assert.strictEqual(childActor.evidence[0].actorType, "Child");
}

function testFactorIndependence() {
    const baseline = calculate({
        interactions: [
            interaction({
                interactionType: "Save"
            })
        ]
    });

    assert.strictEqual(
        calculate({
            interactions: [
                interaction({
                    interactionType: "Save"
                })
            ],
            bookings: [
                booking()
            ],
            recommendations: [
                recommendation()
            ],
            bookingSource: "unavailable",
            recommendationSource: "unavailable"
        }).score,
        baseline.score
    );
    assert.strictEqual(
        calculate({
            interactions: [
                interaction({
                    interactionType: "Save"
                })
            ],
            interestContext: {
                childInterests: [
                    {
                        interestScore: {
                            currentScore: 0
                        }
                    }
                ],
                subcategories: []
            }
        }).score,
        baseline.score
    );
    assert.strictEqual(
        calculate({
            interactions: [
                interaction({
                    interactionType: "Save"
                })
            ],
            preferences: {
                environment: {
                    value: "Outdoor",
                    confidenceScore: 0
                },
                socialStyle: {
                    value: "Solo",
                    confidenceScore: 1
                }
            }
        }).score,
        baseline.score
    );
    assert.strictEqual(
        calculate({
            interactions: [
                interaction({
                    interactionType: "Save"
                })
            ],
            goalContext: {
                goals: [
                    {
                        _id: "goal_1",
                        relatedOutcomes: []
                    }
                ]
            },
            parentGoals: [
                {
                    goalId: "goal_1",
                    status: "Active"
                }
            ]
        }).score,
        baseline.score
    );
    assert.strictEqual(
        calculate(
            {
                interactions: [
                    interaction({
                        interactionType: "Save"
                    })
                ],
                developmentProfile: [
                    {
                        outcomeId: "outcome_1",
                        score: 0
                    }
                ]
            },
            {
                evidence: {
                    interests: [
                        {
                            score: 0
                        }
                    ],
                    goals: [
                        {
                            score: 0
                        }
                    ],
                    summary: ["changed"]
                }
            }
        ).score,
        baseline.score
    );
}

function testUnsupportedLatestBehavior() {
    assertUnavailable(
        calculate({
            interactions: [
                interaction({
                    interactionType: "Save",
                    timestamp: "2026-09-01T10:00:00.000Z"
                }),
                interaction({
                    interactionType: "Share",
                    timestamp: "2026-09-02T10:00:00.000Z"
                })
            ]
        }),
        "unsupported_latest_behavior"
    );
    assertAvailable(
        calculate({
            interactions: [
                interaction({
                    interactionType: "Share",
                    timestamp: "2026-09-01T10:00:00.000Z"
                }),
                interaction({
                    interactionType: "Save",
                    timestamp: "2026-09-02T10:00:00.000Z"
                })
            ]
        }),
        1,
        "explicit_positive",
        "Save"
    );
}

function testEvidenceCorrectness() {
    const selectedId = new ObjectId();
    const selectedTimestamp = "2026-09-02T10:00:00.000Z";
    const result = calculate({
        interactions: [
            interaction({
                interactionType: "View",
                timestamp: "2026-09-01T09:00:00.000Z"
            }),
            interaction({
                id: selectedId,
                interactionType: "Rate",
                ratingValue: 4,
                actorType: "Child",
                timestamp: selectedTimestamp
            }),
            interaction({
                interactionType: "Save",
                timestamp: "2026-09-01T10:00:00.000Z"
            })
        ]
    });
    const evidence = result.evidence[0];

    assert.strictEqual(evidence.type, "exact_activity_behavior");
    assert.strictEqual(evidence.activityId, "activity_1");
    assert.strictEqual(evidence.behaviorState, "rating");
    assert.strictEqual(evidence.selectedInteractionType, "Rate");
    assert.strictEqual(evidence.selectedInteractionId, String(selectedId));
    assert.strictEqual(evidence.selectedTimestamp, selectedTimestamp);
    assert.strictEqual(evidence.actorType, "Child");
    assert.strictEqual(evidence.ratingValue, 4);
    assertClose("Evidence score", evidence.score, 0.75);
    assert.strictEqual(evidence.matchingInteractionCount, 3);
    assert.strictEqual(evidence.explicitInteractionCount, 2);
    assert.strictEqual(evidence.passiveInteractionCount, 1);
    assert(
        !Object.prototype.hasOwnProperty.call(evidence, "eventMetadata")
    );
}

function main() {
    testExplicitPositive();
    testExplicitNegative();
    testRatings();
    testPassive();
    testExplicitPrecedenceAndLatestState();
    testFrequencyIndependence();
    testRecencyValueIndependence();
    testUnavailableInputs();
    testExactActivityFiltering();
    testIgnoredTypesOnly();
    testInvalidRating();
    testMalformedTimestamp();
    testSameTimestampRules();
    testActorTypeIndependence();
    testFactorIndependence();
    testUnsupportedLatestBehavior();
    testEvidenceCorrectness();

    console.log("Behavior factor unit tests: PASSED");
}

main();
