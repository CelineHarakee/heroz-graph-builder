const assert = require("assert");
const {
    ERROR_CODES,
    validateExplanationGrounding
} = require("../explanation/groundingValidator");
const { GENERATION_STATUS } = require("../explanation/languageGenerator");

function plan(overrides = {}) {
    const base = {
        activity: {
            activityId: "activity_1",
            nameAr: "مختبر الروبوتات",
            nameEn: "Robotics Lab",
            resolved: true
        },
        reasonTypes: ["interest", "preference", "goal"],
        reasons: [
            {
                type: "interest",
                supportType: "exact_subcategory_interest",
                subcategory: { name: "Robotics", resolved: true }
            },
            {
                type: "preference",
                dimension: "environment",
                activityValue: "Indoor",
                sourceEvidence: { baseMatch: 0, adjustedScore: 0.45 }
            },
            {
                type: "goal",
                goal: { name: "Improve Problem Solving", resolved: true },
                matchedOutcomes: [
                    { name: "Problem Solving", resolved: true }
                ]
            }
        ],
        practicalSupport: {
            hasEligibleSession: true
        },
        neutralFallbackRequired: false
    };

    return {
        ...base,
        ...overrides
    };
}

function generated(overrides = {}) {
    return {
        reasonTypes: ["interest", "preference", "goal"],
        language: "en",
        status: GENERATION_STATUS.GENERATED,
        text: "We recommend Robotics Lab for these reasons. It connects with a demonstrated interest in Robotics. It fits a known environment preference: Indoor. It supports the goal Improve Problem Solving through practice around Problem Solving. An eligible session is also currently available.",
        ...overrides
    };
}

function codes(result) {
    return result.errors.map((error) => error.code);
}

function assertInvalid(label, result, code) {
    assert.strictEqual(result.valid, false, label);
    assert(codes(result).includes(code), `${label}: missing ${code}`);
}

function testValidGeneratedAccepted() {
    assert.deepStrictEqual(
        validateExplanationGrounding(plan(), generated(), "en"),
        { valid: true, errors: [] }
    );
}

function testReasonTypeStructuralFailures() {
    assertInvalid(
        "mismatch",
        validateExplanationGrounding(plan(), generated({
            reasonTypes: ["interest", "goal", "preference"]
        }), "en"),
        ERROR_CODES.REASON_TYPES_MISMATCH
    );
    assertInvalid(
        "extra",
        validateExplanationGrounding(plan(), generated({
            reasonTypes: ["interest", "preference", "goal", "session"]
        }), "en"),
        ERROR_CODES.REASON_TYPES_MISMATCH
    );
    assertInvalid(
        "missing",
        validateExplanationGrounding(plan(), generated({
            reasonTypes: ["interest", "preference"]
        }), "en"),
        ERROR_CODES.REASON_TYPES_MISMATCH
    );
    assertInvalid(
        "duplicate",
        validateExplanationGrounding(plan({
            reasonTypes: ["interest", "interest"],
            reasons: [{ type: "interest" }, { type: "interest" }]
        }), generated({
            reasonTypes: ["interest", "interest"]
        }), "en"),
        ERROR_CODES.DUPLICATE_REASON_TYPE
    );
}

function testTextLanguageAndStatusFailures() {
    assertInvalid(
        "empty",
        validateExplanationGrounding(plan(), generated({ text: "" }), "en"),
        ERROR_CODES.EMPTY_TEXT
    );
    assertInvalid(
        "unsupported language",
        validateExplanationGrounding(plan(), generated({ language: "fr" }), "fr"),
        ERROR_CODES.UNSUPPORTED_LANGUAGE
    );
    assertInvalid(
        "arabic under english",
        validateExplanationGrounding(plan(), generated({
            text: "نوصي بهذا النشاط."
        }), "en"),
        ERROR_CODES.LANGUAGE_SCRIPT_MISMATCH
    );
    assertInvalid(
        "english under arabic",
        validateExplanationGrounding(plan(), generated({
            language: "ar",
            text: "We recommend this activity."
        }), "ar"),
        ERROR_CODES.LANGUAGE_SCRIPT_MISMATCH
    );
    assertInvalid(
        "bad status",
        validateExplanationGrounding(plan(), generated({
            status: "neutral_fallback_required"
        }), "en"),
        ERROR_CODES.INVALID_GENERATION_STATUS
    );
}

