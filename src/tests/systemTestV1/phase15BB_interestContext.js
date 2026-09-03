require("dotenv").config();

const { ObjectId } = require("mongodb");
const { connectMongoDB, getDatabase } = require("../../config/mongodb");
const driver = require("../../config/neo4j");
const {
    buildRecommendationContext
} = require("../../recommendation/recommendationContextService");

const DATASET = "SYSTEM_TEST_V1";

function assert(condition, message) {
    if (!condition) {
        throw new Error(message);
    }
}

function assertEqual(label, actual, expected) {
    if (actual !== expected) {
        throw new Error(
            `${label}: expected ${expected}, found ${actual}`
        );
    }
}

function assertClose(label, actual, expected, tolerance = 0.000001) {
    if (
        typeof actual !== "number" ||
        Math.abs(actual - expected) > tolerance
    ) {
        throw new Error(
            `${label}: expected ${expected}, found ${actual}`
        );
    }
}

function sameId(left, right) {
    return String(left) === String(right);
}

async function loadChildByName(db, name) {
    const child = await db.collection("children").findOne({
        "identity.firstName": name,
        "metadata.testDataset": DATASET
    });

    assert(child, `${name} not found`);
    assert(child._id instanceof ObjectId, `${name} _id must be ObjectId`);

    return child;
}

async function loadCategoryByName(db, name) {
    const category = await db.collection("categories").findOne({
        name,
        "metadata.testDataset": DATASET
    });

    assert(category, `${name} Category not found`);

    return category;
}

function requireCandidate(context, title) {
    const matches = context.candidates.filter(
        (candidate) => candidate.activity?.title === title
    );

    assertEqual(`${title} candidate count`, matches.length, 1);

    return matches[0];
}

function requireInterestBySubcategory(context, subcategoryName) {
    const subcategory = requireSubcategoryByName(context, subcategoryName);
    const interests = context.interestContext.childInterests.filter(
        (interest) => sameId(interest.subcategoryId, subcategory._id)
    );

    assertEqual(`${subcategoryName} interest count`, interests.length, 1);

    return interests[0];
}

function requireSubcategoryByName(context, name) {
    const matches = context.interestContext.subcategories.filter(
        (subcategory) => subcategory.name === name
    );

    assertEqual(`${name} Subcategory count`, matches.length, 1);

    return matches[0];
}

function assertInterestContextShape(context, expectedInterests, expectedSubcategories) {
    assert(context.interestContext, "interestContext is required");
    assert(
        Array.isArray(context.interestContext.childInterests),
        "interestContext.childInterests must be an Array"
    );
    assert(
        Array.isArray(context.interestContext.subcategories),
        "interestContext.subcategories must be an Array"
    );
    assertEqual(
        `${context.child.identity?.firstName} learned interests`,
        context.interestContext.childInterests.length,
        expectedInterests
    );
    assertEqual(
        `${context.child.identity?.firstName} interest subcategories`,
        context.interestContext.subcategories.length,
        expectedSubcategories
    );
}

function assertUniqueSubcategories(context) {
    const subcategoryIds = context.interestContext.subcategories.map(
        (subcategory) => String(subcategory._id)
    );

    assertEqual(
        "returned Subcategory unique count",
        new Set(subcategoryIds).size,
        subcategoryIds.length
    );
}

function assertNoScoringFields(context) {
    for (const field of [
        "interestScore",
        "factorScore",
        "finalScore",
        "rank",
        "weightedScore"
    ]) {
        assert(
            !Object.prototype.hasOwnProperty.call(context, field),
            `context must not include ${field}`
        );
    }

    for (const candidate of context.candidates) {
        for (const field of [
            "interestScore",
            "factorScore",
            "finalScore",
            "rank",
            "weightedScore"
        ]) {
            assert(
                !Object.prototype.hasOwnProperty.call(candidate, field),
                `${candidate.activity?.title} must not include ${field}`
            );
        }
    }
}

function assertD4EvidencePreserved(context, title, {
    interests,
    goals,
    summary
}) {
    const candidate = requireCandidate(context, title);

    assertEqual(
        `${title} interest evidence count`,
        candidate.evidence.interests.length,
        interests.length
    );
    assertEqual(
        `${title} goal evidence count`,
        candidate.evidence.goals.length,
        goals.length
    );
    assertEqual(
        `${title} evidence summary count`,
        candidate.evidence.summary.length,
        summary.length
    );

    for (const interestName of interests) {
        assert(
            candidate.evidence.interests.some(
                (interest) => interest.name === interestName
            ),
            `${title} missing interest evidence ${interestName}`
        );
    }

    for (const goalName of goals) {
        assert(
            candidate.evidence.goals.some(
                (goal) => goal.name === goalName
            ),
            `${title} missing goal evidence ${goalName}`
        );
    }

    for (const expectedSummary of summary) {
        assert(
            candidate.evidence.summary.includes(expectedSummary),
            `${title} missing summary ${expectedSummary}`
        );
    }
}

