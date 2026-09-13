const assert = require("assert");
const { ObjectId } = require("mongodb");
const {
    createRecommendationEngine
} = require("../recommendation/recommendationEngineService");

function snapshot(value) {
    return JSON.parse(JSON.stringify(value));
}

function assertThrowsAsync(label, fn) {
    return assert.rejects(fn, Error, label);
}

function makeCandidate(id) {
    return {
        id,
        activity: {
            activityId: id,
            title: id
        },
        currentActivity: {
            _id: id
        },
        evidence: {
            interests: [],
            goals: [],
            summary: []
        }
    };
}

function makeContext(candidates = [
    makeCandidate("activity_a"),
    makeCandidate("activity_b"),
    makeCandidate("activity_c")
]) {
    return {
        child: {
            _id: new ObjectId("64f000000000000000000001")
        },
        parent: {
            _id: new ObjectId("64f000000000000000000002"),
            account: {
                preferredLanguage: "en"
            }
        },
        candidates,
        historyContext: {},
        interestContext: {},
        goalContext: {}
    };
}

function makeFactor(name, score = 0.8) {
    return {
        factor: name,
        available: true,
        score,
        evidence: [{ type: `${name}_evidence` }]
    };
}

function createHarness({
    context = makeContext(),
    eligibleIds = ["activity_a", "activity_b"],
    unavailableFinalIds = [],
    resultCount,
    throwAt,
    persistenceId = "64f000000000000000000099"
} = {}) {
    const calls = {
        order: [],
        context: 0,
        eligibility: 0,
        factors: [],
        finalScore: [],
        ranking: [],
        selection: [],
        resultBuilder: [],
        persistence: [],
        explanations: []
    };
    const requestedAt = new Date("2026-09-08T12:00:00.000Z");

    function maybeThrow(stage) {
        if (throwAt === stage) {
            throw new Error(`${stage} failed`);
        }
    }

    function factorDependency(name) {
        return function calculateFactor(_context, eligibilityEvaluation) {
            maybeThrow("factor");
            calls.order.push(`factor:${name}:${eligibilityEvaluation.candidate.id}`);
            calls.factors.push({
                factor: name,
                candidateId: eligibilityEvaluation.candidate.id
            });
            return makeFactor(name);
        };
    }

    const dependencies = {
        now: () => requestedAt,
        async buildRecommendationContext(childId) {
            maybeThrow("context");
            calls.order.push("context");
            calls.context += 1;
            calls.contextChildId = String(childId);
            return context;
        },
        async evaluateRecommendationEligibility(sourceContext) {
            maybeThrow("eligibility");
            calls.order.push("eligibility");
            calls.eligibility += 1;
            assert.strictEqual(sourceContext, context);

            return {
                requestEligibility: {
                    eligible: true,
                    failedConstraints: []
                },
                candidateEvaluations: sourceContext.candidates.map((candidate) => ({
                    candidate,
                    eligibility: {
                        eligible: eligibleIds.includes(candidate.id),
                        failedConstraints: []
                    },
                    eligibleSessions: [],
                    sessionEvaluations: [],
                    missingInformation: []
                })),
                eligibleCandidates: sourceContext.candidates
                    .filter((candidate) => eligibleIds.includes(candidate.id))
                    .map((candidate) => ({
                        candidate,
                        eligibility: {
                            eligible: true,
                            failedConstraints: []
                        },
                        eligibleSessions: [],
                        sessionEvaluations: [],
                        missingInformation: []
                    }))
            };
        },
        createCandidateScoringState(eligibilityEvaluation) {
            calls.order.push(`state:${eligibilityEvaluation.candidate.id}`);
            return {
                eligibilityEvaluation,
                factors: {
                    interest: null,
                    preference: null,
                    goal: null,
                    exploration: null,
                    behavior: null,
                    session: null
                }
            };
        },
        calculateInterestFactor: factorDependency("interest"),
        calculatePreferenceFactor: factorDependency("preference"),
        calculateGoalFactor: factorDependency("goal"),
        calculateExplorationFactor: factorDependency("exploration"),
        calculateBehaviorFactor: factorDependency("behavior"),
        calculateSessionFactor(eligibilityEvaluation, sourceContext) {
            maybeThrow("factor");
            assert.strictEqual(sourceContext, context);
            calls.order.push(`factor:session:${eligibilityEvaluation.candidate.id}`);
            calls.factors.push({
                factor: "session",
                candidateId: eligibilityEvaluation.candidate.id
            });
            return makeFactor("session");
        },
        calculateFinalScore(scoringState) {
            maybeThrow("finalScore");
            const candidateId = scoringState.eligibilityEvaluation.candidate.id;
            calls.order.push(`finalScore:${candidateId}`);
            calls.finalScore.push(scoringState);
            const available = !unavailableFinalIds.includes(candidateId);

            return {
                available,
                score: available ? (candidateId === "activity_a" ? 0.9 : 0.7) : null,
                availableWeight: available ? 1 : 0,
                availableFactorCount: available ? 6 : 0,
                contributions: available
                    ? [{ factor: "interest", score: 0.8 }]
                    : []
            };
        },
        rankCandidates(records) {
            maybeThrow("ranking");
            calls.order.push("ranking");
            calls.ranking.push(records);

            return {
                ranked: records
                    .filter((record) => record.finalScore.available)
                    .map((record, index) => ({
                        ...record,
                        rank: index + 1
                    })),
                unranked: records
                    .filter((record) => !record.finalScore.available)
                    .map((record) => ({
                        ...record,
                        rank: null
                    }))
            };
        },
        selectTopN(rankingResult, topN) {
            maybeThrow("selection");
            calls.order.push("selection");
            calls.selection.push({ rankingResult, topN });
            const selectedCount = resultCount ?? Math.min(topN, rankingResult.ranked.length);

            return {
                selected: rankingResult.ranked.filter((_, index) =>
                    index < selectedCount
                ),
                unselectedRanked: rankingResult.ranked.filter((_, index) =>
                    index >= selectedCount
                ),
                unranked: rankingResult.unranked
            };
        },
        buildRecommendationResults(selectionResult) {
            maybeThrow("resultBuilder");
            calls.order.push("resultBuilder");
            calls.resultBuilder.push(selectionResult);

            return selectionResult.selected.map((record) => ({
                activityId: record.candidate.id,
                rank: record.rank,
                score: record.finalScore.score,
                marker: "from-result-builder"
            }));
        },
        async persistRecommendationSnapshot(payload) {
            maybeThrow("persistence");
            calls.order.push("persistence");
            calls.persistence.push(payload);

            return {
                recommendationId: persistenceId
            };
        },
        async attachRecommendationExplanations(payload) {
            maybeThrow("explanations");
            calls.order.push("explanations");
            calls.explanations.push(payload);

            return {
                recommendationId: payload.recommendationId,
                recommendations: payload.recommendationResults.map((item) => ({
                    ...item,
                    explanation: {
                        reasonTypes: ["interest"],
                        language: payload.parent.account.preferredLanguage,
                        text: `Explanation for ${item.activityId}`,
                        source: "generated"
                    }
                }))
            };
        }
    };

    return {
        engine: createRecommendationEngine(dependencies),
        calls,
        context,
        requestedAt
    };
}

