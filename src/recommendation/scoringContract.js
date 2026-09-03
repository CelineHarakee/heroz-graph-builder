const SCORING_FACTORS = Object.freeze({
    INTEREST: "interest",
    PREFERENCE: "preference",
    GOAL: "goal",
    EXPLORATION: "exploration",
    BEHAVIOR: "behavior",
    SESSION: "session"
});

const SCORING_WEIGHTS = Object.freeze({
    interest: 0.33,
    preference: 0.16,
    goal: 0.16,
    exploration: 0.13,
    behavior: 0.13,
    session: 0.09
});

const WEIGHT_TOLERANCE = 1e-9;

function getCanonicalFactors() {
    return Object.values(SCORING_FACTORS);
}

function validateScoringWeights() {
    const factors = getCanonicalFactors();
    const weightKeys = Object.keys(SCORING_WEIGHTS);

    if (weightKeys.length !== factors.length) {
        throw new Error("Scoring weights must contain exactly one weight per factor");
    }

    for (const factor of factors) {
        if (!Object.prototype.hasOwnProperty.call(SCORING_WEIGHTS, factor)) {
            throw new Error(`Missing scoring weight for factor: ${factor}`);
        }
    }

    for (const factor of weightKeys) {
        if (!factors.includes(factor)) {
            throw new Error(`Unknown scoring weight factor: ${factor}`);
        }

        const weight = SCORING_WEIGHTS[factor];

        if (
            typeof weight !== "number" ||
            !Number.isFinite(weight) ||
            weight <= 0
        ) {
            throw new Error(`Invalid scoring weight for factor: ${factor}`);
        }
    }

    const totalWeight = weightKeys.reduce(
        (total, factor) => total + SCORING_WEIGHTS[factor],
        0
    );

    if (Math.abs(totalWeight - 1) > WEIGHT_TOLERANCE) {
        throw new Error("Scoring weights must total 1");
    }
}

function validateFactor(factor) {
    if (!getCanonicalFactors().includes(factor)) {
        throw new Error("Factor must be a canonical scoring factor");
    }
}

function validateAvailable(available) {
    if (typeof available !== "boolean") {
        throw new Error("Factor availability must be boolean");
    }
}

function validateEvidence(evidence) {
    if (!Array.isArray(evidence)) {
        throw new Error("Factor evidence must be an array");
    }
}

function validateAvailableScore(score) {
    if (
        typeof score !== "number" ||
        !Number.isFinite(score) ||
        score < 0 ||
        score > 1
    ) {
        throw new Error("Available factor score must be a finite number from 0 to 1");
    }
}

function createFactorResult({
    factor,
    available,
    score = null,
    evidence = []
}) {
    validateFactor(factor);
    validateAvailable(available);
    validateEvidence(evidence);

    if (available) {
        validateAvailableScore(score);
    } else if (score !== null) {
        throw new Error("Unavailable factor score must be null");
    }

    return {
        factor,
        available,
        score: available ? score : null,
        evidence: [...evidence]
    };
}

function createEmptyFactorMap() {
    return {
        interest: null,
        preference: null,
        goal: null,
        exploration: null,
        behavior: null,
        session: null
    };
}

function createCandidateScoringState(eligibilityEvaluation) {
    if (!eligibilityEvaluation) {
        throw new Error("Eligibility evaluation is required");
    }

    if (eligibilityEvaluation.eligibility?.eligible !== true) {
        throw new Error("Scoring requires an eligible candidate evaluation");
    }

    return {
        eligibilityEvaluation,
        factors: createEmptyFactorMap()
    };
}

validateScoringWeights();

module.exports = {
    SCORING_FACTORS,
    SCORING_WEIGHTS,
    createFactorResult,
    createEmptyFactorMap,
    createCandidateScoringState
};
