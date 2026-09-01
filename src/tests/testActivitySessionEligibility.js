const {
    ELIGIBILITY_SCOPES
} = require("../recommendation/eligibilityResult");
const {
    evaluateActivitySessions
} = require("../recommendation/activitySessionEligibilityService");

const evaluationTime = new Date("2026-09-01T12:00:00.000Z");

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

function assertThrows(label, fn) {
    let threw = false;

    try {
        fn();
    } catch (error) {
        threw = true;
    }

    assert(threw, `${label}: expected error`);
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

function makeSession(id, overrides = {}) {
    return {
        _id: id,
        availability: {
            status: "Available",
            registrationOpen: true
        },
        capacity: {
            remainingCapacity: 4
        },
        schedule: {
            bookingDeadline: new Date("2026-09-02T12:00:00.000Z"),
            startDateTime: new Date("2026-09-10T15:00:00.000Z"),
            timezone: "Asia/Riyadh"
        },
        ...overrides
    };
}

function makeCandidate(sessions = [makeSession("session-1")], overrides = {}) {
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
        currentSessions: sessions,
        ...overrides
    };
}

function findFailure(result, code, fieldPath = undefined) {
    return result.failedConstraints.find((failure) => (
        failure.code === code &&
        (
            fieldPath === undefined ||
            failure.fieldPath === fieldPath
        )
    ));
}

function assertRootEligible(result) {
    assertEqual("root eligible", result.eligibility.eligible, true);
    assertEqual(
        "root failedConstraints length",
        result.eligibility.failedConstraints.length,
        0
    );
}

function assertRootNoEligibleSession(result) {
    assertEqual("root eligible", result.eligibility.eligible, false);
    assertEqual(
        "root failedConstraints length",
        result.eligibility.failedConstraints.length,
        1
    );
    assertEqual(
        "root failure code",
        result.eligibility.failedConstraints[0].code,
        "NO_ELIGIBLE_SESSION"
    );
    assertEqual(
        "root failure scope",
        result.eligibility.failedConstraints[0].scope,
        ELIGIBILITY_SCOPES.CANDIDATE
    );
    assertEqual(
        "root failure entityType",
        result.eligibility.failedConstraints[0].entityType,
        "Activity"
    );
    assertEqual(
        "root failure fieldPath",
        result.eligibility.failedConstraints[0].fieldPath,
        "currentSessions"
    );
}

function assertSingleFailure(result, expected) {
    assertEqual("eligible", result.eligibility.eligible, false);
    assertEqual(
        "failedConstraints length",
        result.eligibility.failedConstraints.length,
        1
    );

    const failure = result.eligibility.failedConstraints[0];

    for (const [field, value] of Object.entries(expected)) {
        assertEqual(field, failure[field], value);
    }
}

function assertEvaluationHasFailure(evaluation, code, fieldPath = undefined) {
    assert(
        findFailure(evaluation.eligibility, code, fieldPath),
        `missing failure ${code} at ${fieldPath}`
    );
}

function assertNoRootSessionDetails(result) {
    assert(
        !findFailure(result.eligibility, "SESSION_UNAVAILABLE"),
        "root must not duplicate Session operational failures"
    );
    assert(
        !findFailure(result.eligibility, "AGE_NOT_ELIGIBLE"),
        "root must not duplicate Session age failures"
    );
}

function testOneEligibleSession() {
    const result = evaluateActivitySessions(
        makeContext(),
        makeCandidate(),
        evaluationTime
    );

    assertRootEligible(result);
    assertEqual("eligibleSessions length", result.eligibleSessions.length, 1);
    assertEqual("sessionEvaluations length", result.sessionEvaluations.length, 1);
    assertEqual(
        "operational eligible",
        result.sessionEvaluations[0].operationalEligibility.eligible,
        true
    );
    assertEqual(
        "age eligible",
        result.sessionEvaluations[0].ageEligibility.eligible,
        true
    );
    assertEqual(
        "combined eligible",
        result.sessionEvaluations[0].eligibility.eligible,
        true
    );
}

function testMultipleEligibleSessions() {
    const result = evaluateActivitySessions(
        makeContext(),
        makeCandidate([
            makeSession("session-1"),
            makeSession("session-2")
        ]),
        evaluationTime
    );

    assertRootEligible(result);
    assertEqual("eligibleSessions length", result.eligibleSessions.length, 2);
}

function testFailThenPass() {
    const passingSession = makeSession("session-2");
    const result = evaluateActivitySessions(
        makeContext(),
        makeCandidate([
            makeSession("session-1", {
                availability: {
                    status: "Full",
                    registrationOpen: true
                }
            }),
            passingSession
        ]),
        evaluationTime
    );

    assertRootEligible(result);
    assertEqual("eligibleSessions length", result.eligibleSessions.length, 1);
    assertEqual("eligible Session", result.eligibleSessions[0], passingSession);
    assertEqual("sessionEvaluations length", result.sessionEvaluations.length, 2);
}

