const assert = require("assert");
const { ObjectId } = require("mongodb");
const {
    calculateGoalFactor
} = require("../recommendation/goalFactorService");

function assertClose(label, actual, expected, tolerance = 1e-9) {
    assert(
        typeof actual === "number" &&
        Math.abs(actual - expected) <= tolerance,
        `${label}: expected ${expected}, found ${actual}`
    );
}

function assertThrows(label, fn) {
    assert.throws(fn, Error, label);
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function goalDoc(_id, outcomeIds, overrides = {}) {
    return {
        _id,
        name: `Goal ${_id}`,
        isActive: true,
        relatedOutcomes: outcomeIds.map((outcomeId) => ({
            outcomeId
        })),
        ...overrides
    };
}

function parentGoal(goalId, {
    priority = 1,
    status = "Active"
} = {}) {
    return {
        goalId,
        priority,
        status,
        selectedBy: "Parent",
        selectedAt: new Date("2026-09-01T00:00:00.000Z"),
        targetDate: null
    };
}

function learningOutcome(outcomeId, evidenceGuidance = []) {
    return {
        outcomeId,
        evidenceGuidance
    };
}

function makeContext({
    parentGoals = [parentGoal("goal_a")],
    goals = [goalDoc("goal_a", ["A"])],
    developmentProfile = []
} = {}) {
    return {
        child: {
            parentGoals,
            developmentProfile
        },
        goalContext: {
            goals
        },
        interestContext: {
            childInterests: [],
            subcategories: []
        }
    };
}

function makeEvaluation({
    learningOutcomes = [learningOutcome("A")],
    eligible = true,
    evidence = {
        interests: [],
        goals: [],
        summary: []
    },
    includeLearningOutcomes = true
} = {}) {
    const currentActivity = {};

    if (includeLearningOutcomes) {
        currentActivity.learningOutcomes = learningOutcomes;
    }

    return {
        candidate: {
            activity: {
                activityId: "activity_a",
                title: "Activity A"
            },
            evidence,
            currentActivity
        },
        eligibility: {
            eligible,
            failedConstraints: []
        },
        eligibleSessions: [],
        sessionEvaluations: [],
        missingInformation: []
    };
}

function assertAvailable(result, expectedScore) {
    assert.strictEqual(result.factor, "goal");
    assert.strictEqual(result.available, true);
    assertClose("Goal score", result.score, expectedScore);
    assert(Array.isArray(result.evidence), "evidence must be an Array");
}

function assertUnavailable(result) {
    assert.strictEqual(result.factor, "goal");
    assert.strictEqual(result.available, false);
    assert.strictEqual(result.score, null);
    assert(Array.isArray(result.evidence), "evidence must be an Array");
}

function resultFor(contextOptions, evaluationOptions) {
    return calculateGoalFactor(
        makeContext(contextOptions),
        makeEvaluation(evaluationOptions)
    );
}

function testOneActiveGoalMatch() {
    assertAvailable(resultFor(), 1);
}

function testPartialMultiOutcomeCoverage() {
    const result = resultFor(
        {
            goals: [
                goalDoc("goal_a", ["A", "B", "C"])
            ]
        },
        {
            learningOutcomes: [
                learningOutcome("A"),
                learningOutcome("C"),
                learningOutcome("X")
            ]
        }
    );

    assertAvailable(result, 2 / 3);
}

function testZeroOverlap() {
    assertAvailable(
        resultFor(
            {
                goals: [
                    goalDoc("goal_a", ["A"])
                ]
            },
            {
                learningOutcomes: [
                    learningOutcome("X")
                ]
            }
        ),
        0
    );
}

function testMultipleActiveGoals() {
    const result = resultFor(
        {
            parentGoals: [
                parentGoal("goal_a"),
                parentGoal("goal_b")
            ],
            goals: [
                goalDoc("goal_a", ["A"]),
                goalDoc("goal_b", ["B", "C"])
            ]
        },
        {
            learningOutcomes: [
                learningOutcome("A"),
                learningOutcome("B")
            ]
        }
    );

    assertAvailable(result, 0.75);
}

function testPriorityIndependence() {
    const first = resultFor({
        parentGoals: [
            parentGoal("goal_a", { priority: 1 })
        ]
    });
    const second = resultFor({
        parentGoals: [
            parentGoal("goal_a", { priority: 99 })
        ]
    });

    assertAvailable(first, 1);
    assertAvailable(second, 1);
    assert.strictEqual(first.score, second.score);
}

function testNoParentGoals() {
    assertUnavailable(resultFor({ parentGoals: [] }));
}

function testNoActiveParentGoals() {
    assertUnavailable(resultFor({
        parentGoals: [
            parentGoal("goal_a", { status: "Paused" }),
            parentGoal("goal_b", { status: "Completed" }),
            parentGoal("goal_c", { status: "Inactive" })
        ],
        goals: [
            goalDoc("goal_a", ["A"]),
            goalDoc("goal_b", ["A"]),
            goalDoc("goal_c", ["A"])
        ]
    }));
}

function testMissingGoalOnly() {
    const result = resultFor({
        parentGoals: [
            parentGoal("missing_goal")
        ],
        goals: []
    });

    assertUnavailable(result);
    assert.strictEqual(result.evidence[0].type, "missing_goal_document");
    assert.strictEqual(result.evidence[0].goalId, "missing_goal");
}

function testMissingGoalPlusUsableGoal() {
    const result = resultFor({
        parentGoals: [
            parentGoal("missing_goal"),
            parentGoal("goal_a")
        ],
        goals: [
            goalDoc("goal_a", ["A"])
        ]
    });

    assertAvailable(result, 1);
    assert.strictEqual(result.evidence[0].type, "missing_goal_document");
    assert.strictEqual(result.evidence[1].type, "goal_coverage");
}

function testGoalRelatedOutcomesMissing() {
    const result = resultFor({
        goals: [
            {
                _id: "goal_a",
                name: "Goal A"
            }
        ]
    });

    assertUnavailable(result);
    assert.strictEqual(result.evidence[0].type, "unusable_goal_outcomes");
}

function testGoalRelatedOutcomesMalformed() {
    const result = resultFor({
        goals: [
            {
                _id: "goal_a",
                name: "Goal A",
                relatedOutcomes: "A"
            }
        ]
    });

    assertUnavailable(result);
    assert.strictEqual(result.evidence[0].type, "unusable_goal_outcomes");
}

function testGoalRelatedOutcomesEmpty() {
    const result = resultFor({
        goals: [
            goalDoc("goal_a", [])
        ]
    });

    assertUnavailable(result);
    assert.strictEqual(result.evidence[0].type, "unusable_goal_outcomes");
}

function testGoalRelatedOutcomesNoUsableIds() {
    const result = calculateGoalFactor(
        makeContext({
            goals: [
                {
                    _id: "goal_a",
                    name: "Goal A",
                    relatedOutcomes: [
                        null,
                        {},
                        {
                            outcomeId: null
                        }
                    ]
                }
            ]
        }),
        makeEvaluation()
    );

    assertUnavailable(result);
    assert.strictEqual(result.evidence[0].type, "unusable_goal_outcomes");
}

function testActivityOutcomesEmptyArray() {
    assertAvailable(
        resultFor(
            {},
            {
                learningOutcomes: []
            }
        ),
        0
    );
}

function testActivityOutcomesMissing() {
    assertUnavailable(
        resultFor(
            {},
            {
                includeLearningOutcomes: false
            }
        )
    );
}

function testActivityOutcomesWrongType() {
    assertUnavailable(
        resultFor(
            {},
            {
                learningOutcomes: "A"
            }
        )
    );
}

function testActivityOutcomesMalformedItem() {
    for (const item of [null, {}, { outcomeId: null }]) {
        const result = resultFor(
            {},
            {
                learningOutcomes: [
                    learningOutcome("A"),
                    item
                ]
            }
        );

        assertUnavailable(result);
        assert.strictEqual(result.evidence[0].type, "malformed_activity_outcomes");
    }
}

function testDuplicateGoalOutcomeIds() {
    const result = resultFor({
        goals: [
            goalDoc("goal_a", ["A", "A", "B"])
        ]
    });

    assertAvailable(result, 0.5);
    assert.deepStrictEqual(result.evidence[0].goalOutcomeIds, ["A", "B"]);
    assert.deepStrictEqual(result.evidence[0].matchedOutcomeIds, ["A"]);
}

function testDuplicateActivityOutcomeIds() {
    const result = resultFor(
        {
            goals: [
                goalDoc("goal_a", ["A", "B"])
            ]
        },
        {
            learningOutcomes: [
                learningOutcome("A"),
                learningOutcome("A")
            ]
        }
    );

    assertAvailable(result, 0.5);
    assert.deepStrictEqual(result.evidence[0].matchedOutcomeIds, ["A"]);
}

function testDuplicateActiveParentGoals() {
    const result = resultFor({
        parentGoals: [
            parentGoal("goal_a", { priority: 1 }),
            parentGoal("goal_a", { priority: 2 })
        ],
        goals: [
            goalDoc("goal_a", ["A"])
        ]
    });

    assertAvailable(result, 1);
    assert.strictEqual(result.evidence.length, 1);
    assert.strictEqual(result.evidence[0].priority, 1);
}

function testD4EvidenceIndependence() {
    const context = makeContext();
    const first = calculateGoalFactor(
        context,
        makeEvaluation({
            evidence: {
                interests: [],
                goals: [
                    {
                        goalId: "wrong",
                        learningOutcome: {
                            outcomeId: "wrong"
                        }
                    }
                ],
                summary: []
            }
        })
    );
    const second = calculateGoalFactor(
        context,
        makeEvaluation({
            evidence: {
                interests: [],
                goals: [],
                summary: []
            }
        })
    );

    assertAvailable(first, 1);
    assertAvailable(second, 1);
    assert.strictEqual(first.score, second.score);
}

function testEvidenceGuidanceIndependence() {
    const first = resultFor(
        {},
        {
            learningOutcomes: [
                learningOutcome("A", ["Observe collaboration"])
            ]
        }
    );
    const second = resultFor(
        {},
        {
            learningOutcomes: [
                learningOutcome("A", ["Different guidance"])
            ]
        }
    );

    assertAvailable(first, 1);
    assertAvailable(second, 1);
    assert.strictEqual(first.score, second.score);
}

function testDevelopmentProfileIndependence() {
    const first = resultFor({
        developmentProfile: []
    });
    const second = resultFor({
        developmentProfile: [
            {
                outcomeId: "A",
                level: 0
            }
        ]
    });

    assertAvailable(first, 1);
    assertAvailable(second, 1);
    assert.strictEqual(first.score, second.score);
}

function testGoalIsActiveIndependence() {
    const first = resultFor({
        goals: [
            goalDoc("goal_a", ["A"], { isActive: true })
        ]
    });
    const second = resultFor({
        goals: [
            goalDoc("goal_a", ["A"], { isActive: false })
        ]
    });

    assertAvailable(first, 1);
    assertAvailable(second, 1);
    assert.strictEqual(first.score, second.score);
}

function testEvidenceCorrectness() {
    const result = resultFor(
        {
            parentGoals: [
                parentGoal("goal_a", { priority: 7 })
            ],
            goals: [
                goalDoc("goal_a", ["A", "B", "C"])
            ]
        },
        {
            learningOutcomes: [
                learningOutcome("A"),
                learningOutcome("C")
            ]
        }
    );

    assertAvailable(result, 2 / 3);
    assert.deepStrictEqual(result.evidence[0], {
        type: "goal_coverage",
        goalId: "goal_a",
        priority: 7,
        status: "Active",
        goalOutcomeIds: ["A", "B", "C"],
        matchedOutcomeIds: ["A", "C"],
        coverage: 2 / 3
    });
}

function testEvidenceIsolation() {
    const context = makeContext({
        goals: [
            goalDoc("goal_a", ["A", "B"])
        ]
    });
    const evaluation = makeEvaluation();
    const result = calculateGoalFactor(context, evaluation);

    result.evidence[0].goalOutcomeIds.push("Z");
    result.evidence[0].matchedOutcomeIds.push("Z");

    assert.deepStrictEqual(
        context.goalContext.goals[0].relatedOutcomes.map(
            (item) => item.outcomeId
        ),
        ["A", "B"]
    );
    assert.deepStrictEqual(
        evaluation.candidate.currentActivity.learningOutcomes.map(
            (item) => item.outcomeId
        ),
        ["A"]
    );
}

function testInputImmutability() {
    const context = makeContext({
        parentGoals: [
            parentGoal("goal_a"),
            parentGoal("goal_b", { status: "Paused" })
        ],
        goals: [
            goalDoc("goal_a", ["A", "B"]),
            goalDoc("goal_b", ["C"])
        ],
        developmentProfile: [
            {
                outcomeId: "A"
            }
        ]
    });
    const evaluation = makeEvaluation({
        learningOutcomes: [
            learningOutcome("A"),
            learningOutcome("A")
        ],
        evidence: {
            interests: [
                {
                    name: "Robotics"
                }
            ],
            goals: [
                {
                    name: "D4 Goal"
                }
            ],
            summary: [
                "D4"
            ]
        }
    });
    const contextSnapshot = clone(context);
    const evaluationSnapshot = clone(evaluation);

    calculateGoalFactor(context, evaluation);

    assert.deepStrictEqual(clone(context), contextSnapshot);
    assert.deepStrictEqual(clone(evaluation), evaluationSnapshot);
}

function testObjectIdAndStringMatching() {
    const goalId = new ObjectId();
    const outcomeId = new ObjectId();
    const result = calculateGoalFactor(
        makeContext({
            parentGoals: [
                parentGoal(String(goalId))
            ],
            goals: [
                goalDoc(goalId, [outcomeId])
            ]
        }),
        makeEvaluation({
            learningOutcomes: [
                learningOutcome(String(outcomeId))
            ]
        })
    );

    assertAvailable(result, 1);
    assert.strictEqual(result.evidence[0].goalId, String(goalId));
    assert.deepStrictEqual(result.evidence[0].goalOutcomeIds, [
        String(outcomeId)
    ]);
}

function testEligibilityGuards() {
    assertThrows("context required", () =>
        calculateGoalFactor(null, makeEvaluation())
    );
    assertThrows("evaluation required", () =>
        calculateGoalFactor(makeContext(), null)
    );
    assertThrows("eligible evaluation required", () =>
        calculateGoalFactor(
            makeContext(),
            makeEvaluation({ eligible: false })
        )
    );
}

function main() {
    testOneActiveGoalMatch();
    testPartialMultiOutcomeCoverage();
    testZeroOverlap();
    testMultipleActiveGoals();
    testPriorityIndependence();
    testNoParentGoals();
    testNoActiveParentGoals();
    testMissingGoalOnly();
    testMissingGoalPlusUsableGoal();
    testGoalRelatedOutcomesMissing();
    testGoalRelatedOutcomesMalformed();
    testGoalRelatedOutcomesEmpty();
    testGoalRelatedOutcomesNoUsableIds();
    testActivityOutcomesEmptyArray();
    testActivityOutcomesMissing();
    testActivityOutcomesWrongType();
    testActivityOutcomesMalformedItem();
    testDuplicateGoalOutcomeIds();
    testDuplicateActivityOutcomeIds();
    testDuplicateActiveParentGoals();
    testD4EvidenceIndependence();
    testEvidenceGuidanceIndependence();
    testDevelopmentProfileIndependence();
    testGoalIsActiveIndependence();
    testEvidenceCorrectness();
    testEvidenceIsolation();
    testInputImmutability();
    testObjectIdAndStringMatching();
    testEligibilityGuards();

    console.log("Goal factor unit tests: PASSED");
}

main();