async function testHappyPathAndServiceOrder() {
    const {
        engine,
        calls,
        context,
        requestedAt
    } = createHarness();
    const contextBefore = snapshot(context);
    const result = await engine.generateRecommendations(
        "64f000000000000000000001",
        2
    );

    assert.deepStrictEqual(Object.keys(result), [
        "childId",
        "requestedAt",
        "recommendationId",
        "recommendations"
    ]);
    assert.strictEqual(result.childId, "64f000000000000000000001");
    assert.strictEqual(result.requestedAt, requestedAt);
    assert.strictEqual(result.recommendationId, "64f000000000000000000099");
    assert.deepStrictEqual(result.recommendations.map((item) => item.activityId), [
        "activity_a",
        "activity_b"
    ]);
    assert(result.recommendations.every((item) =>
        item.marker === "from-result-builder"
    ));
    assert.strictEqual(calls.context, 1);
    assert.strictEqual(calls.eligibility, 1);
    assert.strictEqual(calls.finalScore.length, 2);
    assert.strictEqual(calls.ranking[0].length, 2);
    assert.strictEqual(calls.selection[0].topN, 2);
    assert.strictEqual(calls.persistence.length, 1);
    assert.strictEqual(calls.persistence[0].parentId, context.parent._id);
    assert.strictEqual(calls.persistence[0].childId, context.child._id);
    assert.strictEqual(calls.persistence[0].requestedAt, requestedAt);
    assert.strictEqual(calls.persistence[0].recommendationResults.length, 2);
    assert(!Object.prototype.hasOwnProperty.call(
        calls.persistence[0].recommendationResults[0],
        "explanation"
    ));
    assert.strictEqual(calls.explanations.length, 1);
    assert.strictEqual(calls.explanations[0].recommendationId, result.recommendationId);
    assert.strictEqual(calls.explanations[0].recommendationResults, calls.persistence[0].recommendationResults);
    assert.strictEqual(calls.explanations[0].parent, context.parent);
    assert.deepStrictEqual(snapshot(context), contextBefore);

    const contextIndex = calls.order.indexOf("context");
    const eligibilityIndex = calls.order.indexOf("eligibility");
    const rankingIndex = calls.order.indexOf("ranking");
    const selectionIndex = calls.order.indexOf("selection");
    const builderIndex = calls.order.indexOf("resultBuilder");
    const persistenceIndex = calls.order.indexOf("persistence");
    const explanationsIndex = calls.order.indexOf("explanations");

    assert(contextIndex < eligibilityIndex);
    assert(eligibilityIndex < calls.order.indexOf("factor:interest:activity_a"));
    assert(calls.order.indexOf("factor:session:activity_a") < rankingIndex);
    assert(calls.order.indexOf("finalScore:activity_b") < rankingIndex);
    assert(rankingIndex < selectionIndex);
    assert(selectionIndex < builderIndex);
    assert(builderIndex < persistenceIndex);
    assert(persistenceIndex < explanationsIndex);
}

