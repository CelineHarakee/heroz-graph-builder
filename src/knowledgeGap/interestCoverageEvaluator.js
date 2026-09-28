const {
    D1_COVERAGE,
    D1_EVALUATION_STATUS,
    D1_RESOLVER,
    D1_SUFFICIENCY,
    MIN_CORROBORATING_NON_PASSIVE_EVENTS
} = require("./knowledgeGapConstants");

const PASSIVE_EVENTS = new Set(["View", "Click"]);
const MEANINGFUL_NON_PASSIVE_EVENTS = new Set(["Save", "Dismiss", "Book", "Attend", "Rate"]);
const REVERSAL_EVENTS = new Set(["Unsave"]);

function hasEntries(value) {
    return Array.isArray(value) && value.length > 0;
}

function evidenceCountOf(childInterest) {
    const count = childInterest?.confidence?.evidenceCount;
    return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

function breakdownOf(childInterest) {
    return Array.isArray(childInterest?.evidenceSummary?.interactionBreakdown)
        ? childInterest.evidenceSummary.interactionBreakdown
        : [];
}

function historyOf(childInterest) {
    return Array.isArray(childInterest?.scoreHistory)
        ? childInterest.scoreHistory
        : [];
}

function isBaselineOnly(childInterest) {
    return evidenceCountOf(childInterest) === 0 &&
        !hasEntries(historyOf(childInterest)) &&
        !hasEntries(breakdownOf(childInterest));
}

function eventIdentity(entry) {
    if (typeof entry?.eventId !== "string" || !entry.eventId.trim()) return null;
    if (typeof entry.eventType !== "string" || !entry.eventType.trim()) return null;
    return `${entry.eventId}:${entry.eventType}`;
}

function classifyEventsFromBreakdown(breakdown) {
    const passiveEvents = [];
    const meaningfulNonPassiveEvents = [];
    const reversalEvents = [];

    for (const item of breakdown) {
        const count = Number.isSafeInteger(item?.count) && item.count > 0 ? item.count : 0;
        if (!count) continue;
        const eventType = item.interactionType;
        const record = { eventType, count };
        if (PASSIVE_EVENTS.has(eventType)) passiveEvents.push(record);
        if (MEANINGFUL_NON_PASSIVE_EVENTS.has(eventType)) meaningfulNonPassiveEvents.push(record);
        if (REVERSAL_EVENTS.has(eventType)) reversalEvents.push(record);
    }

    return { passiveEvents, meaningfulNonPassiveEvents, reversalEvents };
}

function classifyVerifiedHistory(history) {
    const passiveEvents = [];
    const meaningfulNonPassiveEvents = [];
    const reversalEvents = [];
    const meaningfulIds = new Set();
    let hasPositiveMeaningful = false;
    let hasNegativeMeaningful = false;

    for (const entry of history) {
        const identity = eventIdentity(entry);
        const eventType = entry?.eventType;
        if (!identity || typeof eventType !== "string") continue;

        const record = {
            eventType,
            eventId: entry.eventId,
            identity,
            timestamp: entry.timestamp ?? null
        };

        if (PASSIVE_EVENTS.has(eventType)) passiveEvents.push(record);
        if (REVERSAL_EVENTS.has(eventType)) reversalEvents.push(record);
        if (!MEANINGFUL_NON_PASSIVE_EVENTS.has(eventType)) continue;

        meaningfulNonPassiveEvents.push(record);
        meaningfulIds.add(identity);

        if (Number.isFinite(entry.interestDelta)) {
            if (entry.interestDelta > 0) hasPositiveMeaningful = true;
            if (entry.interestDelta < 0) hasNegativeMeaningful = true;
        } else if (["Save", "Book", "Attend"].includes(eventType)) {
            hasPositiveMeaningful = true;
        } else if (eventType === "Dismiss") {
            hasNegativeMeaningful = true;
        }
    }

    return {
        passiveEvents,
        meaningfulNonPassiveEvents,
        reversalEvents,
        distinctMeaningfulNonPassiveCount: meaningfulIds.size,
        conflict: hasPositiveMeaningful && hasNegativeMeaningful
    };
}

function latestObservedEvidenceAt(history) {
    const timestamps = history
        .map((entry) => entry?.timestamp instanceof Date ? entry.timestamp.getTime()
            : typeof entry?.timestamp === "string" && entry.timestamp.trim() ? Date.parse(entry.timestamp) : NaN)
        .filter(Number.isFinite);

    if (!timestamps.length) return null;
    return new Date(Math.max(...timestamps));
}

function possibleResolversFor(state) {
    return state === D1_SUFFICIENCY.SUFFICIENT ? [] : [
        D1_RESOLVER.CHILD_BEHAVIOR,
        D1_RESOLVER.PARENT
    ];
}

function result(bundle, coverageState, sufficiencyState, reasons, details = {}) {
    const childInterest = bundle?.childInterest ?? null;
    const history = historyOf(childInterest);

    return {
        target: {
            type: "Subcategory",
            subcategoryId: bundle?.evaluation?.subcategoryId ?? null
        },
        coverageState,
        sufficiencyState,
        reasons,
        atInitialBaseline: childInterest ? isBaselineOnly(childInterest) : false,
        evidence: {
            score: childInterest?.interestScore?.currentScore ?? null,
            confidence: childInterest?.confidence?.currentScore ?? null,
            evidenceCount: evidenceCountOf(childInterest)
        },
        evidenceSemantics: details.evidenceSemantics ?? {
            passiveEvents: [],
            meaningfulNonPassiveEvents: [],
            reversalEvents: []
        },
        conflict: details.conflict ?? { detected: false, reason: null },
        freshness: {
            interestLastCalculatedAt: childInterest?.interestScore?.lastCalculatedAt ?? null,
            confidenceLastCalculatedAt: childInterest?.confidence?.lastCalculatedAt ?? null,
            lastDecayAt: childInterest?.interestScore?.lastDecayAt ?? null,
            metadataUpdatedAt: childInterest?.metadata?.updatedAt ?? null,
            latestObservedEvidenceAt: latestObservedEvidenceAt(history)
        },
        possibleResolvers: possibleResolversFor(sufficiencyState)
    };
}

function evaluateInterestCoverage(bundle) {
    if (bundle?.evaluation?.status && bundle.evaluation.status !== D1_EVALUATION_STATUS.RESOLVED) {
        return result(bundle, D1_COVERAGE.MISSING, D1_SUFFICIENCY.BLOCKED, ["EVALUATION_UNRESOLVABLE"]);
    }

    const childInterest = bundle?.childInterest ?? null;
    if (!childInterest) {
        return result(bundle, D1_COVERAGE.MISSING, D1_SUFFICIENCY.INSUFFICIENT, ["NO_INTEREST_EVIDENCE"]);
    }

    if (isBaselineOnly(childInterest)) {
        return result(bundle, D1_COVERAGE.AVAILABLE, D1_SUFFICIENCY.INSUFFICIENT, ["INITIAL_BASELINE_ONLY"]);
    }

    const evidenceCount = evidenceCountOf(childInterest);
    const history = historyOf(childInterest);
    const breakdown = breakdownOf(childInterest);

    if (evidenceCount > 0 && !hasEntries(history) && !hasEntries(breakdown)) {
        return result(bundle, D1_COVERAGE.AVAILABLE, D1_SUFFICIENCY.UNCERTAIN, ["EVIDENCE_PROVENANCE_UNAVAILABLE"]);
    }

    const verified = classifyVerifiedHistory(history);
    const aggregate = classifyEventsFromBreakdown(breakdown);
    const semantics = hasEntries(history) ? {
        passiveEvents: verified.passiveEvents,
        meaningfulNonPassiveEvents: verified.meaningfulNonPassiveEvents,
        reversalEvents: verified.reversalEvents
    } : aggregate;

    const conflict = {
        detected: verified.conflict,
        reason: verified.conflict ? "OPPOSING_MEANINGFUL_INTEREST_DELTAS" : null
    };

    if (verified.conflict) {
        return result(bundle, D1_COVERAGE.AVAILABLE, D1_SUFFICIENCY.UNCERTAIN,
            ["CONFLICTING_INTEREST_EVIDENCE"], { evidenceSemantics: semantics, conflict });
    }

    if (!verified.meaningfulNonPassiveEvents.length && !aggregate.meaningfulNonPassiveEvents.length &&
        (verified.passiveEvents.length || aggregate.passiveEvents.length)) {
        return result(bundle, D1_COVERAGE.AVAILABLE, D1_SUFFICIENCY.UNCERTAIN,
            ["PASSIVE_EVIDENCE_ONLY"], { evidenceSemantics: semantics, conflict });
    }

    if (verified.distinctMeaningfulNonPassiveCount >= MIN_CORROBORATING_NON_PASSIVE_EVENTS) {
        return result(bundle, D1_COVERAGE.AVAILABLE, D1_SUFFICIENCY.SUFFICIENT,
            [], { evidenceSemantics: semantics, conflict });
    }

    if (verified.distinctMeaningfulNonPassiveCount === 1) {
        return result(bundle, D1_COVERAGE.AVAILABLE, D1_SUFFICIENCY.UNCERTAIN,
            ["LIMITED_CORROBORATION"], { evidenceSemantics: semantics, conflict });
    }

    if (aggregate.meaningfulNonPassiveEvents.length) {
        return result(bundle, D1_COVERAGE.AVAILABLE, D1_SUFFICIENCY.UNCERTAIN,
            ["CORROBORATION_NOT_VERIFIABLE"], { evidenceSemantics: semantics, conflict });
    }

    return result(bundle, D1_COVERAGE.AVAILABLE, D1_SUFFICIENCY.UNCERTAIN,
        ["EVIDENCE_PROVENANCE_UNAVAILABLE"], { evidenceSemantics: semantics, conflict });
}

module.exports = {
    evaluateInterestCoverage
};
