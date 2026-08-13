const parentQueries = require("./queries/parentQueries");
const activityQueries = require("./queries/activityQueries");
const goalQueries = require("./queries/goalQueries");

async function findParent(childId) {

    return await parentQueries.findParent(childId);

}

async function findActivitiesByInterest(childId) {

    return await activityQueries.findActivitiesByInterest(childId);

}

async function findActivitiesByGoal(childId) {

    return await goalQueries.findActivitiesByGoal(childId);

}

async function findCandidateActivities(childId) {

    const interestCandidates =
        await findActivitiesByInterest(childId);

    const goalCandidates =
        await findActivitiesByGoal(childId);

    const candidates = new Map();

    // Add interest candidates
    for (const candidate of interestCandidates) {

        candidates.set(candidate.activity.activityId, candidate);

    }

    // Merge goal candidates
    for (const candidate of goalCandidates) {

        const existing = candidates.get(candidate.activity.activityId);

        if (existing) {

            existing.evidence.goals.push(
                ...candidate.evidence.goals
            );

        } else {

            candidates.set(
                candidate.activity.activityId,
                candidate
            );

        }

    }

    for (const candidate of candidates.values()) {

    candidate.evidence.summary = [];

    for (const interest of candidate.evidence.interests) {

        candidate.evidence.summary.push(
            `Matched child interest: ${interest.name}`
        );

    }

    for (const goal of candidate.evidence.goals) {

        candidate.evidence.summary.push(
            `Supports parent goal: ${goal.name}`
        );

    }

}

    return Array.from(candidates.values());

}

module.exports = {

    findParent,
    findActivitiesByInterest,
    findActivitiesByGoal,
    findCandidateActivities

};