async function testIneligibleAndMixedCandidates() {
    const {
        engine,
        calls
    } = createHarness({
        eligibleIds: ["activity_a"]
    });

    await engine.generateRecommendations("64f000000000000000000001", 3);

    assert.deepStrictEqual(
        calls.factors.map((call) => call.candidateId),
        Array(6).fill("activity_a")
    );
    assert.strictEqual(calls.finalScore.length, 1);
    assert.deepStrictEqual(
        calls.ranking[0].map((record) => record.candidate.id),
        ["activity_a"]
    );
}

async function testEmptyPathsSkipPersistence() {
    const allIneligible = createHarness({ eligibleIds: [] });
    const allIneligibleResult =
        await allIneligible.engine.generateRecommendations(
            "64f000000000000000000001",
            3
        );

    assert.deepStrictEqual(allIneligibleResult.recommendations, []);
    assert.strictEqual(allIneligibleResult.recommendationId, null);
    assert.strictEqual(allIneligible.calls.persistence.length, 0);
    assert.strictEqual(allIneligible.calls.ranking[0].length, 0);

    const zeroCandidates = createHarness({
        context: makeContext([]),
        eligibleIds: []
    });
    const zeroCandidateResult =
        await zeroCandidates.engine.generateRecommendations(
            "64f000000000000000000001",
            3
        );

    assert.deepStrictEqual(zeroCandidateResult.recommendations, []);
    assert.strictEqual(zeroCandidateResult.recommendationId, null);
    assert.strictEqual(zeroCandidates.calls.persistence.length, 0);

    const unavailable = createHarness({
        eligibleIds: ["activity_a", "activity_b"],
        unavailableFinalIds: ["activity_a", "activity_b"]
    });
    const unavailableResult =
        await unavailable.engine.generateRecommendations(
            "64f000000000000000000001",
            3
        );

    assert.deepStrictEqual(unavailableResult.recommendations, []);
    assert.strictEqual(unavailableResult.recommendationId, null);
    assert.strictEqual(unavailable.calls.persistence.length, 0);
    assert.strictEqual(unavailable.calls.resultBuilder[0].selected.length, 0);
}

