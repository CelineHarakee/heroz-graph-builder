const {
    ELIGIBILITY_SCOPES
} = require("../recommendation/eligibilityResult");
const {
    checkRequestContext,
    checkCandidateEntity
} = require("../recommendation/hardEligibilityService");

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

function testMissingContext() {
    const result = checkRequestContext(null);

    assertSingleFailure(result, {
        code: "CONTEXT_MISSING",
        scope: ELIGIBILITY_SCOPES.REQUEST,
        entityType: "Child",
        entityId: null,
        fieldPath: null,
        detail: "Recommendation context could not be established"
    });
}

function testUndefinedContext() {
    const result = checkRequestContext(undefined);

    assertSingleFailure(result, {
        code: "CONTEXT_MISSING",
        scope: ELIGIBILITY_SCOPES.REQUEST,
        entityType: "Child",
        entityId: null,
        fieldPath: null,
        detail: "Recommendation context could not be established"
    });
}

function testExistingContext() {
    const result = checkRequestContext({});

    assertEqual("existing context eligible", result.eligible, true);
    assertEqual(
        "existing context failedConstraints length",
        result.failedConstraints.length,
        0
    );
}

function testMissingCandidate() {
    const result = checkCandidateEntity(null);

    assertSingleFailure(result, {
        code: "ACTIVITY_MISSING",
        scope: ELIGIBILITY_SCOPES.CANDIDATE,
        entityType: "Activity",
        entityId: null,
        fieldPath: "currentActivity",
        detail: "Current Mongo Activity document is missing"
    });
}

function testMissingCurrentActivity() {
    const result = checkCandidateEntity({
        activity: {
            activityId: "activity-test-123"
        },
        currentActivity: null
    });

    assertSingleFailure(result, {
        code: "ACTIVITY_MISSING",
        scope: ELIGIBILITY_SCOPES.CANDIDATE,
        entityType: "Activity",
        entityId: "activity-test-123",
        fieldPath: "currentActivity",
        detail: "Current Mongo Activity document is missing"
    });
}

function testCurrentActivityExists() {
    const result = checkCandidateEntity({
        activity: {
            activityId: "activity-test-123"
        },
        currentActivity: {
            _id: "activity-test-123"
        }
    });

    assertEqual("current activity eligible", result.eligible, true);
    assertEqual(
        "current activity failedConstraints length",
        result.failedConstraints.length,
        0
    );
}

function testParentNullDoesNotFail() {
    const result = checkRequestContext({
        child: {},
        parent: null,
        candidates: []
    });

    assertEqual("parent null eligible", result.eligible, true);
    assertEqual(
        "parent null failedConstraints length",
        result.failedConstraints.length,
        0
    );
}

function testVendorAndSessionNotEvaluated() {
    const result = checkCandidateEntity({
        activity: {
            activityId: "activity-test-123"
        },
        currentActivity: {
            _id: "activity-test-123"
        },
        currentVendor: null,
        currentSessions: []
    });

    assertEqual("vendor/session eligible", result.eligible, true);
    assertEqual(
        "vendor/session failedConstraints length",
        result.failedConstraints.length,
        0
    );
}

function testActivityStatusNotEvaluated() {
    const result = checkCandidateEntity({
        activity: {
            activityId: "activity-test-123"
        },
        currentActivity: {
            _id: "activity-test-123",
            basicInformation: {
                status: "Draft"
            }
        }
    });

    assertEqual("activity status eligible", result.eligible, true);
    assertEqual(
        "activity status failedConstraints length",
        result.failedConstraints.length,
        0
    );
}

function main() {
    testMissingContext();
    testUndefinedContext();
    testExistingContext();
    testMissingCandidate();
    testMissingCurrentActivity();
    testCurrentActivityExists();
    testParentNullDoesNotFail();
    testVendorAndSessionNotEvaluated();
    testActivityStatusNotEvaluated();

    console.log("========================================");
    console.log("STEP 14C — BASIC HARD ELIGIBILITY");
    console.log("========================================");
    console.log("Missing context:                 PASSED");
    console.log("Undefined context:               PASSED");
    console.log("Existing context:                PASSED");
    console.log("Missing candidate:               PASSED");
    console.log("Missing current Activity:        PASSED");
    console.log("Current Activity exists:         PASSED");
    console.log("Missing Parent not evaluated:    PASSED");
    console.log("Vendor/Session not evaluated:    PASSED");
    console.log("Activity status not evaluated:   PASSED");
    console.log("");
    console.log("Age rules:                       NONE");
    console.log("Gender rules:                    NONE");
    console.log("Parent hard requirements:        NONE");
    console.log("Vendor rules:                    NONE");
    console.log("Session rules:                   NONE");
    console.log("Scoring logic:                   NONE");
    console.log("========================================");
    console.log("✅ PHASE 14C PASSED");
    console.log("========================================");
}

main();
