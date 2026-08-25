const { getDatabase } = require("../config/mongodb");
const nodeBuilder = require("../builders/nodeBuilder");
const relationshipBuilder = require("../builders/relationshipBuilder");
const { toMongoId } = require("../utils/idUtils");

const collections = {
    Child: "children",
    Parent: "parents",
    Activity: "activities",
    Subcategory: "subcategories",
    Goal: "goal_library",
    LearningOutcome: "learning_outcomes",
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

    if (job.entityType === "Goal") {

        if (!Array.isArray(document.relatedOutcomes)) {
            throw new Error(
                `Goal ${document._id} has an invalid relatedOutcomes structure.`
            );
        }

        const seenOutcomeIds = new Set();

        for (const relatedOutcome of document.relatedOutcomes) {

            if (!relatedOutcome || !relatedOutcome.outcomeId) {
                throw new Error(
                    `Goal ${document._id} has a relatedOutcomes entry ` +
                    `missing outcomeId.`
                );
            }

            const outcomeIdKey = String(relatedOutcome.outcomeId);

            if (seenOutcomeIds.has(outcomeIdKey)) {
                throw new Error(
                    `Goal ${document._id} contains duplicate ` +
                    `LearningOutcome: ${relatedOutcome.outcomeId}`
                );
            }

            seenOutcomeIds.add(outcomeIdKey);

            if (
                typeof relatedOutcome.weight !== "number" ||
                !Number.isFinite(relatedOutcome.weight) ||
                relatedOutcome.weight < 0 ||
                relatedOutcome.weight > 1
            ) {
                throw new Error(
                    `Goal ${document._id} has invalid weight for ` +
                    `LearningOutcome: ${relatedOutcome.outcomeId}`
                );
            }

            const outcome = await db.collection("learning_outcomes").findOne({
                _id: toMongoId(relatedOutcome.outcomeId)
            });

            if (!outcome) {
                throw new Error(
                    `Goal ${document._id} references missing ` +
                    `LearningOutcome: ${relatedOutcome.outcomeId}`
                );
            }

            if (outcome.isActive !== true) {
                throw new Error(
                    `Goal ${document._id} references inactive ` +
                    `LearningOutcome: ${relatedOutcome.outcomeId}`
                );
            }

        }

        for (const relatedOutcome of document.relatedOutcomes) {

            await relationshipBuilder.buildRelationship(
                "RELATES_TO_OUTCOME",
                {
                    goalId: document._id,
                    outcomeId: relatedOutcome.outcomeId,
                    properties: {
                        weight: relatedOutcome.weight
                    }
                }
            );

        }

        const currentOutcomeIds = document.relatedOutcomes.map(
            (relatedOutcome) => relatedOutcome.outcomeId
        );

        await relationshipBuilder.removeStaleRelatedOutcomesForGoal(
            document._id,
            currentOutcomeIds
        );

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

        if (document.parentGoals !== null && document.parentGoals !== undefined) {

            if (!Array.isArray(document.parentGoals)) {
                throw new Error(
                    `Child ${document._id} has an invalid parentGoals structure.`
                );
            }

            const currentGoalIds = [];

            for (const parentGoal of document.parentGoals) {

                if (!parentGoal.goalId) {
                    throw new Error(
                        `Child ${document._id} has a parentGoals entry ` +
                        `missing goalId.`
                    );
                }

                const goal = await db.collection("goal_library").findOne({
                    _id: toMongoId(parentGoal.goalId)
                });

                if (!goal) {
                    throw new Error(
                        `Child ${document._id} references missing goal: ` +
                        `${parentGoal.goalId}`
                    );
                }

                currentGoalIds.push(parentGoal.goalId);

                await relationshipBuilder.buildRelationship("HAS_GOAL", {
                    childId: document._id,
                    goalId: parentGoal.goalId,
                    properties: {
                        priority: parentGoal.priority ?? null,
                        status: parentGoal.status ?? null
                    }
                });

            }

            await relationshipBuilder.removeStaleHasGoalsForChild(
                document._id,
                currentGoalIds
            );
        }

    }
}

module.exports = {
    process
};
