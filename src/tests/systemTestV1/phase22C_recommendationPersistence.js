require("dotenv").config();

const assert = require("assert");
const { ObjectId } = require("mongodb");
const { connectMongoDB, getDatabase } = require("../../config/mongodb");
const driver = require("../../config/neo4j");
const {
    SCORING_FACTORS,
    createCandidateScoringState
} = require("../../recommendation/scoringContract");
const {
    buildRecommendationContext
} = require("../../recommendation/recommendationContextService");
const recommendationDataService =
    require("../../recommendation/recommendationDataService");
const {
    calculateInterestFactor
} = require("../../recommendation/interestFactorService");
const {
    calculatePreferenceFactor
} = require("../../recommendation/preferenceFactorService");
const {
    calculateGoalFactor
} = require("../../recommendation/goalFactorService");
const {
    calculateExplorationFactor
} = require("../../recommendation/explorationFactorService");
const {
    calculateBehaviorFactor
} = require("../../recommendation/behaviorFactorService");
const {
    calculateSessionFactor
} = require("../../recommendation/sessionFactorService");
const {
    calculateFinalScore
} = require("../../recommendation/finalScoreService");
const { rankCandidates } = require("../../recommendation/rankingService");
const { selectTopN } = require("../../recommendation/selectionService");
const {
    buildRecommendationResults
} = require("../../recommendation/recommendationResultBuilder");
const {
    persistRecommendationSnapshot
} = require("../../recommendation/recommendationPersistenceService");

const DATASET = "SYSTEM_TEST_V1";
const FACTORS = Object.values(SCORING_FACTORS);

function snapshot(value) {
    return JSON.stringify(value);
}

