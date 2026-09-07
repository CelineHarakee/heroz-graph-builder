const assert = require("assert");
const { ObjectId } = require("mongodb");
const {
    calculateSessionFactor
} = require("../recommendation/sessionFactorService");

function snapshot(value) {
    if (value === undefined) {
        return undefined;
    }

    return JSON.parse(JSON.stringify(value));
}

function assertClose(label, actual, expected, tolerance = 1e-9) {
    assert(
        typeof actual === "number" &&
        Math.abs(actual - expected) <= tolerance,
        `${label}: expected ${expected}, found ${actual}`
    );
}

function session({
    id = new ObjectId(),
    startDateTime = new Date("2026-09-07T10:00:00.000Z"),
    timezone = "UTC",
    remainingCapacity = 4,
    bookingDeadline = new Date("2026-09-01T10:00:00.000Z")
} = {}) {
    return {
        _id: id,
        schedule: {
            startDateTime,
            timezone,
            bookingDeadline
        },
        capacity: {
            totalCapacity: 10,
            bookedCapacity: 6,
            remainingCapacity
        },
        availability: {
            status: "Available",
            registrationOpen: true
        }
    };
}

function makeContext({
    parent = {
        recommendationPreferences: {
            preferredDays: ["Monday"]
        }
    },
    child = {
        preferences: {
            environment: { value: "Indoor" },
            socialStyle: { value: "Team" },
            difficulty: { value: "Beginner" },
            experienceStyle: { value: "Structured" },
            commitmentPreference: { value: "Weekly" }
        }
    },
    interestContext = { childInterests: [] },
    goalContext = { goals: [] },
    historyContext = {
        bookings: [],
        recommendations: [],
        interactions: []
    }
} = {}) {
    return {
        parent,
        child,
        interestContext,
        goalContext,
        historyContext
    };
}

function makeEvaluation(options = {}) {
    const eligibleSessions = Object.prototype.hasOwnProperty.call(
        options,
        "eligibleSessions"
    )
        ? options.eligibleSessions
        : [
            session()
        ];
    const {
    eligible = true,
    evidence = {
        interests: [],
        goals: [],
        summary: []
    }
    } = options;

    return {
        candidate: {
            activity: {
                activityId: "activity_1",
                title: "Activity 1"
            },
            currentActivity: {
                _id: "activity_1",
                experience: {
                    environment: "Indoor",
                    socialStyle: "Team",
                    difficulty: "Beginner",
                    experienceStyles: ["Structured"],
                    commitmentType: "Weekly"
                }
            },
            evidence
        },
        eligibility: {
            eligible,
            failedConstraints: []
        },
        eligibleSessions,
        sessionEvaluations: [],
        missingInformation: []
    };
}

function calculate(contextOptions = {}, evaluationOptions = {}) {
    const context = makeContext(contextOptions);
    const evaluation = makeEvaluation(evaluationOptions);
    const contextSnapshot = snapshot(context);
    const evaluationSnapshot = snapshot(evaluation);
    const eligibleSessionsSnapshot = snapshot(evaluation.eligibleSessions);
    const candidateSnapshot = snapshot(evaluation.candidate);

    const result = calculateSessionFactor(evaluation, context);

    assert.deepStrictEqual(snapshot(context), contextSnapshot);
    assert.deepStrictEqual(snapshot(evaluation), evaluationSnapshot);
    assert.deepStrictEqual(
        snapshot(evaluation.eligibleSessions),
        eligibleSessionsSnapshot
    );
    assert.deepStrictEqual(snapshot(evaluation.candidate), candidateSnapshot);

    return result;
}

function assertAvailable(result, expectedScore) {
    assert.strictEqual(result.factor, "session");
    assert.strictEqual(result.available, true);
    assertClose("Session score", result.score, expectedScore);
    assert.strictEqual(result.evidence.length, 1);
    assertClose("Evidence score", result.evidence[0].score, expectedScore);
}

function assertUnavailable(result, expectedType) {
    assert.strictEqual(result.factor, "session");
    assert.strictEqual(result.available, false);
    assert.strictEqual(result.score, null);
    assert(Array.isArray(result.evidence));
    assert(
        result.evidence.some((item) => item.type === expectedType),
        `Expected unavailable evidence type ${expectedType}`
    );
}

function testSingleMatchAndNonMatch() {
    assertAvailable(calculate(), 1);
    assertAvailable(
        calculate({}, {
            eligibleSessions: [
                session({
                    startDateTime: new Date("2026-09-08T10:00:00.000Z")
                })
            ]
        }),
        0
    );
}

