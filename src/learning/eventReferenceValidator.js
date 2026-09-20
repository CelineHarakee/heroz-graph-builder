const { ObjectId } = require("mongodb");
const { toMongoId, toGraphId } = require("../utils/idUtils");

/**
 * Read-only reference validation for events that already passed validateEvent.
 * First failure wins: child, activity, subcategory, then booking consistency
 * and current operational evidence. Never opens a database connection.
 */
async function validateEventReferences(event, options = {}) {
    function reject(reasonCode) {
        return { status: "REJECTED", reasonCode, retryable: false, event, error: null };
    }

    try {
        // Lazy loading keeps injected database use independent of configuration.
        const db = options.db || require("../config/mongodb").getDatabase();
        if (!db) throw new Error("MongoDB database is unavailable");

        if (event.source === "ParentDecision") {
            const { canonicalParentDecisionId: id } = require("./parentDecisionContract");
            const child = await db.collection("children").findOne({ _id: toMongoId(event.childId) });
            const parent = await db.collection("parents").findOne({ _id: toMongoId(event.parentId) });
            if (!child || !parent || !id(child.parentId) || id(child.parentId) !== id(event.parentId)) {
                return reject("INVALID_PARENT_AUTHORITY");
            }
            if (event.eventType !== "PreferenceUpdated") {
                const goal = await db.collection("goal_library").findOne({ _id: toMongoId(event.eventData.goalId) });
                if (!goal || (event.eventType === "GoalSelected" && goal.isActive !== true)) return reject("INVALID_GOAL_REFERENCE");
            }
            return { status: "VALID", reasonCode: "VALID_REFERENCES", retryable: false, event: structuredClone(event), error: null };
        }
        const child = await db.collection("children").findOne({ _id: toMongoId(event.childId) });
        if (!child) return reject("CHILD_NOT_FOUND");

        const activity = await db.collection("activities").findOne({ _id: toMongoId(event.activityId) });
        if (!activity) return reject("ACTIVITY_NOT_FOUND");

        const subcategoryId = activity.classification?.subcategoryId;
        if (!(subcategoryId instanceof ObjectId) &&
            !(typeof subcategoryId === "string" && subcategoryId.trim().length > 0)) {
            return reject("ACTIVITY_SUBCATEGORY_MISSING");
        }
        const subcategory = await db.collection("subcategories").findOne({ _id: toMongoId(subcategoryId) });
        if (!subcategory) return reject("SUBCATEGORY_NOT_FOUND");

        if (event.eventType === "Book" || event.eventType === "Attend") {
            const booking = await db.collection("bookings").findOne({ _id: toMongoId(event.bookingId) });
            if (!booking) return reject("BOOKING_NOT_FOUND");

            const details = booking.bookingDetails;
            if (toGraphId(details?.childId) !== toGraphId(event.childId)) {
                return reject("BOOKING_CHILD_MISMATCH");
            }
            if (toGraphId(details?.activityId) !== toGraphId(event.activityId)) {
                return reject("BOOKING_ACTIVITY_MISMATCH");
            }
            if (details?.sessionId != null && event.sessionId != null &&
                toGraphId(details.sessionId) !== toGraphId(event.sessionId)) {
                return reject("BOOKING_SESSION_MISMATCH");
            }
            if (event.eventType === "Book" && details.status !== "Confirmed") {
                return reject("BOOKING_NOT_CONFIRMED");
            }
            if (event.eventType === "Attend" &&
                !["Attended", "CheckedOut"].includes(booking.attendance?.status)) {
                return reject("ATTENDANCE_NOT_VERIFIED");
            }
        }

        return {
            status: "VALID",
            reasonCode: "VALID_REFERENCES",
            retryable: false,
            event: { ...structuredClone(event), subcategoryId: toGraphId(subcategoryId) },
            error: null
        };
    } catch (error) {
        return { status: "FAILED", reasonCode: "DATABASE_ERROR", retryable: true, event, error };
    }
}

module.exports = { validateEventReferences };