function testPassThenFail() {
    const passingSession = makeSession("session-1");
    const result = evaluateActivitySessions(
        makeContext(),
        makeCandidate([
            passingSession,
            makeSession("session-2", {
                availability: {
                    status: "Full",
                    registrationOpen: true
                }
            })
        ]),
        evaluationTime
    );

    assertRootEligible(result);
    assertEqual("eligibleSessions length", result.eligibleSessions.length, 1);
    assertEqual("eligible Session", result.eligibleSessions[0], passingSession);
}

function testOperationalFailurePreserved() {
    const result = evaluateActivitySessions(
        makeContext(),
        makeCandidate([
            makeSession("session-1", {
                availability: {
                    status: "Full",
                    registrationOpen: true
                }
            })
        ]),
        evaluationTime
    );

    assertRootNoEligibleSession(result);
    assertEvaluationHasFailure(
        result.sessionEvaluations[0],
        "SESSION_UNAVAILABLE",
        "availability.status"
    );
    assert(
        !findFailure(result.sessionEvaluations[0].eligibility, "AGE_NOT_ELIGIBLE"),
        "age failure must not appear for age-valid Session"
    );
}

function testAgeFailurePreserved() {
    const result = evaluateActivitySessions(
        makeContext(),
        makeCandidate([
            makeSession("session-1", {
                schedule: {
                    bookingDeadline: new Date("2026-09-02T12:00:00.000Z"),
                    startDateTime: new Date("2024-05-09T15:00:00.000Z"),
                    timezone: "Asia/Riyadh"
                }
            })
        ]),
        evaluationTime
    );

    assertRootNoEligibleSession(result);
    assertEvaluationHasFailure(
        result.sessionEvaluations[0],
        "AGE_NOT_ELIGIBLE",
        "eligibility.minimumAge"
    );
}

function testCombinedSessionFailures() {
    const result = evaluateActivitySessions(
        makeContext(),
        makeCandidate([
            makeSession("session-1", {
                availability: {
                    status: "Full",
                    registrationOpen: true
                },
                schedule: {
                    bookingDeadline: new Date("2026-09-02T12:00:00.000Z"),
                    startDateTime: new Date("2024-05-09T15:00:00.000Z"),
                    timezone: "Asia/Riyadh"
                }
            })
        ]),
        evaluationTime
    );

    assertRootNoEligibleSession(result);
    assertEvaluationHasFailure(
        result.sessionEvaluations[0],
        "SESSION_UNAVAILABLE",
        "availability.status"
    );
    assertEvaluationHasFailure(
        result.sessionEvaluations[0],
        "AGE_NOT_ELIGIBLE",
        "eligibility.minimumAge"
    );
}

function testAllSessionsRejected() {
    const result = evaluateActivitySessions(
        makeContext(),
        makeCandidate([
            makeSession("session-a", {
                availability: {
                    status: "Full",
                    registrationOpen: true
                }
            }),
            makeSession("session-b", {
                availability: {
                    status: "Available",
                    registrationOpen: false
                }
            }),
            makeSession("session-c", {
                schedule: {
                    bookingDeadline: new Date("2026-09-02T12:00:00.000Z"),
                    startDateTime: new Date("2024-05-09T15:00:00.000Z"),
                    timezone: "Asia/Riyadh"
                }
            })
        ]),
        evaluationTime
    );

    assertRootNoEligibleSession(result);
    assertNoRootSessionDetails(result);
    assertEqual("sessionEvaluations length", result.sessionEvaluations.length, 3);
    assertEvaluationHasFailure(result.sessionEvaluations[0], "SESSION_UNAVAILABLE");
    assertEvaluationHasFailure(result.sessionEvaluations[1], "BOOKING_CLOSED");
    assertEvaluationHasFailure(result.sessionEvaluations[2], "AGE_NOT_ELIGIBLE");
}

function testZeroSessionsRejected() {
    const result = evaluateActivitySessions(
        makeContext(),
        makeCandidate([]),
        evaluationTime
    );

    assertRootNoEligibleSession(result);
    assertEqual("eligibleSessions length", result.eligibleSessions.length, 0);
    assertEqual("sessionEvaluations length", result.sessionEvaluations.length, 0);
}

function testMissingSessionContext() {
    const candidate = makeCandidate();
    delete candidate.currentSessions;

    assertSingleFailure(
        evaluateActivitySessions(
            makeContext(),
            candidate,
            evaluationTime
        ),
        {
            code: "CONTEXT_MISSING",
            scope: ELIGIBILITY_SCOPES.CANDIDATE,
            entityType: "Activity",
            entityId: "activity-1",
            fieldPath: "currentSessions",
            detail: "Current Session context is missing or invalid"
        }
    );
}

