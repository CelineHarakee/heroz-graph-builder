// Manual isolated development verification. No imports of app, graph or workers.
// node src/tests/systemTestV1/phaseD7F_continuousLearning.js --run-live-development
const assert = require("assert");
const { isDeepStrictEqual } = require("util");
const { randomUUID } = require("crypto");
const { MongoClient, ObjectId } = require("mongodb");
const { processContinuousLearningSource } = require("../../learning/continuousLearningService");
const names = ["children", "activities", "subcategories", "learning_outcomes", "bookings", "interactions",
    "child_interests", "ai_jobs", "graph_sync_queue", "recommendations"];
const close = (a, b) => assert(Math.abs(a - b) < 1e-12, `${a} != ${b}`);
const counts = (data) => Object.fromEntries(names.map((name) => [name, data[name].length]));
async function snapshot(db) {
    const data = {};
    for (const name of names) {
        const exists = (await db.listCollections({ name }, { nameOnly: true }).toArray()).length > 0;
        data[name] = exists ? await db.collection(name).find({}).sort({ _id: 1 }).toArray() : [];
    }
    return data;
}
async function indexes(db) {
    const result = {};
    for (const [collection, name, key] of [
        ["child_interests", "uniq_child_interest", { childId: 1, subcategoryId: 1 }],
        ["ai_jobs", "uniq_learning_idempotency", { jobType: 1, idempotencyKey: 1 }]
    ]) {
        result[collection] = await db.collection(collection).listIndexes().toArray();
        const index = result[collection].find((item) => item.name === name);
        assert(index?.unique); assert.deepStrictEqual(Object.entries(index.key), Object.entries(key));
    }
    return result;
}
async function main() {
    if (process.argv.length !== 3 || process.argv[2] !== "--run-live-development") {
        console.log("D7F live verification skipped: --run-live-development is required; no database access.");
        return;
    }
    require("dotenv").config({ quiet: true });
    const client = new MongoClient(process.env.MONGO_URI, { serverSelectionTimeoutMS: 10000 });
    const marker = `D7F_VERIFY_${randomUUID()}`;
    const captured = Object.fromEntries(names.map((name) => [name, new Map()]));
    const report = { database: "heroz", marker, scenarios: {} };
    let db, baseline, baselineIndexes, failure, failAfterProfile = false, rollbackInjected = false;
    function capture(name, id) {
        captured[name].set(String(id), id);
        console.log(JSON.stringify({ capture: name, id: String(id), marker }));
    }
    // Test-only tagging, ownership guards and failure injection. Real Mongo sessions
    // and production orchestration/persistence remain in use, without dependency overrides.
    const testDb = { collection(name) {
        assert(names.includes(name));
        const col = db.collection(name);
        return new Proxy(col, { get(target, key) {
            if (key === "insertOne") return async (doc, options) => {
                assert(["child_interests", "ai_jobs", "graph_sync_queue"].includes(name));
                assert(options?.session?.inTransaction());
                if (name === "child_interests") assert(captured.children.has(String(doc.childId)));
                if (name === "ai_jobs") assert(captured.children.has(doc.event.childId));
                if (name === "graph_sync_queue") {
                    assert.strictEqual(doc.entityType, "ChildInterest");
                    assert(captured.child_interests.has(String(doc.entityId)));
                }
                capture(name, doc._id);
                return target.insertOne({ ...doc, testDataset: marker }, options);
            };
            if (key === "updateOne") return async (filter, update, options) => {
                assert(["children", "child_interests"].includes(name));
                assert(captured[name].has(String(filter._id))); assert(options?.session?.inTransaction());
                if (name === "children") assert.deepStrictEqual(Object.keys(update.$set), ["developmentProfile"]);
                const result = await target.updateOne({ ...filter, testDataset: marker }, update, options);
                if (name === "children" && failAfterProfile) {
                    rollbackInjected = true;
                    throw new Error("D7F deliberate failure after profile write before commit");
                }
                return result;
            };
            const value = target[key];
            return typeof value === "function" ? value.bind(target) : value;
        } });
    } };
    async function insert(name, fields) {
        const doc = { _id: new ObjectId(), ...fields, testDataset: marker };
        capture(name, doc._id);
        await db.collection(name).insertOne(doc);
        return doc;
    }
    const child = (label, developmentProfile = []) => insert("children", {
        name: `${marker}_${label}`, developmentProfile, parentGoals: [], status: "Active"
    });
    const activity = (label, subcategoryId, outcomeIds) => insert("activities", {
        name: `${marker}_${label}`, classification: { subcategoryId }, learningOutcomes: outcomeIds.map((outcomeId) => ({ outcomeId }))
    });
    // Fixed past instants avoid future evidence and accidental decay between scenarios.
    const time = (hour) => new Date(`2026-09-18T${String(hour).padStart(2, "0")}:00:00.000Z`);
    const booking = (c, a, hour, confirmed = false) => insert("bookings", {
        bookingDetails: { childId: c._id, activityId: a._id, status: confirmed ? "Confirmed" : "Completed", bookedAt: time(hour - 1) },
        attendance: { status: "Attended", checkedInAt: time(hour) }
    });
    async function call(label, doc, statuses, reasons) {
        const before = JSON.stringify(doc);
        const result = await processContinuousLearningSource("Booking", doc, { client, db: testDb });
        report.scenarios[label] = result;
        assert.strictEqual(JSON.stringify(doc), before);
        assert.deepStrictEqual(result.results.map((r) => r.status), statuses, JSON.stringify(result));
        if (reasons) assert.deepStrictEqual(result.results.map((r) => r.reasonCode), reasons, JSON.stringify(result));
        console.log(JSON.stringify({ scenario: label, results: result.results.map(({ eventType, status, reasonCode }) => ({ eventType, status, reasonCode })) }));
        return result;
    }
    async function learned(c) {
        const currentChild = await db.collection("children").findOne({ _id: c._id });
        const interests = await db.collection("child_interests").find({ childId: c._id }).sort({ _id: 1 }).toArray();
        const jobs = await db.collection("ai_jobs").find({ "event.childId": String(c._id) }).sort({ _id: 1 }).toArray();
        const queue = await db.collection("graph_sync_queue").find({ entityId: { $in: interests.map((s) => s._id) } }).sort({ _id: 1 }).toArray();
        return { child: currentChild, interests, jobs, queue };
    }
    function checkInterest(state, interest, confidence, types) {
        close(state.interestScore.currentScore, interest); close(state.confidence.currentScore, confidence);
        assert.strictEqual(state.confidence.evidenceCount, types.length);
        assert.deepStrictEqual(state.scoreHistory.map((h) => h.eventType), types);
        assert.deepStrictEqual(state.evidenceSummary.interactionBreakdown,
            [...new Set(types)].map((interactionType) => ({ interactionType, count: types.filter((t) => t === interactionType).length })));
    }
    function checkJobs(data, source, types) {
        for (const type of types) {
            const job = data.jobs.find((j) => j.idempotencyKey === `booking:${source._id}:${type}`);
            assert(job); assert.strictEqual(job.jobType, "ContinuousLearning");
            assert.strictEqual(job.status, "COMPLETED"); assert.strictEqual(job.outcome, "APPLIED");
            assert(job.processing.completedAt instanceof Date);
            assert.strictEqual(job.components.interest.status, "APPLIED");
            for (const component of Object.values(job.components)) assert(component.completedAt instanceof Date);
            if (type === "Book") assert.deepStrictEqual(Object.keys(job.components), ["interest"]);
        }
        assert.strictEqual(new Set(data.jobs.map((j) => j.idempotencyKey)).size, data.jobs.length);
        assert.strictEqual(data.queue.length, data.jobs.length);
        for (const item of data.queue) {
            assert.strictEqual(item.entityType, "ChildInterest"); assert.strictEqual(item.status, "PENDING");
            assert(data.interests.some((s) => s._id.equals(item.entityId)));
        }
    }
    function checkProfile(data, original, outcomes, evidence, timestamps, started) {
        const profile = data.child.developmentProfile;
        assert.strictEqual(profile.length, outcomes.length);
        assert.deepStrictEqual({ ...data.child, developmentProfile: undefined }, { ...original, developmentProfile: undefined });
        for (const id of outcomes) {
            const entry = profile.find((e) => e.outcomeId instanceof ObjectId && e.outcomeId.equals(id));
            assert(entry); close(entry.score, 0.1 * evidence); close(entry.confidenceScore, 0.05 * evidence);
            assert.strictEqual(entry.evidenceCount, evidence); assert.strictEqual(entry.trend, null);
            assert.strictEqual(entry.history.length, evidence);
            assert.deepStrictEqual(entry.lastEvidenceAt, timestamps.at(-1));
            assert.deepStrictEqual(entry.history.map((h) => h.timestamp), timestamps);
            assert(entry.lastUpdated instanceof Date);
            assert(entry.lastUpdated.getTime() >= started && entry.lastUpdated.getTime() <= Date.now());
            for (const h of entry.history) { assert.strictEqual(h.eventType, "Attend"); assert.strictEqual(typeof h.bookingId, "string"); }
        }
    }
    async function rejected(label, c, a, hour, reason) {
        const doc = await booking(c, a, hour);
        const before = await learned(c);
        await call(label, doc, ["REJECTED"], [reason]);
        assert.deepStrictEqual(await learned(c), before);
    }
    try {
        await client.connect(); db = client.db("heroz");
        assert.strictEqual(db.databaseName, "heroz");
        baseline = await snapshot(db); baselineIndexes = await indexes(db);
        report.baselineCounts = counts(baseline); report.indexesBefore = baselineIndexes;
        report.baselineInterestIds = baseline.child_interests.map((d) => String(d._id));
        console.log(JSON.stringify({ database: db.databaseName, marker, baseline: report.baselineCounts }));
        const subA = await insert("subcategories", { name: `${marker}_SubA` });
        const subB = await insert("subcategories", { name: `${marker}_SubB` });
        const o1 = await insert("learning_outcomes", { name: `${marker}_Outcome1`, isActive: true });
        const o2 = await insert("learning_outcomes", { name: `${marker}_Outcome2`, isActive: true });
        const outcomes = [o1._id, o2._id];
        const a = await child("A"), b = await child("B");
        const actA = await activity("A", subA._id, outcomes), actB = await activity("B", subB._id, []);
        const first = await booking(a, actA, 10, true), firstStarted = Date.now();
        const result = await call("A_FirstBookAttend", first, ["APPLIED", "APPLIED"]);
        assert.deepStrictEqual(result.results.map((r) => r.eventType), ["Book", "Attend"]);
        assert.deepStrictEqual(result.results[0].components, { interest: { status: "APPLIED" } });
        assert.strictEqual(result.results[0].outcomeTransition, null);
        assert.strictEqual(result.results[1].components.outcomes.status, "APPLIED");
        const afterFirst = await learned(a);
        assert.strictEqual(afterFirst.interests.length, 1); assert.strictEqual(afterFirst.jobs.length, 2);
        checkInterest(afterFirst.interests[0], 0.68, 0.27, ["Book", "Attend"]);
        checkProfile(afterFirst, a, outcomes, 1, [time(10)], firstStarted); checkJobs(afterFirst, first, ["Book", "Attend"]);
        assert(afterFirst.queue.every((q) => q.entityId.equals(afterFirst.interests[0]._id)));
        report.firstInterest = { score: afterFirst.interests[0].interestScore.currentScore,
            confidence: afterFirst.interests[0].confidence.currentScore, evidence: 2,
            breakdown: afterFirst.interests[0].evidenceSummary.interactionBreakdown, historyLength: 2 };
        report.firstDevelopmentProfile = afterFirst.child.developmentProfile;
        await call("B_Replay", first, ["IGNORED", "IGNORED"], ["DUPLICATE_EVENT", "DUPLICATE_EVENT"]);
        assert.deepStrictEqual(await learned(a), afterFirst);
        const second = await booking(a, actA, 11), secondStarted = Date.now();
        await call("C_SecondAttend", second, ["APPLIED"]);
        const afterSecond = await learned(a);
        checkInterest(afterSecond.interests[0], 0.78, 0.31, ["Book", "Attend", "Attend"]);
        checkProfile(afterSecond, a, outcomes, 2, [time(10), time(11)], secondStarted); checkJobs(afterSecond, second, ["Attend"]);
        assert.strictEqual(afterSecond.jobs.length, 3);
        const empty = await booking(b, actB, 10);
        await call("D_EmptyMappings", empty, ["APPLIED"]);
        const afterEmpty = await learned(b);
        assert.deepStrictEqual(afterEmpty.child, b); assert.strictEqual(afterEmpty.jobs.length, 1);
        checkInterest(afterEmpty.interests[0], 0.60, 0.24, ["Attend"]); checkJobs(afterEmpty, empty, ["Attend"]);
        assert.strictEqual(afterEmpty.jobs[0].components.outcomes.status, "NOT_APPLICABLE");
        assert.strictEqual(afterEmpty.jobs[0].components.outcomes.reasonCode, "NO_MAPPED_OUTCOMES");
        const invalidActivity = await activity("InvalidReference", subA._id, [new ObjectId()]);
        await rejected("E_InvalidReference", b, invalidActivity, 12, "INVALID_OUTCOME_MAPPING");
        const inactive = await insert("learning_outcomes", { name: `${marker}_Inactive`, isActive: false });
        const inactiveActivity = await activity("Inactive", subA._id, [inactive._id]);
        await rejected("F_InactiveOutcome", b, inactiveActivity, 12, "INVALID_OUTCOME_MAPPING");
        const malformed = await child("Malformed", [{ outcomeId: o1._id, score: -1, confidenceScore: 0,
            evidenceCount: 0, trend: null, history: [] }]);
        await rejected("G_InvalidProfile", malformed, actA, 12, "INVALID_EXISTING_DEVELOPMENT_STATE");
        const ordered = await child("Ordering");
        await call("H_NewerAttend", await booking(ordered, actA, 14), ["APPLIED"]);
        // Different subcategory avoids the earlier interest-order gate, exercising
        // the outcome-order gate for the same child and outcome references.
        const olderActivity = await activity("EarlierOtherSubcategory", subB._id, outcomes);
        await rejected("H_OlderAttend", ordered, olderActivity, 13, "OUT_OF_ORDER_OUTCOME_EVENT");
        report.orderingIsolation = "Same child/outcomes, different subcategory: outcome ordering gate exercised";
        const rollback = await booking(a, actA, 15), beforeRollback = await learned(a);
        failAfterProfile = true;
        await call("I_RollbackAfterProfileWrite", rollback, ["FAILED"], ["DATABASE_ERROR"]);
        failAfterProfile = false;
        assert(rollbackInjected); assert.deepStrictEqual(await learned(a), beforeRollback);
        report.rollbackVerified = true;
        const pending = await db.collection("graph_sync_queue").find({ testDataset: marker }).toArray();
        assert.strictEqual(pending.length, 5);
        assert(pending.every((q) => q.status === "PENDING" && q.entityType === "ChildInterest"));
        assert(!Object.keys(require.cache).some((p) => /\/(queueWorker|graphBuilderService)\.js$|\/config\/neo4j\.js$/.test(p)));
        report.noGraphExecution = true;
        report.temporaryCountsBeforeCleanup = Object.fromEntries(await Promise.all(names.map(async (name) =>
            [name, await db.collection(name).countDocuments({ testDataset: marker })])));
    } catch (error) {
        failure = error;
        report.failure = { name: error.name, message: error.message };
    } finally {
        if (db && baseline) {
            report.cleanup = {};
            for (const name of ["graph_sync_queue", "ai_jobs", "child_interests", "interactions", "bookings", "activities",
                "learning_outcomes", "subcategories", "children", "recommendations"]) {
                let deleted = 0;
                for (const id of captured[name].values()) {
                    try {
                        const filter = { _id: id, testDataset: marker };
                        if (name === "graph_sync_queue") {
                            const q = await db.collection(name).findOne(filter);
                            if (q && q.status !== "PENDING") failure ??= new Error("Temporary queue intent unexpectedly processed");
                        }
                        deleted += (await db.collection(name).deleteOne(filter)).deletedCount;
                    } catch (error) { failure ??= error; }
                }
                report.cleanup[name] = deleted;
            }
            try {
                const restored = await snapshot(db);
                report.postCounts = counts(restored);
                for (const name of names) {
                    assert(isDeepStrictEqual(restored[name], baseline[name]), `${name} full baseline changed`);
                    assert.strictEqual(await db.collection(name).countDocuments({ testDataset: marker }), 0);
                }
                assert.deepStrictEqual(restored.child_interests.map((d) => String(d._id)), report.baselineInterestIds);
                const afterIndexes = await indexes(db);
                assert.deepStrictEqual(afterIndexes, baselineIndexes);
                report.fullBaselineUnchanged = true; report.zeroMarkers = true; report.indexesUnchanged = true;
            } catch (error) { failure ??= error; report.restorationError = error.message; }
        }
        await client.close();
    }
    console.log(JSON.stringify(report, null, 2));
    if (failure) throw failure;
    console.log("D7F continuous learning live verification: PASSED (scenarios A-I; cleanup verified)");
}
if (require.main === module) main().catch((error) => {
    console.error(`D7F live verification failed: ${error.name}: ${error.message}`);
    process.exitCode = 1;
});
