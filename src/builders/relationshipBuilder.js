const hasChildBuilder = require("./relationships/hasChildBuilder");
const classifiedAsBuilder = require("./relationships/classifiedAsBuilder");
const likesBuilder = require("./relationships/likesBuilder");
const hasGoalBuilder = require("./relationships/hasGoalBuilder");
const supportsBuilder = require("./relationships/supportsBuilder");
const relatesToOutcomeBuilder =
    require("./relationships/relatesToOutcomeBuilder");

async function buildRelationship(type, data) {

    switch (type) {

        case "HAS_CHILD":
            return await hasChildBuilder.build(
                data.parentId,
                data.childId
            );

        case "CLASSIFIED_AS":

            return await classifiedAsBuilder.build(
                data.activityId,
                data.subcategoryId
            );

        case "LIKES":

            return await likesBuilder.build(
                data.childId,
                data.subcategoryId,
                data.properties
            );

        case "HAS_GOAL":

            return await hasGoalBuilder.build(
                data.childId,
                data.goalId,
                data.properties
            );

        case "SUPPORTS":

            return await supportsBuilder.build(
                data.activityId,
                data.goalId
            );

        case "RELATES_TO_OUTCOME":

            return await relatesToOutcomeBuilder.build(
                data.goalId,
                data.outcomeId,
                data.properties
            );

        default:
            throw new Error(`Unsupported relationship: ${type}`);

    }

}

async function removeStaleHasGoalsForChild(childId, currentGoalIds = []) {
    return await hasGoalBuilder.removeStaleForChild(
        childId,
        currentGoalIds
    );
}

async function removeStaleRelatedOutcomesForGoal(
    goalId,
    currentOutcomeIds = []
) {
    return await relatesToOutcomeBuilder.removeStaleForGoal(
        goalId,
        currentOutcomeIds
    );
}

module.exports = {
    buildRelationship,
    removeStaleHasGoalsForChild,
    removeStaleRelatedOutcomesForGoal
};
