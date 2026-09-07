const {
    SCORING_FACTORS,
    createFactorResult
} = require("./scoringContract");

const WEEKDAY_BY_LOWERCASE = Object.freeze({
    monday: "Monday",
    tuesday: "Tuesday",
    wednesday: "Wednesday",
    thursday: "Thursday",
    friday: "Friday",
    saturday: "Saturday",
    sunday: "Sunday"
});

function createUnavailableSessionResult(evidence = []) {
    return createFactorResult({
        factor: SCORING_FACTORS.SESSION,
        available: false,
        score: null,
        evidence
    });
}

function createAvailableSessionResult({
    preferredDays,
    eligibleSessions,
    sessionWeekdays,
    matchingSessions,
    score
}) {
    return createFactorResult({
        factor: SCORING_FACTORS.SESSION,
        available: true,
        score,
        evidence: [
            {
                type: "preferred_day_match",
                preferredDays: [...preferredDays],
                eligibleSessionCount: eligibleSessions.length,
                checkedSessions: sessionWeekdays.map((item) => ({
                    sessionId: item.sessionId,
                    weekday: item.weekday
                })),
                matchingSessionIds: matchingSessions.map(
                    (item) => item.sessionId
                ),
                matchingWeekdays: Array.from(new Set(
                    matchingSessions.map((item) => item.weekday)
                )),
                score
            }
        ]
    });
}

function normalizePreferredDays(preferredDays) {
    if (!Array.isArray(preferredDays)) {
        return {
            valid: false,
            reason: "malformed_preferred_days"
        };
    }

    if (preferredDays.length === 0) {
        return {
            valid: false,
            reason: "no_preferred_days"
        };
    }

    const normalizedDays = [];
    const seenDays = new Set();

    for (const value of preferredDays) {
        if (typeof value !== "string") {
            return {
                valid: false,
                reason: "malformed_preferred_days"
            };
        }

        const trimmed = value.trim();

        if (trimmed.length === 0) {
            return {
                valid: false,
                reason: "malformed_preferred_days"
            };
        }

        const normalized = WEEKDAY_BY_LOWERCASE[trimmed.toLowerCase()];

        if (!normalized) {
            return {
                valid: false,
                reason: "malformed_preferred_days"
            };
        }

        if (!seenDays.has(normalized)) {
            seenDays.add(normalized);
            normalizedDays.push(normalized);
        }
    }

    return {
        valid: true,
        days: normalizedDays
    };
}

function isValidDate(value) {
    return value instanceof Date &&
        !Number.isNaN(value.getTime());
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

function getLocalWeekday(session) {
    const startDateTime = session?.schedule?.startDateTime;
    const timezone = session?.schedule?.timezone;

    if (!isValidDate(startDateTime) || !isValidTimeZone(timezone)) {
        return null;
    }

    return new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        weekday: "long"
    }).format(startDateTime);
}

function toIdKey(value) {
    if (value === null || value === undefined) {
        return null;
    }

    return String(value);
}

function calculateSessionFactor(eligibilityEvaluation, context) {
    if (eligibilityEvaluation === null || eligibilityEvaluation === undefined) {
        throw new Error("Eligibility evaluation is required");
    }

    if (context === null || context === undefined) {
        throw new Error("Recommendation context is required");
    }

    if (eligibilityEvaluation.eligibility?.eligible !== true) {
        throw new Error("Session scoring requires an eligible candidate evaluation");
    }

    const preferredDays =
        context.parent?.recommendationPreferences?.preferredDays;

    if (preferredDays === undefined || preferredDays === null) {
        return createUnavailableSessionResult([
            {
                type: "no_preferred_days"
            }
        ]);
    }

    const normalizedPreference = normalizePreferredDays(preferredDays);

    if (!normalizedPreference.valid) {
        return createUnavailableSessionResult([
            {
                type: normalizedPreference.reason
            }
        ]);
    }

    const eligibleSessions = eligibilityEvaluation.eligibleSessions;

    if (
        !Array.isArray(eligibleSessions) ||
        eligibleSessions.length === 0
    ) {
        return createUnavailableSessionResult([
            {
                type: "missing_eligible_sessions"
            }
        ]);
    }

    const sessionWeekdays = [];

    for (const session of eligibleSessions) {
        const weekday = getLocalWeekday(session);

        if (!weekday) {
            return createUnavailableSessionResult([
                {
                    type: "malformed_eligible_session",
                    sessionId: toIdKey(session?._id)
                }
            ]);
        }

        sessionWeekdays.push({
            sessionId: toIdKey(session?._id),
            weekday
        });
    }

    const preferredDaySet = new Set(normalizedPreference.days);
    const matchingSessions = sessionWeekdays.filter((item) =>
        preferredDaySet.has(item.weekday)
    );
    const score = matchingSessions.length > 0 ? 1 : 0;

    return createAvailableSessionResult({
        preferredDays: normalizedPreference.days,
        eligibleSessions,
        sessionWeekdays,
        matchingSessions,
        score
    });
}

module.exports = {
    calculateSessionFactor
};
