const {
    ELIGIBILITY_SCOPES,
    createEligibilityFailure,
    buildEligibilityResult
} = require("./eligibilityResult");
const {
    checkRequestContext,
    checkCandidateEntity
} = require("./hardEligibilityService");
const {
    calculateAge
} = require("../utils/dateUtils");

function isValidDate(value) {
    return value instanceof Date &&
        !Number.isNaN(value.getTime());
}

function isUsableAgeBound(value) {
    return (
        typeof value === "number" &&
        Number.isFinite(value) &&
        value >= 0
    );
}

function isValidTimeZone(timezone) {
    if (
        typeof timezone !== "string" ||
        timezone.trim().length === 0
    ) {
        return false;
    }

    try {
        new Intl.DateTimeFormat("en-US", {
            timeZone: timezone
        });
        return true;
    } catch (error) {
        return false;
    }
}

function getCalendarDatePartsInTimeZone(date, timeZone) {
    const formatter = new Intl.DateTimeFormat("en-US", {
        timeZone,
        year: "numeric",
        month: "numeric",
        day: "numeric"
    });

    const parts = formatter.formatToParts(date);
    const values = {};

    for (const part of parts) {
        if (part.type === "year" || part.type === "month" || part.type === "day") {
            values[part.type] = Number(part.value);
        }
    }

    return {
        year: values.year,
        month: values.month,
        day: values.day
    };
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

function createAgeFailure(candidate, fieldPath, detail) {
    return createEligibilityFailure({
        code: "AGE_NOT_ELIGIBLE",
        scope: ELIGIBILITY_SCOPES.SESSION,
        entityType: "Activity",
        entityId:
            candidate.currentActivity._id ??
            candidate.activity?.activityId ??
            null,
        fieldPath,
        detail
    });
}

function checkSessionAgeEligibility(
    context,
    candidate,
    session
) {
    const contextResult = checkRequestContext(context);

    if (!contextResult.eligible) {
        return contextResult;
    }

    if (
        context.child === null ||
        context.child === undefined
    ) {
        return buildEligibilityResult([
            createEligibilityFailure({
                code: "CONTEXT_MISSING",
                scope: ELIGIBILITY_SCOPES.REQUEST,
                entityType: "Child",
                entityId: null,
                fieldPath: "child",
                detail: "Child context is missing"
            })
        ]);
    }

    const candidateResult = checkCandidateEntity(candidate);

    if (!candidateResult.eligible) {
        return candidateResult;
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

    const startDateTime = session.schedule?.startDateTime;

    if (!isValidDate(startDateTime)) {
        return buildEligibilityResult([
            createSessionFailure(
                session,
                "SESSION_REQUIRED_DATA_MISSING",
                "schedule.startDateTime",
                "Session start date and time is required for age eligibility"
            )
        ]);
    }

    const timezone = session.schedule?.timezone;

    if (!isValidTimeZone(timezone)) {
        return buildEligibilityResult([
            createSessionFailure(
                session,
                "SESSION_REQUIRED_DATA_MISSING",
                "schedule.timezone",
                "Session timezone is required for age eligibility"
            )
        ]);
    }

    const dateOfBirth = context.child?.identity?.dateOfBirth;

    if (!isValidDate(dateOfBirth)) {
        return buildEligibilityResult([]);
    }

    const minimumAge =
        candidate.currentActivity
            ?.eligibility
            ?.minimumAge;
    const maximumAge =
        candidate.currentActivity
            ?.eligibility
            ?.maximumAge;
    const hasMinimumAge = isUsableAgeBound(minimumAge);
    const hasMaximumAge = isUsableAgeBound(maximumAge);

    if (!hasMinimumAge && !hasMaximumAge) {
        return buildEligibilityResult([]);
    }

    if (
        hasMinimumAge &&
        hasMaximumAge &&
        minimumAge > maximumAge
    ) {
        return buildEligibilityResult([]);
    }

    const sessionDateParts = getCalendarDatePartsInTimeZone(
        startDateTime,
        timezone
    );
    const normalizedDob = new Date(
        dateOfBirth.getUTCFullYear(),
        dateOfBirth.getUTCMonth(),
        dateOfBirth.getUTCDate(),
        12,
        0,
        0,
        0
    );
    const sessionReferenceDate = new Date(
        sessionDateParts.year,
        sessionDateParts.month - 1,
        sessionDateParts.day,
        12,
        0,
        0,
        0
    );
    const childAge = calculateAge(
        normalizedDob,
        sessionReferenceDate
    );

    if (
        childAge === null ||
        childAge < 0
    ) {
        return buildEligibilityResult([]);
    }

    if (
        hasMinimumAge &&
        childAge < minimumAge
    ) {
        return buildEligibilityResult([
            createAgeFailure(
                candidate,
                "eligibility.minimumAge",
                "Child is below the minimum age for this session"
            )
        ]);
    }

    if (
        hasMaximumAge &&
        childAge > maximumAge
    ) {
        return buildEligibilityResult([
            createAgeFailure(
                candidate,
                "eligibility.maximumAge",
                "Child is above the maximum age for this session"
            )
        ]);
    }

    return buildEligibilityResult([]);
}

module.exports = {
    checkSessionAgeEligibility
};
