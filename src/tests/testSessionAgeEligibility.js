const {
    ELIGIBILITY_SCOPES
} = require("../recommendation/eligibilityResult");
const {
    checkSessionAgeEligibility
} = require("../recommendation/sessionAgeEligibilityService");

function assert(condition, message) {
    if (!condition) {
        throw new Error(message);
    }
}

function assertEqual(label, actual, expected) {
    if (actual !== expected) {
        throw new Error(
            `${label}: expected ${expected}, found ${actual}`
        );
    }
}

function makeContext(overrides = {}) {
    return {
        child: {
            _id: "child-1",
            identity: {
                dateOfBirth: new Date("2017-05-10T00:00:00.000Z")
            }
        },
        ...overrides
    };
}

function makeCandidate(overrides = {}) {
    return {
        activity: {
            activityId: "activity-1"
        },
        currentActivity: {
            _id: "activity-1",
            eligibility: {
                minimumAge: 7,
                maximumAge: 12
            }
        },
        ...overrides
    };
}

function makeSession(overrides = {}) {
    return {
        _id: "session-1",
        schedule: {
            startDateTime: new Date("2026-09-10T15:00:00.000Z"),
            timezone: "Asia/Riyadh"
        },
        ...overrides
    };
}

function findFailure(result, code) {
    return result.failedConstraints.find(
        failure => failure.code === code
    );
}

function assertEligible(label, result) {
    assertEqual(`${label} eligible`, result.eligible, true);
    assertEqual(
        `${label} failedConstraints length`,
        result.failedConstraints.length,
        0
    );
}

function assertSingleFailure(result, expected) {
    assertEqual("eligible", result.eligible, false);
    assertEqual(
        "failedConstraints length",
        result.failedConstraints.length,
        1
    );

    const failure = result.failedConstraints[0];

    for (const [field, value] of Object.entries(expected)) {
        assertEqual(field, failure[field], value);
    }
}

function assertAgeFailure(result, fieldPath, detail) {
    assertSingleFailure(result, {
        code: "AGE_NOT_ELIGIBLE",
        scope: ELIGIBILITY_SCOPES.SESSION,
        entityType: "Activity",
        entityId: "activity-1",
        fieldPath,
        detail
    });
}

function assertSessionRequiredFailure(result, fieldPath, detail) {
    assertSingleFailure(result, {
        code: "SESSION_REQUIRED_DATA_MISSING",
        scope: ELIGIBILITY_SCOPES.SESSION,
        entityType: "Session",
        entityId: "session-1",
        fieldPath,
        detail
    });
}

function testAgeInsideRange() {
    assertEligible(
        "age inside range",
        checkSessionAgeEligibility(
            makeContext(),
            makeCandidate(),
            makeSession()
        )
    );
}

function testExactMinimumAge() {
    assertEligible(
        "exact minimum age",
        checkSessionAgeEligibility(
            makeContext(),
            makeCandidate(),
            makeSession({
                schedule: {
                    startDateTime: new Date("2024-05-10T15:00:00.000Z"),
                    timezone: "Asia/Riyadh"
                }
            })
        )
    );
}

function testBelowMinimumRejected() {
    assertAgeFailure(
        checkSessionAgeEligibility(
            makeContext(),
            makeCandidate(),
            makeSession({
                schedule: {
                    startDateTime: new Date("2024-05-09T15:00:00.000Z"),
                    timezone: "Asia/Riyadh"
                }
            })
        ),
        "eligibility.minimumAge",
        "Child is below the minimum age for this session"
    );
}

function testExactMaximumAge() {
    assertEligible(
        "exact maximum age",
        checkSessionAgeEligibility(
            makeContext(),
            makeCandidate(),
            makeSession({
                schedule: {
                    startDateTime: new Date("2029-05-10T15:00:00.000Z"),
                    timezone: "Asia/Riyadh"
                }
            })
        )
    );
}

function testAboveMaximumRejected() {
    assertAgeFailure(
        checkSessionAgeEligibility(
            makeContext(),
            makeCandidate(),
            makeSession({
                schedule: {
                    startDateTime: new Date("2030-05-10T15:00:00.000Z"),
                    timezone: "Asia/Riyadh"
                }
            })
        ),
        "eligibility.maximumAge",
        "Child is above the maximum age for this session"
    );
}