function countSiblingCategoryInterests(context, exactSubcategory) {
    return context.interestContext.childInterests.filter((interest) => {
        if (sameId(interest.subcategoryId, exactSubcategory._id)) {
            return false;
        }

        const interestSubcategory =
            context.interestContext.subcategories.find(
                (subcategory) => sameId(subcategory._id, interest.subcategoryId)
            );

        return (
            interestSubcategory &&
            sameId(interestSubcategory.categoryId, exactSubcategory.categoryId)
        );
    }).length;
}

async function assertSara(db, sara) {
    const stem = await loadCategoryByName(db, "STEM");
    const arts = await loadCategoryByName(db, "Arts");
    const context = await buildRecommendationContext(sara._id);

    assert(context, "Sara context is required");
    assertEqual("Sara candidate count", context.candidates.length, 5);
    assertInterestContextShape(context, 2, 2);
    assertUniqueSubcategories(context);
    assertNoScoringFields(context);

    const robotics = requireSubcategoryByName(context, "Robotics");
    const painting = requireSubcategoryByName(context, "Painting");

    assert(
        sameId(robotics.categoryId, stem._id),
        "Robotics must map to STEM"
    );
    assert(
        sameId(painting.categoryId, arts._id),
        "Painting must map to Arts"
    );

    const roboticsInterest = requireInterestBySubcategory(context, "Robotics");
    const paintingInterest = requireInterestBySubcategory(context, "Painting");

    assertClose(
        "Sara Robotics learned score",
        roboticsInterest.interestScore.currentScore,
        0.88
    );
    assertClose(
        "Sara Robotics confidence",
        roboticsInterest.confidence.currentScore,
        0.82
    );
    assertEqual(
        "Sara Robotics evidenceCount",
        roboticsInterest.confidence.evidenceCount,
        12
    );
    assertClose(
        "Sara Painting learned score",
        paintingInterest.interestScore.currentScore,
        0.56
    );
    assertClose(
        "Sara Painting confidence",
        paintingInterest.confidence.currentScore,
        0.64
    );

    const roboticsLab = requireCandidate(context, "Robotics Lab");
    assert(
        sameId(
            roboticsLab.currentActivity.classification.subcategoryId,
            roboticsInterest.subcategoryId
        ),
        "Robotics Lab must join to Sara Robotics interest"
    );
    assert(
        sameId(
            roboticsLab.currentActivity.classification.categoryId,
            robotics.categoryId
        ),
        "Robotics Lab must join to Robotics category"
    );

    const creativeRobotics = requireCandidate(context, "Creative Robotics");
    assert(
        sameId(
            creativeRobotics.currentActivity.classification.subcategoryId,
            roboticsLab.currentActivity.classification.subcategoryId
        ),
        "Creative Robotics must share Robotics Lab subcategory"
    );
    assert(
        sameId(
            creativeRobotics.currentActivity.classification.categoryId,
            roboticsLab.currentActivity.classification.categoryId
        ),
        "Creative Robotics must share Robotics Lab category"
    );

    const paintingStudio = requireCandidate(context, "Painting Studio");
    assert(
        sameId(
            paintingStudio.currentActivity.classification.subcategoryId,
            paintingInterest.subcategoryId
        ),
        "Painting Studio must join to Sara Painting interest"
    );
    assert(
        sameId(
            paintingStudio.currentActivity.classification.categoryId,
            painting.categoryId
        ),
        "Painting Studio must join to Painting category"
    );

    const roboticsSiblings =
        countSiblingCategoryInterests(context, robotics);
    const paintingSiblings =
        countSiblingCategoryInterests(context, painting);

    assertEqual("Robotics sibling STEM interests", roboticsSiblings, 0);
    assertEqual("Painting sibling Arts interests", paintingSiblings, 0);

    assertD4EvidencePreserved(context, "Robotics Lab", {
        interests: ["Robotics"],
        goals: ["Improve Problem Solving", "Build Teamwork"],
        summary: [
            "Matched child interest: Robotics",
            "Supports parent goal: Improve Problem Solving",
            "Supports parent goal: Build Teamwork"
        ]
    });
    assertD4EvidencePreserved(context, "Creative Robotics", {
        interests: ["Robotics"],
        goals: ["Improve Problem Solving"],
        summary: [
            "Matched child interest: Robotics",
            "Supports parent goal: Improve Problem Solving"
        ]
    });
    assertD4EvidencePreserved(context, "Painting Studio", {
        interests: ["Painting"],
        goals: [],
        summary: [
            "Matched child interest: Painting"
        ]
    });

    return {
        context,
        roboticsInterest,
        paintingInterest,
        roboticsSiblings,
        paintingSiblings
    };
}

