const { observeOperation } = require("../observability/structuredLogger");
const { runBackground, currentTrace } = require("../observability/traceContext");
const { getDatabase } = require("../config/mongodb");
const graphBuilderService = require("../services/graphBuilderService");

const { ObjectId } = require("mongodb");
const { toMongoId } = require("../utils/idUtils");

// No options preserves normal queue consumption. Explicit IDs only narrow it;
// invalid input fails before any database access and an empty list selects none.
// retryFailed selects only FAILED jobs and requires explicit jobIds. Each job
// gets one attempt; graph projection rereads Mongo and reuses MERGE identities.
async function processQueue(options = {}, observation = {}) {
    if (options === null || typeof options !== "object" || Array.isArray(options) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(options)) ||
        Reflect.ownKeys(options).some(key => !["jobIds", "retryFailed"].includes(key))) {
        throw new TypeError("processQueue options must contain only optional jobIds and retryFailed");
    }
    // Recovery is explicit and restricted to existing identities. Normal queue
    // consumption never sweeps failures or repeats a job within this invocation.
    if (Object.hasOwn(options, "retryFailed") && typeof options.retryFailed !== "boolean") {
        throw new TypeError("retryFailed must be boolean");
    }
    if (options.retryFailed && !Object.hasOwn(options, "jobIds")) {
        throw new TypeError("retryFailed requires exact jobIds");
    }
    const filter = { status: "PENDING" };
    if (options.retryFailed) filter.status = "FAILED";
    if (Object.hasOwn(options, "jobIds")) {
        if (!Array.isArray(options.jobIds)) throw new TypeError("jobIds must be an array of ObjectIds or 24-character hex strings");
        const ids = new Map();
        for (const value of options.jobIds) {
            if (!(value instanceof ObjectId) && !(typeof value === "string" && /^[a-fA-F0-9]{24}$/.test(value))) {
                throw new TypeError("jobIds must contain only ObjectIds or 24-character hex strings");
            }
            const id = toMongoId(value);
            ids.set(id.toHexString(), id);
        }
        filter._id = { $in: [...ids.values()] };
    }

    const db = getDatabase();

    const queue = db.collection("graph_sync_queue");

    const pendingJobs = await queue.find(filter).toArray();


    for (const job of pendingJobs) {
        let traceOptions;
        try {
            traceOptions = { ...observation, correlationId: observation?.correlationId ?? job.correlationId ?? currentTrace()?.correlationId };
        } catch (_) { traceOptions = {}; }
        await runBackground(async () => {
            try {
                await observeOperation({
                    component: "GraphSync", operation: "processJob", context: { jobId: String(job._id) }
                }, async () => {
                    await graphBuilderService.process(job);
                    await queue.updateOne(
                        { _id: job._id },
                        { $set: { status: "PROCESSED", processedAt: new Date() } }
                    );
                });
            } catch (error) {
                await queue.updateOne(
                    { _id: job._id },
                    { $set: { status: "FAILED", error: error.message, failedAt: new Date() } }
                );
            }
        }, traceOptions);
    }
}

module.exports = { processQueue };
