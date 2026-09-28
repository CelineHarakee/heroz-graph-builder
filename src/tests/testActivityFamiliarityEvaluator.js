const assert = require("assert");
const { ObjectId } = require("mongodb");
const { evaluateActivityFamiliarity } = require("../knowledgeGap/activityFamiliarityEvaluator");
const {
    D1_COVERAGE,
    D1_EVALUATION_STATUS,
    D1_RESOLVER,
    D1_SUFFICIENCY
} = require("../knowledgeGap/knowledgeGapConstants");

const childId = new ObjectId("64f100000000000000000001");
const siblingId = new ObjectId("64f100000000000000000002");
const activityId = new ObjectId("64f100000000000000000003");
const otherActivityId = new ObjectId("64f100000000000000000004");

function bundle({ interactions = [], bookings = [], recommendationExposure = [] } = {}) {
    return {
        evaluation: {
            status: D1_EVALUATION_STATUS.RESOLVED,
            childId: String(childId),
            activityId: String(activityId)
        },
        interactions,
        bookings,
        recommendationExposure
    };
}

function interaction(type, overrides = {}) {
    return {
        _id: overrides._id ?? new ObjectId(),
        actor: { childId: overrides.childId ?? childId },
        targetEntity: {
            entityType: "Activity",
            entityId: overrides.activityId ?? activityId
        },
        interactionDetails: {
            interactionType: type,
            ...(type === "Rate" ? { ratingValue: overrides.ratingValue ?? 5 } : {})
        },
        timestamp: overrides.timestamp ?? new Date("2026-01-01T00:00:00Z")
    };
}

function booking(overrides = {}) {
    return {
        _id: overrides._id ?? new ObjectId(),
        bookingDetails: {
            childId: overrides.childId ?? childId,
            activityId: overrides.activityId ?? activityId,
            status: overrides.status ?? "Confirmed",
            bookedAt: overrides.bookedAt ?? new Date("2026-01-01T00:00:00Z")
        },
        attendance: overrides.attendance
    };
}

function check(result, coverageState, sufficiencyState, familiarityStatus, reason = null) {
    assert.strictEqual(result.coverageState, coverageState);
    assert.strictEqual(result.sufficiencyState, sufficiencyState);
    assert.strictEqual(result.familiarityStatus, familiarityStatus);
    if (reason) assert(result.reasons.includes(reason), `${reason} missing from ${result.reasons}`);
}

function testNoHistory() {
    const result = evaluateActivityFamiliarity(bundle());
    check(result, D1_COVERAGE.MISSING, D1_SUFFICIENCY.INSUFFICIENT, "MISSING", "NO_ACTIVITY_HISTORY");
    assert.deepStrictEqual(result.possibleResolvers, [D1_RESOLVER.CHILD_BEHAVIOR]);
}

function testView() {
    const result = evaluateActivityFamiliarity(bundle({
        interactions: [interaction("View")]
    }));
    check(result, D1_COVERAGE.AVAILABLE, D1_SUFFICIENCY.SUFFICIENT, "ESTABLISHED");
    assert.strictEqual(result.events[0].eventType, "View");
}

function testDismiss() {
    const result = evaluateActivityFamiliarity(bundle({
        interactions: [interaction("Dismiss")]
    }));
    check(result, D1_COVERAGE.AVAILABLE, D1_SUFFICIENCY.SUFFICIENT, "ESTABLISHED");
    assert.strictEqual(result.events[0].eventType, "Dismiss");
}

function testExposureOnly() {
    const result = evaluateActivityFamiliarity(bundle({
        recommendationExposure: [{ recommendedItems: [{ activityId }] }]
    }));
    check(result, D1_COVERAGE.MISSING, D1_SUFFICIENCY.INSUFFICIENT, "MISSING", "NO_ACTIVITY_HISTORY");
}

function testSave() {
    const result = evaluateActivityFamiliarity(bundle({
        interactions: [interaction("Save")]
    }));
    check(result, D1_COVERAGE.AVAILABLE, D1_SUFFICIENCY.SUFFICIENT, "ESTABLISHED");
    assert.deepStrictEqual(
        { status: result.currentSavedState.status, saved: result.currentSavedState.saved },
        { status: "RESOLVED", saved: true }
    );
}

function testSaveUnsave() {
    const result = evaluateActivityFamiliarity(bundle({
        interactions: [
            interaction("Save", { timestamp: new Date("2026-01-01T00:00:00Z") }),
            interaction("Unsave", { timestamp: new Date("2026-01-02T00:00:00Z") })
        ]
    }));
    check(result, D1_COVERAGE.AVAILABLE, D1_SUFFICIENCY.SUFFICIENT, "ESTABLISHED");
    assert.deepStrictEqual(
        { status: result.currentSavedState.status, saved: result.currentSavedState.saved, eventType: result.currentSavedState.eventType },
        { status: "RESOLVED", saved: false, eventType: "Unsave" }
    );
}

