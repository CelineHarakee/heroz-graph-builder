const { getDatabase } = require("../config/mongodb");

async function getChild(childId) {

    const db = getDatabase();

    return await db.collection("children").findOne({
        _id: childId
    });
}

async function getActivity(activityId) {

    const db = getDatabase();

    return await db.collection("activities").findOne({
        _id: activityId
    });
}

async function getVendor(vendorId) {

    const db = getDatabase();

    return await db.collection("vendors").findOne({
        _id: vendorId
    });
}


async function getSessions(activityId) {

    const db = getDatabase();

    return await db.collection("sessions")
        .find({
            activityId
        })
        .toArray();
}

module.exports = {
    getChild,
    getActivity,
     getVendor,
    getSessions
};