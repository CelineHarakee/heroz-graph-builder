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

async function getChildInterests(childId) {

    const db = getDatabase();

    return await db.collection("child_interests")
        .find({
            childId: toMongoId(childId)
        })
        .toArray();
}

async function getSubcategoriesByIds(subcategoryIds) {

    if (!Array.isArray(subcategoryIds)) {
        throw new Error("subcategoryIds must be an Array");
    }

    const subcategoryIdsByKey = new Map();

    for (const subcategoryId of subcategoryIds) {
        if (subcategoryId === null || subcategoryId === undefined) {
            continue;
        }

        const normalizedSubcategoryId = toMongoId(subcategoryId);
        subcategoryIdsByKey.set(
            String(normalizedSubcategoryId),
            normalizedSubcategoryId
        );
    }

    const normalizedUniqueIds =
        Array.from(subcategoryIdsByKey.values());

    if (normalizedUniqueIds.length === 0) {
        return [];
    }

    const db = getDatabase();

    return await db.collection("subcategories")
        .find({
            _id: {
                $in: normalizedUniqueIds
            }
        })
        .toArray();
}

module.exports = {
    getChild,
    getParent,
    getActivity,
    getVendor,
    getSessions,
    getChildInterests,
    getSubcategoriesByIds
};
