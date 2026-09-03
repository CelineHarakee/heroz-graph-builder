const {
    SCORING_FACTORS,
    createFactorResult
} = require("./scoringContract");

function idsEqual(left, right) {
    if (left === null || left === undefined) {
        return false;
    }

    if (right === null || right === undefined) {
        return false;
    }

    if (
        typeof left.equals === "function" &&
        left.equals(right)
    ) {
        return true;
    }

    if (
        typeof right.equals === "function" &&
        right.equals(left)
    ) {
        return true;
    }

    return String(left) === String(right);
}

function isValidScoringNumber(value) {
    return (
        typeof value === "number" &&
        Number.isFinite(value) &&
        value >= 0 &&
        value <= 1
    );
}

function createUnavailableInterestResult(evidence = []) {
    return createFactorResult({
        factor: SCORING_FACTORS.INTEREST,
        available: false,
        evidence
    });
}

function getInterestContext(context) {
    const interestContext = context.interestContext;

    if (
        !interestContext ||
        !Array.isArray(interestContext.childInterests) ||
        !Array.isArray(interestContext.subcategories)
    ) {
        return null;
    }

    return interestContext;
}

function buildSubcategoryCategoryLookup(subcategories) {
    return subcategories.map((subcategory) => ({
        subcategoryId: subcategory._id,
        categoryId: subcategory.categoryId
    }));
}

function findCategoryId(lookup, subcategoryId) {
    const entry = lookup.find((item) =>
        idsEqual(item.subcategoryId, subcategoryId)
    );

    return entry?.categoryId ?? null;
}

function findExactInterest(childInterests, subcategoryId) {
    return childInterests.find((interest) =>
        idsEqual(interest.subcategoryId, subcategoryId)
    );
}

function calculateCategoryFallback({
    childInterests,
    subcategoryLookup,
    categoryId,
    excludedSubcategoryId
}) {
    const siblingScores = [];

    for (const interest of childInterests) {
        if (idsEqual(interest.subcategoryId, excludedSubcategoryId)) {
            continue;
        }

        const interestCategoryId = findCategoryId(
            subcategoryLookup,
            interest.subcategoryId
        );

        if (!idsEqual(interestCategoryId, categoryId)) {
            continue;
        }

        const score = interest.interestScore?.currentScore;

        if (isValidScoringNumber(score)) {
            siblingScores.push(score);
        }
    }

    if (siblingScores.length === 0) {
        return null;
    }

    const categoryScore = siblingScores.reduce(
        (total, score) => total + score,
        0
    ) / siblingScores.length;

    return {
        type: "category_fallback",
        categoryId,
        excludedSubcategoryId,
        siblingCount: siblingScores.length,
        siblingScores,
        categoryScore
    };
}

function calculateInterestFactor(context, eligibilityEvaluation) {
    if (!context) {
        throw new Error("Recommendation context is required");
    }

    if (!eligibilityEvaluation) {
        throw new Error("Eligibility evaluation is required");
    }

    if (eligibilityEvaluation.eligibility?.eligible !== true) {
        throw new Error("Interest scoring requires an eligible candidate evaluation");
    }

    const classification =
        eligibilityEvaluation.candidate?.currentActivity?.classification;
    const candidateSubcategoryId = classification?.subcategoryId;
    const candidateCategoryId = classification?.categoryId;

    if (!candidateSubcategoryId || !candidateCategoryId) {
        return createUnavailableInterestResult();
    }

    const interestContext = getInterestContext(context);

    if (!interestContext) {
        return createUnavailableInterestResult();
    }

    const subcategoryLookup = buildSubcategoryCategoryLookup(
        interestContext.subcategories
    );
    const exactInterest = findExactInterest(
        interestContext.childInterests,
        candidateSubcategoryId
    );
    const exactScore = exactInterest?.interestScore?.currentScore;
    const confidence = exactInterest?.confidence?.currentScore;
    const hasExactScore = isValidScoringNumber(exactScore);
    const hasValidConfidence = isValidScoringNumber(confidence);
    const categoryFallback = calculateCategoryFallback({
        childInterests: interestContext.childInterests,
        subcategoryLookup,
        categoryId: candidateCategoryId,
        excludedSubcategoryId: candidateSubcategoryId
    });
    const hasCategoryFallback = categoryFallback !== null;

    if (hasExactScore && !hasValidConfidence) {
        return createUnavailableInterestResult([
            {
                type: "exact_subcategory_interest",
                subcategoryId: candidateSubcategoryId,
                score: exactScore,
                confidence
            }
        ]);
    }

    if (hasExactScore && hasValidConfidence && hasCategoryFallback) {
        const score =
            (confidence * exactScore) +
            ((1 - confidence) * categoryFallback.categoryScore);

        return createFactorResult({
            factor: SCORING_FACTORS.INTEREST,
            available: true,
            score,
            evidence: [
                {
                    type: "exact_subcategory_interest",
                    subcategoryId: candidateSubcategoryId,
                    score: exactScore,
                    confidence
                },
                categoryFallback
            ]
        });
    }

    if (hasExactScore && hasValidConfidence) {
        return createFactorResult({
            factor: SCORING_FACTORS.INTEREST,
            available: true,
            score: exactScore,
            evidence: [
                {
                    type: "exact_subcategory_interest",
                    subcategoryId: candidateSubcategoryId,
                    score: exactScore,
                    confidence
                }
            ]
        });
    }

    if (hasCategoryFallback) {
        return createFactorResult({
            factor: SCORING_FACTORS.INTEREST,
            available: true,
            score: categoryFallback.categoryScore,
            evidence: [
                categoryFallback
            ]
        });
    }

    return createUnavailableInterestResult();
}

module.exports = {
    calculateInterestFactor
};