function testScoreLeakage() {
    for (const text of [
        "This has a score of 0.8.",
        "This reason is 33% important.",
        "It is weighted at 16%.",
        "The normalized weight contribution is high."
    ]) {
        assertInvalid(
            text,
            validateExplanationGrounding(plan(), generated({ text }), "en"),
            ERROR_CODES.SCORE_LEAKAGE
        );
    }
}

function testUnsupportedSemanticClaims() {
    assertInvalid(
        "interest absent",
        validateExplanationGrounding(plan({
            reasonTypes: ["goal"],
            reasons: [plan().reasons[2]]
        }), generated({
            reasonTypes: ["goal"],
            text: "This supports the goal and shows your child's interest."
        }), "en"),
        ERROR_CODES.UNSUPPORTED_INTEREST_CLAIM
    );
    assertInvalid(
        "goal guarantee",
        validateExplanationGrounding(plan(), generated({
            text: "This guarantees improvement and mastery."
        }), "en"),
        ERROR_CODES.UNSUPPORTED_GOAL_CLAIM
    );
    assertInvalid(
        "exploration popularity",
        validateExplanationGrounding(plan({
            reasonTypes: ["exploration"],
            reasons: [{ type: "exploration", noveltyState: "new" }]
        }), generated({
            reasonTypes: ["exploration"],
            text: "This is popular and trending."
        }), "en"),
        ERROR_CODES.UNSUPPORTED_EXPLORATION_CLAIM
    );
    assertInvalid(
        "partial preference exact",
        validateExplanationGrounding(plan({
            reasonTypes: ["preference"],
            reasons: [plan().reasons[1]],
            practicalSupport: { hasEligibleSession: false }
        }), generated({
            reasonTypes: ["preference"],
            text: "This is an exact match for the preference."
        }), "en"),
        ERROR_CODES.UNSUPPORTED_PREFERENCE_CLAIM
    );
}

function testBehaviorSessionPracticalFailures() {
    assertInvalid(
        "parent behavior as child",
        validateExplanationGrounding(plan({
            reasonTypes: ["behavior"],
            reasons: [
                {
                    type: "behavior",
                    actorAttribution: "parent"
                }
            ]
        }), generated({
            reasonTypes: ["behavior"],
            text: "It reflects that your child previously saved this activity."
        }), "en"),
        ERROR_CODES.UNSUPPORTED_BEHAVIOR_CLAIM
    );
    assertInvalid(
        "neutral behavior actor",
        validateExplanationGrounding(plan({
            reasonTypes: ["behavior"],
            reasons: [
                {
                    type: "behavior",
                    actorAttribution: "neutral"
                }
            ]
        }), generated({
            reasonTypes: ["behavior"],
            text: "It reflects previous parent engagement with this activity."
        }), "en"),
        ERROR_CODES.UNSUPPORTED_BEHAVIOR_CLAIM
    );
    assertInvalid(
        "preferred time",
        validateExplanationGrounding(plan({
            reasonTypes: ["session"],
            reasons: [
                {
                    type: "session",
                    matchingWeekdays: ["Monday"]
                }
            ]
        }), generated({
            reasonTypes: ["session"],
            text: "The session matches your preferred time of day."
        }), "en"),
        ERROR_CODES.UNSUPPORTED_SESSION_CLAIM
    );
    assertInvalid(
        "false practical availability",
        validateExplanationGrounding(plan({
            practicalSupport: { hasEligibleSession: false }
        }), generated({
            text: "An eligible session is also currently available."
        }), "en"),
        ERROR_CODES.UNSUPPORTED_PRACTICAL_CLAIM
    );
}

function testNeutralPlanRejected() {
    assertInvalid(
        "neutral plan",
        validateExplanationGrounding(plan({
            reasonTypes: [],
            reasons: [],
            neutralFallbackRequired: true
        }), generated({
            reasonTypes: []
        }), "en"),
        ERROR_CODES.NEUTRAL_FALLBACK_REQUIRED
    );
}

function main() {
    testValidGeneratedAccepted();
    testReasonTypeStructuralFailures();
    testTextLanguageAndStatusFailures();
    testScoreLeakage();
    testUnsupportedSemanticClaims();
    testBehaviorSessionPracticalFailures();
    testNeutralPlanRejected();

    console.log("Grounding validator unit tests: PASSED");
}

main();
