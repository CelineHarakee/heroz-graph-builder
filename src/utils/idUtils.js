const { ObjectId } = require("mongodb");

function toMongoId(value) {
    if (value === null || value === undefined) {
        return value;
    }

    if (value instanceof ObjectId) {
        return value;
    }

    if (
        typeof value === "string" &&
        ObjectId.isValid(value)
    ) {
        return new ObjectId(value);
    }

    return value;
}

function toGraphId(value) {
    if (value === null || value === undefined) {
        return null;
    }

    return String(value);
}

module.exports = {
    toMongoId,
    toGraphId
};
