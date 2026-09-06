const { getDatabase } = require("../config/mongodb");
const { ObjectId } = require("mongodb");
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

async function getGoalsByIds(goalIds) {

    if (!Array.isArray(goalIds)) {
        throw new Error("goalIds must be an Array");
    }

    const goalIdsByKey = new Map();

    for (const goalId of goalIds) {
        if (goalId === null || goalId === undefined) {
            continue;
        }

        const normalizedGoalId = toMongoId(goalId);

        if (!(normalizedGoalId instanceof ObjectId)) {
            continue;
        }

        goalIdsByKey.set(
            String(normalizedGoalId),
            normalizedGoalId
        );
    }

    const normalizedUniqueIds =
        Array.from(goalIdsByKey.values());

    if (normalizedUniqueIds.length === 0) {
        return [];
    }

    const db = getDatabase();

    return await db.collection("goal_library")
        .find({
            _id: {
                $in: normalizedUniqueIds
            }
        })
        .toArray();
}

async function collectionExists(collectionName) {
    const db = getDatabase();

    const collections = await db.listCollections(
        { name: collectionName },
        { nameOnly: true }
    ).toArray();

    return collections.length > 0;
}

function getUniqueMongoIds(values) {
    if (!Array.isArray(values)) {
        throw new Error("values must be an Array");
    }

    const idsByKey = new Map();

    for (const value of values) {
        if (value === null || value === undefined) {
            continue;
        }

        const normalizedValue = toMongoId(value);

        if (!(normalizedValue instanceof ObjectId)) {
            continue;
        }

        idsByKey.set(
            String(normalizedValue),
            normalizedValue
        );
    }

    return Array.from(idsByKey.values());
}

async function getExplorationBookingHistory(childId, candidateActivityIds) {

    if (!Array.isArray(candidateActivityIds)) {
        throw new Error("candidateActivityIds must be an Array");
    }

    const childMongoId = toMongoId(childId);

    if (!(childMongoId instanceof ObjectId)) {
        return {
            source: "unavailable",
            bookings: []
        };
    }

    if (!await collectionExists("bookings")) {
        return {
            source: "unavailable",
            bookings: []
        };
    }

    const activityIds = getUniqueMongoIds(candidateActivityIds);

    if (activityIds.length === 0) {
        return {
            source: "available",
            bookings: []
        };
    }

    const db = getDatabase();

    const bookings = await db.collection("bookings")
        .find({
            "bookingDetails.childId": childMongoId,
            "bookingDetails.activityId": {
                $in: activityIds
            }
        })
        .project({
            _id: 1,
            "bookingDetails.childId": 1,
            "bookingDetails.activityId": 1,
            "bookingDetails.sessionId": 1,
            "bookingDetails.status": 1,
            "bookingDetails.bookedAt": 1,
            "attendance.status": 1,
            "attendance.checkedInAt": 1,
            "attendance.checkedOutAt": 1
        })
        .toArray();

    return {
        source: "available",
        bookings
    };
}

async function getExplorationRecommendationHistory(
    childId,
    candidateActivityIds
) {

    if (!Array.isArray(candidateActivityIds)) {
        throw new Error("candidateActivityIds must be an Array");
    }

    const childMongoId = toMongoId(childId);

    if (!(childMongoId instanceof ObjectId)) {
        return {
            source: "unavailable",
            recommendations: []
        };
    }

    if (!await collectionExists("recommendations")) {
        return {
            source: "unavailable",
            recommendations: []
        };
    }

    const activityIds = getUniqueMongoIds(candidateActivityIds);

    if (activityIds.length === 0) {
        return {
            source: "available",
            recommendations: []
        };
    }

    const db = getDatabase();

    const recommendations = await db.collection("recommendations")
        .find({
            childId: childMongoId,
            "recommendedItems.activityId": {
                $in: activityIds
            }
        })
        .project({
            _id: 1,
            childId: 1,
            "recommendationContext.requestedAt": 1,
            "recommendedItems.activityId": 1,
            "response.wasDisplayed": 1,
            "response.displayedAt": 1,
            "response.clickedActivityIds": 1,
            "response.savedActivityIds": 1,
            "response.bookedSessionIds": 1,
            "response.dismissedActivityIds": 1,
            "response.lastResponseAt": 1
        })
        .toArray();

    return {
        source: "available",
        recommendations
    };
}

module.exports = {
    getChild,
    getParent,
    getActivity,
    getVendor,
    getSessions,
    getChildInterests,
    getSubcategoriesByIds,
    getGoalsByIds,
    getExplorationBookingHistory,
    getExplorationRecommendationHistory
};
