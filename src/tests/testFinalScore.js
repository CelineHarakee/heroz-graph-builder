const assert = require("assert");
const {
    SCORING_FACTORS,
    SCORING_WEIGHTS,
    createFactorResult,
    createCandidateScoringState
} = require("../recommendation/scoringContract");
const {
    calculateFinalScore
} = require("../recommendation/finalScoreService");

const FACTORS = Object.values(SCORING_FACTORS);

function assertClose(label, actual, expected, tolerance = 1e-9) {
    assert(
        typeof actual === "number" &&
        Math.abs(actual - expected) <= tolerance,
        `${label}: expected ${expected}, found ${actual}`
    );
}

function snapshot(value) {
    return JSON.parse(JSON.stringify(value));
}

function available(factor, score) {
    return createFactorResult({
        factor,
        available: true,
        score,
        evidence: [
            {
                type: `${factor}_evidence`
            }
        ]
    });
}

function unavailable(factor) {
    return createFactorResult({
        factor,
        available: false,
        score: null,
        evidence: [
            {
                type: `${factor}_unavailable`
            }
        ]
    });
}

function makeState(scores = {}) {
    const eligibilityEvaluation = {
        candidate: {
            activity: {
                activityId: "activity_1",
                title: "Activity 1"
            }
        },
        eligibility: {
            eligible: true,
            failedConstraints: []
        },
        eligibleSessions: [],
        sessionEvaluations: [],
        missingInformation: []
    };
    const state = createCandidateScoringState(eligibilityEvaluation);

    for (const factor of FACTORS) {
        state.factors[factor] = Object.prototype.hasOwnProperty.call(
            scores,
            factor
        )
            ? available(factor, scores[factor])
            : unavailable(factor);
    }

    return state;
}

function assertContribution(result, factor, expected) {
    const contribution = result.contributions.find(
        (item) => item.factor === factor
    );

    assert(contribution, `${factor} contribution missing`);
    assertClose(
        `${factor} canonicalWeight`,
        contribution.canonicalWeight,
        SCORING_WEIGHTS[factor]
    );
    assertClose(`${factor} score`, contribution.score, expected.score);
    assertClose(
        `${factor} normalizedWeight`,
        contribution.normalizedWeight,
        expected.normalizedWeight
    );
    assertClose(
        `${factor} contribution`,
        contribution.contribution,
        expected.contribution
    );
}

function assertAggregate(result, {
    available: expectedAvailable = true,
    score,
    availableWeight,
    availableFactorCount
}) {
    assert.strictEqual(result.available, expectedAvailable);

    if (expectedAvailable) {
        assertClose("final score", result.score, score);
        assertClose("availableWeight", result.availableWeight, availableWeight);
        assert.strictEqual(
            result.availableFactorCount,
            availableFactorCount
        );
        const normalizedWeightTotal = result.contributions.reduce(
            (total, item) => total + item.normalizedWeight,
            0
        );
        const contributionTotal = result.contributions.reduce(
            (total, item) => total + item.contribution,
            0
        );

        assertClose("normalized weight total", normalizedWeightTotal, 1);
        assertClose("contribution total", contributionTotal, result.score);
        assert(result.score >= 0 && result.score <= 1);
    } else {
        assert.strictEqual(result.score, null);
        assert.strictEqual(result.availableWeight, 0);
        assert.strictEqual(result.availableFactorCount, 0);
        assert.deepStrictEqual(result.contributions, []);
    }
}

function testAllSixAvailable() {
    const result = calculateFinalScore(makeState({
        interest: 0.8,
        preference: 0.9,
        goal: 0.75,
        exploration: 0.5,
        behavior: 0.75,
        session: 1
    }));

    assertAggregate(result, {
        score: 0.7805,
        availableWeight: 1,
        availableFactorCount: 6
    });

    for (const factor of FACTORS) {
        assertContribution(result, factor, {
            score: {
                interest: 0.8,
                preference: 0.9,
                goal: 0.75,
                exploration: 0.5,
                behavior: 0.75,
                session: 1
            }[factor],
            normalizedWeight: SCORING_WEIGHTS[factor],
            contribution: SCORING_WEIGHTS[factor] * {
                interest: 0.8,
                preference: 0.9,
                goal: 0.75,
                exploration: 0.5,
                behavior: 0.75,
                session: 1
            }[factor]
        });
    }
}