function testMultipleSessions() {
    assertAvailable(
        calculate({}, {
            eligibleSessions: [
                session({
                    startDateTime: new Date("2026-09-08T10:00:00.000Z")
                }),
                session({
                    startDateTime: new Date("2026-09-09T10:00:00.000Z")
                }),
                session({
                    startDateTime: new Date("2026-09-07T10:00:00.000Z")
                })
            ]
        }),
        1
    );
    assertAvailable(
        calculate({}, {
            eligibleSessions: [
                session({
                    startDateTime: new Date("2026-09-08T10:00:00.000Z")
                }),
                session({
                    startDateTime: new Date("2026-09-09T10:00:00.000Z")
                })
            ]
        }),
        0
    );
}

function testMultiplePreferredDays() {
    assertAvailable(
        calculate({
            parent: {
                recommendationPreferences: {
                    preferredDays: ["Tuesday", "Thursday"]
                }
            }
        }, {
            eligibleSessions: [
                session({
                    startDateTime: new Date("2026-09-08T10:00:00.000Z")
                })
            ]
        }),
        1
    );
}

function testNoPreference() {
    assertUnavailable(
        calculate({
            parent: {
                recommendationPreferences: {
                    preferredDays: []
                }
            }
        }),
        "no_preferred_days"
    );
    assertUnavailable(
        calculate({
            parent: {
                recommendationPreferences: {}
            }
        }),
        "no_preferred_days"
    );
    assertUnavailable(
        calculate({
            parent: {
                recommendationPreferences: {
                    preferredDays: null
                }
            }
        }),
        "no_preferred_days"
    );
    assertUnavailable(
        calculate({
            parent: {}
        }),
        "no_preferred_days"
    );
}

function testNormalizationAndMalformedPreferences() {
    assertAvailable(
        calculate({
            parent: {
                recommendationPreferences: {
                    preferredDays: ["monday"]
                }
            }
        }),
        1
    );
    assertAvailable(
        calculate({
            parent: {
                recommendationPreferences: {
                    preferredDays: [" Monday "]
                }
            }
        }),
        1
    );
    const duplicate = calculate({
        parent: {
            recommendationPreferences: {
                preferredDays: ["Monday", "monday"]
            }
        }
    });
    assertAvailable(duplicate, 1);
    assert.deepStrictEqual(duplicate.evidence[0].preferredDays, ["Monday"]);
    assertUnavailable(
        calculate({
            parent: {
                recommendationPreferences: {
                    preferredDays: "Monday"
                }
            }
        }),
        "malformed_preferred_days"
    );
    assertUnavailable(
        calculate({
            parent: {
                recommendationPreferences: {
                    preferredDays: ["Mon"]
                }
            }
        }),
        "malformed_preferred_days"
    );
    assertUnavailable(
        calculate({
            parent: {
                recommendationPreferences: {
                    preferredDays: ["Banana"]
                }
            }
        }),
        "malformed_preferred_days"
    );
    assertUnavailable(
        calculate({
            parent: {
                recommendationPreferences: {
                    preferredDays: ["Monday", "Banana"]
                }
            }
        }),
        "malformed_preferred_days"
    );
    assertUnavailable(
        calculate({
            parent: {
                recommendationPreferences: {
                    preferredDays: ["Monday", 2]
                }
            }
        }),
        "malformed_preferred_days"
    );
}

function testEligibleSessionAvailability() {
    assertUnavailable(
        calculate({}, {
            eligibleSessions: undefined
        }),
        "missing_eligible_sessions"
    );
    assertUnavailable(
        calculate({}, {
            eligibleSessions: "session"
        }),
        "missing_eligible_sessions"
    );
    assertUnavailable(
        calculate({}, {
            eligibleSessions: []
        }),
        "missing_eligible_sessions"
    );
}

function testLocalTimezoneAndMalformedSession() {
    assertAvailable(
        calculate({
            parent: {
                recommendationPreferences: {
                    preferredDays: ["Tuesday"]
                }
            }
        }, {
            eligibleSessions: [
                session({
                    startDateTime: new Date("2026-09-07T22:30:00.000Z"),
                    timezone: "Asia/Riyadh"
                })
            ]
        }),
        1
    );
    assertUnavailable(
        calculate({}, {
            eligibleSessions: [
                session({
                    startDateTime: "2026-09-07T10:00:00.000Z"
                })
            ]
        }),
        "malformed_eligible_session"
    );
    assertUnavailable(
        calculate({}, {
            eligibleSessions: [
                session({
                    timezone: "Not/AZone"
                })
            ]
        }),
        "malformed_eligible_session"
    );
}

