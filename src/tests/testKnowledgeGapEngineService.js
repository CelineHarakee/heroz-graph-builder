const assert = require("assert");
const { ObjectId } = require("mongodb");
const {
    composeKnowledgeGapResult,
    evaluateKnowledgeGaps
} = require("../knowledgeGap/knowledgeGapEngineService");
const {
    D1_COVERAGE,
    D1_EVALUATION_STATUS,
    D1_SUFFICIENCY
} = require("../knowledgeGap/knowledgeGapConstants");

const ids = {
    child: new ObjectId("64f200000000000000000001"),
    activity: new ObjectId("64f200000000000000000002"),
    subcategory: new ObjectId("64f200000000000000000003"),
    outcome: new ObjectId("64f200000000000000000004"),
    goal: new ObjectId("64f200000000000000000005"),
    booking: new ObjectId("64f200000000000000000006")
};

function preference(value, confidenceScore = 1) {
    return { value, confidenceScore, source: "Parent", updatedAt: new Date("2026-01-01T00:00:00Z") };
}

function child(overrides = {}) {
    return {
        _id: ids.child,
        preferences: {
            environment: preference("Indoor"),
            socialStyle: preference("Team"),
            difficulty: preference("Beginner"),
            experienceStyle: preference("Structured"),
            commitmentPreference: preference("Weekly")
        },
        parentGoals: [],
        developmentProfile: [],
        ...overrides
    };
}

function activity(overrides = {}) {
    return {
        _id: ids.activity,
        classification: { subcategoryId: ids.subcategory },
        experience: {
            environment: "Indoor",
            socialStyle: "Team",
            difficulty: "Beginner",
            experienceStyles: ["Structured"],
            commitmentType: "Weekly"
        },
        learningOutcomes: [],
        ...overrides
    };
}

function resolvedBundle(overrides = {}) {
    return {
        evaluation: {
            status: D1_EVALUATION_STATUS.RESOLVED,
            reason: "CONTEXT_RESOLVED",
            childId: String(ids.child),
            activityId: String(ids.activity),
            subcategoryId: String(ids.subcategory)
        },
        child: child(),
        activity: activity(),
        subcategory: { _id: ids.subcategory },
        childInterest: {
            interestScore: { currentScore: 0.8 },
            confidence: { currentScore: 0.4, evidenceCount: 2 },
            scoreHistory: [
                { eventId: "i1", eventType: "Save", interestDelta: 0.05, timestamp: new Date("2026-01-01T00:00:00Z") },
                { eventId: "i2", eventType: "Attend", interestDelta: 0.1, timestamp: new Date("2026-01-02T00:00:00Z") }
            ],
            evidenceSummary: { interactionBreakdown: [] }
        },
        interactions: [{ _id: new ObjectId(), actor: { childId: ids.child }, targetEntity: { entityType: "Activity", entityId: ids.activity }, interactionDetails: { interactionType: "View" }, timestamp: new Date("2026-01-01T00:00:00Z") }],
        bookings: [],
        parentGoals: [],
        developmentProfile: [],
        goalLibrary: [],
        learningOutcomes: [],
        recommendationExposure: [],
        sources: { recommendations: "available" },
        ...overrides
    };
}

function pathValue(record, path) {
    return path.split(".").reduce((value, key) => {
        if (Array.isArray(value)) return value.map((item) => item?.[key]);
        return value?.[key];
    }, record);
}

function sameValue(left, right) {
    if (Array.isArray(left)) return left.some((item) => sameValue(item, right));
    return String(left) === String(right);
}

function matches(record, query) {
    return Object.entries(query).every(([key, expected]) => {
        const actual = pathValue(record, key);
        if (expected && typeof expected === "object" && Array.isArray(expected.$in)) {
            return expected.$in.some((value) => sameValue(actual, value));
        }
        return sameValue(actual, expected);
    });
}

function cursor(records) {
    return { toArray: async () => records };
}

