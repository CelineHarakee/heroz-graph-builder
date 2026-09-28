const assert = require("assert");
const { ObjectId } = require("mongodb");
const { buildKnowledgeGapContext } = require("../knowledgeGap/knowledgeGapContextService");
const { D1_EVALUATION_STATUS } = require("../knowledgeGap/knowledgeGapConstants");

const ids = {
    child: new ObjectId("64f000000000000000000001"),
    sibling: new ObjectId("64f000000000000000000002"),
    activity: new ObjectId("64f000000000000000000003"),
    missingActivity: new ObjectId("64f000000000000000000004"),
    subcategory: new ObjectId("64f000000000000000000005"),
    missingSubcategory: new ObjectId("64f000000000000000000006"),
    goal: new ObjectId("64f000000000000000000007"),
    outcome: new ObjectId("64f000000000000000000008"),
    interest: new ObjectId("64f000000000000000000009")
};

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
    return {
        toArray: async () => records
    };
}

function fakeDb(overrides = {}) {
    const data = {
        children: [
            {
                _id: ids.child,
                parentGoals: [{ goalId: ids.goal }],
                developmentProfile: [{ outcomeId: ids.outcome, score: 0.2 }]
            },
            {
                _id: ids.sibling,
                parentGoals: [],
                developmentProfile: []
            }
        ],
        activities: [
            {
                _id: ids.activity,
                classification: { subcategoryId: ids.subcategory },
                learningOutcomes: [{ outcomeId: ids.outcome }]
            }
        ],
        subcategories: [{ _id: ids.subcategory, name: "Robotics" }],
        child_interests: [
            { _id: ids.interest, childId: ids.child, subcategoryId: ids.subcategory },
            { _id: new ObjectId(), childId: ids.sibling, subcategoryId: ids.subcategory }
        ],
        interactions: [
            { _id: new ObjectId(), actor: { childId: ids.child }, targetEntity: { entityType: "Activity", entityId: ids.activity } },
            { _id: new ObjectId(), actor: { childId: ids.sibling }, targetEntity: { entityType: "Activity", entityId: ids.activity } }
        ],
        bookings: [
            { _id: new ObjectId(), bookingDetails: { childId: ids.child, activityId: ids.activity } },
            { _id: new ObjectId(), bookingDetails: { childId: ids.sibling, activityId: ids.activity } }
        ],
        goal_library: [
            { _id: ids.goal, relatedOutcomes: [{ outcomeId: ids.outcome }] }
        ],
        learning_outcomes: [
            { _id: ids.outcome, name: "Problem Solving" }
        ],
        recommendations: [
            { _id: new ObjectId(), childId: ids.child, recommendedItems: [{ activityId: ids.activity }] },
            { _id: new ObjectId(), childId: ids.sibling, recommendedItems: [{ activityId: ids.activity }] }
        ],
        ...overrides.data
    };
    const absent = new Set(overrides.absent ?? []);
    const calls = [];

    return {
        calls,
        collection(name) {
            assert(!["ai_jobs", "graph_sync_queue"].includes(name));
            calls.push({ type: "collection", name });
            if (absent.has(name)) {
                const error = new Error("missing collection");
                error.codeName = "NamespaceNotFound";
                throw error;
            }
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

async function testResolvedContext() {
    const db = fakeDb();
    const result = await buildKnowledgeGapContext(ids.child, ids.activity, { db });

    assert.strictEqual(result.evaluation.status, D1_EVALUATION_STATUS.RESOLVED);
    assert.strictEqual(result.evaluation.reason, "CONTEXT_RESOLVED");
    assert.strictEqual(result.evaluation.childId, String(ids.child));
    assert.strictEqual(result.evaluation.activityId, String(ids.activity));
    assert.strictEqual(result.evaluation.subcategoryId, String(ids.subcategory));
    assert.strictEqual(String(result.childInterest._id), String(ids.interest));
    assert.strictEqual(result.interactions.length, 1);
    assert.strictEqual(result.bookings.length, 1);
    assert.strictEqual(result.goalLibrary.length, 1);
    assert.strictEqual(result.learningOutcomes.length, 1);
    assert.strictEqual(result.recommendationExposure.length, 1);
}

async function testMissingChild() {
    const result = await buildKnowledgeGapContext(new ObjectId(), ids.activity, { db: fakeDb() });
    assert.strictEqual(result.evaluation.status, D1_EVALUATION_STATUS.UNRESOLVABLE);
    assert.strictEqual(result.evaluation.reason, "CHILD_NOT_FOUND");
}

async function testMissingActivity() {
    const result = await buildKnowledgeGapContext(ids.child, ids.missingActivity, { db: fakeDb() });
    assert.strictEqual(result.evaluation.status, D1_EVALUATION_STATUS.UNRESOLVABLE);
    assert.strictEqual(result.evaluation.reason, "ACTIVITY_NOT_FOUND");
}

async function testBrokenSubcategory() {
    const missing = await buildKnowledgeGapContext(ids.child, ids.activity, {
        db: fakeDb({ data: { activities: [{ _id: ids.activity }] } })
    });
    assert.strictEqual(missing.evaluation.reason, "ACTIVITY_SUBCATEGORY_MISSING");

    const broken = await buildKnowledgeGapContext(ids.child, ids.activity, {
        db: fakeDb({ data: { activities: [{ _id: ids.activity, classification: { subcategoryId: ids.missingSubcategory } }] } })
    });
    assert.strictEqual(broken.evaluation.reason, "SUBCATEGORY_NOT_FOUND");
}

async function testOptionalCollectionsAndIsolation() {
    const result = await buildKnowledgeGapContext(ids.child, ids.activity, {
        db: fakeDb({ absent: ["interactions", "recommendations"] })
    });

    assert.strictEqual(result.evaluation.status, D1_EVALUATION_STATUS.RESOLVED);
    assert.deepStrictEqual(result.interactions, []);
    assert.deepStrictEqual(result.recommendationExposure, []);
    assert.strictEqual(result.sources.interactions, "unavailable");
    assert.strictEqual(result.sources.recommendations, "unavailable");
    assert(result.bookings.every((booking) => sameValue(booking.bookingDetails.childId, ids.child)));
}

async function main() {
    await testResolvedContext();
    await testMissingChild();
    await testMissingActivity();
    await testBrokenSubcategory();
    await testOptionalCollectionsAndIsolation();
    console.log("Knowledge gap context service tests: PASSED");
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