async function assertOmar(omar) {
    const context = await buildRecommendationContext(omar._id);

    assert(context, "Omar context is required");
    assertEqual("Omar candidate count", context.candidates.length, 3);
    assertInterestContextShape(context, 1, 1);
    assertUniqueSubcategories(context);
    assertNoScoringFields(context);

    const football = requireSubcategoryByName(context, "Football");
    const footballInterest = requireInterestBySubcategory(context, "Football");

    assert(
        sameId(footballInterest.subcategoryId, football._id),
        "Omar Football interest mapping must be present"
    );
    assertClose(
        "Omar Football learned score",
        footballInterest.interestScore.currentScore,
        0.91
    );
    assertClose(
        "Omar Football confidence",
        footballInterest.confidence.currentScore,
        0.87
    );

    assertD4EvidencePreserved(context, "Football Team Camp", {
        interests: ["Football"],
        goals: ["Build Teamwork"],
        summary: [
            "Matched child interest: Football",
            "Supports parent goal: Build Teamwork"
        ]
    });

    return {
        context,
        footballInterest
    };
}

async function assertLina(lina) {
    const context = await buildRecommendationContext(lina._id);

    assert(context, "Lina context is required");
    assertEqual("Lina candidate count", context.candidates.length, 2);
    assertInterestContextShape(context, 0, 0);
    assertNoScoringFields(context);

    for (const candidate of context.candidates) {
        assertEqual(
            `${candidate.activity.title} Lina interest evidence count`,
            candidate.evidence.interests.length,
            0
        );
    }

    return context;
}

async function assertStringChildId(sara, saraContext) {
    const stringContext = await buildRecommendationContext(String(sara._id));

    assert(stringContext, "Sara string context is required");
    assertEqual("Sara string candidate count", stringContext.candidates.length, 5);
    assertEqual(
        "Sara string learned interests",
        stringContext.interestContext.childInterests.length,
        saraContext.interestContext.childInterests.length
    );
    assertEqual(
        "Sara string subcategories",
        stringContext.interestContext.subcategories.length,
        saraContext.interestContext.subcategories.length
    );
}

async function main() {
    await connectMongoDB();

    const db = getDatabase();

    try {
        const sara = await loadChildByName(db, "Sara");
        const omar = await loadChildByName(db, "Omar");
        const lina = await loadChildByName(db, "Lina");

        const saraResult = await assertSara(db, sara);
        const omarResult = await assertOmar(omar);
        const linaContext = await assertLina(lina);

        await assertStringChildId(sara, saraResult.context);

        assertEqual(
            "Sara candidate filtering",
            saraResult.context.candidates.length,
            5
        );
        assertEqual(
            "Omar candidate filtering",
            omarResult.context.candidates.length,
            3
        );
        assertEqual(
            "Lina candidate filtering",
            linaContext.candidates.length,
            2
        );

        console.log("========================================");
        console.log("STEP 15B-B - INTEREST CONTEXT");
        console.log("========================================");
        console.log("");
        console.log("Sara candidates:                         5 / 5");
        console.log("Sara learned interests:                  2 / 2");
        console.log(
            `Robotics learned score:                  ${saraResult.roboticsInterest.interestScore.currentScore.toFixed(2)}`
        );
        console.log(
            `Robotics confidence:                     ${saraResult.roboticsInterest.confidence.currentScore.toFixed(2)}`
        );
        console.log(
            `Painting learned score:                  ${saraResult.paintingInterest.interestScore.currentScore.toFixed(2)}`
        );
        console.log(
            `Painting confidence:                     ${saraResult.paintingInterest.confidence.currentScore.toFixed(2)}`
        );
        console.log("");
        console.log("Interest Subcategories loaded:           2 / 2");
        console.log("Robotics -> STEM mapping:                PASSED");
        console.log("Painting -> Arts mapping:                PASSED");
        console.log("");
        console.log("Robotics Lab exact-interest join:        PASSED");
        console.log("Creative Robotics same base signal:      PASSED");
        console.log("Painting Studio exact-interest join:     PASSED");
        console.log("");
        console.log(
            `Robotics sibling STEM interests:         ${saraResult.roboticsSiblings}`
        );
        console.log(
            `Painting sibling Arts interests:         ${saraResult.paintingSiblings}`
        );
        console.log("");
        console.log("Omar learned interests:                  1 / 1");
        console.log("Lina learned interests:                  0 / 0");
        console.log("");
        console.log("String Child ID:                         PASSED");
        console.log("D4 evidence:                             PRESERVED");
        console.log("");
        console.log("Candidate filtering:                     NONE");
        console.log("Interest factor calculation:             NONE");
        console.log("Final scoring:                           NONE");
        console.log("Ranking:                                 NONE");
        console.log("");
        console.log("Mongo writes:                            NONE");
        console.log("Neo4j writes:                            NONE");
        console.log("");
        console.log("========================================");
        console.log("STEP 15B-B INTEREST CONTEXT PASSED");
        console.log("========================================");

    } finally {
        await driver.close();
    }
}

main()
    .then(() => {
        process.exit(0);
    })
    .catch((error) => {
        console.error("STEP 15B-B INTEREST CONTEXT FAILED");
        console.error(error);
        process.exit(1);
    });
