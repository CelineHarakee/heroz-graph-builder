require("dotenv").config();

const assert = require("assert");
const { ObjectId } = require("mongodb");
const { connectMongoDB, getDatabase } = require("../../config/mongodb");
const driver = require("../../config/neo4j");
const {
    SCORING_FACTORS
} = require("../../recommendation/scoringContract");
const {
    buildRecommendationContext
} = require("../../recommendation/recommendationContextService");
const {
    evaluateRecommendationEligibility
} = require("../../recommendation/recommendationEligibilityService");
const recommendationDataService =
    require("../../recommendation/recommendationDataService");
const {
    generateRecommendations
} = require("../../recommendation/recommendationEngineService");

const DATASET = "SYSTEM_TEST_V1";
const TEST_DATASET = "STEP22E_FINAL_D5";
const FACTORS = Object.values(SCORING_FACTORS);
const EXPECTED_TOP_3 = [
    {
        title: "Strategy Escape Challenge",
        score: 1,
        factors: {
            interest: null,
            preference: null,
            goal: 1,
            exploration: null,
            behavior: null,
            session: null
        }
    },
    {
        title: "Robotics Lab",
        score: 0.9191836734693879,
        factors: {
            interest: 0.88,
            preference: null,
            goal: 1,
            exploration: null,
            behavior: null,
            session: null
        }
    },
    {
        title: "Creative Robotics",
        score: 0.755918367346939,
        factors: {
            interest: 0.88,
            preference: null,
            goal: 0.5,
            exploration: null,
            behavior: null,
            session: null
        }
    }
];

function assertClose(label, actual, expected, tolerance = 0.000001) {
    assert(
        typeof actual === "number" &&
        Math.abs(actual - expected) <= tolerance,
        `${label}: expected ${expected}, found ${actual}`
    );
}

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

async function countCollection(db, name) {
    if (!await collectionExists(db, name)) {
        return null;
    }

    return await db.collection(name).countDocuments({});
}

async function loadSara(db) {
    const sara = await db.collection("children").findOne({
        "identity.firstName": "Sara",
        "metadata.testDataset": DATASET
    });

    assert(sara, "Sara fixture not found");
    assert(sara._id instanceof ObjectId, "Sara _id must be ObjectId");

    return sara;
}

function titleOfCandidate(candidate) {
    return candidate.currentActivity?.basicInformation?.nameEn ??
        candidate.activity?.title;
}

function metadata(now) {
    return {
        version: 1,
        createdBy: "System",
        createdAt: now,
        updatedAt: now,
        testDataset: TEST_DATASET
    };
}

function makeSession(candidate, index, now) {
    const bookingDeadline = new Date(
        now.getTime() + ((30 + index) * 24 * 60 * 60 * 1000)
    );
    const startDateTime = new Date(
        now.getTime() + ((60 + index) * 24 * 60 * 60 * 1000)
    );
    const endDateTime = new Date(
        startDateTime.getTime() + (2 * 60 * 60 * 1000)
    );

    return {
        _id: new ObjectId(),
        activityId: candidate.currentActivity._id,
        vendorId: candidate.currentActivity.vendorId,
        schedule: {
            startDateTime,
            endDateTime,
            timezone: "Asia/Riyadh",
            bookingDeadline
        },
        capacity: {
            totalCapacity: 10,
            bookedCapacity: 2,
            remainingCapacity: 8,
            minimumParticipants: 1
        },
        availability: {
            status: "Available",
            registrationOpen: true,
            cancellationReason: null
        },
        metadata: metadata(now)
    };
}

function assertReturnContract(result) {
    assert.deepStrictEqual(Object.keys(result), [
        "childId",
        "requestedAt",
        "recommendationId",
        "recommendations"
    ]);
    assert(result.requestedAt instanceof Date);
    assert.strictEqual(typeof result.recommendationId, "string");
    assert(result.recommendationId.length > 0);

    for (const field of [
        "context",
        "recommendationContext",
        "rankingResult",
        "selectionResult",
        "unselectedRanked",
        "unranked",
        "eligibleCandidates",
        "candidateEvaluations",
        "historyContext",
        "parent"
    ]) {
        assert(!Object.prototype.hasOwnProperty.call(result, field));
    }
}

