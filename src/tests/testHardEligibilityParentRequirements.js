const {
    ELIGIBILITY_SCOPES
} = require("../recommendation/eligibilityResult");
const {
    checkParentHardRequirements
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

function makeContext(hardRequirements = {}) {
    return {
        child: {
            _id: "child-1",
            parentId: "parent-1",
            status: "Active"
        },
        parent: {
            _id: "parent-1",
            account: {
                status: "Active"
            },
            hardRequirements
        }
    };
}

function makeCandidate(activityConstraints = {}) {
    return {
        activity: {
            activityId: "activity-1"
        },
        currentActivity: {
            _id: "activity-1",
            activityConstraints
        }
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

function assertFailure(result, expected) {
    assertEqual("eligible", result.eligible, false);

    const failure = findFailure(result, expected.code);

    assert(failure, `missing failure ${expected.code}`);

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

function testNoAccessibilityRequirement() {
    assertEligible(
        "no accessibility requirement",
        checkParentHardRequirements(
            makeContext({ accessibilityRequirements: [] }),
            makeCandidate({ accessibilityFeatures: [] })
        )
    );
}

function testAccessibilityExactMatch() {
    assertEligible(
        "accessibility exact match",
        checkParentHardRequirements(
            makeContext({
                accessibilityRequirements: ["Wheelchair Accessible"]
            }),
            makeCandidate({
                accessibilityFeatures: ["Wheelchair Accessible"]
            })
        )
    );
}

function testAccessibilityMultipleMatch() {
    assertEligible(
        "accessibility multiple match",
        checkParentHardRequirements(
            makeContext({
                accessibilityRequirements: [
                    "Wheelchair Accessible",
                    "Accessible Restroom"
                ]
            }),
            makeCandidate({
                accessibilityFeatures: [
                    "Elevator",
                    "Wheelchair Accessible",
                    "Accessible Restroom"
                ]
            })
        )
    );
}

function testAccessibilityMismatch() {
    assertFailure(
        checkParentHardRequirements(
            makeContext({
                accessibilityRequirements: ["Wheelchair Accessible"]
            }),
            makeCandidate({
                accessibilityFeatures: ["Stairs Only"]
            })
        ),
        {
            code: "REQUIREMENT_NOT_MET",
            scope: ELIGIBILITY_SCOPES.CANDIDATE,
            entityType: "Activity",
            entityId: "activity-1",
            fieldPath: "activityConstraints.accessibilityFeatures",
            detail: "Activity does not satisfy the Parent accessibility requirements"
        }
    );
}

function testAccessibilityPartialMismatch() {
    assertFailure(
        checkParentHardRequirements(
            makeContext({
                accessibilityRequirements: [
                    "Wheelchair Accessible",
                    "Accessible Restroom"
                ]
            }),
            makeCandidate({
                accessibilityFeatures: ["Wheelchair Accessible"]
            })
        ),
        {
            code: "REQUIREMENT_NOT_MET",
            scope: ELIGIBILITY_SCOPES.CANDIDATE,
            entityType: "Activity",
            entityId: "activity-1",
            fieldPath: "activityConstraints.accessibilityFeatures",
            detail: "Activity does not satisfy the Parent accessibility requirements"
        }
    );
}

function testAccessibilityMissingData() {
    assertEligible(
        "accessibility missing data",
        checkParentHardRequirements(
            makeContext({
                accessibilityRequirements: ["Wheelchair Accessible"]
            }),
            makeCandidate({})
        )
    );
}

function testAccessibilityNullData() {
    assertEligible(
        "accessibility null data",
        checkParentHardRequirements(
            makeContext({
                accessibilityRequirements: ["Wheelchair Accessible"]
            }),
            makeCandidate({ accessibilityFeatures: null })
        )
    );
}

function testAccessibilityEmptyData() {
    assertEligible(
        "accessibility empty data",
        checkParentHardRequirements(
            makeContext({
                accessibilityRequirements: ["Wheelchair Accessible"]
            }),
            makeCandidate({ accessibilityFeatures: [] })
        )
    );
}

function testAccessibilityMalformedData() {
    assertEligible(
        "accessibility malformed data",
        checkParentHardRequirements(
            makeContext({
                accessibilityRequirements: ["Wheelchair Accessible"]
            }),
            makeCandidate({ accessibilityFeatures: "Wheelchair Accessible" })
        )
    );
}

function testNoSafetyRequirement() {
    assertEligible(
        "no safety requirement",
        checkParentHardRequirements(
            makeContext({ safetyRequirements: [] }),
            makeCandidate({ safetyRequirements: [] })
        )
    );
}

function testSafetyExactMatch() {
    assertEligible(
        "safety exact match",
        checkParentHardRequirements(
            makeContext({
                safetyRequirements: ["First Aid Available"]
            }),
            makeCandidate({
                safetyRequirements: ["First Aid Available"]
            })
        )
    );
}

function testSafetyMultipleMatch() {
    assertEligible(
        "safety multiple match",
        checkParentHardRequirements(
            makeContext({
                safetyRequirements: [
                    "First Aid Available",
                    "Protective Equipment"
                ]
            }),
            makeCandidate({
                safetyRequirements: [
                    "Protective Equipment",
                    "First Aid Available",
                    "Emergency Exit"
                ]
            })
        )
    );
}

function testSafetyMismatch() {
    assertFailure(
        checkParentHardRequirements(
            makeContext({
                safetyRequirements: ["First Aid Available"]
            }),
            makeCandidate({
                safetyRequirements: ["Protective Equipment"]
            })
        ),
        {
            code: "REQUIREMENT_NOT_MET",
            scope: ELIGIBILITY_SCOPES.CANDIDATE,
            entityType: "Activity",
            entityId: "activity-1",
            fieldPath: "activityConstraints.safetyRequirements",
            detail: "Activity does not satisfy the Parent safety requirements"
        }
    );
}

function testSafetyMissingData() {
    assertEligible(
        "safety missing data",
        checkParentHardRequirements(
            makeContext({
                safetyRequirements: ["First Aid Available"]
            }),
            makeCandidate({})
        )
    );
}

function testSafetyEmptyData() {
    assertEligible(
        "safety empty data",
        checkParentHardRequirements(
            makeContext({
                safetyRequirements: ["First Aid Available"]
            }),
            makeCandidate({ safetyRequirements: [] })
        )
    );
}

function testBothRequirementsMatch() {
    assertEligible(
        "both requirements match",
        checkParentHardRequirements(
            makeContext({
                accessibilityRequirements: ["Wheelchair Accessible"],
                safetyRequirements: ["First Aid Available"]
            }),
            makeCandidate({
                accessibilityFeatures: ["Wheelchair Accessible"],
                safetyRequirements: ["First Aid Available"]
            })
        )
    );
}

function testAccessibilityOnlyFailure() {
    assertFailureCodes(
        checkParentHardRequirements(
            makeContext({
                accessibilityRequirements: ["Wheelchair Accessible"],
                safetyRequirements: ["First Aid Available"]
            }),
            makeCandidate({
                accessibilityFeatures: ["Stairs Only"],
                safetyRequirements: ["First Aid Available"]
            })
        ),
        ["REQUIREMENT_NOT_MET"]
    );
}

function testSafetyOnlyFailure() {
    assertFailureCodes(
        checkParentHardRequirements(
            makeContext({
                accessibilityRequirements: ["Wheelchair Accessible"],
                safetyRequirements: ["First Aid Available"]
            }),
            makeCandidate({
                accessibilityFeatures: ["Wheelchair Accessible"],
                safetyRequirements: ["Protective Equipment"]
            })
        ),
        ["REQUIREMENT_NOT_MET"]
    );
}

function testBothExplicitFailures() {
    assertFailureCodes(
        checkParentHardRequirements(
            makeContext({
                accessibilityRequirements: ["Wheelchair Accessible"],
                safetyRequirements: ["First Aid Available"]
            }),
            makeCandidate({
                accessibilityFeatures: ["Stairs Only"],
                safetyRequirements: ["Protective Equipment"]
            })
        ),
        [
            "REQUIREMENT_NOT_MET",
            "REQUIREMENT_NOT_MET"
        ]
    );
}

function testBothVendorFieldsMissing() {
    assertEligible(
        "both vendor fields missing",
        checkParentHardRequirements(
            makeContext({
                accessibilityRequirements: ["Wheelchair Accessible"],
                safetyRequirements: ["First Aid Available"]
            }),
            makeCandidate({})
        )
    );
}

function testMissingActivityConstraints() {
    assertEligible(
        "missing activityConstraints",
        checkParentHardRequirements(
            makeContext({
                accessibilityRequirements: ["Wheelchair Accessible"],
                safetyRequirements: ["First Aid Available"]
            }),
            {
                activity: {
                    activityId: "activity-1"
                },
                currentActivity: {
                    _id: "activity-1"
                }
            }
        )
    );
}

function testDeferredRequirementsIgnored() {
    assertEligible(
        "deferred requirements ignored",
        checkParentHardRequirements(
            makeContext({
                medicalRequirements: ["Some Medical Requirement"],
                requiredInstructorGender: "Female",
                allergyRestrictions: ["Peanuts"],
                transportationRequired: true
            }),
            makeCandidate({})
        )
    );
}

function testMissingContext() {
    assertFailure(
        checkParentHardRequirements(null, makeCandidate({})),
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

function testMissingCurrentActivity() {
    assertFailure(
        checkParentHardRequirements(
            makeContext({
                accessibilityRequirements: ["Wheelchair Accessible"]
            }),
            {
                activity: {
                    activityId: "activity-1"
                },
                currentActivity: null
            }
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

function main() {
    testNoAccessibilityRequirement();
    testAccessibilityExactMatch();
    testAccessibilityMultipleMatch();
    testAccessibilityMismatch();
    testAccessibilityPartialMismatch();
    testAccessibilityMissingData();
    testAccessibilityNullData();
    testAccessibilityEmptyData();
    testAccessibilityMalformedData();
    testNoSafetyRequirement();
    testSafetyExactMatch();
    testSafetyMultipleMatch();
    testSafetyMismatch();
    testSafetyMissingData();
    testSafetyEmptyData();
    testBothRequirementsMatch();
    testAccessibilityOnlyFailure();
    testSafetyOnlyFailure();
    testBothExplicitFailures();
    testBothVendorFieldsMissing();
    testMissingActivityConstraints();
    testDeferredRequirementsIgnored();
    testMissingContext();
    testMissingCurrentActivity();

    console.log("========================================");
    console.log("STEP 14F1 — PARENT HARD REQUIREMENTS");
    console.log("========================================");
    console.log("No accessibility requirement:       PASSED");
    console.log("Accessibility exact match:           PASSED");
    console.log("Accessibility multiple match:        PASSED");
    console.log("Accessibility mismatch rejected:     PASSED");
    console.log("Accessibility partial mismatch:      PASSED");
    console.log("Accessibility missing data:          PASSED");
    console.log("Accessibility null data:             PASSED");
    console.log("Accessibility empty data:            PASSED");
    console.log("Accessibility malformed data:        PASSED");
    console.log("");
    console.log("No safety requirement:                PASSED");
    console.log("Safety exact match:                   PASSED");
    console.log("Safety multiple match:                PASSED");
    console.log("Safety mismatch rejected:             PASSED");
    console.log("Safety missing data:                  PASSED");
    console.log("Safety empty data:                    PASSED");
    console.log("");
    console.log("Both requirements match:              PASSED");
    console.log("Accessibility-only failure:           PASSED");
    console.log("Safety-only failure:                  PASSED");
    console.log("Both explicit failures:               PASSED");
    console.log("");
    console.log("Both Vendor fields missing:           PASSED");
    console.log("Missing activityConstraints:          PASSED");
    console.log("Deferred requirements ignored:        PASSED");
    console.log("");
    console.log("Missing context preserved:            PASSED");
    console.log("Missing Activity preserved:           PASSED");
    console.log("");
    console.log("Medical rule:                          NONE");
    console.log("Instructor gender rule:                NONE");
    console.log("Allergy rule:                          NONE");
    console.log("Transportation rule:                   NONE");
    console.log("Missing-info warning layer:            NONE");
    console.log("Scoring/ranking:                       NONE");
    console.log("========================================");
    console.log("✅ PHASE 14F1 PASSED");
    console.log("========================================");
}

main();