function testInterestAndGoalOnly() {
    const result = calculateFinalScore(makeState({
        interest: 0.88,
        goal: 1
    }));

    assertAggregate(result, {
        score: 0.9191836734693878,
        availableWeight: 0.49,
        availableFactorCount: 2
    });
    assert.deepStrictEqual(
        result.contributions.map((item) => item.factor),
        [SCORING_FACTORS.INTEREST, SCORING_FACTORS.GOAL]
    );
    assertContribution(result, SCORING_FACTORS.INTEREST, {
        score: 0.88,
        normalizedWeight: 0.33 / 0.49,
        contribution: (0.33 / 0.49) * 0.88
    });
    assertContribution(result, SCORING_FACTORS.GOAL, {
        score: 1,
        normalizedWeight: 0.16 / 0.49,
        contribution: 0.16 / 0.49
    });
}

function testGoalOnly() {
    const result = calculateFinalScore(makeState({
        goal: 0.5
    }));

    assertAggregate(result, {
        score: 0.5,
        availableWeight: 0.16,
        availableFactorCount: 1
    });
    assert.deepStrictEqual(
        result.contributions.map((item) => item.factor),
        [SCORING_FACTORS.GOAL]
    );
    assertContribution(result, SCORING_FACTORS.GOAL, {
        score: 0.5,
        normalizedWeight: 1,
        contribution: 0.5
    });
}

function testAvailableZeroParticipates() {
    const result = calculateFinalScore(makeState({
        interest: 0.88,
        goal: 0
    }));

    assertAggregate(result, {
        score: 0.5926530612244898,
        availableWeight: 0.49,
        availableFactorCount: 2
    });
    assertContribution(result, SCORING_FACTORS.GOAL, {
        score: 0,
        normalizedWeight: 0.16 / 0.49,
        contribution: 0
    });
}

function testAllUnavailable() {
    assertAggregate(calculateFinalScore(makeState()), {
        available: false
    });
}

function testZeroFromOnlyFactor() {
    const result = calculateFinalScore(makeState({
        behavior: 0
    }));

    assertAggregate(result, {
        score: 0,
        availableWeight: 0.13,
        availableFactorCount: 1
    });
    assertContribution(result, SCORING_FACTORS.BEHAVIOR, {
        score: 0,
        normalizedWeight: 1,
        contribution: 0
    });
}

function testAllOnesAndZeros() {
    assertAggregate(calculateFinalScore(makeState({
        interest: 1,
        preference: 1,
        goal: 1,
        exploration: 1,
        behavior: 1,
        session: 1
    })), {
        score: 1,
        availableWeight: 1,
        availableFactorCount: 6
    });
    assertAggregate(calculateFinalScore(makeState({
        interest: 0,
        preference: 0,
        goal: 0,
        exploration: 0,
        behavior: 0,
        session: 0
    })), {
        score: 0,
        availableWeight: 1,
        availableFactorCount: 6
    });
}

function testMixedAvailability() {
    const caseA = calculateFinalScore(makeState({
        preference: 0.25,
        exploration: 1,
        session: 0
    }));

    assertAggregate(caseA, {
        score: (
            (0.16 / 0.38) * 0.25 +
            (0.13 / 0.38) * 1 +
            (0.09 / 0.38) * 0
        ),
        availableWeight: 0.38,
        availableFactorCount: 3
    });

    const caseB = calculateFinalScore(makeState({
        interest: 0.2,
        behavior: 0.75
    }));

    assertAggregate(caseB, {
        score: (
            (0.33 / 0.46) * 0.2 +
            (0.13 / 0.46) * 0.75
        ),
        availableWeight: 0.46,
        availableFactorCount: 2
    });
}

function testFactorInputOrder() {
    const state = makeState({
        interest: 0.88,
        goal: 1
    });
    const reordered = {
        eligibilityEvaluation: state.eligibilityEvaluation,
        factors: {
            session: state.factors.session,
            behavior: state.factors.behavior,
            exploration: state.factors.exploration,
            goal: state.factors.goal,
            preference: state.factors.preference,
            interest: state.factors.interest
        }
    };

    assert.deepStrictEqual(
        calculateFinalScore(reordered),
        calculateFinalScore(state)
    );
    assert.deepStrictEqual(
        calculateFinalScore(reordered).contributions.map((item) => item.factor),
        [SCORING_FACTORS.INTEREST, SCORING_FACTORS.GOAL]
    );
}