function assertRecommendationResult(item, expected, activityIdByTitle, sessionIdByActivityId) {
    const expectedActivityId = activityIdByTitle.get(expected.title);

    assert.strictEqual(item.activityId, expectedActivityId);
    assert.strictEqual(item.rank, EXPECTED_TOP_3.indexOf(expected) + 1);
    assertClose(`${expected.title} score`, item.score, expected.score);
    assert.deepStrictEqual(Object.keys(item.factors), FACTORS);
    assert.deepStrictEqual(Object.keys(item.evidence.factors), FACTORS);
    assert.deepStrictEqual(item.eligibleSessionIds, [
        sessionIdByActivityId.get(item.activityId)
    ]);
    assert(item.evidence.discovery);
    assert(!Object.prototype.hasOwnProperty.call(item, "currentActivity"));
    assert(!Object.prototype.hasOwnProperty.call(item, "currentSessions"));
    assert(!Object.prototype.hasOwnProperty.call(item, "vendor"));
    assert(!Object.prototype.hasOwnProperty.call(item, "eligibilityEvaluation"));
    assert(!Object.prototype.hasOwnProperty.call(item, "sessionEvaluations"));
    assert(Object.prototype.hasOwnProperty.call(item, "explanation"));
    assert(item.explanation);
    assert(Array.isArray(item.explanation.reasonTypes));
    assert(["en", "ar"].includes(item.explanation.language));
    assert(typeof item.explanation.text === "string");
    assert(item.explanation.text.trim().length > 0);
    assert(["generated", "fallback"].includes(item.explanation.source));
    assert(!Object.prototype.hasOwnProperty.call(item.factors, "vendor"));

    for (const factor of FACTORS) {
        const factorState = item.factors[factor];
        const expectedScore = expected.factors[factor];

        if (expectedScore === null) {
            assert.strictEqual(factorState.available, false, `${expected.title} ${factor}`);
            assert.strictEqual(factorState.score, null, `${expected.title} ${factor}`);
        } else {
            assert.strictEqual(factorState.available, true, `${expected.title} ${factor}`);
            assertClose(`${expected.title} ${factor}`, factorState.score, expectedScore);
        }
    }

    assert.strictEqual(item.factors.session.available, false);
    assert.strictEqual(item.factors.session.score, null);
    assert(item.scoring.availableWeight > 0);
    assert(Number.isInteger(item.scoring.availableFactorCount));
    assert(Array.isArray(item.scoring.contributions));
}

function assertStoredSnapshot({
    document,
    sara,
    result,
    activityIdByTitle,
    sessionIdByActivityId
}) {
    assert(document, "Persisted recommendation must be found");
    assert.strictEqual(String(document._id), result.recommendationId);
    assert(document.childId.equals(sara._id));
    assert(document.parentId.equals(sara.parentId));
    assert.strictEqual(
        document.recommendationContext.requestedAt.getTime(),
        result.requestedAt.getTime()
    );
    assert.strictEqual(document.recommendedItems.length, 3);

    for (let index = 0; index < EXPECTED_TOP_3.length; index += 1) {
        const stored = document.recommendedItems[index];
        const returned = result.recommendations[index];
        const expected = EXPECTED_TOP_3[index];

        assert.strictEqual(String(stored.activityId), activityIdByTitle.get(expected.title));
        assert.strictEqual(stored.rank, index + 1);
        assertClose(`${expected.title} stored score`, stored.score, expected.score);
        assert.deepStrictEqual(stored.factors, returned.factors);
        assert.deepStrictEqual(stored.scoring, returned.scoring);
        assert.deepStrictEqual(snapshot(stored.evidence), snapshot(returned.evidence));
        assert.deepStrictEqual(
            stored.eligibleSessionIds.map(String),
            [sessionIdByActivityId.get(returned.activityId)]
        );
    }

    assert.strictEqual(
        document.recommendedItems.some((item) =>
            String(item.activityId) === activityIdByTitle.get("Football Team Camp")
        ),
        false
    );
    assert.strictEqual(
        document.recommendedItems.some((item) =>
            String(item.activityId) === activityIdByTitle.get("Painting Studio")
        ),
        false
    );
    assert.strictEqual(document.algorithmVersion, 1);
    assert.strictEqual(document.metadata.version, 1);
    assert.deepStrictEqual(document.response, {
        wasDisplayed: false,
        displayedAt: null,
        clickedActivityIds: [],
        savedActivityIds: [],
        bookedSessionIds: [],
        dismissedActivityIds: [],
        lastResponseAt: null
    });

    for (const field of [
        "explanation",
        "reason",
        "reasonText",
        "whyRecommended",
        "expiresAt",
        "expirationTimestamp",
        "cacheTTL",
        "unselectedRanked",
        "unranked",
        "eligibilityEvaluation"
    ]) {
        assert(!Object.prototype.hasOwnProperty.call(document, field));
    }
}

