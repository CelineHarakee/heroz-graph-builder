const {
    ELIGIBILITY_SCOPES,
    createEligibilityFailure,
    buildEligibilityResult
} = require("./eligibilityResult");

const AVAILABLE_STATUSES = new Set([
    "Available",
    "Full",
    "Cancelled",
    "Completed"
]);

function isValidDate(value) {
    return value instanceof Date &&
        !Number.isNaN(value.getTime());
}

function createSessionFailure(session, code, fieldPath, detail) {
    return createEligibilityFailure({
        code,
        scope: ELIGIBILITY_SCOPES.SESSION,
        entityType: "Session",
        entityId: session?._id ?? null,
        fieldPath,
        detail
    });
}

function checkSessionOperationalEligibility(
    session,
    evaluationTime = new Date()
) {
    if (!isValidDate(evaluationTime)) {
        throw new Error("evaluationTime must be a valid Date");
    }

    if (session === null || session === undefined) {
        return buildEligibilityResult([
            createSessionFailure(
                session,
                "SESSION_MISSING",
                null,
                "Session document is missing"
            )
        ]);
    }

    const failures = [];
    const status = session.availability?.status;
    const registrationOpen = session.availability?.registrationOpen;
    const remainingCapacity = session.capacity?.remainingCapacity;
    const bookingDeadline = session.schedule?.bookingDeadline;
    const startDateTime = session.schedule?.startDateTime;
    const evaluationTimeMs = evaluationTime.getTime();

    if (
        typeof status !== "string" ||
        !AVAILABLE_STATUSES.has(status)
    ) {
        failures.push(createSessionFailure(
            session,
            "SESSION_REQUIRED_DATA_MISSING",
            "availability.status",
            "Session availability status is missing or invalid"
        ));
    } else if (status !== "Available") {
        failures.push(createSessionFailure(
            session,
            "SESSION_UNAVAILABLE",
            "availability.status",
            "Session is not available for booking"
        ));
    }

    if (typeof registrationOpen !== "boolean") {
        failures.push(createSessionFailure(
            session,
            "SESSION_REQUIRED_DATA_MISSING",
            "availability.registrationOpen",
            "Session registration status is missing or invalid"
        ));
    } else if (registrationOpen === false) {
        failures.push(createSessionFailure(
            session,
            "BOOKING_CLOSED",
            "availability.registrationOpen",
            "Session registration is closed"
        ));
    }

    if (
        typeof remainingCapacity !== "number" ||
        !Number.isFinite(remainingCapacity)
    ) {
        failures.push(createSessionFailure(
            session,
            "SESSION_REQUIRED_DATA_MISSING",
            "capacity.remainingCapacity",
            "Session remaining capacity is missing or invalid"
        ));
    } else if (remainingCapacity <= 0) {
        failures.push(createSessionFailure(
            session,
            "SESSION_FULL",
            "capacity.remainingCapacity",
            "Session has no remaining capacity"
        ));
    }

    if (!isValidDate(bookingDeadline)) {
        failures.push(createSessionFailure(
            session,
            "SESSION_REQUIRED_DATA_MISSING",
            "schedule.bookingDeadline",
            "Session booking deadline is missing or invalid"
        ));
    } else if (bookingDeadline.getTime() <= evaluationTimeMs) {
        failures.push(createSessionFailure(
            session,
            "BOOKING_CLOSED",
            "schedule.bookingDeadline",
            "Session booking deadline has passed"
        ));
    }

    if (!isValidDate(startDateTime)) {
        failures.push(createSessionFailure(
            session,
            "SESSION_REQUIRED_DATA_MISSING",
            "schedule.startDateTime",
            "Session start date and time is missing or invalid"
        ));
    } else if (startDateTime.getTime() <= evaluationTimeMs) {
        failures.push(createSessionFailure(
            session,
            "SESSION_UNAVAILABLE",
            "schedule.startDateTime",
            "Session has already started or passed"
        ));
    }

    return buildEligibilityResult(failures);
}

module.exports = {
    checkSessionOperationalEligibility
};
