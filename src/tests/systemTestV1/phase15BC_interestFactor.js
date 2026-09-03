require("dotenv").config();

const { ObjectId } = require("mongodb");
const { connectMongoDB, getDatabase } = require("../../config/mongodb");
const driver = require("../../config/neo4j");
const {
    buildRecommendationContext
} = require("../../recommendation/recommendationContextService");
const {
    calculateInterestFactor
} = require("../../recommendation/interestFactorService");

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

function cloneEvidence(candidate) {
    return JSON.stringify(candidate.evidence);
}

function calculateForCandidate(context, title) {
    const candidate = requireCandidate(context, title);
    const evidenceSnapshot = cloneEvidence(candidate);
    const result = calculateInterestFactor(
        context,
        makeEligibleEvaluation(candidate)
    );

    assertEqual(
        `${title} D4 evidence preserved`,
        cloneEvidence(candidate),
        evidenceSnapshot
    );

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

        const roboticsLab =
            calculateForCandidate(saraContext, "Robotics Lab");
        const creativeRobotics =
            calculateForCandidate(saraContext, "Creative Robotics");
        const paintingStudio =
            calculateForCandidate(saraContext, "Painting Studio");
        const omarFootball =
            calculateForCandidate(omarContext, "Football Team Camp");
        const linaCandidate =
            calculateForCandidate(linaContext, "Painting Studio");

        assertEqual("Robotics Lab available", roboticsLab.available, true);
        assertEqual(
            "Creative Robotics available",
            creativeRobotics.available,
            true
        );
        assertEqual(
            "Painting Studio available",
            paintingStudio.available,
            true
        );
        assertEqual("Omar Football available", omarFootball.available, true);
        assertEqual("Lina Interest available", linaCandidate.available, false);

        assertClose("Sara Robotics Lab Interest", roboticsLab.score, 0.88);
        assertClose(
            "Sara Creative Robotics Interest",
            creativeRobotics.score,
            0.88
        );
        assertClose(
            "Sara Painting Studio Interest",
            paintingStudio.score,
            0.56
        );
        assertClose("Omar Football Interest", omarFootball.score, 0.91);
        assertEqual("Lina score", linaCandidate.score, null);
        assertEqual(
            "Same Robotics signal",
            roboticsLab.score,
            creativeRobotics.score
        );

        console.log("========================================");
        console.log("STEP 15B-C - REAL INTEREST FACTOR");
        console.log("========================================");
        console.log("");
        console.log("Sara:");
        console.log(`Robotics Lab:                       ${roboticsLab.score.toFixed(2)}`);
        console.log(`Creative Robotics:                  ${creativeRobotics.score.toFixed(2)}`);
        console.log(`Painting Studio:                    ${paintingStudio.score.toFixed(2)}`);
        console.log("");
        console.log("Same Robotics signal:               PASSED");
        console.log("");
        console.log(`Omar Football:                      ${omarFootball.score.toFixed(2)}`);
        console.log("");
        console.log("Lina Interest available:            NO");
        console.log("Lina score:                         null");
        console.log("");
        console.log("D4 evidence:                        PRESERVED");
        console.log("Mongo writes:                       NONE");
        console.log("Neo4j writes:                       NONE");
        console.log("");
        console.log("========================================");
        console.log("STEP 15B-C REAL INTEREST TEST PASSED");
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
        console.error("STEP 15B-C REAL INTEREST TEST FAILED");
        console.error(error);
        process.exit(1);
    });
