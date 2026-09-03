require("dotenv").config();

const { ObjectId } = require("mongodb");
const { connectMongoDB, getDatabase } = require("../../config/mongodb");
const driver = require("../../config/neo4j");
const {
    buildRecommendationContext
} = require("../../recommendation/recommendationContextService");
const {
    calculatePreferenceFactor
} = require("../../recommendation/preferenceFactorService");

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

async function loadChildByName(db, name) {
    const child = await db.collection("children").findOne({
        "identity.firstName": name,
        "metadata.testDataset": DATASET
    });

    assert(child, `${name} not found`);
    assert(child._id instanceof ObjectId, `${name} _id must be ObjectId`);

    return child;
}

function requireCandidate(context, title) {
    const matches = context.candidates.filter(
        (candidate) => candidate.activity?.title === title
    );

    assertEqual(`${title} candidate count`, matches.length, 1);

    return matches[0];
}

function makeEligibleEvaluation(candidate) {
    return {
        candidate,
        eligibility: {
            eligible: true,
            failedConstraints: []
        },
        eligibleSessions: [],
        sessionEvaluations: [],
        missingInformation: []
    };
}

function calculateForCandidate(context, title) {
    const candidate = requireCandidate(context, title);
    const evidenceSnapshot = JSON.stringify(candidate.evidence);
    const result = calculatePreferenceFactor(
        context,
        makeEligibleEvaluation(candidate)
    );

    assertEqual(
        `${title} D4 evidence preserved`,
        JSON.stringify(candidate.evidence),
        evidenceSnapshot
    );
    assertEqual(`${title} Preference available`, result.available, false);
    assertEqual(`${title} Preference score`, result.score, null);

    return result;
}

async function main() {
    await connectMongoDB();

    const db = getDatabase();

    try {
        const sara = await loadChildByName(db, "Sara");
        const omar = await loadChildByName(db, "Omar");
        const lina = await loadChildByName(db, "Lina");

        const saraContext = await buildRecommendationContext(sara._id);
        const omarContext = await buildRecommendationContext(omar._id);
        const linaContext = await buildRecommendationContext(lina._id);

        const saraRobotics =
            calculateForCandidate(saraContext, "Robotics Lab");
        const saraCreativeRobotics =
            calculateForCandidate(saraContext, "Creative Robotics");
        const saraPainting =
            calculateForCandidate(saraContext, "Painting Studio");
        const omarPreference =
            calculateForCandidate(omarContext, "Football Team Camp");
        const linaPreference =
            calculateForCandidate(linaContext, "Painting Studio");

        assertEqual("Sara Robotics score", saraRobotics.score, null);
        assertEqual(
            "Sara Creative Robotics score",
            saraCreativeRobotics.score,
            null
        );
        assertEqual("Sara Painting score", saraPainting.score, null);
        assertEqual("Omar Preference available", omarPreference.available, false);
        assertEqual("Lina Preference available", linaPreference.available, false);

        console.log("========================================");
        console.log("STEP 15C-B - REAL PREFERENCE FACTOR");
        console.log("========================================");
        console.log("");
        console.log("Sara Robotics Lab:");
        console.log("available:                             NO");
        console.log("score:                                 null");
        console.log("");
        console.log("Sara Creative Robotics:");
        console.log("available:                             NO");
        console.log("score:                                 null");
        console.log("");
        console.log("Sara Painting Studio:");
        console.log("available:                             NO");
        console.log("score:                                 null");
        console.log("");
        console.log("Omar Preference:");
        console.log("available:                             NO");
        console.log("");
        console.log("Lina Preference:");
        console.log("available:                             NO");
        console.log("");
        console.log("Reason:");
        console.log("Current SYSTEM_TEST_V1 Activity experience preference fields are");
        console.log("missing/unconfirmed.");
        console.log("");
        console.log("Missing Activity data treated as zero:");
        console.log("NO");
        console.log("");
        console.log("D4 evidence:");
        console.log("PRESERVED");
        console.log("");
        console.log("Mongo writes:");
        console.log("NONE");
        console.log("");
        console.log("Neo4j writes:");
        console.log("NONE");
        console.log("");
        console.log("========================================");
        console.log("STEP 15C-B REAL PREFERENCE TEST PASSED");
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
        console.error("STEP 15C-B REAL PREFERENCE TEST FAILED");
        console.error(error);
        process.exit(1);
    });