function testNonInflationAndIndependence() {
    assertAvailable(
        calculate({}, {
            eligibleSessions: [
                session({ id: "session_1" }),
                session({ id: "session_2" }),
                session({ id: "session_3" })
            ]
        }),
        1
    );
    assertAvailable(
        calculate({}, {
            eligibleSessions: [
                session({
                    startDateTime: new Date("2026-09-08T10:00:00.000Z")
                }),
                session({
                    startDateTime: new Date("2026-09-09T10:00:00.000Z")
                }),
                session({
                    startDateTime: new Date("2026-09-10T10:00:00.000Z")
                })
            ]
        }),
        0
    );

    const baseline = calculate();
    const changedCapacity = calculate({}, {
        eligibleSessions: [
            session({
                remainingCapacity: 99
            })
        ]
    });
    const changedDeadline = calculate({}, {
        eligibleSessions: [
            session({
                bookingDeadline: new Date("2026-09-06T10:00:00.000Z")
            })
        ]
    });
    const changedProximity = calculate({}, {
        eligibleSessions: [
            session({
                startDateTime: new Date("2026-09-14T10:00:00.000Z")
            })
        ]
    });
    const changedPreferenceData = calculate({
        child: {
            preferences: {
                environment: { value: "Outdoor" },
                socialStyle: { value: "Solo" },
                difficulty: { value: "Advanced" },
                experienceStyle: { value: "Open" },
                commitmentPreference: { value: "DropIn" }
            }
        }
    });
    const changedInterest = calculate({
        interestContext: {
            childInterests: [
                {
                    interestScore: 0
                }
            ]
        }
    });
    const changedGoal = calculate({
        goalContext: {
            goals: [
                {
                    _id: "goal_1"
                }
            ]
        }
    });
    const changedExploration = calculate({
        historyContext: {
            bookings: [
                {
                    _id: "booking_1"
                }
            ],
            recommendations: [
                {
                    _id: "recommendation_1"
                }
            ],
            interactions: []
        }
    });
    const changedBehavior = calculate({
        historyContext: {
            bookings: [],
            recommendations: [],
            interactions: [
                {
                    _id: "interaction_1"
                }
            ]
        }
    });
    const changedD4 = calculate({}, {
        evidence: {
            interests: [
                {
                    name: "Robotics"
                }
            ],
            goals: [],
            summary: []
        }
    });

    for (const result of [
        changedCapacity,
        changedDeadline,
        changedProximity,
        changedPreferenceData,
        changedInterest,
        changedGoal,
        changedExploration,
        changedBehavior,
        changedD4
    ]) {
        assert.strictEqual(result.available, baseline.available);
        assert.strictEqual(result.score, baseline.score);
    }
}

function testEvidenceCorrectness() {
    const mondaySession = session({
        id: "session_monday",
        startDateTime: new Date("2026-09-07T10:00:00.000Z")
    });
    const tuesdaySession = session({
        id: "session_tuesday",
        startDateTime: new Date("2026-09-08T10:00:00.000Z")
    });
    const result = calculate({}, {
        eligibleSessions: [
            mondaySession,
            tuesdaySession
        ]
    });

    assertAvailable(result, 1);
    assert.deepStrictEqual(result.evidence[0].preferredDays, ["Monday"]);
    assert.strictEqual(result.evidence[0].eligibleSessionCount, 2);
    assert.deepStrictEqual(
        result.evidence[0].matchingSessionIds,
        ["session_monday"]
    );
    assert.deepStrictEqual(result.evidence[0].matchingWeekdays, ["Monday"]);
    assert.deepStrictEqual(result.evidence[0].checkedSessions, [
        {
            sessionId: "session_monday",
            weekday: "Monday"
        },
        {
            sessionId: "session_tuesday",
            weekday: "Tuesday"
        }
    ]);
}

function testIneligibleEvaluationGuard() {
    assert.throws(
        () => calculate({}, {
            eligible: false
        }),
        /eligible candidate evaluation/
    );
}

function main() {
    testSingleMatchAndNonMatch();
    testMultipleSessions();
    testMultiplePreferredDays();
    testNoPreference();
    testNormalizationAndMalformedPreferences();
    testEligibleSessionAvailability();
    testLocalTimezoneAndMalformedSession();
    testNonInflationAndIndependence();
    testEvidenceCorrectness();
    testIneligibleEvaluationGuard();

    console.log("Session Factor: PASSED");
}

main();
