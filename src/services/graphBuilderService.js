const { getDatabase } = require("../config/mongodb");
const nodeBuilder = require("../builders/nodeBuilder");
const relationshipBuilder = require("../builders/relationshipBuilder");
const { toMongoId } = require("../utils/idUtils");

const collections = {
    Child: "children",
    Parent: "parents",
    Activity: "activities",
    Subcategory: "subcategories",
    Goal: "goals",
    ChildInterest: "child_interests"
}; 

async function process(job) {

    const db = getDatabase();

    console.log(`\n🧠 Processing ${job.entityType}`);

    const collectionName = collections[job.entityType];

    if (!collectionName) {
        throw new Error(`Unknown entity type: ${job.entityType}`);
    }

    const document = await db.collection(collectionName).findOne({
        _id: job.entityType === "ChildInterest"
            ? toMongoId(job.entityId)
            : job.entityId
    });

    if (!document) {
        throw new Error(`${job.entityType} not found.`);
    }

    if (job.entityType === "ChildInterest") {

        if (!document.childId) {
            throw new Error(
                `ChildInterest ${document._id} is missing childId.`
            );
        }

        if (!document.subcategoryId) {
            throw new Error(
                `ChildInterest ${document._id} is missing subcategoryId.`
            );
        }

        const child = await db.collection("children").findOne({
            _id: toMongoId(document.childId)
        });

        if (!child) {
            throw new Error(
                `ChildInterest ${document._id} references missing child: ` +
                `${document.childId}`
            );
        }

        const subcategory =
            await db.collection("subcategories").findOne({
                _id: toMongoId(document.subcategoryId)
            });

        if (!subcategory) {
            throw new Error(
                `ChildInterest ${document._id} references missing ` +
                `subcategory: ${document.subcategoryId}`
            );
        }

        await relationshipBuilder.buildRelationship("LIKES", {
            childId: document.childId,
            subcategoryId: document.subcategoryId,
            properties: {
                score:
                    document.interestScore?.currentScore ?? null,
                confidence:
                    document.confidence?.currentScore ?? null,
                evidenceCount:
                    document.confidence?.evidenceCount ?? null,
                lastUpdated:
                    document.metadata?.updatedAt ?? null
            }
        });

        return;
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

    }
}

module.exports = {
    process
};