async function testShortfallAndTopNPreserved() {
    const {
        engine,
        calls
    } = createHarness({
        eligibleIds: ["activity_a", "activity_b"]
    });
    const result = await engine.generateRecommendations(
        "64f000000000000000000001",
        5
    );

    assert.strictEqual(calls.selection[0].topN, 5);
    assert.strictEqual(result.recommendations.length, 2);
    assert.strictEqual(calls.persistence.length, 1);
    assert.strictEqual(calls.persistence[0].recommendationResults.length, 2);
}

async function testRequestedAtSingleValue() {
    const {
        engine,
        calls,
        requestedAt
    } = createHarness();
    const result = await engine.generateRecommendations(
        new ObjectId("64f000000000000000000001"),
        1
    );

    assert.strictEqual(result.requestedAt, requestedAt);
    assert.strictEqual(calls.persistence[0].requestedAt, requestedAt);
}

async function testFailurePropagation() {
    for (const stage of [
        "context",
        "eligibility",
        "factor",
        "finalScore",
        "ranking",
            "selection",
            "resultBuilder",
            "persistence",
            "explanations"
    ]) {
        const {
            engine,
            calls
        } = createHarness({ throwAt: stage });

        await assertThrowsAsync(`${stage} propagates`, async () => {
            await engine.generateRecommendations(
                "64f000000000000000000001",
                2
            );
        });

        if (stage === "context") {
            assert.strictEqual(calls.eligibility, 0);
        }

        if (stage === "resultBuilder") {
            assert.strictEqual(calls.persistence.length, 0);
        }
    }
}

async function testValidationBeforeContext() {
    for (const childId of [null, undefined, "", "not-an-object-id"]) {
        const {
            engine,
            calls
        } = createHarness();

        await assertThrowsAsync("invalid childId", async () => {
            await engine.generateRecommendations(childId, 3);
        });
        assert.strictEqual(calls.context, 0);
    }

    for (const topN of [undefined, null, 0, -1, 1.5, NaN, Infinity, "3"]) {
        const {
            engine,
            calls
        } = createHarness();

        await assertThrowsAsync("invalid topN", async () => {
            await engine.generateRecommendations(
                "64f000000000000000000001",
                topN
            );
        });
        assert.strictEqual(calls.context, 0);
    }
}

async function testNoUnselectedLeakageAndResultPreservation() {
    const {
        engine
    } = createHarness();
    const result = await engine.generateRecommendations(
        "64f000000000000000000001",
        1
    );

    assert(!Object.prototype.hasOwnProperty.call(result, "context"));
    assert(!Object.prototype.hasOwnProperty.call(result, "rankingResult"));
    assert(!Object.prototype.hasOwnProperty.call(result, "selectionResult"));
    assert(!Object.prototype.hasOwnProperty.call(result, "unselectedRanked"));
    assert(!Object.prototype.hasOwnProperty.call(result, "unranked"));
    assert.deepStrictEqual(result.recommendations, [
        {
            activityId: "activity_a",
            rank: 1,
            score: 0.9,
            marker: "from-result-builder",
            explanation: {
                reasonTypes: ["interest"],
                language: "en",
                text: "Explanation for activity_a",
                source: "generated"
            }
        }
    ]);
}

async function main() {
    await testHappyPathAndServiceOrder();
    await testIneligibleAndMixedCandidates();
    await testEmptyPathsSkipPersistence();
    await testShortfallAndTopNPreserved();
    await testRequestedAtSingleValue();
    await testFailurePropagation();
    await testValidationBeforeContext();
    await testNoUnselectedLeakageAndResultPreservation();

    console.log("Recommendation engine unit tests: PASSED");
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