async function verifyHistoryCompatibility(context, result) {
    const history =
        await recommendationDataService.getExplorationRecommendationHistory(
            context.child._id,
            result.recommendations.map((item) => item.activityId)
        );
    const generated = history.recommendations.find((recommendation) =>
        String(recommendation._id) === result.recommendationId
    );

    assert.strictEqual(history.source, "available");
    assert(generated, "Generated recommendation must be loaded by history loader");
    assert.strictEqual(generated.response.wasDisplayed, false);
    assert.deepStrictEqual(
        generated.recommendedItems.map((item) => String(item.activityId)),
        result.recommendations.map((item) => item.activityId)
    );
}

async function cleanup({
    db,
    sessionIds,
    recommendationId,
    sessionsExistedBefore,
    sessionsBaselineCount,
    recommendationsExistedBefore,
    recommendationsBaselineCount
}) {
    if (recommendationId) {
        await db.collection("recommendations")
            .deleteOne({ _id: new ObjectId(recommendationId) });
    }

    if (sessionIds.length > 0) {
        await db.collection("sessions").deleteMany({
            _id: {
                $in: sessionIds
            }
        });
    }

    if (
        !recommendationsExistedBefore &&
        await collectionExists(db, "recommendations")
    ) {
        await db.collection("recommendations").drop();
    }

    if (!sessionsExistedBefore && await collectionExists(db, "sessions")) {
        await db.collection("sessions").drop();
    }

    const sessionsExistAfter = await collectionExists(db, "sessions");
    const recommendationsExistAfter =
        await collectionExists(db, "recommendations");

    assert.strictEqual(sessionsExistAfter, sessionsExistedBefore);
    assert.strictEqual(recommendationsExistAfter, recommendationsExistedBefore);

    if (sessionsExistedBefore) {
        assert.strictEqual(
            await db.collection("sessions").countDocuments({}),
            sessionsBaselineCount
        );
    }

    if (recommendationsExistedBefore) {
        assert.strictEqual(
            await db.collection("recommendations").countDocuments({}),
            recommendationsBaselineCount
        );
    }

    for (const sessionId of sessionIds) {
        assert.strictEqual(
            await db.collection("sessions").countDocuments({ _id: sessionId }),
            0
        );
    }

    if (recommendationId && recommendationsExistAfter) {
        assert.strictEqual(
            await db.collection("recommendations").countDocuments({
                _id: new ObjectId(recommendationId)
            }),
            0
        );
    }
}

