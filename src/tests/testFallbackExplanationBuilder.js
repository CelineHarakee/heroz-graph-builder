const assert = require("assert");
const {
    buildFallbackExplanation
} = require("../explanation/fallbackExplanationBuilder");

function snapshot(value) {
    return JSON.parse(JSON.stringify(value));
}

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
                activityValue: "Indoor"
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

function assertNoMath(text) {
    assert(!text.includes("0.8"));
    assert(!text.includes("33%"));
    assert(!text.includes("weight"));
    assert(!text.includes("contribution"));
}

function testEnglishAndArabicPositiveFallback() {
    const en = buildFallbackExplanation(plan(), "en");
    const ar = buildFallbackExplanation(plan(), "ar");

    assert.deepStrictEqual(en.reasonTypes, ["interest", "preference", "goal"]);
    assert.deepStrictEqual(ar.reasonTypes, ["interest", "preference", "goal"]);
    assert(en.text.includes("We recommend Robotics Lab"));
    assert(ar.text.includes("نوصي بـ مختبر الروبوتات"));
    assert(en.text.indexOf("interest") < en.text.indexOf("preference"));
    assert(en.text.indexOf("preference") < en.text.indexOf("supports"));
    assertNoMath(en.text);
    assertNoMath(ar.text);
    assert(!ar.text.includes("Robotics"));
}

function testNeutralFallbackNoPersonalization() {
    const fallback = buildFallbackExplanation(plan({
        reasonTypes: [],
        reasons: [],
        neutralFallbackRequired: true,
        practicalSupport: {
            hasEligibleSession: false
        }
    }), "en");

    assert.deepStrictEqual(fallback.reasonTypes, []);
    assert(fallback.text.includes("currently eligible options"));
    assert(!fallback.text.includes("interest"));
    assert(!fallback.text.includes("preference"));
    assert(!fallback.text.includes("goal"));
}

function testBehaviorAttributionFallback() {
    const parentBehavior = buildFallbackExplanation(plan({
        reasonTypes: ["behavior"],
        reasons: [
            {
                type: "behavior",
                selectedInteractionType: "Save",
                actorAttribution: "parent"
            }
        ],
        practicalSupport: {
            hasEligibleSession: false
        }
    }), "en");
    const childBehavior = buildFallbackExplanation(plan({
        reasonTypes: ["behavior"],
        reasons: [
            {
                type: "behavior",
                selectedInteractionType: "Rate",
                actorAttribution: "child"
            }
        ],
        practicalSupport: {
            hasEligibleSession: false
        }
    }), "en");

    assert(parentBehavior.text.includes("previous parent engagement"));
    assert(!parentBehavior.text.includes("your child previously saved"));
    assert(childBehavior.text.includes("your child previously rated"));
}

function testSessionDayOnlyAndPracticalSeparate() {
    const fallback = buildFallbackExplanation(plan({
        reasonTypes: ["session"],
        reasons: [
            {
                type: "session",
                matchingWeekdays: ["Monday"]
            }
        ],
        practicalSupport: {
            hasEligibleSession: true
        }
    }), "en");

    assert(fallback.text.includes("preferred day"));
    assert(fallback.text.includes("Monday"));
    assert(!fallback.text.includes("also currently available"));
    assert(!fallback.text.includes("time of day"));
}

function testImmutability() {
    const input = plan();
    const before = snapshot(input);
    const fallback = buildFallbackExplanation(input, "en");

    fallback.reasonTypes.push("session");
    assert.deepStrictEqual(snapshot(input), before);
}

function main() {
    testEnglishAndArabicPositiveFallback();
    testNeutralFallbackNoPersonalization();
    testBehaviorAttributionFallback();
    testSessionDayOnlyAndPracticalSeparate();
    testImmutability();

    console.log("Fallback explanation builder unit tests: PASSED");
}

main();
