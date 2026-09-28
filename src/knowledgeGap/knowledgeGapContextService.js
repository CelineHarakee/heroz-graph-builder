const { ObjectId } = require("mongodb");
const { toMongoId, toGraphId } = require("../utils/idUtils");
const { D1_EVALUATION_STATUS } = require("./knowledgeGapConstants");

const optionalCollections = new Set([
    "interactions",
    "bookings",
    "goal_library",
    "learning_outcomes",
    "recommendations"
]);

function asMongoId(value) {
    const id = toMongoId(value);
    return id instanceof ObjectId ? id : null;
}

function uniqueMongoIds(values) {
    const ids = new Map();

    for (const value of values) {
        const id = asMongoId(value);
        if (id) ids.set(String(id), id);
    }

    return Array.from(ids.values());
}

async function collectionExists(db, name) {
    if (!optionalCollections.has(name)) return true;
    if (typeof db.listCollections !== "function") return true;

    const matches = await db.listCollections({ name }, { nameOnly: true }).toArray();
    return matches.length > 0;
}

async function optionalFind(db, name, query) {
    if (!await collectionExists(db, name)) {
        return { source: "unavailable", records: [] };
    }

    try {
        const records = await db.collection(name).find(query).toArray();
        return { source: "available", records };
    } catch (error) {
        if (error?.codeName === "NamespaceNotFound" || error?.code === 26) {
            return { source: "unavailable", records: [] };
        }
        throw error;
    }
}

function getActivitySubcategoryId(activity) {
    return activity?.classification?.subcategoryId ?? activity?.subcategoryId ?? null;
}

function getParentGoalIds(child) {
    if (!Array.isArray(child?.parentGoals)) return [];
    return uniqueMongoIds(child.parentGoals.map((goal) => goal?.goalId));
}

function getOutcomeIds(activity, goalLibrary) {
    const ids = [];

    if (Array.isArray(activity?.learningOutcomes)) {
        ids.push(...activity.learningOutcomes.map((outcome) => outcome?.outcomeId));
    }

    for (const goal of goalLibrary) {
        if (!Array.isArray(goal?.relatedOutcomes)) continue;
        ids.push(...goal.relatedOutcomes.map((outcome) => outcome?.outcomeId));
    }

    return uniqueMongoIds(ids);
}

function unresolved(reason, childId, activityId) {
    return {
        evaluation: {
            status: D1_EVALUATION_STATUS.UNRESOLVABLE,
            reason,
            childId: toGraphId(childId),
            activityId: toGraphId(activityId),
            subcategoryId: null
        },
        child: null,
        activity: null,
        subcategory: null,
        childInterest: null,
        interactions: [],
        bookings: [],
        parentGoals: [],
        developmentProfile: [],
        goalLibrary: [],
        learningOutcomes: [],
        recommendationExposure: [],
        sources: {}
    };
}

async function buildKnowledgeGapContext(childId, activityId, options = {}) {
    const db = options.db || require("../config/mongodb").getDatabase();
    const childMongoId = asMongoId(childId);
    const activityMongoId = asMongoId(activityId);

    if (!db || !childMongoId) return unresolved("CHILD_NOT_FOUND", childId, activityId);
    if (!activityMongoId) return unresolved("ACTIVITY_NOT_FOUND", childId, activityId);

    const child = await db.collection("children").findOne({ _id: childMongoId });
    if (!child) return unresolved("CHILD_NOT_FOUND", childId, activityId);

    const activity = await db.collection("activities").findOne({ _id: activityMongoId });
    if (!activity) return unresolved("ACTIVITY_NOT_FOUND", childId, activityId);

    const subcategoryMongoId = asMongoId(getActivitySubcategoryId(activity));
    if (!subcategoryMongoId) return unresolved("ACTIVITY_SUBCATEGORY_MISSING", childId, activityId);

    const subcategory = await db.collection("subcategories").findOne({ _id: subcategoryMongoId });
    if (!subcategory) return unresolved("SUBCATEGORY_NOT_FOUND", childId, activityId);

    const childInterest = await db.collection("child_interests").findOne({
        childId: childMongoId,
        subcategoryId: subcategoryMongoId
    });

    const interactions = await optionalFind(db, "interactions", {
        "actor.childId": childMongoId,
        "targetEntity.entityType": "Activity",
        "targetEntity.entityId": activityMongoId
    });

    const bookings = await optionalFind(db, "bookings", {
        "bookingDetails.childId": childMongoId,
        "bookingDetails.activityId": activityMongoId
    });

    const goalIds = getParentGoalIds(child);
    const goalLibrary = goalIds.length
        ? await optionalFind(db, "goal_library", { _id: { $in: goalIds } })
        : { source: "available", records: [] };

    const outcomeIds = getOutcomeIds(activity, goalLibrary.records);
    const learningOutcomes = outcomeIds.length
        ? await optionalFind(db, "learning_outcomes", { _id: { $in: outcomeIds } })
        : { source: "available", records: [] };

    const recommendationExposure = await optionalFind(db, "recommendations", {
        childId: childMongoId,
        "recommendedItems.activityId": activityMongoId
    });

    return {
        evaluation: {
            status: D1_EVALUATION_STATUS.RESOLVED,
            reason: "CONTEXT_RESOLVED",
            childId: toGraphId(childMongoId),
            activityId: toGraphId(activityMongoId),
            subcategoryId: toGraphId(subcategoryMongoId)
        },
        child,
        activity,
        subcategory,
        childInterest,
        interactions: interactions.records,
        bookings: bookings.records,
        parentGoals: Array.isArray(child.parentGoals) ? child.parentGoals : [],
        developmentProfile: Array.isArray(child.developmentProfile) ? child.developmentProfile : [],
        goalLibrary: goalLibrary.records,
        learningOutcomes: learningOutcomes.records,
        recommendationExposure: recommendationExposure.records,
        sources: {
            interactions: interactions.source,
            bookings: bookings.source,
            goalLibrary: goalLibrary.source,
            learningOutcomes: learningOutcomes.source,
            recommendations: recommendationExposure.source
        }
    };
}

module.exports = {
    buildKnowledgeGapContext
};
