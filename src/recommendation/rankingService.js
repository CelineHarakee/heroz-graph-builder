const { toGraphId } = require("../utils/idUtils");

function isPlainObject(value) {
    return (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value)
    );
}

function isUsableActivityId(value) {
    return (
        typeof value === "string" &&
        value.trim().length > 0
    );
}

function getActivityId(record) {
    const candidate = record?.candidate;
    const activityId =
        candidate?.currentActivity?._id ??
        candidate?.currentActivity?.activityId ??
        candidate?.activity?.activityId ??
        null;
    const normalized = toGraphId(activityId);

    return isUsableActivityId(normalized)
        ? normalized
        : null;
}

function validateEligibility(record) {
    const eligibilityEvaluation = record?.eligibilityEvaluation;
    const eligible =
        eligibilityEvaluation?.eligibility?.eligible ??
        eligibilityEvaluation?.eligible;

    if (eligible !== true) {
        throw new Error("Ranking requires hard-eligible scored candidates");
    }
}

function validateFinalScore(record) {
    const finalScore = record?.finalScore;

    if (!isPlainObject(finalScore)) {
        throw new Error("Ranking record finalScore is required");
    }

    if (typeof finalScore.available !== "boolean") {
        throw new Error("Ranking record finalScore availability is invalid");
    }

    if (finalScore.available) {
        if (
            typeof finalScore.score !== "number" ||
            !Number.isFinite(finalScore.score) ||
            finalScore.score < 0 ||
            finalScore.score > 1
        ) {
            throw new Error("Rankable finalScore score must be finite from 0 to 1");
        }

        return;
    }

    if (finalScore.score !== null) {
        throw new Error("Unavailable finalScore score must be null");
    }
}

function rankCandidates(scoredRecords = []) {
    if (!Array.isArray(scoredRecords)) {
        throw new Error("Ranking input must be an array");
    }

    const seenActivityIds = new Set();
    const rankable = [];
    const unranked = [];

    for (const record of scoredRecords) {
        if (!isPlainObject(record)) {
            throw new Error("Ranking record must be an object");
        }

        validateEligibility(record);
        validateFinalScore(record);

        const activityId = getActivityId(record);

        if (activityId === null) {
            throw new Error("Ranking record requires a canonical Activity ID");
        }

        if (seenActivityIds.has(activityId)) {
            throw new Error(`Duplicate Activity ID in ranking input: ${activityId}`);
        }

        seenActivityIds.add(activityId);

        if (record.finalScore.available) {
            rankable.push({
                record,
                activityId
            });
        } else {
            unranked.push({
                ...record,
                rank: null
            });
        }
    }

    const ranked = [...rankable]
        .sort((left, right) => {
            if (left.record.finalScore.score !== right.record.finalScore.score) {
                return right.record.finalScore.score - left.record.finalScore.score;
            }

            return left.activityId.localeCompare(right.activityId);
        })
        .map((item, index) => ({
            ...item.record,
            rank: index + 1
        }));

    return {
        ranked,
        unranked
    };
}

module.exports = {
    rankCandidates
};
