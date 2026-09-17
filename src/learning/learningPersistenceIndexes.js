/** Explicit initialization only; callers must complete this before enabling writes. */
async function ensureLearningPersistenceIndexes(db) {
    await db.collection("child_interests").createIndex(
        { childId: 1, subcategoryId: 1 },
        { unique: true, name: "uniq_child_interest" }
    );
    await db.collection("ai_jobs").createIndex(
        { jobType: 1, idempotencyKey: 1 },
        { unique: true, name: "uniq_learning_idempotency" }
    );
}

module.exports = { ensureLearningPersistenceIndexes };
