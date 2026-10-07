const { toMongoId } = require("../utils/idUtils");
const { ApiError } = require("../api/apiError");

const PREFERENCE_DIMENSIONS = [
    "environment", "socialStyle", "difficulty", "experienceStyle", "commitmentPreference"
];
const jsonDate = (value) => value instanceof Date ? value.toISOString() : value;

// Reads persisted current state only. The optional db follows existing service
// conventions and lets callers test this boundary without a live connection.
async function getChildIntelligence(childId, options = {}) {
    const db = options.db || require("../config/mongodb").getDatabase();
    const child = await db.collection("children").findOne({ _id: toMongoId(childId) });
    if (!child) throw new ApiError(404, "CHILD_NOT_FOUND", "Child not found.");

    const interests = await db.collection("child_interests")
        .find({ childId: child._id }).toArray();
    const preferences = {};
    for (const dimension of PREFERENCE_DIMENSIONS) {
        const state = child.preferences?.[dimension];
        if (state == null) continue;
        preferences[dimension] = {
            value: state.value,
            confidenceScore: state.confidenceScore,
            source: state.source,
            updatedAt: jsonDate(state.updatedAt)
        };
    }

    return {
        childId: String(child._id),
        interests: interests.map((interest) => ({
            subcategoryId: String(interest.subcategoryId),
            score: interest.interestScore?.currentScore,
            confidence: interest.confidence?.currentScore,
            evidenceCount: interest.confidence?.evidenceCount,
            lastUpdated: jsonDate(interest.metadata?.updatedAt)
        })),
        preferences,
        goals: (child.parentGoals ?? [])
            .filter((goal) => goal.status === "Active")
            .map((goal) => ({ goalId: String(goal.goalId), priority: goal.priority })),
        development: (child.developmentProfile ?? []).map((entry) => ({
            learningOutcomeId: String(entry.outcomeId),
            score: entry.score,
            confidence: entry.confidenceScore,
            evidenceCount: entry.evidenceCount,
            trend: entry.trend,
            lastUpdated: jsonDate(entry.lastUpdated)
        }))
    };
}

module.exports = { getChildIntelligence };