function testRiyadhBirthdayBoundary() {
    assertAgeFailure(
        checkSessionAgeEligibility(
            makeContext(),
            makeCandidate({
                currentActivity: {
                    _id: "activity-1",
                    eligibility: {
                        minimumAge: 7,
                        maximumAge: 8
                    }
                }
            }),
            makeSession({
                schedule: {
                    startDateTime: new Date("2026-05-09T22:30:00.000Z"),
                    timezone: "Asia/Riyadh"
                }
            })
        ),
        "eligibility.maximumAge",
        "Child is above the maximum age for this session"
    );
}

function testNewYorkBirthdayBoundary() {
    assertAgeFailure(
        checkSessionAgeEligibility(
            makeContext(),
            makeCandidate({
                currentActivity: {
                    _id: "activity-1",
                    eligibility: {
                        minimumAge: 9,
                        maximumAge: 12
                    }
                }
            }),
            makeSession({
                schedule: {
                    startDateTime: new Date("2026-05-10T01:30:00.000Z"),
                    timezone: "America/New_York"
                }
            })
        ),
        "eligibility.minimumAge",
        "Child is below the minimum age for this session"
    );
}

function testMissingTimezoneRejected() {
    assertSessionRequiredFailure(
        checkSessionAgeEligibility(
            makeContext(),
            makeCandidate(),
            makeSession({
                schedule: {
                    startDateTime: new Date("2026-09-10T15:00:00.000Z")
                }
            })
        ),
        "schedule.timezone",
        "Session timezone is required for age eligibility"
    );
}

function testInvalidTimezoneRejected() {
    assertSessionRequiredFailure(
        checkSessionAgeEligibility(
            makeContext(),
            makeCandidate(),
            makeSession({
                schedule: {
                    startDateTime: new Date("2026-09-10T15:00:00.000Z"),
                    timezone: "Not/A_Timezone"
                }
            })
        ),
        "schedule.timezone",
        "Session timezone is required for age eligibility"
    );
}

function testMissingStartRejected() {
    assertSessionRequiredFailure(
        checkSessionAgeEligibility(
            makeContext(),
            makeCandidate(),
            makeSession({
                schedule: {
                    timezone: "Asia/Riyadh"
                }
            })
        ),
        "schedule.startDateTime",
        "Session start date and time is required for age eligibility"
    );
}

function testInvalidStartRejected() {
    assertSessionRequiredFailure(
        checkSessionAgeEligibility(
            makeContext(),
            makeCandidate(),
            makeSession({
                schedule: {
                    startDateTime: new Date("invalid"),
                    timezone: "Asia/Riyadh"
                }
            })
        ),
        "schedule.startDateTime",
        "Session start date and time is required for age eligibility"
    );
}

function testStringStartRejected() {
    assertSessionRequiredFailure(
        checkSessionAgeEligibility(
            makeContext(),
            makeCandidate(),
            makeSession({
                schedule: {
                    startDateTime: "2026-09-10T15:00:00Z",
                    timezone: "Asia/Riyadh"
                }
            })
        ),
        "schedule.startDateTime",
        "Session start date and time is required for age eligibility"
    );
}

function testMissingChildDobPassThrough() {
    assertEligible(
        "missing child DOB",
        checkSessionAgeEligibility(
            makeContext({
                child: {
                    _id: "child-1",
                    identity: {}
                }
            }),
            makeCandidate(),
            makeSession()
        )
    );
}

function testInvalidChildDobPassThrough() {
    assertEligible(
        "invalid child DOB",
        checkSessionAgeEligibility(
            makeContext({
                child: {
                    _id: "child-1",
                    identity: {
                        dateOfBirth: new Date("invalid")
                    }
                }
            }),
            makeCandidate(),
            makeSession()
        )
    );
}

function testMaximumOnlyEnforcement() {
    assertAgeFailure(
        checkSessionAgeEligibility(
            makeContext(),
            makeCandidate({
                currentActivity: {
                    _id: "activity-1",
                    eligibility: {
                        maximumAge: 8
                    }
                }
            }),
            makeSession()
        ),
        "eligibility.maximumAge",
        "Child is above the maximum age for this session"
    );
}

