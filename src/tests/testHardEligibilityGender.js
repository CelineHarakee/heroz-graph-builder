const {
    ELIGIBILITY_SCOPES
} = require("../recommendation/eligibilityResult");
const {
    checkGenderEligibility
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

function makeContext(gender, overrides = {}) {
    return {
        child: {
            identity: {
                gender
            }
        },
        ...overrides
    };
}

function makeCandidate(allowedGenders, overrides = {}) {
    return {
        activity: {
            activityId: "activity-1"
        },
        currentActivity: {
            _id: "activity-1",
            eligibility: {
                allowedGenders
            }
        },
        ...overrides
    };
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

function assertGenderFailure(result) {
    assertFailure(result, {
        code: "GENDER_NOT_ELIGIBLE",
        scope: ELIGIBILITY_SCOPES.CANDIDATE,
        entityType: "Activity",
        entityId: "activity-1",
        fieldPath: "eligibility.allowedGenders",
        detail: "Child gender is not allowed for this activity"
    });
}

function testFemaleAllowed() {
    assertEligible(
        "female allowed",
        checkGenderEligibility(
            makeContext("Female"),
            makeCandidate(["Female"])
        )
    );
}

function testBothGendersAllowed() {
    assertEligible(
        "both genders allowed",
        checkGenderEligibility(
            makeContext("Female"),
            makeCandidate(["Male", "Female"])
        )
    );
}

function testMaleAllowed() {
    assertEligible(
        "male allowed",
        checkGenderEligibility(
            makeContext("Male"),
            makeCandidate(["Male"])
        )
    );
}

function testFemaleMismatch() {
    assertGenderFailure(
        checkGenderEligibility(
            makeContext("Female"),
            makeCandidate(["Male"])
        )
    );
}

function testMaleMismatch() {
    assertGenderFailure(
        checkGenderEligibility(
            makeContext("Male"),
            makeCandidate(["Female"])
        )
    );
}

function testMissingAllowedGenders() {
    assertEligible(
        "missing allowedGenders",
        checkGenderEligibility(
            makeContext("Female"),
            {
                activity: {
                    activityId: "activity-1"
                },
                currentActivity: {
                    _id: "activity-1",
                    eligibility: {}
                }
            }
        )
    );
}

function testNullAllowedGenders() {
    assertEligible(
        "null allowedGenders",
        checkGenderEligibility(
            makeContext("Female"),
            makeCandidate(null)
        )
    );
}

function testEmptyAllowedGenders() {
    assertEligible(
        "empty allowedGenders",
        checkGenderEligibility(
            makeContext("Female"),
            makeCandidate([])
        )
    );
}

function testMissingEligibilityObject() {
    assertEligible(
        "missing eligibility object",
        checkGenderEligibility(
            makeContext("Female"),
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

function testMissingChildGender() {
    assertEligible(
        "missing child gender",
        checkGenderEligibility(
            { child: { identity: {} } },
            makeCandidate(["Female"])
        )
    );
}

function testNullChildGender() {
    assertEligible(
        "null child gender",
        checkGenderEligibility(
            makeContext(null),
            makeCandidate(["Female"])
        )
    );
}

function testEmptyChildGender() {
    assertEligible(
        "empty child gender",
        checkGenderEligibility(
            makeContext(""),
            makeCandidate(["Female"])
        )
    );
}

function testMalformedAllowedGenders() {
    assertEligible(
        "malformed allowedGenders",
        checkGenderEligibility(
            makeContext("Female"),
            makeCandidate("Female")
        )
    );
}

function testMissingContext() {
    assertFailure(
        checkGenderEligibility(null, makeCandidate(["Female"])),
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
        checkGenderEligibility(
            makeContext("Female"),
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

function testCanonicalNestedFields() {
    assertEligible(
        "canonical nested fields",
        checkGenderEligibility(
            {
                child: {
                    gender: "Male",
                    identity: {
                        gender: "Female"
                    }
                }
            },
            {
                currentActivity: {
                    allowedGenders: ["Male"],
                    eligibility: {
                        allowedGenders: ["Female"]
                    }
                }
            }
        )
    );
}

function main() {
    testFemaleAllowed();
    testBothGendersAllowed();
    testMaleAllowed();
    testFemaleMismatch();
    testMaleMismatch();
    testMissingAllowedGenders();
    testNullAllowedGenders();
    testEmptyAllowedGenders();
    testMissingEligibilityObject();
    testMissingChildGender();
    testNullChildGender();
    testEmptyChildGender();
    testMalformedAllowedGenders();
    testMissingContext();
    testMissingCurrentActivity();
    testCanonicalNestedFields();

    console.log("========================================");
    console.log("STEP 14E — GENDER ELIGIBILITY");
    console.log("========================================");
    console.log("Female allowed:                   PASSED");
    console.log("Both genders allowed:             PASSED");
    console.log("Male allowed:                     PASSED");
    console.log("Female mismatch rejected:         PASSED");
    console.log("Male mismatch rejected:           PASSED");
    console.log("");
    console.log("Missing allowedGenders:           PASSED");
    console.log("Null allowedGenders:              PASSED");
    console.log("Empty allowedGenders:             PASSED");
    console.log("Missing eligibility object:       PASSED");
    console.log("Missing Child gender:             PASSED");
    console.log("Null Child gender:                PASSED");
    console.log("Empty Child gender:               PASSED");
    console.log("Malformed allowedGenders:         PASSED");
    console.log("");
    console.log("Missing context preserved:        PASSED");
    console.log("Missing Activity preserved:       PASSED");
    console.log("Canonical nested fields:          PASSED");
    console.log("");
    console.log("Missing gender data hard-filter:  NONE");
    console.log("Age rules:                        NONE");
    console.log("Parent hard requirements:         NONE");
    console.log("Vendor rules:                     NONE");
    console.log("Session rules:                    NONE");
    console.log("Scoring:                          NONE");
    console.log("========================================");
    console.log("✅ PHASE 14E PASSED");
    console.log("========================================");
}

main();
