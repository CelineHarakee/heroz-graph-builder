const { getDatabase } = require("../config/mongodb");
const nodeBuilder = require("../builders/nodeBuilder");

async function process(job) {

    const db = getDatabase();

    console.log(`\n🧠 Processing ${job.entityType}`);

    if (job.entityType === "Child") {

    const child = await db.collection("children").findOne({
        _id: job.entityId
    });

    if (!child) {
        console.log("❌ Child not found.");
        return;
    }

    await nodeBuilder.buildChildNode(child);

    }

}

module.exports = {
    process
};