function testMinimumOnlyEnforcement() {
    assertAgeFailure(
        checkSessionAgeEligibility(
            makeContext(),
            makeCandidate({
                currentActivity: {
                    _id: "activity-1",
                    eligibility: {
                        minimumAge: 10
                    }
                }
            }),
            makeSession()
        ),
        "eligibility.minimumAge",
        "Child is below the minimum age for this session"
    );
}

function testBothBoundsMissingPassThrough() {
    assertEligible(
        "both bounds missing",
        checkSessionAgeEligibility(
            makeContext(),
            makeCandidate({
                currentActivity: {
                    _id: "activity-1",
                    eligibility: {}
                }
            }),
            makeSession()
        )
    );
}

function testMalformedMinimumPassThrough() {
    assertEligible(
        "malformed minimum",
        checkSessionAgeEligibility(
            makeContext(),
            makeCandidate({
                currentActivity: {
                    _id: "activity-1",
                    eligibility: {
                        minimumAge: "10",
                        maximumAge: 12
                    }
                }
            }),
            makeSession()
        )
    );
}

function testMalformedMaximumPassThrough() {
    assertEligible(
        "malformed maximum",
        checkSessionAgeEligibility(
            makeContext(),
            makeCandidate({
                currentActivity: {
                    _id: "activity-1",
                    eligibility: {
                        minimumAge: 7,
                        maximumAge: "8"
                    }
                }
            }),
            makeSession()
        )
    );
}

function testContradictoryBoundsPassThrough() {
    assertEligible(
        "contradictory bounds",
        checkSessionAgeEligibility(
            makeContext(),
            makeCandidate({
                currentActivity: {
                    _id: "activity-1",
                    eligibility: {
                        minimumAge: 12,
                        maximumAge: 7
                    }
                }
            }),
            makeSession()
        )
    );
}

function testMissingContextPreserved() {
    assertSingleFailure(
        checkSessionAgeEligibility(
            null,
            makeCandidate(),
            makeSession()
        ),
        {
            code: "CONTEXT_MISSING",
            scope: ELIGIBILITY_SCOPES.REQUEST,
            entityType: "Child",
            entityId: null,
            fieldPath: null,
            detail: "Recommendation context could not be established"
        }
    );
}

function testMissingChildPreserved() {
    assertSingleFailure(
        checkSessionAgeEligibility(
            { child: null },
            makeCandidate(),
            makeSession()
        ),
        {
            code: "CONTEXT_MISSING",
            scope: ELIGIBILITY_SCOPES.REQUEST,
            entityType: "Child",
            entityId: null,
            fieldPath: "child",
            detail: "Child context is missing"
        }
    );
}

function testMissingActivityPreserved() {
    assertSingleFailure(
        checkSessionAgeEligibility(
            makeContext(),
            {
                activity: {
                    activityId: "activity-1"
                },
                currentActivity: null
            },
            makeSession()
        ),
        {
            code: "ACTIVITY_MISSING",
            scope: ELIGIBILITY_SCOPES.CANDIDATE,
            entityType: "Activity",
            entityId: "activity-1",
            fieldPath: "currentActivity",
            detail: "Current Mongo Activity document is missing"
        }
    );
}

function testMissingSessionPreserved() {
    assertSingleFailure(
        checkSessionAgeEligibility(
            makeContext(),
            makeCandidate(),
            null
        ),
        {
            code: "SESSION_MISSING",
            scope: ELIGIBILITY_SCOPES.SESSION,
            entityType: "Session",
            entityId: null,
            fieldPath: null,
            detail: "Session document is missing"
        }
    );
}

function testOldChildAgeIgnored() {
    assertEligible(
        "old child.age ignored",
        checkSessionAgeEligibility(
            makeContext({
                child: {
                    _id: "child-1",
                    age: 99,
                    identity: {
                        dateOfBirth: new Date("2017-05-10T00:00:00.000Z")
                    }
                }
            }),
            makeCandidate(),
            makeSession()
        )
    );
}

