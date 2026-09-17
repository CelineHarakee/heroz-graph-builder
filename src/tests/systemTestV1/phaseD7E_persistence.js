// TEST ONLY. Deliberate manual invocation:
// node src/tests/systemTestV1/phaseD7E_persistence.js --run-live-development
// Leaves the two approved indexes in place; removes only this run's documents.
const assert = require("assert");
const { randomUUID } = require("crypto");
const { MongoClient, ObjectId } = require("mongodb");
const { ensureLearningPersistenceIndexes } = require("../../learning/learningPersistenceIndexes");
const { persistAppliedInterestLearning } = require("../../learning/learningPersistenceService");
const { getLearningInstruction } = require("../../learning/learningRuleEngine");
const { calculateNextInterestState } = require("../../learning/interestStateTransition");

const COLLECTIONS = ["child_interests", "ai_jobs", "graph_sync_queue"];
const close = (actual, expected) => assert(Math.abs(actual - expected) < 1e-12);

async function snapshot(db) {
    const result = {};
    for (const name of COLLECTIONS) {
        const exists = (await db.listCollections({ name }, { nameOnly: true }).toArray()).length > 0;
        result[name] = {
            exists,
            documents: exists ? await db.collection(name).find({}).sort({ _id: 1 }).toArray() : [],
            indexes: exists ? await db.collection(name).listIndexes().toArray() : []
        };
    }
    return result;
}

function checkIndexes(snapshotData) {
    for (const [collection, name, key] of [
        ["child_interests", "uniq_child_interest", { childId: 1, subcategoryId: 1 }],
        ["ai_jobs", "uniq_learning_idempotency", { jobType: 1, idempotencyKey: 1 }]
    ]) {
        const indexes = snapshotData[collection].indexes;
        assert(indexes.some((index) => index.name === "_id_"));
        const index = indexes.find((item) => item.name === name);
        assert(index);
        assert.strictEqual(index.unique, true);
        assert.deepStrictEqual(Object.entries(index.key), Object.entries(key));
    }
}

