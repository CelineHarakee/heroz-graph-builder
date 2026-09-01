const {
    ELIGIBILITY_SCOPES
} = require("../recommendation/eligibilityResult");
const {
    checkRequestOperationalState,
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

function makeContext(overrides = {}) {
    const childId = "child-1";
    const parentId = "parent-1";

    return {
        child: {
            _id: childId,
            parentId,
            status: "Active"
        },
        parent: {
            _id: parentId,
            account: {
                status: "Active"
            }
        },
        ...overrides
    };
}

function makeCandidate(status, overrides = {}) {
    return {
        activity: {
            activityId: "activity-1"
        },
        currentActivity: {
            _id: "activity-1",
            basicInformation: {
                status
            }
        },
        ...overrides
    };
}

function findFailure(result, code) {
    return result.failedConstraints.find(
        (failure) => failure.code === code
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

function assertFailure(result, expected) {
    assertEqual("eligible", result.eligible, false);

    const failure = findFailure(result, expected.code);

    assert(failure, `missing failure ${expected.code}`);

    for (const [field, value] of Object.entries(expected)) {
        assertEqual(field, failure[field], value);
    }
}

function testActiveRequest() {
    assertEligible(
        "active request",
        checkRequestOperationalState(makeContext())
    );
}

function testInactiveChild() {
    const context = makeContext({
        child: {
            _id: "child-1",
            parentId: "parent-1",
            status: "Inactive"
        }
    });

    assertFailure(checkRequestOperationalState(context), {
        code: "CHILD_INACTIVE",
        scope: ELIGIBILITY_SCOPES.REQUEST,
        entityType: "Child",
        entityId: "child-1",
        fieldPath: "status",
        detail: "Child is not active"
    });
}

function testSuspendedParent() {
    const context = makeContext({
        parent: {
            _id: "parent-1",
            account: {
                status: "Suspended"
            }
        }
    });

    assertFailure(checkRequestOperationalState(context), {
        code: "PARENT_INACTIVE",
        scope: ELIGIBILITY_SCOPES.REQUEST,
        entityType: "Parent",
        entityId: "parent-1",
        fieldPath: "account.status",
        detail: "Parent is not active"
    });
}

function testDeletedParent() {
    const context = makeContext({
        parent: {
            _id: "parent-1",
            account: {
                status: "Deleted"
            }
        }
    });

    assertFailure(checkRequestOperationalState(context), {
        code: "PARENT_INACTIVE",
        scope: ELIGIBILITY_SCOPES.REQUEST,
        entityType: "Parent",
        entityId: "parent-1",
        fieldPath: "account.status",
        detail: "Parent is not active"
    });
}

function testMissingParent() {
    const context = makeContext({
        parent: null
    });

    assertFailure(checkRequestOperationalState(context), {
        code: "CONTEXT_MISSING",
        scope: ELIGIBILITY_SCOPES.REQUEST,
        entityType: "Parent",
        entityId: "parent-1",
        fieldPath: "parent",
        detail: "Parent context is missing"
    });
}

function testParentChildMismatch() {
    const context = makeContext({
        parent: {
            _id: "parent-2",
            account: {
                status: "Active"
            }
        }
    });

    assertFailure(checkRequestOperationalState(context), {
        code: "PARENT_CHILD_MISMATCH",
        scope: ELIGIBILITY_SCOPES.REQUEST,
        entityType: "Child",
        entityId: "child-1",
        fieldPath: "parentId",
        detail: "Child parentId does not match the loaded Parent"
    });
}

function testMultipleRequestFailures() {
    const result = checkRequestOperationalState(makeContext({
        child: {
            _id: "child-1",
            parentId: "parent-1",
            status: "Inactive"
        },
        parent: {
            _id: "parent-2",
            account: {
                status: "Suspended"
            }
        }
    }));

    assertEqual("multiple eligible", result.eligible, false);
    assertEqual(
        "multiple failedConstraints length",
        result.failedConstraints.length,
        3
    );
    assert(findFailure(result, "CHILD_INACTIVE"), "missing CHILD_INACTIVE");
    assert(findFailure(result, "PARENT_INACTIVE"), "missing PARENT_INACTIVE");
    assert(
        findFailure(result, "PARENT_CHILD_MISMATCH"),
        "missing PARENT_CHILD_MISMATCH"
    );
}

function testMissingCurrentActivity() {
    assertFailure(
        checkCandidateEntity({
            activity: {
                activityId: "activity-1"
            },
            currentActivity: null
        }),
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

function testOldActivityIsActiveIgnored() {
    assertEligible(
        "old activity isActive false",
        checkCandidateEntity({
            currentActivity: {
                _id: "activity-1",
                isActive: false,
                basicInformation: {
                    status: "Published"
                }
            }
        })
    );
}

function testOldChildIsActiveIgnored() {
    assertEligible(
        "old child isActive false",
        checkRequestOperationalState(makeContext({
            child: {
                _id: "child-1",
                parentId: "parent-1",
                status: "Active",
                isActive: false
            }
        }))
    );

    assertFailure(
        checkRequestOperationalState(makeContext({
            child: {
                _id: "child-1",
                parentId: "parent-1",
                status: "Inactive",
                isActive: true
            }
        })),
        {
            code: "CHILD_INACTIVE",
            scope: ELIGIBILITY_SCOPES.REQUEST,
            entityType: "Child",
            entityId: "child-1",
            fieldPath: "status",
            detail: "Child is not active"
        }
    );
}

function main() {
    testActiveRequest();
    testInactiveChild();
    testSuspendedParent();
    testDeletedParent();
    testMissingParent();
    testParentChildMismatch();
    testMultipleRequestFailures();
    testMissingCurrentActivity();
    testOldChildIsActiveIgnored();
    testOldActivityIsActiveIgnored();

    console.log("========================================");
    console.log("STEP 14D — STATUS ELIGIBILITY");
    console.log("========================================");
    console.log("Active request:                   PASSED");
    console.log("Inactive Child:                   PASSED");
    console.log("Suspended Parent:                 PASSED");
    console.log("Deleted Parent:                   PASSED");
    console.log("Missing Parent:                   PASSED");
    console.log("Parent/Child mismatch:            PASSED");
    console.log("Multiple request failures:        PASSED");
    console.log("");
    console.log("Missing Activity preserved:       PASSED");
    console.log("Activity lifecycle status:        IGNORED");
    console.log("");
    console.log("Old child.isActive ignored:       PASSED");
    console.log("Old activity.isActive ignored:    PASSED");
    console.log("");
    console.log("Age rules:                        NONE");
    console.log("Gender rules:                     NONE");
    console.log("Parent requirements:              NONE");
    console.log("Parent exclusions:                NONE");
    console.log("Vendor rules:                     NONE");
    console.log("Session rules:                    NONE");
    console.log("Scoring:                          NONE");
    console.log("========================================");
    console.log("✅ PHASE 14D PASSED");
    console.log("========================================");
}

main();
