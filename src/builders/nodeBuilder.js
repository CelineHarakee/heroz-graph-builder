const childBuilder = require("./childBuilder");
const parentBuilder = require("./parentBuilder");

async function buildNode(entityType, document) {

    switch (entityType) {

    case "Child":
        return await childBuilder.buildChildNode(document);

    case "Parent":
        return await parentBuilder.buildParentNode(document);

    default:
        throw new Error(`Unsupported entity type: ${entityType}`);

}

}

module.exports = {
    buildNode
};