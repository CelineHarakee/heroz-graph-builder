function isPlainObject(value) {
    return (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value)
    );
}

function validateRankingResult(rankingResult) {
    if (!isPlainObject(rankingResult)) {
        throw new Error("Ranking result is required");
    }

    if (!Array.isArray(rankingResult.ranked)) {
        throw new Error("Ranking result ranked must be an array");
    }

    if (!Array.isArray(rankingResult.unranked)) {
        throw new Error("Ranking result unranked must be an array");
    }
}

function validateTopN(n) {
    if (
        typeof n !== "number" ||
        !Number.isFinite(n) ||
        !Number.isInteger(n) ||
        n <= 0
    ) {
        throw new Error("Top-N count must be a positive integer number");
    }
}

function selectTopN(rankingResult, n) {
    validateRankingResult(rankingResult);
    validateTopN(n);

    return {
        selected: rankingResult.ranked.slice(0, n),
        unselectedRanked: rankingResult.ranked.slice(n),
        unranked: [...rankingResult.unranked]
    };
}

module.exports = {
    selectTopN
};