function fakeDb(overrides = {}) {
    const data = {
        children: [child()],
        activities: [activity()],
        subcategories: [{ _id: ids.subcategory }],
        child_interests: [],
        interactions: [],
        bookings: [],
        goal_library: [],
        learning_outcomes: [],
        recommendations: [],
        ...overrides.data
    };
    const absent = new Set(overrides.absent ?? []);

    return {
        collection(name) {
            assert(!["ai_jobs", "graph_sync_queue"].includes(name));
            return {
                findOne: async (query) => data[name]?.find((record) => matches(record, query)) ?? null,
                find: (query) => cursor((data[name] ?? []).filter((record) => matches(record, query)))
            };
        },
        listCollections(filter) {
            return cursor(absent.has(filter.name) || !Object.hasOwn(data, filter.name) ? [] : [{ name: filter.name }]);
        }
    };
}

function gapByKey(result, key) {
    return result.knowledgeGaps.find((item) => item.key === key);
}

async function testValidComposition() {
    const result = await evaluateKnowledgeGaps(ids.child, ids.activity, { db: fakeDb() });
    assert.strictEqual(result.evaluation.status, D1_EVALUATION_STATUS.RESOLVED);
    assert(result.interestCoverage);
    assert(result.experienceFit);
    assert(result.activityFamiliarity);
    assert(result.developmentalRelevance);
}

async function testUnresolvable() {
    const result = await evaluateKnowledgeGaps(new ObjectId(), ids.activity, { db: fakeDb() });
    assert.strictEqual(result.evaluation.status, D1_EVALUATION_STATUS.UNRESOLVABLE);
    assert.strictEqual(result.interestCoverage, undefined);
    assert.deepStrictEqual(result.knowledgeGaps, []);

    const broken = await evaluateKnowledgeGaps(ids.child, ids.activity, {
        db: fakeDb({ data: { activities: [{ _id: ids.activity }] } })
    });
    assert.strictEqual(broken.evaluation.reason, "ACTIVITY_SUBCATEGORY_MISSING");
}

function testInterestGap() {
    const result = composeKnowledgeGapResult(resolvedBundle({ childInterest: null }));
    const key = `interest:${ids.child}:subcategory:${ids.subcategory}`;
    const found = gapByKey(result, key);
    assert(found);
    assert.strictEqual(found.sufficiencyState, D1_SUFFICIENCY.INSUFFICIENT);
    assert.strictEqual(composeKnowledgeGapResult(resolvedBundle({ childInterest: null })).knowledgeGaps[0].key, key);
}

function testPreferenceAndCatalogGaps() {
    const result = composeKnowledgeGapResult(resolvedBundle({
        child: child({
            preferences: {
                environment: preference("Indoor"),
                socialStyle: preference(null),
                difficulty: preference("Beginner"),
                experienceStyle: preference("Structured"),
                commitmentPreference: preference("Weekly")
            }
        }),
        activity: activity({ experience: { ...activity().experience, difficulty: null } })
    }));

    assert(gapByKey(result, `preference:${ids.child}:socialStyle`));
    assert(gapByKey(result, `catalog:activity:${ids.activity}:experience:difficulty`));
}

function testBothSideGap() {
    const result = composeKnowledgeGapResult(resolvedBundle({
        child: child({ preferences: { ...child().preferences, environment: preference(null) } }),
        activity: activity({ experience: { ...activity().experience, environment: null } })
    }));

    assert(gapByKey(result, `preference:${ids.child}:environment`));
    assert(gapByKey(result, `catalog:activity:${ids.activity}:experience:environment`));
}

function testFamiliarityGap() {
    const result = composeKnowledgeGapResult(resolvedBundle({ interactions: [], bookings: [] }));
    assert(gapByKey(result, `familiarity:${ids.child}:activity:${ids.activity}`));
}

function testDevelopmentGaps() {
    const na = composeKnowledgeGapResult(resolvedBundle({ activity: activity({ learningOutcomes: [] }) }));
    assert(!na.knowledgeGaps.some((item) => item.dimension === "developmentalRelevance"));

    const sufficient = composeKnowledgeGapResult(resolvedBundle({
        activity: activity({ learningOutcomes: [{ outcomeId: ids.outcome }] }),
        learningOutcomes: [{ _id: ids.outcome, isActive: true }],
        developmentProfile: [{ outcomeId: ids.outcome, score: 0.4, confidenceScore: 0.3, evidenceCount: 1, history: [] }]
    }));
    assert(!sufficient.knowledgeGaps.some((item) => item.dimension === "developmentalRelevance"));

    const blocked = composeKnowledgeGapResult(resolvedBundle({
        activity: activity({ learningOutcomes: [{ outcomeId: ids.outcome }] }),
        learningOutcomes: [{ _id: ids.outcome, isActive: true }],
        developmentProfile: [{ score: 0.4 }]
    }));
    assert(blocked.knowledgeGaps.some((item) => item.dimension === "developmentalRelevance" &&
        item.sufficiencyState === D1_SUFFICIENCY.BLOCKED));
}

