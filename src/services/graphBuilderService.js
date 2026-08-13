const { getDatabase } = require("../config/mongodb");
const nodeBuilder = require("../builders/nodeBuilder");
const relationshipBuilder = require("../builders/relationshipBuilder");

const collections = {
    Child: "children",
    Parent: "parents",
    Activity: "activities",
    Subcategory: "subcategories",
    Goal: "goals"
}; 

async function process(job) {

    const db = getDatabase();

    console.log(`\n🧠 Processing ${job.entityType}`);

    const collectionName = collections[job.entityType];

    if (!collectionName) {
        throw new Error(`Unknown entity type: ${job.entityType}`);
    }

    const document = await db.collection(collectionName).findOne({
        _id: job.entityId
    });

    if (!document) {
        throw new Error(`${job.entityType} not found.`);
    }

    await nodeBuilder.buildNode(job.entityType, document);

    if (job.entityType === "Parent") {

    for (const goalId of document.selectedGoals) {

        await relationshipBuilder.buildRelationship("HAS_GOAL", {
            parentId: document._id,
            goalId
        });

        }
    }

    if (job.entityType === "Activity") {

        await relationshipBuilder.buildRelationship("CLASSIFIED_AS", {
            activityId: document._id,
            subcategoryId: document.subcategoryId
        });

        if (document.supportedGoals) {

    for (const goalId of document.supportedGoals) {

        await relationshipBuilder.buildRelationship("SUPPORTS", {
            activityId: document._id,
            goalId
        });

    }

}

    }

    // Child-specific relationships
    if (job.entityType === "Child") {

        await relationshipBuilder.buildRelationship("HAS_CHILD", {
            parentId: document.parentId,
            childId: document._id
        });

        for (const subcategoryId of document.interestSubcategories) {

            await relationshipBuilder.buildRelationship("LIKES", {
                childId: document._id,
                subcategoryId
            });

        }

    }
}

module.exports = {
    process
};