const childBuilder = require("./childBuilder");
const parentBuilder = require("./parentBuilder");
const activityBuilder = require("./activityBuilder");
const subcategoryBuilder = require("./subcategoryBuilder");
const goalBuilder = require("./goalBuilder");

async function buildNode(entityType, document) {

    switch (entityType) {

    case "Child":
        return await childBuilder.buildChildNode(document);

    case "Parent":
        return await parentBuilder.buildParentNode(document);

    case "Activity":
        return await activityBuilder.buildActivityNode(document);

    case "Subcategory":
        return await subcategoryBuilder.buildSubcategoryNode(document);

    case "Goal":
        return await goalBuilder.buildGoalNode(document);

    default:
        throw new Error(`Unsupported entity type: ${entityType}`);

}

}

module.exports = {
    buildNode
};