function testBook() {
    const result = evaluateActivityFamiliarity(bundle({
        bookings: [booking({ attendance: { status: "NotAttended" } })]
    }));
    check(result, D1_COVERAGE.AVAILABLE, D1_SUFFICIENCY.SUFFICIENT, "ESTABLISHED");
    assert.deepStrictEqual(result.events.map((event) => event.eventType), ["Book"]);
}

function testAttend() {
    const result = evaluateActivityFamiliarity(bundle({
        bookings: [booking({
            status: "Cancelled",
            attendance: {
                status: "Attended",
                checkedInAt: new Date("2026-01-03T00:00:00Z")
            }
        })]
    }));
    check(result, D1_COVERAGE.AVAILABLE, D1_SUFFICIENCY.SUFFICIENT, "ESTABLISHED");
    assert.deepStrictEqual(result.events.map((event) => event.eventType), ["Attend"]);
}

function testBookAttendSharedIdentity() {
    const id = new ObjectId("64f100000000000000000099");
    const result = evaluateActivityFamiliarity(bundle({
        bookings: [booking({
            _id: id,
            attendance: {
                status: "CheckedOut",
                checkedOutAt: new Date("2026-01-04T00:00:00Z")
            }
        })]
    }));

    check(result, D1_COVERAGE.AVAILABLE, D1_SUFFICIENCY.SUFFICIENT, "ESTABLISHED");
    assert.deepStrictEqual(result.events.map((event) => `${event.eventId}:${event.eventType}`), [
        `${id}:Book`,
        `${id}:Attend`
    ]);
}

function testBookingNotAutomaticallyBoth() {
    const pending = evaluateActivityFamiliarity(bundle({
        bookings: [booking({ status: "Pending", attendance: { status: "NotAttended" } })]
    }));
    check(pending, D1_COVERAGE.MISSING, D1_SUFFICIENCY.INSUFFICIENT, "MISSING", "NO_ACTIVITY_HISTORY");

    const bookOnly = evaluateActivityFamiliarity(bundle({
        bookings: [booking({ attendance: { status: "NoShow" } })]
    }));
    assert.deepStrictEqual(bookOnly.events.map((event) => event.eventType), ["Book"]);
}

function testRating() {
    const result = evaluateActivityFamiliarity(bundle({
        interactions: [
            interaction("Rate", { ratingValue: 3, timestamp: new Date("2026-01-01T00:00:00Z") }),
            interaction("Rate", { ratingValue: 5, timestamp: new Date("2026-01-02T00:00:00Z") })
        ]
    }));
    check(result, D1_COVERAGE.AVAILABLE, D1_SUFFICIENCY.SUFFICIENT, "ESTABLISHED");
    assert.deepStrictEqual(
        { status: result.latestRating.status, ratingValue: result.latestRating.ratingValue },
        { status: "RESOLVED", ratingValue: 5 }
    );
}

function testAmbiguousRating() {
    const timestamp = new Date("2026-01-02T00:00:00Z");
    const result = evaluateActivityFamiliarity(bundle({
        interactions: [
            interaction("Rate", { ratingValue: 1, timestamp }),
            interaction("Rate", { ratingValue: 5, timestamp })
        ]
    }));
    check(result, D1_COVERAGE.AVAILABLE, D1_SUFFICIENCY.SUFFICIENT, "ESTABLISHED");
    assert.strictEqual(result.latestRating.status, "AMBIGUOUS");
}

function testSiblingIsolation() {
    const result = evaluateActivityFamiliarity(bundle({
        interactions: [interaction("View", { childId: siblingId })],
        bookings: [booking({ childId: siblingId })]
    }));
    check(result, D1_COVERAGE.MISSING, D1_SUFFICIENCY.INSUFFICIENT, "MISSING", "NO_ACTIVITY_HISTORY");
}

function testOtherActivityIsolation() {
    const result = evaluateActivityFamiliarity(bundle({
        interactions: [interaction("View", { activityId: otherActivityId })],
        bookings: [booking({ activityId: otherActivityId })]
    }));
    check(result, D1_COVERAGE.MISSING, D1_SUFFICIENCY.INSUFFICIENT, "MISSING", "NO_ACTIVITY_HISTORY");
}

function main() {
    testNoHistory();
    testView();
    testDismiss();
    testExposureOnly();
    testSave();
    testSaveUnsave();
    testBook();
    testAttend();
    testBookAttendSharedIdentity();
    testBookingNotAutomaticallyBoth();
    testRating();
    testAmbiguousRating();
    testSiblingIsolation();
    testOtherActivityIsolation();
    console.log("Activity familiarity evaluator tests: PASSED");
}

main();