function testNullSessionContext() {
    assertSingleFailure(
        evaluateActivitySessions(
            makeContext(),
            makeCandidate(null),
            evaluationTime
        ),
        {
            code: "CONTEXT_MISSING",
            scope: ELIGIBILITY_SCOPES.CANDIDATE,
            entityType: "Activity",
            entityId: "activity-1",
            fieldPath: "currentSessions",
            detail: "Current Session context is missing or invalid"
        }
    );
}

function testMalformedSessionContext() {
    assertSingleFailure(
        evaluateActivitySessions(
            makeContext(),
            makeCandidate("not-an-array"),
            evaluationTime
        ),
        {
            code: "CONTEXT_MISSING",
            scope: ELIGIBILITY_SCOPES.CANDIDATE,
            entityType: "Activity",
            entityId: "activity-1",
            fieldPath: "currentSessions",
            detail: "Current Session context is missing or invalid"
        }
    );
}

function testMissingRequestContext() {
    const result = evaluateActivitySessions(
        null,
        makeCandidate(),
        evaluationTime
    );

    assertSingleFailure(result, {
        code: "CONTEXT_MISSING",
        scope: ELIGIBILITY_SCOPES.REQUEST,
        entityType: "Child",
        entityId: null,
        fieldPath: null,
        detail: "Recommendation context could not be established"
    });
    assertEqual("eligibleSessions length", result.eligibleSessions.length, 0);
    assertEqual("sessionEvaluations length", result.sessionEvaluations.length, 0);
}