async function main() {
    await connectMongoDB();
    const db = getDatabase();
    const sessionsExistedBefore = await collectionExists(db, "sessions");
    const recommendationsExistedBefore =
        await collectionExists(db, "recommendations");
    const sessionsBaselineCount = await countCollection(db, "sessions");
    const recommendationsBaselineCount =
        await countCollection(db, "recommendations");
    const sara = await loadSara(db);
    const baselineContext = await buildRecommendationContext(sara._id);
    const activityIdByTitle = new Map();
    const sessionIdByActivityId = new Map();
    const insertedSessionIds = [];
    let recommendationId = null;

    assert.strictEqual(baselineContext.candidates.length, 5);
    assert.deepStrictEqual(
        baselineContext.candidates.map(titleOfCandidate).sort(),
        [
            "Creative Robotics",
            "Football Team Camp",
            "Painting Studio",
            "Robotics Lab",
            "Strategy Escape Challenge"
        ]
    );

    for (const candidate of baselineContext.candidates) {
        activityIdByTitle.set(
            titleOfCandidate(candidate),
            String(candidate.currentActivity._id)
        );
    }

    try {
        const now = new Date();
        const sessions = baselineContext.candidates.map((candidate, index) =>
            makeSession(candidate, index, now)
        );
        const insertResult = await db.collection("sessions")
            .insertMany(sessions);

        insertedSessionIds.push(...Object.values(insertResult.insertedIds));

        for (const session of sessions) {
            sessionIdByActivityId.set(String(session.activityId), String(session._id));
        }

        assert.strictEqual(insertedSessionIds.length, 5);

        const preEngineContext = await buildRecommendationContext(sara._id);
        const preEngineEligibility =
            evaluateRecommendationEligibility(preEngineContext);

        assert.strictEqual(preEngineContext.candidates.length, 5);
        assert.strictEqual(preEngineEligibility.eligibleCandidates.length, 5);

        for (const candidate of preEngineContext.candidates) {
            assert.strictEqual(candidate.currentSessions.length, 1);
        }

        const recommendationBaselineCount =
            recommendationsExistedBefore
                ? await db.collection("recommendations").countDocuments({})
                : 0;
        const result = await generateRecommendations(sara._id, 3);
        const resultSnapshot = snapshot(result);

        recommendationId = result.recommendationId;

        assertReturnContract(result);
        assert.strictEqual(result.childId, String(sara._id));
        assert.strictEqual(result.recommendations.length, 3);

        for (let index = 0; index < EXPECTED_TOP_3.length; index += 1) {
            assertRecommendationResult(
                result.recommendations[index],
                EXPECTED_TOP_3[index],
                activityIdByTitle,
                sessionIdByActivityId
            );
        }

        const recommendationsCountAfter =
            await db.collection("recommendations").countDocuments({});

        assert.strictEqual(
            recommendationsCountAfter,
            recommendationBaselineCount + 1
        );

        const stored = await db.collection("recommendations")
            .findOne({ _id: new ObjectId(recommendationId) });

        assertStoredSnapshot({
            document: stored,
            sara,
            result,
            activityIdByTitle,
            sessionIdByActivityId
        });

        await verifyHistoryCompatibility(preEngineContext, result);

        assert.strictEqual(snapshot(result), resultSnapshot);

        console.log("========================================");
        console.log("STEP 22E - FINAL D5 END-TO-END");
        console.log("========================================");
        console.log(`Sessions collection existed: ${sessionsExistedBefore ? "YES" : "NO"}`);
        console.log(`Sessions baseline count: ${sessionsBaselineCount ?? "N/A"}`);
        console.log(`Recommendations collection existed: ${recommendationsExistedBefore ? "YES" : "NO"}`);
        console.log(`Recommendations baseline count: ${recommendationsBaselineCount ?? "N/A"}`);
        console.log("Temporary eligible Sessions inserted: 5");
        console.log("Sara candidate Sessions: PASS");
        console.log("Only Session fixtures mutated: YES");
        console.log("Production generateRecommendations used: YES");
        console.log("Manual pipeline assembly: NO");
        console.log("Child: Sara");
        console.log("Top-N: 3");
        console.log("D4 candidates: 5");
        console.log("Hard-eligible candidates: 5");
        console.log("Returned recommendations: 3");
        console.log("Recommendation ID returned: YES");
    } finally {
        await cleanup({
            db,
            sessionIds: insertedSessionIds,
            recommendationId,
            sessionsExistedBefore,
            sessionsBaselineCount,
            recommendationsExistedBefore,
            recommendationsBaselineCount
        });

        await driver.close();
    }

    console.log("Inserted recommendation removed: PASS");
    console.log("Temporary Sessions removed: PASS");
    console.log("Sessions baseline restored: PASS");
    console.log("Recommendations baseline restored: PASS");
    console.log("Collection-presence baseline restored: PASS");
    console.log("No artifacts remain: PASS");
    console.log("");
    console.log("STEP 22E FINAL D5 END-TO-END PASSED");
}

main()
    .then(() => {
        process.exit(0);
    })
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
