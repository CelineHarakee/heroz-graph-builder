const { getDatabase } = require("../config/mongodb");
const graphBuilderService = require("../services/graphBuilderService");

async function processQueue() {

    const db = getDatabase();

    const queue = db.collection("graph_sync_queue");

    const pendingJobs = await queue.find({
        status: "PENDING"
    }).toArray();

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