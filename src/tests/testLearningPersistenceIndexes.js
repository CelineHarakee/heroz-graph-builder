const assert = require("assert");
const { ensureLearningPersistenceIndexes } = require("../learning/learningPersistenceIndexes");

async function main() {
    const calls = [];
    const indexes = new Map();
    const db = { collection(collection) { return { async createIndex(key, options) {
        const definition = { collection, key, options };
        calls.push(definition);
        const previous = indexes.get(options.name);
        if (previous) assert.deepStrictEqual(definition, previous);
        indexes.set(options.name, definition);
        return options.name;
    } }; } };
    await ensureLearningPersistenceIndexes(db);
    await ensureLearningPersistenceIndexes(db);
    const expected = [
        { collection: "child_interests", key: { childId: 1, subcategoryId: 1 }, options: { unique: true, name: "uniq_child_interest" } },
        { collection: "ai_jobs", key: { jobType: 1, idempotencyKey: 1 }, options: { unique: true, name: "uniq_learning_idempotency" } }
    ];
    assert.deepStrictEqual(calls, [...expected, ...expected]);
    assert.strictEqual(indexes.size, 2);
    for (const failing of ["child_interests", "ai_jobs"]) {
        const error = new Error("Index initialization failed");
        await assert.rejects(ensureLearningPersistenceIndexes({ collection(name) {
            return { async createIndex() { if (name === failing) throw error; } };
        } }), (actual) => actual === error);
    }
    console.log("Learning persistence indexes unit tests: PASSED");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
