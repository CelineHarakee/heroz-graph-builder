const { getDatabase } = require("../config/mongodb");

async function process(job) {

    const db = getDatabase();

    console.log(`\n🧠 Processing ${job.entityType}`);

    if (job.entityType === "Child") {

        const child = await db.collection("children").findOne({
            _id: job.entityId
        });

        console.log("Loaded Child:");

        console.log(child);

    }

}

module.exports = {
    process
};