function testMissingChild() {
    assertSingleFailure(
        evaluateActivitySessions(
            { child: null },
            makeCandidate(),
            evaluationTime
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

function testMissingActivity() {
    assertSingleFailure(
        evaluateActivitySessions(
            makeContext(),
            {
                activity: {
                    activityId: "activity-1"
                },
                currentActivity: null,
                currentSessions: [makeSession("session-1")]
            },
            evaluationTime
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

function testNullSessionDocument() {
    const result = evaluateActivitySessions(
        makeContext(),
        makeCandidate([null]),
        evaluationTime
    );

    assertRootNoEligibleSession(result);
    assertEqual(
        "combined failure count",
        result.sessionEvaluations[0].eligibility.failedConstraints.length,
        1
    );
    assertEvaluationHasFailure(
        result.sessionEvaluations[0],
        "SESSION_MISSING",
        null
    );
}

function testDuplicateSessionFailureRemoved() {
    const result = evaluateActivitySessions(
        makeContext(),
        makeCandidate([
            makeSession("session-1", {
                schedule: {
                    bookingDeadline: new Date("2026-09-02T12:00:00.000Z"),
                    timezone: "Asia/Riyadh"
                }
            })
        ]),
        evaluationTime
    );
    const matchingFailures =
        result.sessionEvaluations[0]
            .eligibility
            .failedConstraints
            .filter(failure => (
                failure.code === "SESSION_REQUIRED_DATA_MISSING" &&
                failure.fieldPath === "schedule.startDateTime"
            ));

    assertRootNoEligibleSession(result);
    assertEqual("duplicate failure count", matchingFailures.length, 1);
}

function testDistinctMissingFieldsPreserved() {
    const result = evaluateActivitySessions(
        makeContext(),
        makeCandidate([
            makeSession("session-1", {
                capacity: {},
                schedule: {
                    bookingDeadline: new Date("2026-09-02T12:00:00.000Z"),
                    timezone: "Asia/Riyadh"
                }
            })
        ]),
        evaluationTime
    );

    assertEvaluationHasFailure(
        result.sessionEvaluations[0],
        "SESSION_REQUIRED_DATA_MISSING",
        "schedule.startDateTime"
    );
    assertEvaluationHasFailure(
        result.sessionEvaluations[0],
        "SESSION_REQUIRED_DATA_MISSING",
        "capacity.remainingCapacity"
    );
}

function testOriginalSessionReferences() {
    const session = makeSession("session-1");
    const result = evaluateActivitySessions(
        makeContext(),
        makeCandidate([session]),
        evaluationTime
    );

    assertEqual("eligible Session identity", result.eligibleSessions[0], session);
    assertEqual(
        "evaluation Session identity",
        result.sessionEvaluations[0].session,
        session
    );
}

function testSessionOrderingPreserved() {
    const sessionA = makeSession("A");
    const sessionB = makeSession("B", {
        availability: {
            status: "Full",
            registrationOpen: true
        }
    });
    const sessionC = makeSession("C");
    const result = evaluateActivitySessions(
        makeContext(),
        makeCandidate([sessionA, sessionB, sessionC]),
        evaluationTime
    );

    assertEqual("evaluation A", result.sessionEvaluations[0].session, sessionA);
    assertEqual("evaluation B", result.sessionEvaluations[1].session, sessionB);
    assertEqual("evaluation C", result.sessionEvaluations[2].session, sessionC);
    assertEqual("eligible A", result.eligibleSessions[0], sessionA);
    assertEqual("eligible C", result.eligibleSessions[1], sessionC);
}

function testInvalidEvaluationTimeRejected() {
    assertThrows("invalid evaluationTime", () => {
        evaluateActivitySessions(
            makeContext(),
            makeCandidate([]),
            new Date("invalid")
        );
    });
}

function testDefaultEvaluationTime() {
    const futureDate = new Date();
    futureDate.setUTCFullYear(futureDate.getUTCFullYear() + 1);
    const laterDate = new Date();
    laterDate.setUTCFullYear(laterDate.getUTCFullYear() + 2);

    const result = evaluateActivitySessions(
        makeContext(),
        makeCandidate([
            makeSession("session-1", {
                schedule: {
                    bookingDeadline: futureDate,
                    startDateTime: laterDate,
                    timezone: "Asia/Riyadh"
                }
            })
        ])
    );

    assertRootEligible(result);
}

function testNoScoringFields() {
    const result = evaluateActivitySessions(
        makeContext(),
        makeCandidate(),
        evaluationTime
    );
    const keys = Object.keys(result);

    assertEqual("return key count", keys.length, 3);
    assert(keys.includes("eligibility"), "missing eligibility");
    assert(keys.includes("eligibleSessions"), "missing eligibleSessions");
    assert(keys.includes("sessionEvaluations"), "missing sessionEvaluations");
    assert(!keys.includes("score"), "score must not be returned");
    assert(!keys.includes("rank"), "rank must not be returned");
    assert(!keys.includes("selectedSession"), "selectedSession must not be returned");
    assert(!keys.includes("bestSession"), "bestSession must not be returned");
    assert(!keys.includes("finalScore"), "finalScore must not be returned");
    assert(
        !keys.includes("sessionSuitability"),
        "sessionSuitability must not be returned"
    );
}

function main() {
    testOneEligibleSession();
    testMultipleEligibleSessions();
    testFailThenPass();
    testPassThenFail();
    testOperationalFailurePreserved();
    testAgeFailurePreserved();
    testCombinedSessionFailures();
    testAllSessionsRejected();
    testZeroSessionsRejected();
    testMissingSessionContext();
    testNullSessionContext();
    testMalformedSessionContext();
    testMissingRequestContext();
    testMissingChild();
    testMissingActivity();
    testNullSessionDocument();
    testDuplicateSessionFailureRemoved();
    testDistinctMissingFieldsPreserved();
    testOriginalSessionReferences();
    testSessionOrderingPreserved();
    testInvalidEvaluationTimeRejected();
    testDefaultEvaluationTime();
    testNoScoringFields();

    console.log("========================================");
    console.log("STEP 14G-D — ACTIVITY SESSION ELIGIBILITY");
    console.log("========================================");
    console.log("");
    console.log("One eligible Session:                 PASSED");
    console.log("Multiple eligible Sessions:           PASSED");
    console.log("Fail then pass:                       PASSED");
    console.log("Pass then fail:                       PASSED");
    console.log("");
    console.log("Operational failure preserved:        PASSED");
    console.log("Age failure preserved:                PASSED");
    console.log("Combined Session failures:            PASSED");
    console.log("All Sessions rejected:                PASSED");
    console.log("");
    console.log("Zero Sessions rejected:               PASSED");
    console.log("Missing Session context:              PASSED");
    console.log("Null Session context:                 PASSED");
    console.log("Malformed Session context:            PASSED");
    console.log("");
    console.log("Missing request context:              PASSED");
    console.log("Missing Child:                        PASSED");
    console.log("Missing Activity:                     PASSED");
    console.log("Null Session document:                PASSED");
    console.log("");
    console.log("Duplicate Session failure removed:    PASSED");
    console.log("Distinct missing fields preserved:    PASSED");
    console.log("");
    console.log("Original Session references:          PASSED");
    console.log("Session ordering preserved:           PASSED");
    console.log("Invalid evaluationTime rejected:      PASSED");
    console.log("Default evaluationTime:               PASSED");
    console.log("");
    console.log("Best Session selection:               NONE");
    console.log("Session sorting:                      NONE");
    console.log("Location/price:                       NONE");
    console.log("Bookings:                             NONE");
    console.log("Scoring/ranking:                      NONE");
    console.log("");
    console.log("========================================");
    console.log("✅ PHASE 14G-D PASSED");
    console.log("========================================");
}

main();
