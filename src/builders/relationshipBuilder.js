const hasChildBuilder = require("./relationships/hasChildBuilder");
const classifiedAsBuilder = require("./relationships/classifiedAsBuilder");
const likesBuilder = require("./relationships/likesBuilder");
const hasGoalBuilder = require("./relationships/hasGoalBuilder");
const supportsBuilder = require("./relationships/supportsBuilder");

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
                data.parentId,
                data.goalId
            );

        case "SUPPORTS":

            return await supportsBuilder.build(
                data.activityId,
                data.goalId
            );

        default:
            throw new Error(`Unsupported relationship: ${type}`);

    }

}

module.exports = {
    buildRelationship
};
