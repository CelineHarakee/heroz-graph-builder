const {
    ELIGIBILITY_SCOPES,
    createEligibilityFailure,
    buildEligibilityResult
} = require("../recommendation/eligibilityResult");

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

function assertThrows(label, fn) {
    let threw = false;

    try {
        fn();
    } catch (error) {
        threw = true;
    }

    assert(threw, `${label}: expected error`);
}

function makeFailure(overrides = {}) {
    return createEligibilityFailure({
        code: "TEST_FAILURE",
        scope: ELIGIBILITY_SCOPES.CANDIDATE,
        entityType: "Activity",
        entityId: "entity-test-id",
        fieldPath: null,
        detail: "Synthetic eligibility contract test",
        ...overrides
    });
}

function testEmptyResult() {
    const result = buildEligibilityResult([]);

    assertEqual("empty eligible", result.eligible, true);
    assert(
        Array.isArray(result.failedConstraints),
        "failedConstraints must be an array"
    );
    assertEqual(
        "empty failedConstraints length",
        result.failedConstraints.length,
        0
    );

    const defaultResult = buildEligibilityResult();

    assertEqual("default eligible", defaultResult.eligible, true);
    assertEqual(
        "default failedConstraints length",
        defaultResult.failedConstraints.length,
        0
    );
}

function testCandidateFailure() {
    const fieldPath = ["basicInformation", "status"].join(".");

    const failure = createEligibilityFailure({
        code: "TEST_ACTIVITY_FAILURE",
        scope: ELIGIBILITY_SCOPES.CANDIDATE,
        entityType: "Activity",
        entityId: "activity-test-id",
        fieldPath,
        detail: "Synthetic eligibility contract test"
    });

    const result = buildEligibilityResult([failure]);

    assertEqual("candidate eligible", result.eligible, false);
    assertEqual(
        "candidate failedConstraints length",
        result.failedConstraints.length,
        1
    );

    assertEqual("candidate code", failure.code, "TEST_ACTIVITY_FAILURE");
    assertEqual("candidate scope", failure.scope, ELIGIBILITY_SCOPES.CANDIDATE);
    assertEqual("candidate entityType", failure.entityType, "Activity");
    assertEqual("candidate entityId", failure.entityId, "activity-test-id");
    assertEqual("candidate fieldPath", failure.fieldPath, fieldPath);
    assertEqual(
        "candidate detail",
        failure.detail,
        "Synthetic eligibility contract test"
    );
}

function testRequestFailure() {
    const failure = makeFailure({
        code: "TEST_REQUEST_FAILURE",
        scope: ELIGIBILITY_SCOPES.REQUEST,
        entityType: "Child"
    });

    const result = buildEligibilityResult([failure]);

    assertEqual("request scope", failure.scope, ELIGIBILITY_SCOPES.REQUEST);
    assertEqual("request eligible", result.eligible, false);
}

function testSessionFailure() {
    const failure = makeFailure({
        code: "TEST_SESSION_FAILURE",
        scope: ELIGIBILITY_SCOPES.SESSION,
        entityType: "Session"
    });

    const result = buildEligibilityResult([failure]);

    assertEqual("session scope", failure.scope, ELIGIBILITY_SCOPES.SESSION);
    assertEqual("session entityType", failure.entityType, "Session");
    assertEqual("session eligible", result.eligible, false);
}

function testMultipleFailures() {
    const first = makeFailure({
        code: "TEST_FIRST_FAILURE",
        entityId: "first"
    });
    const second = makeFailure({
        code: "TEST_SECOND_FAILURE",
        entityId: "second"
    });

    const result = buildEligibilityResult([first, second]);

    assertEqual("multiple eligible", result.eligible, false);
    assertEqual(
        "multiple failedConstraints length",
        result.failedConstraints.length,
        2
    );
    assertEqual("multiple first order", result.failedConstraints[0], first);
    assertEqual("multiple second order", result.failedConstraints[1], second);
}

function testInputArrayIsolation() {
    const failure = makeFailure();
    const failures = [failure];
    const result = buildEligibilityResult(failures);

    assert(
        result.failedConstraints !== failures,
        "result must own a shallow-copied array"
    );
    assertEqual(
        "failure object identity",
        result.failedConstraints[0],
        failures[0]
    );
}

function testInvalidCode() {
    assertThrows("empty code", () => {
        makeFailure({ code: "" });
    });

    assertThrows("missing code", () => {
        createEligibilityFailure({
            scope: ELIGIBILITY_SCOPES.CANDIDATE,
            entityType: "Activity"
        });
    });
}

function testInvalidScope() {
    assertThrows("invalid scope", () => {
        makeFailure({ scope: "UNKNOWN" });
    });
}

function testInvalidEntityType() {
    assertThrows("empty entityType", () => {
        makeFailure({ entityType: "" });
    });
}

function testInvalidResultInput() {
    assertThrows("null failedConstraints", () => {
        buildEligibilityResult(null);
    });

    assertThrows("non-array failedConstraints", () => {
        buildEligibilityResult("invalid");
    });
}

function main() {
    testEmptyResult();
    testCandidateFailure();
    testRequestFailure();
    testSessionFailure();
    testMultipleFailures();
    testInputArrayIsolation();
    testInvalidCode();
    testInvalidScope();
    testInvalidEntityType();
    testInvalidResultInput();

    console.log("========================================");
    console.log("STEP 14B — ELIGIBILITY RESULT CONTRACT");
    console.log("========================================");
    console.log("Empty result:                    PASSED");
    console.log("Candidate failure:               PASSED");
    console.log("Request failure:                 PASSED");
    console.log("Session failure:                 PASSED");
    console.log("Multiple failures:               PASSED");
    console.log("Input array isolation:           PASSED");
    console.log("Invalid code validation:         PASSED");
    console.log("Invalid scope validation:        PASSED");
    console.log("Invalid entity validation:       PASSED");
    console.log("Invalid result input:            PASSED");
    console.log("");
    console.log("Soft preference fields:          NONE");
    console.log("Eligibility rules implemented:   NONE");
    console.log("Scoring logic:                   NONE");
    console.log("Ranking logic:                   NONE");
    console.log("========================================");
    console.log("✅ PHASE 14B PASSED");
    console.log("========================================");
}

main();
