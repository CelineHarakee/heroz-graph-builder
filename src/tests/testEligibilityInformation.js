const {
    collectMissingEligibilityInformation
} = require("../recommendation/eligibilityInformationService");

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

function assertArrayEqual(label, actual, expected) {
    assertEqual(`${label} length`, actual.length, expected.length);

    for (let index = 0; index < expected.length; index += 1) {
        assertEqual(`${label} ${index}`, actual[index], expected[index]);
    }
}

function makeContext({
    gender = "Female",
    accessibilityRequirements = [],
    safetyRequirements = [],
    extraHardRequirements = {}
} = {}) {
    return {
        child: {
            identity: {
                gender
            }
        },
        parent: {
            hardRequirements: {
                accessibilityRequirements,
                safetyRequirements,
                ...extraHardRequirements
            }
        }
    };
}

function makeCandidate({
    allowedGenders = ["Male", "Female"],
    accessibilityFeatures = ["Wheelchair Accessible"],
    safetyRequirements = ["First Aid Available"],
    includeEligibility = true,
    includeAllowedGenders = true,
    includeActivityConstraints = true,
    includeAccessibilityFeatures = true,
    includeSafetyRequirements = true
} = {}) {
    const currentActivity = {
        _id: "activity-1"
    };

    if (includeEligibility) {
        currentActivity.eligibility = {};

        if (includeAllowedGenders) {
            currentActivity.eligibility.allowedGenders = allowedGenders;
        }
    }

    if (includeActivityConstraints) {
        currentActivity.activityConstraints = {};

        if (includeAccessibilityFeatures) {
            currentActivity.activityConstraints.accessibilityFeatures =
                accessibilityFeatures;
        }

        if (includeSafetyRequirements) {
            currentActivity.activityConstraints.safetyRequirements =
                safetyRequirements;
        }
    }

    return {
        activity: {
            activityId: "activity-1"
        },
        currentActivity
    };
}

function findRecord(records, code) {
    return records.find(record => record.code === code);
}

function assertNoRecord(records, code) {
    assert(!findRecord(records, code), `unexpected record ${code}`);
}

function assertRecord(records, expected) {
    const record = findRecord(records, expected.code);

    assert(record, `missing record ${expected.code}`);
    assertEqual("code", record.code, expected.code);
    assertEqual("entityType", record.entityType, "Activity");
    assertEqual("entityId", record.entityId, "activity-1");
    assertEqual("fieldPath", record.fieldPath, expected.fieldPath);
    assertArrayEqual(
        "requiredValues",
        record.requiredValues,
        expected.requiredValues
    );
    assertEqual("detail", record.detail, expected.detail);
}

function testCompleteInformation() {
    const records = collectMissingEligibilityInformation(
        makeContext({
            accessibilityRequirements: ["Wheelchair Accessible"],
            safetyRequirements: ["First Aid Available"]
        }),
        makeCandidate()
    );

    assertEqual("complete information", records.length, 0);
}

function testMissingAllowedGenders() {
    const records = collectMissingEligibilityInformation(
        makeContext(),
        makeCandidate({ includeAllowedGenders: false })
    );

    assertEqual("missing allowed genders count", records.length, 1);
    assertRecord(records, {
        code: "ALLOWED_GENDERS_UNCONFIRMED",
        fieldPath: "eligibility.allowedGenders",
        requiredValues: ["Female"],
        detail: "Allowed gender information has not been confirmed"
    });
}

function testNullAllowedGenders() {
    const records = collectMissingEligibilityInformation(
        makeContext(),
        makeCandidate({ allowedGenders: null })
    );

    assertRecord(records, {
        code: "ALLOWED_GENDERS_UNCONFIRMED",
        fieldPath: "eligibility.allowedGenders",
        requiredValues: ["Female"],
        detail: "Allowed gender information has not been confirmed"
    });
}

function testEmptyAllowedGenders() {
    const records = collectMissingEligibilityInformation(
        makeContext(),
        makeCandidate({ allowedGenders: [] })
    );

    assertRecord(records, {
        code: "ALLOWED_GENDERS_UNCONFIRMED",
        fieldPath: "eligibility.allowedGenders",
        requiredValues: ["Female"],
        detail: "Allowed gender information has not been confirmed"
    });
}

function testMalformedAllowedGenders() {
    const records = collectMissingEligibilityInformation(
        makeContext(),
        makeCandidate({ allowedGenders: "Female" })
    );

    assertRecord(records, {
        code: "ALLOWED_GENDERS_UNCONFIRMED",
        fieldPath: "eligibility.allowedGenders",
        requiredValues: ["Female"],
        detail: "Allowed gender information has not been confirmed"
    });
}

function testMissingChildGenderHandling() {
    const records = collectMissingEligibilityInformation(
        {
            child: {
                identity: {}
            },
            parent: {
                hardRequirements: {
                    accessibilityRequirements: [],
                    safetyRequirements: []
                }
            }
        },
        makeCandidate({ includeAllowedGenders: false })
    );

    assertEqual("missing child gender count", records.length, 1);
    assertRecord(records, {
        code: "ALLOWED_GENDERS_UNCONFIRMED",
        fieldPath: "eligibility.allowedGenders",
        requiredValues: [],
        detail: "Allowed gender information has not been confirmed"
    });
}

