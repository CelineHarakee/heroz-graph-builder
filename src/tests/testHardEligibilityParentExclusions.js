const { ObjectId } = require("mongodb");
const {
    ELIGIBILITY_SCOPES
} = require("../recommendation/eligibilityResult");
const {
    checkParentExclusions
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

function makeContext(recommendationPreferences = {}) {
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
            recommendationPreferences
        }
    };
}

function makeCandidate({
    activityId = "activity-1",
    vendorId = "vendor-1"
} = {}) {
    return {
        activity: {
            activityId
        },
        currentActivity: {
            _id: activityId,
            vendorId
        }
    };
}

function findFailure(result, expected) {
    return result.failedConstraints.find(failure => (
        failure.code === expected.code &&
        failure.scope === expected.scope &&
        failure.entityType === expected.entityType &&
        failure.entityId === expected.entityId &&
        failure.fieldPath === expected.fieldPath
    ));
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
    assert(findFailure(result, expected), `missing failure ${expected.code}`);
}

function testEmptyExclusionArrays() {
    assertEligible(
        "empty exclusions",
        checkParentExclusions(
            makeContext({
                excludedActivityIds: [],
                excludedVendorIds: []
            }),
            makeCandidate()
        )
    );
}

function testMissingExclusionArrays() {
    assertEligible(
        "missing exclusions",
        checkParentExclusions(
            makeContext({}),
            makeCandidate()
        )
    );
}

function testActivityExcluded() {
    const result = checkParentExclusions(
        makeContext({
            excludedActivityIds: ["activity-1"],
            excludedVendorIds: []
        }),
        makeCandidate()
    );

    assertFailure(result, {
        code: "PARENT_EXCLUDED",
        scope: ELIGIBILITY_SCOPES.CANDIDATE,
        entityType: "Activity",
        entityId: "activity-1",
        fieldPath: "recommendationPreferences.excludedActivityIds"
    });
}

function testVendorExcluded() {
    const result = checkParentExclusions(
        makeContext({
            excludedActivityIds: [],
            excludedVendorIds: ["vendor-1"]
        }),
        makeCandidate()
    );

    assertFailure(result, {
        code: "PARENT_EXCLUDED",
        scope: ELIGIBILITY_SCOPES.CANDIDATE,
        entityType: "Vendor",
        entityId: "vendor-1",
        fieldPath: "recommendationPreferences.excludedVendorIds"
    });
}

function testBothExcluded() {
    const result = checkParentExclusions(
        makeContext({
            excludedActivityIds: ["activity-1"],
            excludedVendorIds: ["vendor-1"]
        }),
        makeCandidate()
    );

    assertEqual("eligible", result.eligible, false);
    assertEqual(
        "failedConstraints length",
        result.failedConstraints.length,
        2
    );
    assertFailure(result, {
        code: "PARENT_EXCLUDED",
        scope: ELIGIBILITY_SCOPES.CANDIDATE,
        entityType: "Activity",
        entityId: "activity-1",
        fieldPath: "recommendationPreferences.excludedActivityIds"
    });
    assertFailure(result, {
        code: "PARENT_EXCLUDED",
        scope: ELIGIBILITY_SCOPES.CANDIDATE,
        entityType: "Vendor",
        entityId: "vendor-1",
        fieldPath: "recommendationPreferences.excludedVendorIds"
    });
}

function testDifferentIdsPass() {
    assertEligible(
        "different ids",
        checkParentExclusions(
            makeContext({
                excludedActivityIds: ["activity-2"],
                excludedVendorIds: ["vendor-2"]
            }),
            makeCandidate()
        )
    );
}

function testSeparateObjectIdInstancesMatch() {
    const activityId = new ObjectId();
    const vendorId = new ObjectId();
    const result = checkParentExclusions(
        makeContext({
            excludedActivityIds: [new ObjectId(activityId.toHexString())],
            excludedVendorIds: [new ObjectId(vendorId.toHexString())]
        }),
        makeCandidate({
            activityId,
            vendorId
        })
    );

    assertEqual("ObjectId eligible", result.eligible, false);
    assertEqual("ObjectId failures", result.failedConstraints.length, 2);
}

function testStringIdsMatch() {
    const result = checkParentExclusions(
        makeContext({
            excludedActivityIds: ["activity-1"],
            excludedVendorIds: ["vendor-1"]
        }),
        makeCandidate()
    );

    assertEqual("string id eligible", result.eligible, false);
    assertEqual("string id failures", result.failedConstraints.length, 2);
}

function testMalformedActivityExclusionsPass() {
    assertEligible(
        "malformed activity exclusions",
        checkParentExclusions(
            makeContext({
                excludedActivityIds: "activity-1",
                excludedVendorIds: []
            }),
            makeCandidate()
        )
    );
}

function testMalformedVendorExclusionsPass() {
    assertEligible(
        "malformed vendor exclusions",
        checkParentExclusions(
            makeContext({
                excludedActivityIds: [],
                excludedVendorIds: "vendor-1"
            }),
            makeCandidate()
        )
    );
}

function testOtherRecommendationPreferencesIgnored() {
    assertEligible(
        "soft recommendationPreferences",
        checkParentExclusions(
            makeContext({
                preferredDays: ["Monday"],
                preferredTimeRanges: ["Morning"],
                preferredTravelDistanceKm: 1,
                budget: {
                    preferredMaximumAmount: 0
                },
                preferredActivityIds: ["different-activity"],
                preferredVendorIds: ["different-vendor"],
                transportationPreferred: true
            }),
            makeCandidate()
        )
    );
}

function main() {
    testEmptyExclusionArrays();
    testMissingExclusionArrays();
    testActivityExcluded();
    testVendorExcluded();
    testBothExcluded();
    testDifferentIdsPass();
    testSeparateObjectIdInstancesMatch();
    testStringIdsMatch();
    testMalformedActivityExclusionsPass();
    testMalformedVendorExclusionsPass();
    testOtherRecommendationPreferencesIgnored();

    console.log("========================================");
    console.log("STEP 14J-B — PARENT EXCLUSIONS");
    console.log("========================================");
    console.log("Empty exclusion arrays:             PASSED");
    console.log("Missing exclusion arrays:           PASSED");
    console.log("Activity excluded:                  PASSED");
    console.log("Vendor excluded:                    PASSED");
    console.log("Both excluded:                      PASSED");
    console.log("Different IDs pass:                 PASSED");
    console.log("ObjectId equality:                  PASSED");
    console.log("String ID equality:                 PASSED");
    console.log("Malformed Activity exclusions:      PASSED");
    console.log("Malformed Vendor exclusions:        PASSED");
    console.log("Other recommendationPreferences:    IGNORED");
    console.log("");
    console.log("Vendor eligibility:                 NONE");
    console.log("Category/Subcategory eligibility:   NONE");
    console.log("Bookings:                           NONE");
    console.log("Scoring/ranking:                    NONE");
    console.log("========================================");
    console.log("✅ PHASE 14J-B PARENT EXCLUSIONS PASSED");
    console.log("========================================");
}

main();
