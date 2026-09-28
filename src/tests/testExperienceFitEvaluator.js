const assert = require("assert");
const { evaluateExperienceFit } = require("../knowledgeGap/experienceFitEvaluator");
const {
    D1_COVERAGE,
    D1_EVALUATION_STATUS,
    D1_EXPERIENCE_COMPARISON,
    D1_RESOLVER,
    D1_SUFFICIENCY
} = require("../knowledgeGap/knowledgeGapConstants");
const { calculatePreferenceFactor } = require("../recommendation/preferenceFactorService");

function preference(value, confidenceScore = 1, source = "Parent") {
    return {
        value,
        confidenceScore,
        source,
        updatedAt: new Date("2026-09-01T00:00:00.000Z")
    };
}

function preferences(overrides = {}) {
    return {
        environment: preference("Indoor"),
        socialStyle: preference("Team"),
        difficulty: preference("Beginner"),
        experienceStyle: preference("Structured"),
        commitmentPreference: preference("Weekly"),
        ...overrides
    };
}

function experience(overrides = {}) {
    return {
        environment: "Indoor",
        socialStyle: "Team",
        difficulty: "Beginner",
        experienceStyles: ["Structured"],
        commitmentType: "Weekly",
        ...overrides
    };
}

function bundle(childPreferences = preferences(), activityExperience = experience(), extras = {}) {
    return {
        evaluation: {
            status: D1_EVALUATION_STATUS.RESOLVED
        },
        child: {
            preferences: childPreferences
        },
        activity: {
            experience: activityExperience
        },
        ...extras
    };
}

function check(result, coverageState, sufficiencyState, reasons = []) {
    assert.strictEqual(result.coverageState, coverageState);
    assert.strictEqual(result.sufficiencyState, sufficiencyState);
    for (const reason of reasons) {
        assert(result.reasons.includes(reason), `${reason} missing from ${result.reasons}`);
    }
}

function testAllMatch() {
    const result = evaluateExperienceFit(bundle());
    check(result, D1_COVERAGE.AVAILABLE, D1_SUFFICIENCY.SUFFICIENT);
    assert(Object.values(result.dimensions).every((item) =>
        item.comparisonState === D1_EXPERIENCE_COMPARISON.MATCH));
}

function testMixedMatchMismatch() {
    const result = evaluateExperienceFit(bundle(preferences(), experience({
        environment: "Outdoor",
        difficulty: "Advanced",
        commitmentType: "OneTime"
    })));

    check(result, D1_COVERAGE.AVAILABLE, D1_SUFFICIENCY.SUFFICIENT);
    assert.strictEqual(result.dimensions.environment.comparisonState, D1_EXPERIENCE_COMPARISON.MISMATCH);
    assert.strictEqual(result.dimensions.socialStyle.comparisonState, D1_EXPERIENCE_COMPARISON.MATCH);
    assert.strictEqual(result.dimensions.commitmentPreference.comparisonState, D1_EXPERIENCE_COMPARISON.MISMATCH);
}

function testChildGapWithUsableComparisons() {
    const result = evaluateExperienceFit(bundle(preferences({
        environment: preference(null)
    })));

    check(result, D1_COVERAGE.PARTIAL, D1_SUFFICIENCY.UNCERTAIN, ["CHILD_PREFERENCE_MISSING"]);
    assert.deepStrictEqual(result.dimensions.environment.possibleResolvers, [D1_RESOLVER.PARENT]);
}

function testChildGapNoUsableComparisons() {
    const result = evaluateExperienceFit(bundle({
        environment: preference(null),
        socialStyle: preference(null),
        difficulty: preference(null),
        experienceStyle: preference(null),
        commitmentPreference: preference(null)
    }));

    check(result, D1_COVERAGE.MISSING, D1_SUFFICIENCY.INSUFFICIENT, ["CHILD_PREFERENCE_MISSING"]);
    assert.deepStrictEqual(result.possibleResolvers, [D1_RESOLVER.PARENT]);
}

function testCatalogGapNoChildGaps() {
    const result = evaluateExperienceFit(bundle(preferences(), experience({
        environment: null
    })));

    check(result, D1_COVERAGE.PARTIAL, D1_SUFFICIENCY.BLOCKED, ["ACTIVITY_ATTRIBUTE_MISSING"]);
    assert.deepStrictEqual(result.dimensions.environment.possibleResolvers, [D1_RESOLVER.CATALOG]);
}

function testBothMissing() {
    const result = evaluateExperienceFit(bundle(preferences({
        environment: preference(null)
    }), experience({
        environment: null
    })));
    const dimension = result.dimensions.environment;

    assert.strictEqual(dimension.comparisonState, D1_EXPERIENCE_COMPARISON.UNAVAILABLE);
    assert.strictEqual(dimension.sufficiencyState, D1_SUFFICIENCY.INSUFFICIENT);
    assert.deepStrictEqual(dimension.reasons, ["BOTH_MISSING"]);
    assert.deepStrictEqual(dimension.possibleResolvers, [D1_RESOLVER.PARENT, D1_RESOLVER.CATALOG]);
}