async function collectionExists(db, name) {
    const collections = await db.listCollections(
        { name },
        { nameOnly: true }
    ).toArray();

    return collections.length > 0;
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

function composeFactors(state, results) {
    return {
        ...state,
        factors: {
            ...state.factors,
            [SCORING_FACTORS.INTEREST]: results.interest,
            [SCORING_FACTORS.PREFERENCE]: results.preference,
            [SCORING_FACTORS.GOAL]: results.goal,
            [SCORING_FACTORS.EXPLORATION]: results.exploration,
            [SCORING_FACTORS.BEHAVIOR]: results.behavior,
            [SCORING_FACTORS.SESSION]: results.session
        }
    };
}

function titleOf(record) {
    return record.candidate.activity?.title;
}

function calculateRecords(context) {
    return context.candidates.map((candidate) => {
        const eligibilityEvaluation = makeEligibleEvaluation(candidate);
        const state = createCandidateScoringState(eligibilityEvaluation);
        const results = {
            interest: calculateInterestFactor(context, eligibilityEvaluation),
            preference: calculatePreferenceFactor(context, eligibilityEvaluation),
            goal: calculateGoalFactor(context, eligibilityEvaluation),
            exploration: calculateExplorationFactor(context, eligibilityEvaluation),
            behavior: calculateBehaviorFactor(context, eligibilityEvaluation),
            session: calculateSessionFactor(eligibilityEvaluation, context)
        };
        const scoringState = composeFactors(state, results);

        return {
            candidate,
            eligibilityEvaluation,
            scoringState,
            finalScore: calculateFinalScore(scoringState)
        };
    });
}

function assertNoSnapshotLeakage(document) {
    const forbidden = [
        "explanation",
        "reason",
        "reasonText",
        "whyRecommended",
        "expiresAt",
        "expirationTimestamp",
        "cacheTTL",
        "activeUntil",
        "unselectedRanked",
        "unranked",
        "candidate",
        "eligibilityEvaluation",
        "historyContext",
        "parent",
        "child"
    ];

    for (const field of forbidden) {
        assert(!Object.prototype.hasOwnProperty.call(document, field));
    }

    for (const item of document.recommendedItems) {
        assert(!Object.prototype.hasOwnProperty.call(item, "currentActivity"));
        assert(!Object.prototype.hasOwnProperty.call(item, "currentSessions"));
        assert(!Object.prototype.hasOwnProperty.call(item, "vendor"));
        assert(!Object.prototype.hasOwnProperty.call(item.factors, "vendor"));
    }
}

function assertStoredDocument({
    document,
    context,
    recommendationResults,
    requestedAt
}) {
    assert(document, "Inserted recommendation document must be fetchable");
    assert(document.parentId.equals(context.parent._id));
    assert(document.childId.equals(context.child._id));
    assert(document.recommendationContext.requestedAt instanceof Date);
    assert.strictEqual(
        document.recommendationContext.requestedAt.getTime(),
        requestedAt.getTime()
    );
    assert.strictEqual(document.recommendedItems.length, 3);
    assert.deepStrictEqual(
        document.recommendedItems.map((item) => String(item.activityId)),
        recommendationResults.map((result) => result.activityId)
    );
    assert.deepStrictEqual(
        document.recommendedItems.map((item) => item.rank),
        [1, 2, 3]
    );
    assert.deepStrictEqual(
        document.recommendedItems.map((item) => item.score),
        recommendationResults.map((result) => result.score)
    );

    for (let index = 0; index < document.recommendedItems.length; index += 1) {
        const stored = document.recommendedItems[index];
        const source = recommendationResults[index];

        assert.deepStrictEqual(Object.keys(stored.factors), FACTORS);
        assert.deepStrictEqual(stored.factors, source.factors);
        assert.strictEqual(stored.scoring.availableWeight, source.scoring.availableWeight);
        assert.strictEqual(
            stored.scoring.availableFactorCount,
            source.scoring.availableFactorCount
        );
        assert.deepStrictEqual(
            stored.scoring.contributions,
            source.scoring.contributions
        );
        assert.deepStrictEqual(
            snapshot(stored.evidence),
            snapshot(source.evidence)
        );
        assert.deepStrictEqual(
            stored.eligibleSessionIds.map(String),
            source.eligibleSessionIds
        );
    }

    assert.strictEqual(document.algorithmVersion, 1);
    assert.deepStrictEqual(document.response, {
        wasDisplayed: false,
        displayedAt: null,
        clickedActivityIds: [],
        savedActivityIds: [],
        bookedSessionIds: [],
        dismissedActivityIds: [],
        lastResponseAt: null
    });
    assert.strictEqual(document.metadata.version, 1);
    assert(document.metadata.createdAt instanceof Date);
    assert(document.metadata.updatedAt instanceof Date);
    assert.strictEqual(
        document.metadata.createdAt.getTime(),
        document.metadata.updatedAt.getTime()
    );
    assertNoSnapshotLeakage(document);
}

async function verifyHistoryLoaderCompatibility({
    context,
    recommendationResults,
    insertedId
}) {
    const history =
        await recommendationDataService.getExplorationRecommendationHistory(
            context.child._id,
            recommendationResults.map((result) => result.activityId)
        );
    const inserted = history.recommendations.find((recommendation) =>
        String(recommendation._id) === String(insertedId)
    );

    assert.strictEqual(history.source, "available");
    assert(inserted, "Inserted recommendation must be loaded as history");
    assert.strictEqual(inserted.response.wasDisplayed, false);
    assert.deepStrictEqual(
        inserted.recommendedItems.map((item) => String(item.activityId)),
        recommendationResults.map((result) => result.activityId)
    );
}

async function buildSaraRecommendationResults(db) {
    const child = await loadChildByName(db, "Sara");
    const context = await buildRecommendationContext(child._id);
    const contextSnapshot = snapshot(context);
    const records = calculateRecords(context);
    const ranking = rankCandidates(records);
    const selection = selectTopN(ranking, 3);
    const recommendationResults = buildRecommendationResults(selection);

    assert.deepStrictEqual(selection.selected.map(titleOf), [
        "Strategy Escape Challenge",
        "Robotics Lab",
        "Creative Robotics"
    ]);
    assert.strictEqual(snapshot(context), contextSnapshot);

    return {
        context,
        recommendationResults
    };
}

async function main() {
    await connectMongoDB();
    const db = getDatabase();
    const existedBefore = await collectionExists(db, "recommendations");
    const baselineCount = existedBefore
        ? await db.collection("recommendations").countDocuments({})
        : null;
    let insertedId = null;
    let cleanupDeleteResult = null;

    try {
        const {
            context,
            recommendationResults
        } = await buildSaraRecommendationResults(db);
        const resultsSnapshot = snapshot(recommendationResults);
        const requestedAt = new Date();
        const persistenceResult = await persistRecommendationSnapshot({
            parentId: context.parent._id,
            childId: context.child._id,
            requestedAt,
            recommendationResults
        });

        insertedId = new ObjectId(persistenceResult.recommendationId);

        const document = await db.collection("recommendations")
            .findOne({ _id: insertedId });

        assertStoredDocument({
            document,
            context,
            recommendationResults,
            requestedAt
        });
        assert.strictEqual(snapshot(recommendationResults), resultsSnapshot);

        await verifyHistoryLoaderCompatibility({
            context,
            recommendationResults,
            insertedId
        });

        console.log("========================================");
        console.log("STEP 22C - REAL RECOMMENDATION PERSISTENCE");
        console.log("========================================");
        console.log(`Collection existed before: ${existedBefore ? "YES" : "NO"}`);
        console.log("Real child: Sara");
        console.log("Top-N: 3");
        console.log(`Recommendation ID: ${persistenceResult.recommendationId}`);
        console.log("Recommendation inserted: PASS");
        console.log("Stored item count: 3");
        console.log("Scores preserved: PASS");
        console.log("Ranks preserved: PASS");
        console.log("Factors preserved: PASS");
        console.log("Evidence preserved: PASS");
        console.log("History loader compatibility: PASS");
        console.log("wasDisplayed false: PASS");
        console.log("No explanation: PASS");
        console.log("No expiration: PASS");
    } finally {
        if (insertedId) {
            cleanupDeleteResult = await db.collection("recommendations")
                .deleteOne({ _id: insertedId });
        }

        if (!existedBefore && await collectionExists(db, "recommendations")) {
            await db.collection("recommendations").drop();
        }

        const existsAfter = await collectionExists(db, "recommendations");

        if (existedBefore) {
            const finalCount = await db.collection("recommendations")
                .countDocuments({});

            assert.strictEqual(existsAfter, true);
            assert.strictEqual(finalCount, baselineCount);
        } else {
            assert.strictEqual(existsAfter, false);
        }

        if (insertedId) {
            assert.strictEqual(cleanupDeleteResult.deletedCount, 1);
        }

        await driver.close();
    }

    console.log("Exact inserted document removed: PASS");
    console.log("Collection presence restored: PASS");
    console.log("Baseline document count restored: PASS");
    console.log("No test artifacts remain: PASS");
    console.log("");
    console.log("STEP 22C REAL RECOMMENDATION PERSISTENCE PASSED");
}

main()
    .then(() => {
        process.exit(0);
    })
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