function testExplicitGenderMismatchIgnored() {
    const records = collectMissingEligibilityInformation(
        makeContext({ gender: "Female" }),
        makeCandidate({ allowedGenders: ["Male"] })
    );

    assertEqual("explicit gender mismatch", records.length, 0);
}

function testMissingAccessibilityInfo() {
    const records = collectMissingEligibilityInformation(
        makeContext({
            accessibilityRequirements: ["Wheelchair Accessible"]
        }),
        makeCandidate({ includeAccessibilityFeatures: false })
    );

    assertRecord(records, {
        code: "ACCESSIBILITY_INFO_UNCONFIRMED",
        fieldPath: "activityConstraints.accessibilityFeatures",
        requiredValues: ["Wheelchair Accessible"],
        detail: "Accessibility information has not been confirmed"
    });
}

function testNullAccessibilityInfo() {
    const records = collectMissingEligibilityInformation(
        makeContext({
            accessibilityRequirements: ["Wheelchair Accessible"]
        }),
        makeCandidate({ accessibilityFeatures: null })
    );

    assertRecord(records, {
        code: "ACCESSIBILITY_INFO_UNCONFIRMED",
        fieldPath: "activityConstraints.accessibilityFeatures",
        requiredValues: ["Wheelchair Accessible"],
        detail: "Accessibility information has not been confirmed"
    });
}

function testEmptyAccessibilityInfo() {
    const records = collectMissingEligibilityInformation(
        makeContext({
            accessibilityRequirements: ["Wheelchair Accessible"]
        }),
        makeCandidate({ accessibilityFeatures: [] })
    );

    assertRecord(records, {
        code: "ACCESSIBILITY_INFO_UNCONFIRMED",
        fieldPath: "activityConstraints.accessibilityFeatures",
        requiredValues: ["Wheelchair Accessible"],
        detail: "Accessibility information has not been confirmed"
    });
}

function testMalformedAccessibilityInfo() {
    const records = collectMissingEligibilityInformation(
        makeContext({
            accessibilityRequirements: ["Wheelchair Accessible"]
        }),
        makeCandidate({ accessibilityFeatures: "Wheelchair Accessible" })
    );

    assertRecord(records, {
        code: "ACCESSIBILITY_INFO_UNCONFIRMED",
        fieldPath: "activityConstraints.accessibilityFeatures",
        requiredValues: ["Wheelchair Accessible"],
        detail: "Accessibility information has not been confirmed"
    });
}

function testNoParentAccessibilityRequirement() {
    const records = collectMissingEligibilityInformation(
        makeContext({ accessibilityRequirements: [] }),
        makeCandidate({ includeAccessibilityFeatures: false })
    );

    assertNoRecord(records, "ACCESSIBILITY_INFO_UNCONFIRMED");
}

function testExplicitAccessibilityMismatch() {
    const records = collectMissingEligibilityInformation(
        makeContext({
            accessibilityRequirements: ["Wheelchair Accessible"]
        }),
        makeCandidate({ accessibilityFeatures: ["Stairs Only"] })
    );

    assertNoRecord(records, "ACCESSIBILITY_INFO_UNCONFIRMED");
}

function testMissingSafetyInfo() {
    const records = collectMissingEligibilityInformation(
        makeContext({
            safetyRequirements: ["First Aid Available"]
        }),
        makeCandidate({ includeSafetyRequirements: false })
    );

    assertRecord(records, {
        code: "SAFETY_INFO_UNCONFIRMED",
        fieldPath: "activityConstraints.safetyRequirements",
        requiredValues: ["First Aid Available"],
        detail: "Safety information has not been confirmed"
    });
}

function testEmptySafetyInfo() {
    const records = collectMissingEligibilityInformation(
        makeContext({
            safetyRequirements: ["First Aid Available"]
        }),
        makeCandidate({ safetyRequirements: [] })
    );

    assertRecord(records, {
        code: "SAFETY_INFO_UNCONFIRMED",
        fieldPath: "activityConstraints.safetyRequirements",
        requiredValues: ["First Aid Available"],
        detail: "Safety information has not been confirmed"
    });
}

function testNoParentSafetyRequirement() {
    const records = collectMissingEligibilityInformation(
        makeContext({ safetyRequirements: [] }),
        makeCandidate({ includeSafetyRequirements: false })
    );

    assertNoRecord(records, "SAFETY_INFO_UNCONFIRMED");
}

function testExplicitSafetyMismatch() {
    const records = collectMissingEligibilityInformation(
        makeContext({
            safetyRequirements: ["First Aid Available"]
        }),
        makeCandidate({ safetyRequirements: ["Protective Equipment"] })
    );

    assertNoRecord(records, "SAFETY_INFO_UNCONFIRMED");
}

