const {
    SCORING_FACTORS,
    SCORING_WEIGHTS
} = require("./scoringContract");

const CANONICAL_FACTORS = Object.values(SCORING_FACTORS);

function isPlainObject(value) {
    return (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value)
    );
}

function validateScore(value, factor) {
    if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < 0 ||
        value > 1
    ) {
        throw new Error(`Available factor score is invalid for ${factor}`);
    }
}

function validateFactorResult(result, factor) {
    if (!isPlainObject(result)) {
        throw new Error(`Completed FactorResult is required for ${factor}`);
    }

    if (result.factor !== factor) {
        throw new Error(`FactorResult does not match slot ${factor}`);
    }

    if (typeof result.available !== "boolean") {
        throw new Error(`Factor availability is invalid for ${factor}`);
    }

    if (!Array.isArray(result.evidence)) {
        throw new Error(`Factor evidence is invalid for ${factor}`);
    }

    if (result.available) {
        validateScore(result.score, factor);
    } else if (result.score !== null) {
        throw new Error(`Unavailable factor score must be null for ${factor}`);
    }
}

function validateScoringState(state) {
    if (!isPlainObject(state)) {
        throw new Error("Candidate Scoring State is required");
    }

    if (state.eligibilityEvaluation?.eligibility?.eligible !== true) {
        throw new Error("Final scoring requires an eligible Candidate Scoring State");
    }

    if (!isPlainObject(state.factors)) {
        throw new Error("Candidate Scoring State factors are required");
    }

    const factorKeys = Object.keys(state.factors);

    if (factorKeys.length !== CANONICAL_FACTORS.length) {
        throw new Error("Candidate Scoring State must contain exactly six factor slots");
    }

    for (const factor of CANONICAL_FACTORS) {
        if (!Object.prototype.hasOwnProperty.call(state.factors, factor)) {
            throw new Error(`Missing factor slot: ${factor}`);
        }
    }

    for (const factor of factorKeys) {
        if (!CANONICAL_FACTORS.includes(factor)) {
            throw new Error(`Unknown factor slot: ${factor}`);
        }
    }

    for (const factor of CANONICAL_FACTORS) {
        validateFactorResult(state.factors[factor], factor);
    }
}

function calculateFinalScore(state) {
    validateScoringState(state);

    const availableFactors = CANONICAL_FACTORS.filter(
        (factor) => state.factors[factor].available === true
    );
    const availableWeight = availableFactors.reduce(
        (total, factor) => total + SCORING_WEIGHTS[factor],
        0
    );

    if (availableFactors.length === 0) {
        return {
            available: false,
            score: null,
            availableWeight: 0,
            availableFactorCount: 0,
            contributions: []
        };
    }

    const contributions = availableFactors.map((factor) => {
        const factorResult = state.factors[factor];
        const canonicalWeight = SCORING_WEIGHTS[factor];
        const normalizedWeight = canonicalWeight / availableWeight;

        return {
            factor,
            score: factorResult.score,
            canonicalWeight,
            normalizedWeight,
            contribution: normalizedWeight * factorResult.score
        };
    });
    const score = contributions.reduce(
        (total, item) => total + item.contribution,
        0
    );

    return {
        available: true,
        score,
        availableWeight,
        availableFactorCount: availableFactors.length,
        contributions
    };
}

module.exports = {
    calculateFinalScore
};
