const { getDatabase } = require("../config/mongodb");
const graphBuilderService = require("../services/graphBuilderService");

const { ObjectId } = require("mongodb");
const { toMongoId } = require("../utils/idUtils");

// No options preserves normal queue consumption. Explicit IDs only narrow it;
// invalid input fails before any database access and an empty list selects none.
async function processQueue(options = {}) {
    if (options === null || typeof options !== "object" || Array.isArray(options) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(options)) ||
        Reflect.ownKeys(options).some(key => key !== "jobIds")) {
        throw new TypeError("processQueue options must contain only optional jobIds");
    }
    const filter = { status: "PENDING" };
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

    console.log(`📦 Found ${pendingJobs.length} pending jobs`);

    for (const job of pendingJobs) {

        console.log("--------------------------------");

        console.log("Job ID:", job._id);
        console.log("Entity:", job.entityType);
        console.log("Operation:", job.operation);
        console.log("Status:", job.status);

        try {

            await graphBuilderService.process(job);

            await queue.updateOne(
                { _id: job._id },
                {
                    $set: {
                        status: "PROCESSED",
                        processedAt: new Date()
                    }
                }
            );

            console.log("✅ Job marked as PROCESSED");

        } catch (error) {

            console.error("❌ Job processing failed");
            console.error(error);

            await queue.updateOne(
                { _id: job._id },
                {
                    $set: {
                        status: "FAILED",
                        error: error.message,
                        failedAt: new Date()
                    }
                }
            );

            console.log("⚠️ Job marked as FAILED");

        }

    }

}

module.exports = {
    processQueue
};