function testMixedChildCatalogGaps() {
    const result = evaluateExperienceFit(bundle(preferences({
        environment: preference(null)
    }), experience({
        socialStyle: null
    })));

    check(result, D1_COVERAGE.PARTIAL, D1_SUFFICIENCY.UNCERTAIN,
        ["CHILD_PREFERENCE_MISSING", "ACTIVITY_ATTRIBUTE_MISSING"]);
    assert.deepStrictEqual(result.possibleResolvers, [D1_RESOLVER.PARENT, D1_RESOLVER.CATALOG]);
}

function testAllCatalogMissing() {
    const result = evaluateExperienceFit(bundle(preferences(), {
        environment: null,
        socialStyle: null,
        difficulty: null,
        experienceStyles: [],
        commitmentType: null
    }));

    check(result, D1_COVERAGE.MISSING, D1_SUFFICIENCY.BLOCKED, ["ACTIVITY_ATTRIBUTE_MISSING"]);
    assert.deepStrictEqual(result.possibleResolvers, [D1_RESOLVER.CATALOG]);
}

function testAllChildMissing() {
    const result = evaluateExperienceFit(bundle({
        environment: preference(null),
        socialStyle: preference(null),
        difficulty: preference(null),
        experienceStyle: preference(null),
        commitmentPreference: preference(null)
    }, experience()));

    check(result, D1_COVERAGE.MISSING, D1_SUFFICIENCY.INSUFFICIENT, ["CHILD_PREFERENCE_MISSING"]);
}

function testCommitmentPreference() {
    const result = evaluateExperienceFit(bundle(preferences({
        commitmentPreference: preference("OneTime")
    }), experience({
        commitmentType: "Weekly"
    })));

    assert.strictEqual(result.dimensions.commitmentPreference.comparisonState, D1_EXPERIENCE_COMPARISON.MISMATCH);
    assert.strictEqual(result.dimensions.commitmentPreference.sufficiencyState, D1_SUFFICIENCY.SUFFICIENT);
}

function testD5SemanticAlignment() {
    const mixed = evaluateExperienceFit(bundle(preferences({
        environment: preference("Indoor"),
        experienceStyle: preference("Structured")
    }), experience({
        environment: "Mixed",
        experienceStyles: ["Mixed"]
    })));

    assert.strictEqual(mixed.dimensions.environment.comparisonState, D1_EXPERIENCE_COMPARISON.MATCH);
    assert.strictEqual(mixed.dimensions.experienceStyle.comparisonState, D1_EXPERIENCE_COMPARISON.MISMATCH);
}

function testMissingDimensionsAreUnavailable() {
    const result = evaluateExperienceFit(bundle(preferences({
        difficulty: preference(null)
    }), experience({
        difficulty: "Advanced"
    })));

    assert.strictEqual(result.dimensions.difficulty.comparisonState, D1_EXPERIENCE_COMPARISON.UNAVAILABLE);
    assert.notStrictEqual(result.dimensions.difficulty.comparisonState, D1_EXPERIENCE_COMPARISON.MISMATCH);
}

function testBehaviorNotUsedToInferPreferences() {
    const result = evaluateExperienceFit(bundle({
        environment: preference(null),
        socialStyle: preference(null),
        difficulty: preference(null),
        experienceStyle: preference(null),
        commitmentPreference: preference(null)
    }, experience(), {
        interactions: [{ interactionDetails: { interactionType: "Rate", ratingValue: 5 } }]
    }));

    check(result, D1_COVERAGE.MISSING, D1_SUFFICIENCY.INSUFFICIENT, ["CHILD_PREFERENCE_MISSING"]);
}

function testD5Regression() {
    const result = calculatePreferenceFactor({
        child: {
            preferences: preferences({
                environment: preference("Indoor", 0.8),
                socialStyle: preference(null),
                difficulty: preference("Beginner", 0.4),
                experienceStyle: preference(null),
                commitmentPreference: preference(null)
            })
        }
    }, {
        candidate: {
            currentActivity: {
                experience: experience({
                    environment: "Indoor",
                    difficulty: "Intermediate"
                })
            }
        },
        eligibility: {
            eligible: true
        }
    });

    assert.strictEqual(result.available, true);
    assert(Math.abs(result.score - 0.6) < 1e-9);
    assert.deepStrictEqual(result.evidence.map((item) => item.dimension), ["environment", "difficulty"]);
}

function main() {
    testAllMatch();
    testMixedMatchMismatch();
    testChildGapWithUsableComparisons();
    testChildGapNoUsableComparisons();
    testCatalogGapNoChildGaps();
    testBothMissing();
    testMixedChildCatalogGaps();
    testAllCatalogMissing();
    testAllChildMissing();
    testCommitmentPreference();
    testD5SemanticAlignment();
    testMissingDimensionsAreUnavailable();
    testBehaviorNotUsedToInferPreferences();
    testD5Regression();
    console.log("Experience fit evaluator tests: PASSED");
}

main();
