const assert = require("assert");
const { ObjectId } = require("mongodb");
const {
    calculateInterestFactor
} = require("../recommendation/interestFactorService");

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

function makeContext({
    childInterests = [],
    subcategories = []
} = {}) {
    return {
        interestContext: {
            childInterests,
            subcategories
        }
    };
}

function makeEvaluation({
    categoryId = "category_stem",
    subcategoryId = "subcategory_robotics",
    eligible = true,
    evidence = {}
} = {}) {
    return {
        candidate: {
            activity: {
                activityId: "activity_robotics",
                title: "Robotics Lab"
            },
            evidence,
            currentActivity: {
                classification: {
                    categoryId,
                    subcategoryId
                }
            }
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

function makeInterest({
    subcategoryId,
    score,
    confidence
}) {
    const interest = {
        childId: "child_1",
        subcategoryId,
        interestScore: {},
        confidence: {}
    };

    if (score !== undefined) {
        interest.interestScore.currentScore = score;
    }

    if (confidence !== undefined) {
        interest.confidence.currentScore = confidence;
    }

    return interest;
}

function makeSubcategory(_id, categoryId) {
    return {
        _id,
        categoryId
    };
}

function assertAvailable(result, expectedScore) {
    assert.strictEqual(result.factor, "interest");
    assert.strictEqual(result.available, true);
    assertClose("Interest score", result.score, expectedScore);
    assert(Array.isArray(result.evidence), "evidence must be an Array");
}

function assertUnavailable(result) {
    assert.strictEqual(result.factor, "interest");
    assert.strictEqual(result.available, false);
    assert.strictEqual(result.score, null);
    assert(Array.isArray(result.evidence), "evidence must be an Array");
}

function evidenceTypes(result) {
    return result.evidence.map((item) => item.type);
}

function testFullFormula() {
    const context = makeContext({
        childInterests: [
            makeInterest({
                subcategoryId: "subcategory_robotics",
                score: 0.8,
                confidence: 0.75
            }),
            makeInterest({
                subcategoryId: "subcategory_coding",
                score: 0.6
            }),
            makeInterest({
                subcategoryId: "subcategory_electronics",
                score: 0.4
            })
        ],
        subcategories: [
            makeSubcategory("subcategory_robotics", "category_stem"),
            makeSubcategory("subcategory_coding", "category_stem"),
            makeSubcategory("subcategory_electronics", "category_stem")
        ]
    });

    const result = calculateInterestFactor(context, makeEvaluation());

    assertAvailable(result, 0.725);
}

function testOwnSubcategoryExcluded() {
    const context = makeContext({
        childInterests: [
            makeInterest({
                subcategoryId: "subcategory_robotics",
                score: 0.8,
                confidence: 0.75
            }),
            makeInterest({
                subcategoryId: "subcategory_robotics",
                score: 1
            }),
            makeInterest({
                subcategoryId: "subcategory_coding",
                score: 0.6
            })
        ],
        subcategories: [
            makeSubcategory("subcategory_robotics", "category_stem"),
            makeSubcategory("subcategory_coding", "category_stem")
        ]
    });

    const result = calculateInterestFactor(context, makeEvaluation());
    const categoryEvidence = result.evidence.find(
        (item) => item.type === "category_fallback"
    );

    assertAvailable(result, 0.75);
    assert.deepStrictEqual(categoryEvidence.siblingScores, [0.6]);
}

function testExactOnlyNoCategorySiblings() {
    const context = makeContext({
        childInterests: [
            makeInterest({
                subcategoryId: "subcategory_robotics",
                score: 0.88,
                confidence: 0.82
            })
        ],
        subcategories: [
            makeSubcategory("subcategory_robotics", "category_stem")
        ]
    });

    const result = calculateInterestFactor(context, makeEvaluation());

    assertAvailable(result, 0.88);
}

function testCategoryOnly() {
    const context = makeContext({
        childInterests: [
            makeInterest({
                subcategoryId: "subcategory_coding",
                score: 0.8
            }),
            makeInterest({
                subcategoryId: "subcategory_electronics",
                score: 0.6
            })
        ],
        subcategories: [
            makeSubcategory("subcategory_coding", "category_stem"),
            makeSubcategory("subcategory_electronics", "category_stem")
        ]
    });

    const result = calculateInterestFactor(context, makeEvaluation());

    assertAvailable(result, 0.7);
}

function testNothingAvailable() {
    const result = calculateInterestFactor(
        makeContext(),
        makeEvaluation()
    );

    assertUnavailable(result);
}

function testExactScoreButConfidenceMissing() {
    const result = calculateInterestFactor(
        makeContext({
            childInterests: [
                makeInterest({
                    subcategoryId: "subcategory_robotics",
                    score: 0.8,
                    confidence: undefined
                })
            ],
            subcategories: [
                makeSubcategory("subcategory_robotics", "category_stem")
            ]
        }),
        makeEvaluation()
    );

    assertUnavailable(result);
}

function testExactScoreButConfidenceInvalid() {
    for (const confidence of [NaN, 1.2]) {
        const result = calculateInterestFactor(
            makeContext({
                childInterests: [
                    makeInterest({
                        subcategoryId: "subcategory_robotics",
                        score: 0.8,
                        confidence
                    }),
                    makeInterest({
                        subcategoryId: "subcategory_coding",
                        score: 0.6
                    })
                ],
                subcategories: [
                    makeSubcategory("subcategory_robotics", "category_stem"),
                    makeSubcategory("subcategory_coding", "category_stem")
                ]
            }),
            makeEvaluation()
        );

        assertUnavailable(result);
    }
}

function testExactScoreMissingCategoryExists() {
    const result = calculateInterestFactor(
        makeContext({
            childInterests: [
                makeInterest({
                    subcategoryId: "subcategory_robotics",
                    score: undefined,
                    confidence: 0.8
                }),
                makeInterest({
                    subcategoryId: "subcategory_coding",
                    score: 0.8
                }),
                makeInterest({
                    subcategoryId: "subcategory_electronics",
                    score: 0.6
                })
            ],
            subcategories: [
                makeSubcategory("subcategory_robotics", "category_stem"),
                makeSubcategory("subcategory_coding", "category_stem"),
                makeSubcategory("subcategory_electronics", "category_stem")
            ]
        }),
        makeEvaluation()
    );

    assertAvailable(result, 0.7);
}

function testInvalidSiblingScoresIgnored() {
    const result = calculateInterestFactor(
        makeContext({
            childInterests: [
                makeInterest({
                    subcategoryId: "subcategory_coding",
                    score: 0.6
                }),
                makeInterest({
                    subcategoryId: "subcategory_nan",
                    score: NaN
                }),
                makeInterest({
                    subcategoryId: "subcategory_high",
                    score: 1.4
                }),
                makeInterest({
                    subcategoryId: "subcategory_low",
                    score: -0.2
                }),
                makeInterest({
                    subcategoryId: "subcategory_electronics",
                    score: 0.8
                })
            ],
            subcategories: [
                makeSubcategory("subcategory_coding", "category_stem"),
                makeSubcategory("subcategory_nan", "category_stem"),
                makeSubcategory("subcategory_high", "category_stem"),
                makeSubcategory("subcategory_low", "category_stem"),
                makeSubcategory("subcategory_electronics", "category_stem")
            ]
        }),
        makeEvaluation()
    );

    assertAvailable(result, 0.7);
}

function testDifferentCategoryExcluded() {
    const result = calculateInterestFactor(
        makeContext({
            childInterests: [
                makeInterest({
                    subcategoryId: "subcategory_coding",
                    score: 0.7
                }),
                makeInterest({
                    subcategoryId: "subcategory_painting",
                    score: 0.95
                })
            ],
            subcategories: [
                makeSubcategory("subcategory_coding", "category_stem"),
                makeSubcategory("subcategory_painting", "category_arts")
            ]
        }),
        makeEvaluation()
    );

    assertAvailable(result, 0.7);
}

function testSameSubcategoryActivitiesSameScore() {
    const context = makeContext({
        childInterests: [
            makeInterest({
                subcategoryId: "subcategory_robotics",
                score: 0.88,
                confidence: 0.82
            })
        ],
        subcategories: [
            makeSubcategory("subcategory_robotics", "category_stem")
        ]
    });
    const roboticsLab = makeEvaluation({
        categoryId: "category_stem",
        subcategoryId: "subcategory_robotics"
    });
    const creativeRobotics = makeEvaluation({
        categoryId: "category_stem",
        subcategoryId: "subcategory_robotics"
    });

    const first = calculateInterestFactor(context, roboticsLab);
    const second = calculateInterestFactor(context, creativeRobotics);

    assertAvailable(first, 0.88);
    assertAvailable(second, 0.88);
    assert.strictEqual(first.score, second.score);
}

function testBoundaryScoreZero() {
    const result = calculateInterestFactor(
        makeContext({
            childInterests: [
                makeInterest({
                    subcategoryId: "subcategory_robotics",
                    score: 0,
                    confidence: 0.5
                })
            ],
            subcategories: [
                makeSubcategory("subcategory_robotics", "category_stem")
            ]
        }),
        makeEvaluation()
    );

    assertAvailable(result, 0);
}

function testBoundaryScoreOne() {
    const result = calculateInterestFactor(
        makeContext({
            childInterests: [
                makeInterest({
                    subcategoryId: "subcategory_robotics",
                    score: 1,
                    confidence: 0.5
                })
            ],
            subcategories: [
                makeSubcategory("subcategory_robotics", "category_stem")
            ]
        }),
        makeEvaluation()
    );

    assertAvailable(result, 1);
}

function testMissingClassification() {
    assertUnavailable(
        calculateInterestFactor(
            makeContext(),
            makeEvaluation({
                subcategoryId: null
            })
        )
    );
    assertUnavailable(
        calculateInterestFactor(
            makeContext(),
            makeEvaluation({
                categoryId: null
            })
        )
    );
}

function testMissingInterestContext() {
    assertUnavailable(
        calculateInterestFactor(
            {},
            makeEvaluation()
        )
    );
    assertUnavailable(
        calculateInterestFactor(
            { interestContext: { childInterests: [] } },
            makeEvaluation()
        )
    );
}

function testIneligibleCandidate() {
    assertThrows("ineligible candidate should throw", () => {
        calculateInterestFactor(
            makeContext(),
            makeEvaluation({
                eligible: false
            })
        );
    });
}

function testNullContext() {
    assertThrows("null context should throw", () => {
        calculateInterestFactor(null, makeEvaluation());
    });
}

function testD4EvidenceIgnored() {
    const result = calculateInterestFactor(
        makeContext({
            childInterests: [
                makeInterest({
                    subcategoryId: "subcategory_robotics",
                    score: 0.4,
                    confidence: 1
                })
            ],
            subcategories: [
                makeSubcategory("subcategory_robotics", "category_stem")
            ]
        }),
        makeEvaluation({
            evidence: {
                interests: [
                    {
                        score: 1,
                        confidence: 1
                    }
                ]
            }
        })
    );

    assertAvailable(result, 0.4);
}

function testEvidenceExactOnly() {
    const result = calculateInterestFactor(
        makeContext({
            childInterests: [
                makeInterest({
                    subcategoryId: "subcategory_robotics",
                    score: 0.88,
                    confidence: 0.82
                })
            ],
            subcategories: [
                makeSubcategory("subcategory_robotics", "category_stem")
            ]
        }),
        makeEvaluation()
    );

    assert.deepStrictEqual(evidenceTypes(result), [
        "exact_subcategory_interest"
    ]);
}

function testEvidenceFullFormula() {
    const result = calculateInterestFactor(
        makeContext({
            childInterests: [
                makeInterest({
                    subcategoryId: "subcategory_robotics",
                    score: 0.8,
                    confidence: 0.75
                }),
                makeInterest({
                    subcategoryId: "subcategory_coding",
                    score: 0.6
                })
            ],
            subcategories: [
                makeSubcategory("subcategory_robotics", "category_stem"),
                makeSubcategory("subcategory_coding", "category_stem")
            ]
        }),
        makeEvaluation()
    );
    const categoryEvidence = result.evidence.find(
        (item) => item.type === "category_fallback"
    );

    assert.deepStrictEqual(evidenceTypes(result), [
        "exact_subcategory_interest",
        "category_fallback"
    ]);
    assert.strictEqual(categoryEvidence.siblingCount, 1);
    assertClose("categoryScore", categoryEvidence.categoryScore, 0.6);
    assert.strictEqual(
        categoryEvidence.excludedSubcategoryId,
        "subcategory_robotics"
    );
}

function testObjectIdEquality() {
    const categoryId = new ObjectId();
    const exactSubcategoryId = new ObjectId();
    const siblingSubcategoryId = new ObjectId();
    const result = calculateInterestFactor(
        makeContext({
            childInterests: [
                makeInterest({
                    subcategoryId: exactSubcategoryId,
                    score: 0.8,
                    confidence: 0.5
                }),
                makeInterest({
                    subcategoryId: siblingSubcategoryId,
                    score: 0.6
                })
            ],
            subcategories: [
                makeSubcategory(exactSubcategoryId, categoryId),
                makeSubcategory(siblingSubcategoryId, categoryId)
            ]
        }),
        makeEvaluation({
            categoryId: String(categoryId),
            subcategoryId: String(exactSubcategoryId)
        })
    );

    assertAvailable(result, 0.7);
}

function testInputsNotMutated() {
    const context = makeContext({
        childInterests: [
            makeInterest({
                subcategoryId: "subcategory_robotics",
                score: 0.8,
                confidence: 0.75
            }),
            makeInterest({
                subcategoryId: "subcategory_coding",
                score: 0.6
            })
        ],
        subcategories: [
            makeSubcategory("subcategory_robotics", "category_stem"),
            makeSubcategory("subcategory_coding", "category_stem")
        ]
    });
    const evaluation = makeEvaluation();
    const candidate = evaluation.candidate;
    const contextSnapshot = JSON.stringify(context);
    const evaluationSnapshot = JSON.stringify(evaluation);
    const childInterests = context.interestContext.childInterests;
    const subcategories = context.interestContext.subcategories;

    calculateInterestFactor(context, evaluation);

    assert.strictEqual(JSON.stringify(context), contextSnapshot);
    assert.strictEqual(JSON.stringify(evaluation), evaluationSnapshot);
    assert.strictEqual(context.interestContext.childInterests, childInterests);
    assert.strictEqual(context.interestContext.subcategories, subcategories);
    assert.strictEqual(evaluation.candidate, candidate);
}

function testResultUsesContract() {
    const result = calculateInterestFactor(
        makeContext({
            childInterests: [
                makeInterest({
                    subcategoryId: "subcategory_robotics",
                    score: 0.8,
                    confidence: 0.75
                })
            ],
            subcategories: [
                makeSubcategory("subcategory_robotics", "category_stem")
            ]
        }),
        makeEvaluation()
    );

    assert.deepStrictEqual(Object.keys(result), [
        "factor",
        "available",
        "score",
        "evidence"
    ]);
    assert.strictEqual(result.factor, "interest");
}

function main() {
    testFullFormula();
    testOwnSubcategoryExcluded();
    testExactOnlyNoCategorySiblings();
    testCategoryOnly();
    testNothingAvailable();
    testExactScoreButConfidenceMissing();
    testExactScoreButConfidenceInvalid();
    testExactScoreMissingCategoryExists();
    testInvalidSiblingScoresIgnored();
    testDifferentCategoryExcluded();
    testSameSubcategoryActivitiesSameScore();
    testBoundaryScoreZero();
    testBoundaryScoreOne();
    testMissingClassification();
    testMissingInterestContext();
    testIneligibleCandidate();
    testNullContext();
    testD4EvidenceIgnored();
    testEvidenceExactOnly();
    testEvidenceFullFormula();
    testObjectIdEquality();
    testInputsNotMutated();
    testResultUsesContract();

    console.log("========================================");
    console.log("STEP 15B-C - INTEREST FACTOR");
    console.log("========================================");
    console.log("");
    console.log("Full formula:                        PASSED");
    console.log("Exact-only fallback:                 PASSED");
    console.log("Category-only fallback:              PASSED");
    console.log("No data -> unavailable:              PASSED");
    console.log("Missing confidence -> unavailable:   PASSED");
    console.log("");
    console.log("Own Subcategory excluded from C:     PASSED");
    console.log("Different Categories excluded:       PASSED");
    console.log("Invalid sibling scores ignored:      PASSED");
    console.log("");
    console.log("Mongo source beats D4 evidence:      PASSED");
    console.log("Same Subcategory same score:         PASSED");
    console.log("Evidence contract:                   PASSED");
    console.log("Input mutation:                      NONE");
    console.log("");
    console.log("Final weighted score:                NONE");
    console.log("Ranking:                             NONE");
    console.log("");
    console.log("========================================");
    console.log("STEP 15B-C INTEREST FACTOR PASSED");
    console.log("========================================");
}

main();
