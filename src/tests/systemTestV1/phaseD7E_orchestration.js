// Manual development verification only; never imported by app.js.
// node src/tests/systemTestV1/phaseD7E_orchestration.js --run-live-development
const assert = require("assert");
const { randomUUID } = require("crypto");
const { MongoClient, ObjectId } = require("mongodb");
const { processInterestLearningSource } = require("../../learning/interestLearningService");
const names = ["children", "activities", "subcategories", "bookings", "interactions",
    "child_interests", "ai_jobs", "graph_sync_queue", "recommendations"];
const close = (a, b) => assert(Math.abs(a - b) < 1e-12, `${a} != ${b}`);

async function snapshot(db) {
    const result = {};
    for (const name of names) {
        const exists = (await db.listCollections({ name }, { nameOnly: true }).toArray()).length > 0;
        result[name] = exists ? await db.collection(name).find({}).sort({ _id: 1 }).toArray() : [];
    }
    return result;
}

async function indexes(db) {
    for (const [collection, name, key] of [
        ["child_interests", "uniq_child_interest", { childId: 1, subcategoryId: 1 }],
        ["ai_jobs", "uniq_learning_idempotency", { jobType: 1, idempotencyKey: 1 }]
    ]) {
        const index = (await db.collection(collection).listIndexes().toArray()).find((item) => item.name === name);
        assert(index?.unique);
        assert.deepStrictEqual(Object.entries(index.key), Object.entries(key));
    }
}