async function main() {
    if (process.argv.length !== 3 || process.argv[2] !== "--run-live-development") {
        throw new Error("Manual execution requires --run-live-development");
    }
    require("dotenv").config({ quiet: true });
    const client = new MongoClient(process.env.MONGO_URI, { serverSelectionTimeoutMS: 10000 });
    const marker = `D7E_STEP_3C_${randomUUID()}`;
    const captured = Object.fromEntries(COLLECTIONS.map((name) => [name, new Map()]));
    const report = { marker, database: "heroz" };
    let baseline, db, indexesReady = false, failure;
    const injectedFailure = new Error("D7E_STEP_3C controlled rollback before queue insert");

    // Wrap only the injected db, preserving real sessions and real Mongo writes.
    // IDs are captured BEFORE insertion, allowing cleanup even on ambiguous errors.
    function testDb(failQueue = false) {
        return { collection(name) {
            assert(COLLECTIONS.includes(name));
            const collection = db.collection(name);
            return new Proxy(collection, { get(target, key) {
                if (key === "insertOne") return async (document, options) => {
                    assert(options?.session?.inTransaction());
                    assert(document._id instanceof ObjectId);
                    captured[name].set(String(document._id), document._id);
                    console.log(JSON.stringify({ captured: name, id: String(document._id), marker }));
                    if (failQueue && name === "graph_sync_queue") throw injectedFailure;
                    return target.insertOne({ ...document, testDataset: marker }, options);
                };
                const value = target[key];
                return typeof value === "function" ? value.bind(target) : value;
            } });
        } };
    }

    function event(childId = new ObjectId(), subcategoryId = new ObjectId()) {
        const eventId = new ObjectId().toHexString();
        return {
            eventId, eventType: "View", childId: String(childId), subcategoryId: String(subcategoryId),
            activityId: new ObjectId().toHexString(), bookingId: null, sessionId: null,
            source: "Interaction", eventData: { ratingValue: null },
            context: { recommendationId: null, surface: marker }, occurredAt: new Date(),
            processing: { idempotencyKey: `interaction:${marker}:${eventId}:View` }
        };
    }

    async function persist(input, currentState = null, failQueue = false) {
        const instruction = getLearningInstruction(input);
        assert.strictEqual(instruction.status, "APPLICABLE");
        const calculated = calculateNextInterestState(currentState, instruction, input);
        assert.strictEqual(calculated.status, "APPLIED");
        calculated.state.metadata.testDataset = marker;
        return persistAppliedInterestLearning({
            client, db: testDb(failQueue), event: input, instruction, currentState, nextState: calculated.state
        });
    }

    try {
        await client.connect();
        db = client.db("heroz");
        console.log(`Database verified before writes: ${db.databaseName}`);
        assert.strictEqual(db.databaseName, "heroz");
        console.log(`Test marker: ${marker}`);
        baseline = await snapshot(db);
        report.baselineCounts = Object.fromEntries(COLLECTIONS.map((name) => [name, baseline[name].documents.length]));
        report.aiJobsExisted = baseline.ai_jobs.exists;
        report.baselineInterestIds = baseline.child_interests.documents.map((doc) => String(doc._id));
        report.baselineIndexes = Object.fromEntries(COLLECTIONS.map((name) => [name, baseline[name].indexes]));
        console.log(JSON.stringify({ baseline: report }, null, 2));

        await ensureLearningPersistenceIndexes(db);
        const initialized = await snapshot(db);
        checkIndexes(initialized);
        assert.deepStrictEqual(initialized.graph_sync_queue.indexes, baseline.graph_sync_queue.indexes);
        indexesReady = true;
        report.indexes = Object.fromEntries(COLLECTIONS.map((name) => [name, initialized[name].indexes]));

        const input = event();
        const pair = { childId: new ObjectId(input.childId), subcategoryId: new ObjectId(input.subcategoryId) };
        assert.strictEqual(await db.collection("child_interests").countDocuments(pair), 0);
        // No child/activity/subcategory reference documents are needed by this path.
        const result = await persist(input);
        assert.strictEqual(result.status, "APPLIED", result.reasonCode);
        report.transaction = result.reasonCode;
        const states = await db.collection("child_interests").find(pair).toArray();
        assert.strictEqual(states.length, 1);
        const state = states[0];
        for (const key of ["_id", "childId", "subcategoryId"]) assert(state[key] instanceof ObjectId);
        assert.strictEqual(state.interestScore.previousScore, 0.5);
        close(state.interestScore.currentScore, 0.51);
        close(state.confidence.currentScore, 0.205);
        assert.strictEqual(state.confidence.evidenceCount, 1);
        assert.strictEqual(state.scoreHistory.length, 1);
        assert.strictEqual(state.scoreHistory[0].eventId, input.eventId);
        for (const timestamp of [state.interestScore.lastCalculatedAt, state.interestScore.lastDecayAt,
            state.confidence.lastCalculatedAt, state.metadata.createdAt, state.metadata.updatedAt,
            state.scoreHistory[0].timestamp]) assert(timestamp instanceof Date);
        report.values = { previousScore: state.interestScore.previousScore,
            interest: state.interestScore.currentScore, confidence: state.confidence.currentScore,
            evidenceCount: state.confidence.evidenceCount, historyEntries: state.scoreHistory.length };

        const jobFilter = { jobType: "ContinuousLearning", idempotencyKey: input.processing.idempotencyKey };
        const jobs = await db.collection("ai_jobs").find(jobFilter).toArray();
        assert.strictEqual(jobs.length, 1);
        const job = jobs[0];
        assert.strictEqual(job.status, "COMPLETED"); assert.strictEqual(job.outcome, "APPLIED");
        for (const key of ["childId", "activityId", "subcategoryId"]) assert.strictEqual(job.event[key], input[key]);
        assert.strictEqual(job.source.documentId, input.eventId);
        for (const timestamp of [job.event.occurredAt, job.processing.completedAt, job.metadata.createdAt, job.metadata.updatedAt]) assert(timestamp instanceof Date);
        const queueFilter = { entityType: "ChildInterest", entityId: state._id };
        const queue = await db.collection("graph_sync_queue").find(queueFilter).toArray();
        assert.strictEqual(queue.length, 1);
        assert(queue[0].entityId instanceof ObjectId);
        assert.strictEqual(queue[0].operation, "CREATE"); assert.strictEqual(queue[0].status, "PENDING");
        assert(queue[0].createdAt instanceof Date);
        report.durableEffects = { child_interests: 1, ai_jobs: 1, graph_sync_queue: 1 };

        const duplicate = await persist(input);
        assert.strictEqual(duplicate.reasonCode, "DUPLICATE_EVENT");
        assert.deepStrictEqual(await db.collection("child_interests").find(pair).toArray(), states);
        assert.deepStrictEqual(await db.collection("ai_jobs").find(jobFilter).toArray(), jobs);
        assert.deepStrictEqual(await db.collection("graph_sync_queue").find(queueFilter).toArray(), queue);
        report.duplicate = duplicate.reasonCode;

        const staleEvent = event(pair.childId, pair.subcategoryId);
        const instruction = getLearningInstruction(staleEvent);
        const next = calculateNextInterestState(state, instruction, staleEvent);
        assert.strictEqual(next.status, "APPLIED");
        const simulation = await db.collection("child_interests").updateOne(
            { _id: state._id, testDataset: marker, ...pair }, { $set: { "interestScore.currentScore": 0.61 } }
        );
        assert.strictEqual(simulation.modifiedCount, 1);
        const simulated = await db.collection("child_interests").findOne({ _id: state._id });
        const stale = await persistAppliedInterestLearning({ client, db: testDb(), event: staleEvent,
            instruction, currentState: state, nextState: next.state });
        assert.strictEqual(stale.reasonCode, "CONCURRENT_STATE_CHANGE");
        assert.deepStrictEqual(await db.collection("child_interests").findOne({ _id: state._id }), simulated);
        assert.strictEqual(await db.collection("ai_jobs").countDocuments({ idempotencyKey: staleEvent.processing.idempotencyKey }), 0);
        assert.deepStrictEqual(await db.collection("graph_sync_queue").find(queueFilter).toArray(), queue);
        report.staleState = stale.reasonCode;

        const failedEvent = event();
        const failedPair = { childId: new ObjectId(failedEvent.childId), subcategoryId: new ObjectId(failedEvent.subcategoryId) };
        assert.strictEqual(await db.collection("child_interests").countDocuments(failedPair), 0);
        const rolledBack = await persist(failedEvent, null, true);
        assert.strictEqual(rolledBack.status, "FAILED");
        assert.strictEqual(rolledBack.error, injectedFailure);
        assert.strictEqual(await db.collection("child_interests").countDocuments(failedPair), 0);
        assert.strictEqual(await db.collection("ai_jobs").countDocuments({ idempotencyKey: failedEvent.processing.idempotencyKey }), 0);
        assert.strictEqual(await db.collection("graph_sync_queue").countDocuments({ testDataset: marker }), 1);
        report.rollback = "PASSED: interest and ai_job writes aborted before queue insertion";
    } catch (error) {
        failure = error;
        report.failure = { name: error.name, message: error.message };
    } finally {
        try {
            if (db && baseline) {
                report.cleanup = {};
                for (const name of ["graph_sync_queue", "ai_jobs", "child_interests"]) {
                    let deleted = 0;
                    for (const id of captured[name].values()) {
                        const filter = { _id: id, testDataset: marker };
                        if (name === "graph_sync_queue") {
                            const pending = await db.collection(name).findOne(filter);
                            if (pending && pending.status !== "PENDING") {
                                failure ??= new Error("Temporary queue job changed status unexpectedly");
                            }
                        }
                        deleted += (await db.collection(name).deleteOne(filter)).deletedCount;
                    }
                    report.cleanup[name] = deleted;
                }
                const restored = await snapshot(db);
                report.postCounts = Object.fromEntries(COLLECTIONS.map((name) => [name, restored[name].documents.length]));
                for (const name of COLLECTIONS) {
                    assert.deepStrictEqual(restored[name].documents, baseline[name].documents, `${name} baseline changed`);
                    assert.strictEqual(await db.collection(name).countDocuments({ testDataset: marker }), 0);
                }
                if (indexesReady) checkIndexes(restored);
                assert.deepStrictEqual(restored.graph_sync_queue.indexes, baseline.graph_sync_queue.indexes);
                report.baselineDocumentsUnchanged = true;
                report.remainingIndexes = Object.fromEntries(COLLECTIONS.map((name) => [name, restored[name].indexes]));
            }
        } catch (cleanupError) {
            report.cleanupError = cleanupError.message;
            failure ??= cleanupError;
        } finally {
            await client.close();
        }
    }
    console.log(JSON.stringify(report, null, 2));
    if (failure) throw failure;
    console.log("D7E persistence live integration verification: PASSED");
}

if (require.main === module) {
    main().catch((error) => {
        console.error(`D7E verification failed: ${error.name}: ${error.message}`);
        process.exitCode = 1;
    });
}