function assertThrows(label, fn) {
    assert.throws(fn, Error, label);
}

function validMalformedBase() {
    return makeState({
        interest: 0.8
    });
}

function testMalformedStateValidation() {
    assertThrows("state null", () => calculateFinalScore(null));
    assertThrows("factors missing", () => {
        calculateFinalScore({
            eligibilityEvaluation: {
                eligibility: {
                    eligible: true
                }
            }
        });
    });
    assertThrows("ineligible state", () => {
        const state = validMalformedBase();
        state.eligibilityEvaluation.eligibility.eligible = false;
        calculateFinalScore(state);
    });
    assertThrows("missing factor slot", () => {
        const state = validMalformedBase();
        delete state.factors.session;
        calculateFinalScore(state);
    });
    assertThrows("extra factor slot", () => {
        const state = validMalformedBase();
        state.factors.vendor = {
            factor: "vendor",
            available: false,
            score: null,
            evidence: []
        };
        calculateFinalScore(state);
    });
    assertThrows("legacy Vendor Reliability slot", () => {
        const state = validMalformedBase();
        state.factors.vendorReliability = {
            factor: "vendorReliability",
            available: false,
            score: null,
            evidence: []
        };
        calculateFinalScore(state);
    });
    assertThrows("null factor slot", () => {
        const state = validMalformedBase();
        state.factors.session = null;
        calculateFinalScore(state);
    });
}

function testMalformedFactorResultValidation() {
    for (const score of [null, NaN, Infinity, -0.1, 1.1]) {
        assertThrows(`available score ${score}`, () => {
            const state = validMalformedBase();
            state.factors.interest = {
                factor: "interest",
                available: true,
                score,
                evidence: []
            };
            calculateFinalScore(state);
        });
    }

    assertThrows("unavailable numeric score", () => {
        const state = validMalformedBase();
        state.factors.interest = {
            factor: "interest",
            available: false,
            score: 0,
            evidence: []
        };
        calculateFinalScore(state);
    });
    assertThrows("factor mismatch", () => {
        const state = validMalformedBase();
        state.factors.interest = {
            factor: "goal",
            available: true,
            score: 0.8,
            evidence: []
        };
        calculateFinalScore(state);
    });
    assertThrows("missing evidence", () => {
        const state = validMalformedBase();
        state.factors.interest = {
            factor: "interest",
            available: true,
            score: 0.8
        };
        calculateFinalScore(state);
    });
}

function testImmutability() {
    const state = makeState({
        interest: 0.88,
        goal: 0
    });
    const stateSnapshot = snapshot(state);
    const eligibilitySnapshot = snapshot(state.eligibilityEvaluation);
    const factorSnapshots = {};
    const evidenceArrays = {};

    for (const factor of FACTORS) {
        factorSnapshots[factor] = snapshot(state.factors[factor]);
        evidenceArrays[factor] = state.factors[factor].evidence;
    }

    const result = calculateFinalScore(state);

    assert.deepStrictEqual(snapshot(state), stateSnapshot);
    assert.deepStrictEqual(
        snapshot(state.eligibilityEvaluation),
        eligibilitySnapshot
    );

    for (const factor of FACTORS) {
        assert.deepStrictEqual(snapshot(state.factors[factor]), factorSnapshots[factor]);
        assert.strictEqual(state.factors[factor].evidence, evidenceArrays[factor]);
    }

    for (const contribution of result.contributions) {
        assert.notStrictEqual(contribution, state.factors[contribution.factor]);
        assert(!Object.prototype.hasOwnProperty.call(contribution, "evidence"));
        assert(!Object.prototype.hasOwnProperty.call(
            state.factors[contribution.factor],
            "normalizedWeight"
        ));
        assert(!Object.prototype.hasOwnProperty.call(
            state.factors[contribution.factor],
            "contribution"
        ));
        assert(!Object.prototype.hasOwnProperty.call(
            state.factors[contribution.factor],
            "canonicalWeight"
        ));
    }
}

function main() {
    testAllSixAvailable();
    testInterestAndGoalOnly();
    testGoalOnly();
    testAvailableZeroParticipates();
    testAllUnavailable();
    testZeroFromOnlyFactor();
    testAllOnesAndZeros();
    testMixedAvailability();
    testFactorInputOrder();
    testMalformedStateValidation();
    testMalformedFactorResultValidation();
    testImmutability();

    console.log("Final score unit tests: PASSED");
}

main();