function testMultipleMissingFields() {
    const records = collectMissingEligibilityInformation(
        makeContext({
            gender: "Female",
            accessibilityRequirements: ["Wheelchair Accessible"],
            safetyRequirements: ["First Aid Available"]
        }),
        makeCandidate({
            includeAllowedGenders: false,
            includeAccessibilityFeatures: false,
            includeSafetyRequirements: false
        })
    );

    assertEqual("multiple missing fields", records.length, 3);
    assertEqual("first missing code", records[0].code, "ALLOWED_GENDERS_UNCONFIRMED");
    assertEqual("second missing code", records[1].code, "ACCESSIBILITY_INFO_UNCONFIRMED");
    assertEqual("third missing code", records[2].code, "SAFETY_INFO_UNCONFIRMED");
}

function testRequiredValueIsolation() {
    const accessibilityRequirements = ["Wheelchair Accessible"];
    const context = makeContext({ accessibilityRequirements });
    const records = collectMissingEligibilityInformation(
        context,
        makeCandidate({ includeAccessibilityFeatures: false })
    );
    const record = findRecord(records, "ACCESSIBILITY_INFO_UNCONFIRMED");

    assert(
        record.requiredValues !== accessibilityRequirements,
        "requiredValues must be copied"
    );
    assertArrayEqual(
        "copied requiredValues",
        record.requiredValues,
        ["Wheelchair Accessible"]
    );

    accessibilityRequirements.push("Accessible Restroom");

    assertArrayEqual(
        "returned requiredValues after source mutation",
        record.requiredValues,
        ["Wheelchair Accessible"]
    );
}

function testMissingContext() {
    const records = collectMissingEligibilityInformation(
        null,
        makeCandidate()
    );

    assertEqual("missing context", records.length, 0);
}

function testMissingCandidate() {
    const records = collectMissingEligibilityInformation(
        makeContext(),
        null
    );

    assertEqual("missing candidate", records.length, 0);
}

function testMissingActivity() {
    const records = collectMissingEligibilityInformation(
        makeContext(),
        {
            activity: {
                activityId: "activity-1"
            },
            currentActivity: null
        }
    );

    assertEqual("missing activity", records.length, 0);
}

function testDeferredRequirementsIgnored() {
    const records = collectMissingEligibilityInformation(
        makeContext({
            extraHardRequirements: {
                medicalRequirements: ["Some Medical Requirement"],
                requiredInstructorGender: "Female",
                allergyRestrictions: ["Peanuts"],
                transportationRequired: true
            }
        }),
        makeCandidate()
    );

    assertEqual("deferred requirements ignored", records.length, 0);
}

function main() {
    testCompleteInformation();
    testMissingAllowedGenders();
    testNullAllowedGenders();
    testEmptyAllowedGenders();
    testMalformedAllowedGenders();
    testMissingChildGenderHandling();
    testExplicitGenderMismatchIgnored();
    testMissingAccessibilityInfo();
    testNullAccessibilityInfo();
    testEmptyAccessibilityInfo();
    testMalformedAccessibilityInfo();
    testNoParentAccessibilityRequirement();
    testExplicitAccessibilityMismatch();
    testMissingSafetyInfo();
    testEmptySafetyInfo();
    testNoParentSafetyRequirement();
    testExplicitSafetyMismatch();
    testMultipleMissingFields();
    testRequiredValueIsolation();
    testMissingContext();
    testMissingCandidate();
    testMissingActivity();
    testDeferredRequirementsIgnored();

    console.log("========================================");
    console.log("STEP 14F2 — MISSING ELIGIBILITY INFO");
    console.log("========================================");
    console.log("Complete information:                 PASSED");
    console.log("");
    console.log("Missing allowed genders:              PASSED");
    console.log("Null allowed genders:                 PASSED");
    console.log("Empty allowed genders:                PASSED");
    console.log("Malformed allowed genders:            PASSED");
    console.log("Missing Child gender handling:        PASSED");
    console.log("Explicit gender mismatch ignored:     PASSED");
    console.log("");
    console.log("Missing accessibility info:           PASSED");
    console.log("Null accessibility info:              PASSED");
    console.log("Empty accessibility info:             PASSED");
    console.log("Malformed accessibility info:         PASSED");
    console.log("No Parent accessibility requirement:  PASSED");
    console.log("Explicit accessibility mismatch:      PASSED");
    console.log("");
    console.log("Missing safety info:                  PASSED");
    console.log("Empty safety info:                    PASSED");
    console.log("No Parent safety requirement:         PASSED");
    console.log("Explicit safety mismatch:             PASSED");
    console.log("");
    console.log("Multiple missing fields:              PASSED");
    console.log("Required value isolation:             PASSED");
    console.log("");
    console.log("Missing context:                      PASSED");
    console.log("Missing candidate:                    PASSED");
    console.log("Missing Activity:                     PASSED");
    console.log("Deferred requirements ignored:        PASSED");
    console.log("");
    console.log("Hard eligibility failures created:    NONE");
    console.log("Soft score applied:                   NONE");
    console.log("Vendor notifications sent:            NONE");
    console.log("Parent messages generated:             NONE");
    console.log("========================================");
    console.log("✅ PHASE 14F2 PASSED");
    console.log("========================================");
}

main();