function testExposure() {
    const exposed = composeKnowledgeGapResult(resolvedBundle({
        childInterest: null,
        interactions: [],
        recommendationExposure: [{ _id: "rec-1", response: { wasDisplayed: true } }]
    }));
    assert.strictEqual(exposed.exposureContext.status, "EXPOSED");
    assert(gapByKey(exposed, `familiarity:${ids.child}:activity:${ids.activity}`));
    assert(gapByKey(exposed, `interest:${ids.child}:subcategory:${ids.subcategory}`));

    const unknown = composeKnowledgeGapResult(resolvedBundle({
        sources: { recommendations: "unavailable" }
    }));
    assert.strictEqual(unknown.exposureContext.status, "UNKNOWN");
}

function testOverlap() {
    const input = resolvedBundle({
        childInterest: {
            interestScore: { currentScore: 0.6 },
            confidence: { currentScore: 0.25, evidenceCount: 1 },
            evidenceSummary: { interactionBreakdown: [] },
            scoreHistory: [{ eventId: String(ids.booking), eventType: "Attend", interestDelta: 0.1, timestamp: new Date("2026-01-01T00:00:00Z") }]
        },
        bookings: [{
            _id: ids.booking,
            bookingDetails: { childId: ids.child, activityId: ids.activity, status: "Cancelled" },
            attendance: { status: "Attended", checkedInAt: new Date("2026-01-01T00:00:00Z") }
        }],
        activity: activity({ learningOutcomes: [{ outcomeId: ids.outcome }] }),
        learningOutcomes: [{ _id: ids.outcome, isActive: true }],
        developmentProfile: [{
            outcomeId: ids.outcome,
            score: 0.4,
            confidenceScore: 0.3,
            evidenceCount: 1,
            history: [{ eventId: String(ids.booking), eventType: "Attend", activityId: String(ids.activity), bookingId: String(ids.booking) }]
        }]
    });
    const result = composeKnowledgeGapResult(input);
    assert.strictEqual(result.overlapGroups.length, 1);
    assert.strictEqual(result.overlapGroups[0].identity, `${ids.booking}:Attend`);

    const unavailable = composeKnowledgeGapResult(resolvedBundle());
    assert.deepStrictEqual(unavailable.overlapGroups, []);
}

function testPreferenceBehaviorTension() {
    const present = composeKnowledgeGapResult(resolvedBundle({
        child: child({ preferences: { ...child().preferences, environment: preference("Indoor") } }),
        activity: activity({ experience: { ...activity().experience, environment: "Outdoor" } }),
        interactions: [{ _id: "save-1", actor: { childId: ids.child }, targetEntity: { entityType: "Activity", entityId: ids.activity }, interactionDetails: { interactionType: "Save" }, timestamp: new Date("2026-01-01T00:00:00Z") }]
    }));
    assert.strictEqual(present.annotations.preferenceBehaviorTension.status, "PRESENT");

    const unavailable = composeKnowledgeGapResult(resolvedBundle());
    assert.strictEqual(unavailable.annotations.preferenceBehaviorTension.status, "UNAVAILABLE");
}

function testNoScoresAndSufficientNoGaps() {
    const result = composeKnowledgeGapResult(resolvedBundle());
    assert.strictEqual(Object.hasOwn(result, "overallKnowledgeScore"), false);
    assert.strictEqual(Object.hasOwn(result, "gapScore"), false);
    assert(!result.knowledgeGaps.some((item) => item.sufficiencyState === D1_SUFFICIENCY.SUFFICIENT));
}

async function main() {
    await testValidComposition();
    await testUnresolvable();
    testInterestGap();
    testPreferenceAndCatalogGaps();
    testBothSideGap();
    testFamiliarityGap();
    testDevelopmentGaps();
    testExposure();
    testOverlap();
    testPreferenceBehaviorTension();
    testNoScoresAndSufficientNoGaps();
    console.log("Knowledge gap engine composition tests: PASSED");
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
