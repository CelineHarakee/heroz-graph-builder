const assert = require("assert");
const { ObjectId } = require("mongodb");

function snapshot(value) {
    return JSON.parse(JSON.stringify(value));
}

function assertThrowsAsync(label, fn) {
    return assert.rejects(fn, Error, label);
}

function factor(available, score) {
    return {
        available,
        score: available ? score : null
    };
}

function makeRecommendationResult() {
    return {
        activityId: "64f000000000000000000011",
        rank: 1,
        score: 0.8,
        factors: {
            interest: factor(true, 0.8),
            preference: factor(false, null),
            goal: factor(false, null),
            exploration: factor(false, null),
            behavior: factor(false, null),
            session: factor(false, null)
        },
        scoring: {
            availableWeight: 0.33,
            availableFactorCount: 1,
            contributions: [
                {
                    factor: "interest",
                    score: 0.8,
                    canonicalWeight: 0.33,
                    normalizedWeight: 1,
                    contribution: 0.8
                }
            ]
        },
        eligibleSessionIds: [],
        evidence: {
            discovery: {
                interests: [],
                goals: [],
                summary: []
            },
            factors: {
                interest: [{ type: "exact_subcategory_interest" }],
                preference: [],
                goal: [],
                exploration: [],
                behavior: [],
                session: []
            }
        }
    };
}

function createFakeDb({
    insertedId = new ObjectId("64f000000000000000000099"),
    failInsert = false
} = {}) {
    const calls = {
        collectionNames: [],
        inserts: [],
        updates: [],
        deleteOne: 0
    };

    return {
        calls,
        collection(collectionName) {
            calls.collectionNames.push(collectionName);

            return {
                async insertOne(document) {
                    if (failInsert) {
                        throw new Error("insert failed");
                    }

                    calls.inserts.push(document);

                    return {
                        insertedId
                    };
                },
                async updateOne(filter, update) {
                    calls.updates.push({ filter, update });

                    return {
                        matchedCount: 1,
                        modifiedCount: 1
                    };
                },
                async deleteOne() {
                    calls.deleteOne += 1;
                }
            };
        }
    };
}

function loadPersistenceService(fakeDb) {
    const mongodbConfig = require("../config/mongodb");
    mongodbConfig.getDatabase = () => fakeDb;

    delete require.cache[
        require.resolve("../recommendation/recommendationPersistenceService")
    ];

    return require("../recommendation/recommendationPersistenceService");
}

async function testValidPersistence() {
    const fakeDb = createFakeDb();
    const {
        persistRecommendationSnapshot
    } = loadPersistenceService(fakeDb);
    const recommendationResults = [makeRecommendationResult()];
    const before = snapshot(recommendationResults);
    const result = await persistRecommendationSnapshot({
        parentId: "64f000000000000000000001",
        childId: "64f000000000000000000002",
        requestedAt: new Date("2026-09-08T10:00:00.000Z"),
        recommendationResults
    });

    assert.strictEqual(result.recommendationId, "64f000000000000000000099");
    assert.deepStrictEqual(fakeDb.calls.collectionNames, ["recommendations"]);
    assert.strictEqual(fakeDb.calls.inserts.length, 1);
    assert.strictEqual(fakeDb.calls.updates.length, 0);
    assert.strictEqual(fakeDb.calls.deleteOne, 0);
    assert(fakeDb.calls.inserts[0].parentId instanceof ObjectId);
    assert.strictEqual(fakeDb.calls.inserts[0].algorithmVersion, 1);
    assert.strictEqual(fakeDb.calls.inserts[0].response.wasDisplayed, false);
    assert.deepStrictEqual(snapshot(recommendationResults), before);
}

async function testValidationFailureDoesNotInsert() {
    const fakeDb = createFakeDb();
    const {
        persistRecommendationSnapshot
    } = loadPersistenceService(fakeDb);

    await assertThrowsAsync("validation failure", async () => {
        await persistRecommendationSnapshot({
            parentId: "not-an-id",
            childId: "64f000000000000000000002",
            requestedAt: new Date("2026-09-08T10:00:00.000Z"),
            recommendationResults: [makeRecommendationResult()]
        });
    });

    assert.strictEqual(fakeDb.calls.inserts.length, 0);
}

async function testInsertFailurePropagates() {
    const fakeDb = createFakeDb({ failInsert: true });
    const {
        persistRecommendationSnapshot
    } = loadPersistenceService(fakeDb);

    await assertThrowsAsync("insert failure", async () => {
        await persistRecommendationSnapshot({
            parentId: "64f000000000000000000001",
            childId: "64f000000000000000000002",
            requestedAt: new Date("2026-09-08T10:00:00.000Z"),
            recommendationResults: [makeRecommendationResult()]
        });
    });

    assert.strictEqual(fakeDb.calls.inserts.length, 0);
}

async function testAlgorithmVersionNotCallerOverridable() {
    const fakeDb = createFakeDb();
    const {
        persistRecommendationSnapshot
    } = loadPersistenceService(fakeDb);
    const result = makeRecommendationResult();

    result.algorithmVersion = 999;

    await persistRecommendationSnapshot({
        parentId: "64f000000000000000000001",
        childId: "64f000000000000000000002",
        requestedAt: new Date("2026-09-08T10:00:00.000Z"),
        recommendationResults: [result]
    });

    assert.strictEqual(fakeDb.calls.inserts[0].algorithmVersion, 1);
}

async function testAttachRecommendationItemExplanation() {
    const fakeDb = createFakeDb();
    const {
        attachRecommendationItemExplanation
    } = loadPersistenceService(fakeDb);
    const result = await attachRecommendationItemExplanation({
        recommendationId: "64f000000000000000000099",
        activityId: "64f000000000000000000011",
        explanation: {
            reasonTypes: ["interest"],
            language: "en",
            text: "Grounded explanation.",
            source: "generated"
        }
    });

    assert.deepStrictEqual(result, {
        recommendationId: "64f000000000000000000099",
        activityId: "64f000000000000000000011"
    });
    assert.strictEqual(fakeDb.calls.updates.length, 1);
    assert.strictEqual(
        String(fakeDb.calls.updates[0].filter._id),
        "64f000000000000000000099"
    );
    assert.strictEqual(
        String(fakeDb.calls.updates[0].filter["recommendedItems.activityId"]),
        "64f000000000000000000011"
    );
    assert.deepStrictEqual(
        fakeDb.calls.updates[0].update.$set["recommendedItems.$.explanation"],
        {
            reasonTypes: ["interest"],
            language: "en",
            text: "Grounded explanation.",
            source: "generated"
        }
    );
    assert(fakeDb.calls.updates[0].update.$set["metadata.updatedAt"] instanceof Date);
}

async function main() {
    await testValidPersistence();
    await testValidationFailureDoesNotInsert();
    await testInsertFailurePropagates();
    await testAlgorithmVersionNotCallerOverridable();
    await testAttachRecommendationItemExplanation();

    console.log("Recommendation persistence unit tests: PASSED");
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