async function main() {
    assert(process.argv.length === 3 && process.argv[2] === "--run-live-development", "Explicit live flag required");
    require("dotenv").config({ quiet: true });
    const client = new MongoClient(process.env.MONGO_URI, { serverSelectionTimeoutMS: 10000 });
    const marker = `D7E_FINAL_${randomUUID()}`;
    const captured = Object.fromEntries(names.map((name) => [name, new Map()]));
    const report = { database: "heroz", marker, scenarios: {} };
    let db, baseline, failure;

    // Real database/session operations; only test tagging and ID capture are added.
    function instrumentedDb() {
        return { collection(name) {
            assert(names.includes(name));
            const col = db.collection(name);
            return new Proxy(col, { get(target, key) {
                if (key === "insertOne") return async (document, options) => {
                    assert(["child_interests", "ai_jobs", "graph_sync_queue"].includes(name));
                    assert(options.session.inTransaction());
                    captured[name].set(String(document._id), document._id);
                    console.log(JSON.stringify({ capture: name, id: String(document._id), marker }));
                    return target.insertOne({ ...document, testDataset: marker }, options);
                };
                const value = target[key];
                return typeof value === "function" ? value.bind(target) : value;
            } });
        } };
    }

    async function insert(name, doc) {
        captured[name].set(String(doc._id), doc._id);
        console.log(JSON.stringify({ capture: name, id: String(doc._id), marker }));
        await db.collection(name).insertOne({ ...doc, testDataset: marker });
    }
    async function references() {
        const childId = new ObjectId(), activityId = new ObjectId(), subcategoryId = new ObjectId();
        await insert("children", { _id: childId });
        await insert("subcategories", { _id: subcategoryId });
        await insert("activities", { _id: activityId, classification: { subcategoryId } });
        return { childId, activityId, subcategoryId };
    }
    const day = new Date(); day.setUTCHours(0, 0, 0, 0);
    const time = (hour) => new Date(day.getTime() + hour * 3600000);
    function raw(ref, type, hour, rating = null) {
        return { _id: new ObjectId(), actor: { childId: ref.childId, actorType: "Child" },
            targetEntity: { entityType: "Activity", entityId: ref.activityId },
            interactionDetails: { interactionType: type, ratingValue: rating }, timestamp: time(hour),
            context: { surface: marker }, testDataset: marker };
    }
    async function call(label, source, doc, statuses, reasons) {
        const before = JSON.stringify(doc);
        const result = await processInterestLearningSource(source, doc, { client, db: instrumentedDb() });
        report.scenarios[label] = result;
        assert.strictEqual(JSON.stringify(doc), before);
        assert.strictEqual(result.status, "COMPLETED");
        assert.deepStrictEqual(result.results.map((item) => item.status), statuses, JSON.stringify(result));
        if (reasons) assert.deepStrictEqual(result.results.map((item) => item.reasonCode), reasons);
        assert(result.results.every((item) => item.eventType !== "Complete" || item.status !== "APPLIED"));
        return result;
    }
    async function checkState(ref, interest, confidence, types) {
        const states = await db.collection("child_interests").find({ childId: ref.childId, subcategoryId: ref.subcategoryId }).toArray();
        assert.strictEqual(states.length, 1);
        const state = states[0];
        close(state.interestScore.currentScore, interest); close(state.confidence.currentScore, confidence);
        assert.strictEqual(state.confidence.evidenceCount, types.length);
        assert.deepStrictEqual(state.scoreHistory.map((item) => item.eventType), types);
        assert.deepStrictEqual(state.evidenceSummary.interactionBreakdown,
            types.map((interactionType) => ({ interactionType, count: 1 })));
        const jobs = await db.collection("ai_jobs").find({ "event.childId": String(ref.childId) }).toArray();
        assert.strictEqual(jobs.length, types.length);
        assert(jobs.every((job) => job.jobType === "ContinuousLearning" && job.status === "COMPLETED" && job.outcome === "APPLIED"));
        assert.deepStrictEqual(jobs.map((job) => job.event.eventType).sort(), [...types].sort());
        const queue = await db.collection("graph_sync_queue").find({ entityType: "ChildInterest", entityId: state._id }).toArray();
        assert.strictEqual(queue.length, types.length);
        assert(queue.every((job) => job.status === "PENDING"));
        return { state, jobs, queue };
    }
    try {
        await client.connect(); db = client.db("heroz");
        assert.strictEqual(db.databaseName, "heroz");
        console.log(`Database before writes: ${db.databaseName}; marker: ${marker}`);
        baseline = await snapshot(db);
        report.baselineCounts = Object.fromEntries(names.map((name) => [name, baseline[name].length]));
        report.baselineInterestIds = baseline.child_interests.map((item) => String(item._id));
        await indexes(db);
        console.log(JSON.stringify({ baseline: report.baselineCounts }));
        const first = await references();
        const view = raw(first, "View", 10);
        // Raw interactions need not be stored: D7C reads only their references.
        await call("View", "Interaction", view, ["APPLIED"]);
        const firstState = await checkState(first, 0.51, 0.205, ["View"]);
        close(firstState.state.interestScore.previousScore, 0.50);
        assert.strictEqual(firstState.jobs[0].idempotencyKey, `interaction:${view._id}:View`);
        await call("Replay", "Interaction", view, ["IGNORED"], ["DUPLICATE_EVENT"]);
        assert.deepStrictEqual(await checkState(first, 0.51, 0.205, ["View"]), firstState);
        await call("Save", "Interaction", raw(first, "Save", 11), ["APPLIED"]);
        const afterSave = await checkState(first, 0.56, 0.225, ["View", "Save"]);
        await call("Repeat", "Interaction", raw(first, "View", 12), ["IGNORED"], ["REPEAT_LIMIT_REACHED"]);
        assert.deepStrictEqual(await checkState(first, 0.56, 0.225, ["View", "Save"]), afterSave);

        const second = await references();
        const booking = { _id: new ObjectId(), bookingDetails: { ...second, status: "Confirmed", bookedAt: time(10) },
            attendance: { status: "Attended", checkedInAt: time(11) }, testDataset: marker };
        await insert("bookings", booking);
        const both = await call("BookAttend", "Booking", booking, ["APPLIED", "APPLIED"]);
        assert.deepStrictEqual(both.results.map((item) => item.eventType), ["Book", "Attend"]);
        const afterBooking = await checkState(second, 0.68, 0.27, ["Book", "Attend"]);
        close(both.results[0].transition.currentScore, 0.58);
        close(both.results[1].transition.previousScore, 0.58);

        await call("Invalid", "Interaction", raw(first, "Rate", 13, 6), ["REJECTED"], ["INVALID_RATING"]);
        await call("CompleteUnsupported", "Interaction", raw(first, "Complete", 13), ["IGNORED"], ["NON_LEARNING_EVENT"]);
        assert.deepStrictEqual(await checkState(first, 0.56, 0.225, ["View", "Save"]), afterSave);
        assert.deepStrictEqual(await checkState(second, 0.68, 0.27, ["Book", "Attend"]), afterBooking);
        report.scenarioCount = 6;
        report.additionalCompleteCheck = "PASSED";
    } catch (error) {
        failure = error;
        report.failure = { name: error.name, message: error.message };
    } finally {
        if (db && baseline) {
            report.cleanup = {};
            for (const name of ["graph_sync_queue", "ai_jobs", "child_interests", "interactions", "bookings", "activities", "subcategories", "children"]) {
                let deleted = 0;
                for (const id of captured[name].values()) {
                    try {
                        const filter = { _id: id, testDataset: marker };
                        if (name === "graph_sync_queue") {
                            const job = await db.collection(name).findOne(filter);
                            if (job && job.status !== "PENDING") failure ??= new Error("Test queue job was unexpectedly processed");
                        }
                        deleted += (await db.collection(name).deleteOne(filter)).deletedCount;
                    } catch (error) { failure ??= error; }
                }
                report.cleanup[name] = deleted;
            }
            try {
                const restored = await snapshot(db);
                report.postCounts = Object.fromEntries(names.map((name) => [name, restored[name].length]));
                for (const name of names) {
                    assert.deepStrictEqual(restored[name], baseline[name], `${name} baseline changed`);
                    assert.strictEqual(await db.collection(name).countDocuments({ testDataset: marker }), 0);
                }
                await indexes(db);
                report.baselineUnchanged = true; report.indexesRemain = true;
            } catch (error) { failure ??= error; report.restorationError = error.message; }
        }
        await client.close();
    }
    console.log(JSON.stringify(report, null, 2));
    if (failure) throw failure;
    console.log("D7E orchestration live verification: PASSED (6 scenarios + Complete boundary)");
}

if (require.main === module) main().catch((error) => {
    console.error(`D7E orchestration verification failed: ${error.name}: ${error.message}`);
    process.exitCode = 1;
});