function testAgeGroupIgnored() {
    assertEligible(
        "ageGroup ignored",
        checkSessionAgeEligibility(
            makeContext({
                child: {
                    _id: "child-1",
                    identity: {
                        dateOfBirth: new Date("2017-05-10T00:00:00.000Z"),
                        ageGroup: "16-18"
                    }
                }
            }),
            makeCandidate(),
            makeSession()
        )
    );
}

function testSessionTimezoneRespected() {
    const result = checkSessionAgeEligibility(
        makeContext(),
        makeCandidate({
            currentActivity: {
                _id: "activity-1",
                eligibility: {
                    minimumAge: 9
                }
            }
        }),
        makeSession({
            schedule: {
                startDateTime: new Date("2026-05-10T01:30:00.000Z"),
                timezone: "America/New_York"
            }
        })
    );

    assert(
        findFailure(result, "AGE_NOT_ELIGIBLE"),
        "expected Session timezone to determine local birthday boundary"
    );
}

function main() {
    testAgeInsideRange();
    testExactMinimumAge();
    testBelowMinimumRejected();
    testExactMaximumAge();
    testAboveMaximumRejected();
    testRiyadhBirthdayBoundary();
    testNewYorkBirthdayBoundary();
    testSessionTimezoneRespected();
    testMissingTimezoneRejected();
    testInvalidTimezoneRejected();
    testMissingStartRejected();
    testInvalidStartRejected();
    testStringStartRejected();
    testMissingChildDobPassThrough();
    testInvalidChildDobPassThrough();
    testMaximumOnlyEnforcement();
    testMinimumOnlyEnforcement();
    testBothBoundsMissingPassThrough();
    testMalformedMinimumPassThrough();
    testMalformedMaximumPassThrough();
    testContradictoryBoundsPassThrough();
    testMissingContextPreserved();
    testMissingChildPreserved();
    testMissingActivityPreserved();
    testMissingSessionPreserved();
    testOldChildAgeIgnored();
    testAgeGroupIgnored();

    console.log("========================================");
    console.log("STEP 14G-C — SESSION AGE ELIGIBILITY");
    console.log("========================================");
    console.log("");
    console.log("Age inside range:                     PASSED");
    console.log("Exact minimum age:                    PASSED");
    console.log("Below minimum rejected:               PASSED");
    console.log("Exact maximum age:                    PASSED");
    console.log("Above maximum rejected:               PASSED");
    console.log("");
    console.log("Riyadh birthday boundary:             PASSED");
    console.log("New York birthday boundary:           PASSED");
    console.log("Session timezone respected:           PASSED");
    console.log("");
    console.log("Missing timezone rejected:            PASSED");
    console.log("Invalid timezone rejected:            PASSED");
    console.log("Missing start rejected:               PASSED");
    console.log("Invalid start rejected:               PASSED");
    console.log("String start rejected:                PASSED");
    console.log("");
    console.log("Missing Child DOB pass-through:       PASSED");
    console.log("Invalid Child DOB pass-through:       PASSED");
    console.log("Minimum-only enforcement:             PASSED");
    console.log("Maximum-only enforcement:             PASSED");
    console.log("Both bounds missing pass-through:     PASSED");
    console.log("Malformed minimum pass-through:       PASSED");
    console.log("Malformed maximum pass-through:       PASSED");
    console.log("Contradictory bounds pass-through:    PASSED");
    console.log("");
    console.log("Missing context preserved:            PASSED");
    console.log("Missing Child preserved:              PASSED");
    console.log("Missing Activity preserved:           PASSED");
    console.log("Missing Session preserved:            PASSED");
    console.log("");
    console.log("Old child.age ignored:                PASSED");
    console.log("ageGroup ignored:                     PASSED");
    console.log("");
    console.log("Operational Session rules:            NONE");
    console.log("Gender rules:                         NONE");
    console.log("Multiple Session aggregation:         NONE");
    console.log("Scoring/ranking:                      NONE");
    console.log("");
    console.log("========================================");
    console.log("✅ PHASE 14G-C PASSED");
    console.log("========================================");
}

main();
