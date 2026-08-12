const hasChildBuilder = require("./relationships/hasChildBuilder");

async function buildRelationship(type, data) {

    switch (type) {

        case "HAS_CHILD":
            return await hasChildBuilder.build(
                data.parentId,
                data.childId
            );

        default:
            throw new Error(`Unsupported relationship: ${type}`);

    }

}

module.exports = {
    buildRelationship
};