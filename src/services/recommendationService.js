const traversalService = require("../traversal/traversalService");

async function generateRecommendations(childId) {

    if (!childId) {
        throw new Error("childId is required");
    }

    const candidates =
        await traversalService.findCandidateActivities(childId);

    return candidates;
}

module.exports = {
    generateRecommendations
};