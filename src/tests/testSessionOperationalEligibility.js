const {
    ELIGIBILITY_SCOPES
} = require("../recommendation/eligibilityResult");
const {
    checkSessionOperationalEligibility
} = require("../recommendation/sessionEligibilityService");

const EVALUATION_TIME = new Date("2026-09-01T12:00:00.000Z");

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

function makeEligibleSession(overrides = {}) {
    return {
        _id: "session-1",
        availability: {
            status: "Available",
            registrationOpen: true
        },
        capacity: {
            remainingCapacity: 3
        },
        schedule: {
            bookingDeadline: new Date("2026-09-02T12:00:00.000Z"),
            startDateTime: new Date("2026-09-03T12:00:00.000Z")
        },
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

function assertEligible(label, result) {
    assertEqual(`${label} eligible`, result.eligible, true);
    assertEqual(
        `${label} failedConstraints length`,
        result.failedConstraints.length,
        0
    );
}

function assertFailure(result, expected) {
    assertEqual("eligible", result.eligible, false);

    const failure = findFailure(
        result,
        expected.code,
        expected.fieldPath
    );

    assert(
        failure,
        `missing failure ${expected.code} at ${expected.fieldPath}`
    );

    for (const [field, value] of Object.entries(expected)) {
        assertEqual(field, failure[field], value);
    }
}

function assertFailureCodes(result, expectedCodes) {
    assertEqual("eligible", result.eligible, false);
    assertEqual(
        "failedConstraints length",
        result.failedConstraints.length,
        expectedCodes.length
    );

    for (const code of expectedCodes) {
        assert(findFailure(result, code), `missing failure ${code}`);
    }
}

function testEligibleSession() {
    assertEligible(
        "eligible session",
        checkSessionOperationalEligibility(
            makeEligibleSession(),
            EVALUATION_TIME
        )
    );
}

function testMissingSession() {
    assertFailure(
        checkSessionOperationalEligibility(null, EVALUATION_TIME),
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

function testInvalidEvaluationTimeThrows() {
    assertThrows("invalid evaluationTime", () => {
        checkSessionOperationalEligibility(
            makeEligibleSession(),
            new Date("not-a-date")
        );
    });

    assertThrows("string evaluationTime", () => {
        checkSessionOperationalEligibility(
            makeEligibleSession(),
            "2026-09-01T12:00:00.000Z"
        );
    });
}

function testUnavailableStatuses() {
    for (const status of ["Full", "Cancelled", "Completed"]) {
        assertFailure(
            checkSessionOperationalEligibility(
                makeEligibleSession({
                    _id: `session-${status}`,
                    availability: {
                        status,
                        registrationOpen: true
                    }
                }),
                EVALUATION_TIME
            ),
            {
                code: "SESSION_UNAVAILABLE",
                scope: ELIGIBILITY_SCOPES.SESSION,
                entityType: "Session",
                entityId: `session-${status}`,
                fieldPath: "availability.status",
                detail: "Session is not available for booking"
            }
        );
    }
}

function testMissingOrInvalidStatus() {
    for (const status of [undefined, null, 123, "Draft"]) {
        assertFailure(
            checkSessionOperationalEligibility(
                makeEligibleSession({
                    availability: {
                        status,
                        registrationOpen: true
                    }
                }),
                EVALUATION_TIME
            ),
            {
                code: "SESSION_REQUIRED_DATA_MISSING",
                scope: ELIGIBILITY_SCOPES.SESSION,
                entityType: "Session",
                entityId: "session-1",
                fieldPath: "availability.status",
                detail: "Session availability status is missing or invalid"
            }
        );
    }
}

function testRegistrationClosed() {
    assertFailure(
        checkSessionOperationalEligibility(
            makeEligibleSession({
                availability: {
                    status: "Available",
                    registrationOpen: false
                }
            }),
            EVALUATION_TIME
        ),
        {
            code: "BOOKING_CLOSED",
            scope: ELIGIBILITY_SCOPES.SESSION,
            entityType: "Session",
            entityId: "session-1",
            fieldPath: "availability.registrationOpen",
            detail: "Session registration is closed"
        }
    );
}

function testInvalidRegistrationOpen() {
    assertFailure(
        checkSessionOperationalEligibility(
            makeEligibleSession({
                availability: {
                    status: "Available",
                    registrationOpen: "true"
                }
            }),
            EVALUATION_TIME
        ),
        {
            code: "SESSION_REQUIRED_DATA_MISSING",
            scope: ELIGIBILITY_SCOPES.SESSION,
            entityType: "Session",
            entityId: "session-1",
            fieldPath: "availability.registrationOpen",
            detail: "Session registration status is missing or invalid"
        }
    );
}

function testNoRemainingCapacity() {
    for (const remainingCapacity of [0, -1]) {
        assertFailure(
            checkSessionOperationalEligibility(
                makeEligibleSession({
                    capacity: {
                        remainingCapacity
                    }
                }),
                EVALUATION_TIME
            ),
            {
                code: "SESSION_FULL",
                scope: ELIGIBILITY_SCOPES.SESSION,
                entityType: "Session",
                entityId: "session-1",
                fieldPath: "capacity.remainingCapacity",
                detail: "Session has no remaining capacity"
            }
        );
    }
}

function testInvalidRemainingCapacity() {
    for (const remainingCapacity of [undefined, null, "3", Infinity]) {
        assertFailure(
            checkSessionOperationalEligibility(
                makeEligibleSession({
                    capacity: {
                        remainingCapacity
                    }
                }),
                EVALUATION_TIME
            ),
            {
                code: "SESSION_REQUIRED_DATA_MISSING",
                scope: ELIGIBILITY_SCOPES.SESSION,
                entityType: "Session",
                entityId: "session-1",
                fieldPath: "capacity.remainingCapacity",
                detail: "Session remaining capacity is missing or invalid"
            }
        );
    }
}

function testBookingDeadlinePassedOrReached() {
    for (const bookingDeadline of [
        new Date("2026-09-01T12:00:00.000Z"),
        new Date("2026-09-01T11:59:59.999Z")
    ]) {
        assertFailure(
            checkSessionOperationalEligibility(
                makeEligibleSession({
                    schedule: {
                        bookingDeadline,
                        startDateTime: new Date("2026-09-03T12:00:00.000Z")
                    }
                }),
                EVALUATION_TIME
            ),
            {
                code: "BOOKING_CLOSED",
                scope: ELIGIBILITY_SCOPES.SESSION,
                entityType: "Session",
                entityId: "session-1",
                fieldPath: "schedule.bookingDeadline",
                detail: "Session booking deadline has passed"
            }
        );
    }
}

function testInvalidBookingDeadline() {
    for (const bookingDeadline of [
        undefined,
        null,
        "2026-09-02T12:00:00.000Z",
        new Date("not-a-date")
    ]) {
        assertFailure(
            checkSessionOperationalEligibility(
                makeEligibleSession({
                    schedule: {
                        bookingDeadline,
                        startDateTime: new Date("2026-09-03T12:00:00.000Z")
                    }
                }),
                EVALUATION_TIME
            ),
            {
                code: "SESSION_REQUIRED_DATA_MISSING",
                scope: ELIGIBILITY_SCOPES.SESSION,
                entityType: "Session",
                entityId: "session-1",
                fieldPath: "schedule.bookingDeadline",
                detail: "Session booking deadline is missing or invalid"
            }
        );
    }
}

function testSessionNotFuture() {
    for (const startDateTime of [
        new Date("2026-09-01T12:00:00.000Z"),
        new Date("2026-09-01T11:59:59.999Z")
    ]) {
        assertFailure(
            checkSessionOperationalEligibility(
                makeEligibleSession({
                    schedule: {
                        bookingDeadline: new Date("2026-09-02T12:00:00.000Z"),
                        startDateTime
                    }
                }),
                EVALUATION_TIME
            ),
            {
                code: "SESSION_UNAVAILABLE",
                scope: ELIGIBILITY_SCOPES.SESSION,
                entityType: "Session",
                entityId: "session-1",
                fieldPath: "schedule.startDateTime",
                detail: "Session has already started or passed"
            }
        );
    }
}

function testInvalidStartDateTime() {
    for (const startDateTime of [
        undefined,
        null,
        "2026-09-03T12:00:00.000Z",
        new Date("not-a-date")
    ]) {
        assertFailure(
            checkSessionOperationalEligibility(
                makeEligibleSession({
                    schedule: {
                        bookingDeadline: new Date("2026-09-02T12:00:00.000Z"),
                        startDateTime
                    }
                }),
                EVALUATION_TIME
            ),
            {
                code: "SESSION_REQUIRED_DATA_MISSING",
                scope: ELIGIBILITY_SCOPES.SESSION,
                entityType: "Session",
                entityId: "session-1",
                fieldPath: "schedule.startDateTime",
                detail: "Session start date and time is missing or invalid"
            }
        );
    }
}

function testIndependentOperationalFailures() {
    const result = checkSessionOperationalEligibility(
        makeEligibleSession({
            availability: {
                status: "Full",
                registrationOpen: false
            },
            capacity: {
                remainingCapacity: 0
            },
            schedule: {
                bookingDeadline: new Date("2026-08-31T12:00:00.000Z"),
                startDateTime: new Date("2026-09-03T12:00:00.000Z")
            }
        }),
        EVALUATION_TIME
    );

    assertFailureCodes(result, [
        "SESSION_UNAVAILABLE",
        "BOOKING_CLOSED",
        "SESSION_FULL",
        "BOOKING_CLOSED"
    ]);
}

function testMissingDataDoesNotDuplicateOperationalFailure() {
    const result = checkSessionOperationalEligibility(
        makeEligibleSession({
            availability: {
                registrationOpen: "false"
            },
            capacity: {
                remainingCapacity: "0"
            },
            schedule: {
                bookingDeadline: "2026-08-31T12:00:00.000Z",
                startDateTime: "2026-08-31T12:00:00.000Z"
            }
        }),
        EVALUATION_TIME
    );

    assertFailureCodes(result, [
        "SESSION_REQUIRED_DATA_MISSING",
        "SESSION_REQUIRED_DATA_MISSING",
        "SESSION_REQUIRED_DATA_MISSING",
        "SESSION_REQUIRED_DATA_MISSING",
        "SESSION_REQUIRED_DATA_MISSING"
    ]);
    assert(
        !findFailure(result, "SESSION_UNAVAILABLE"),
        "invalid status must not create availability failure"
    );
    assert(
        !findFailure(result, "BOOKING_CLOSED"),
        "invalid registrationOpen must not create closed failure"
    );
    assert(
        !findFailure(result, "SESSION_FULL"),
        "invalid capacity must not create no-capacity failure"
    );
    assert(
        !findFailure(result, "BOOKING_CLOSED"),
        "invalid bookingDeadline must not create deadline failure"
    );
    assert(
        !findFailure(result, "SESSION_UNAVAILABLE"),
        "invalid startDateTime must not create future failure"
    );
}

function main() {
    testEligibleSession();
    testMissingSession();
    testInvalidEvaluationTimeThrows();
    testUnavailableStatuses();
    testMissingOrInvalidStatus();
    testRegistrationClosed();
    testInvalidRegistrationOpen();
    testNoRemainingCapacity();
    testInvalidRemainingCapacity();
    testBookingDeadlinePassedOrReached();
    testInvalidBookingDeadline();
    testSessionNotFuture();
    testInvalidStartDateTime();
    testIndependentOperationalFailures();
    testMissingDataDoesNotDuplicateOperationalFailure();

    console.log("========================================");
    console.log("STEP 14G-B — SESSION OPERATIONAL ELIGIBILITY");
    console.log("========================================");
    console.log("Eligible Session:                PASSED");
    console.log("Missing Session:                 PASSED");
    console.log("Invalid evaluationTime:          PASSED");
    console.log("Availability status:             PASSED");
    console.log("Registration open:               PASSED");
    console.log("Remaining capacity:              PASSED");
    console.log("Booking deadline:                PASSED");
    console.log("Future session start:            PASSED");
    console.log("Independent failures:            PASSED");
    console.log("Missing-data duplicate handling: PASSED");
    console.log("");
    console.log("Age rules:                       NONE");
    console.log("Activity aggregation:            NONE");
    console.log("Scoring logic:                   NONE");
    console.log("Ranking logic:                   NONE");
    console.log("========================================");
    console.log("✅ PHASE 14G-B PASSED");
    console.log("========================================");
}

main();
