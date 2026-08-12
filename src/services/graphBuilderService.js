const { getDatabase } = require("../config/mongodb");
const nodeBuilder = require("../builders/nodeBuilder");
const relationshipBuilder = require("../builders/relationshipBuilder");

async function process(job) {

    const db = getDatabase();

    console.log(`\n🧠 Processing ${job.entityType}`);

    if (job.entityType === "Child") {

        const child = await db.collection("children").findOne({
            _id: job.entityId
        });

        if (!child) {
            throw new Error("Child not found.");
        }

        await nodeBuilder.buildNode("Child", child);

        await relationshipBuilder.buildRelationship("HAS_CHILD", {
            parentId: child.parentId,
            childId: child._id
        });

    }

    else if (job.entityType === "Parent") {

    console.log("Looking for parent:", job.entityId);

    const parents = await db.collection("parents").find().toArray();

    console.log("All parents:");
    console.log(parents);

    const parent = await db.collection("parents").findOne({
        _id: job.entityId
    });

    console.log("Found parent:");
    console.log(parent);

    if (!parent) {
        throw new Error("Parent not found.");
    }

    await nodeBuilder.buildNode("Parent", parent);
}

}

module.exports = {
    process
};
