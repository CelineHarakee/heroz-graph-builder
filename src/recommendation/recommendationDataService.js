const { getDatabase } = require("../config/mongodb");
const { toMongoId } = require("../utils/idUtils");

async function getChild(childId) {

    const db = getDatabase();

    return await db.collection("children").findOne({
        _id: toMongoId(childId)
    });
}

async function getParent(parentId) {

    const db = getDatabase();

    return await db.collection("parents").findOne({
        _id: toMongoId(parentId)
    });
}

async function getActivity(activityId) {

    const db = getDatabase();

    return await db.collection("activities").findOne({
        _id: toMongoId(activityId)
    });
}

async function getVendor(vendorId) {

    const db = getDatabase();

    return await db.collection("vendors").findOne({
        _id: toMongoId(vendorId)
    });
}


async function getSessions(activityId) {

    const db = getDatabase();

    return await db.collection("sessions")
        .find({
            activityId: toMongoId(activityId)
        })
        .toArray();
}

module.exports = {
    getChild,
    getParent,
    getActivity,
     getVendor,
    getSessions
};
