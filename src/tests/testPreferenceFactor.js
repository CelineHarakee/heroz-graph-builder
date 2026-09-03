const assert = require("assert");
const {
    calculatePreferenceFactor
} = require("../recommendation/preferenceFactorService");

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

function preference(value, confidenceScore = 1, source = "Onboarding") {
    return {
        value,
        confidenceScore,
        source,
        updatedAt: new Date("2026-09-01T00:00:00.000Z")
    };
}

function makePreferences(overrides = {}) {
    return {
        environment: preference(null),
        socialStyle: preference(null),
        difficulty: preference(null),
        experienceStyle: preference(null),
        commitmentPreference: preference(null),
        ...overrides
    };
}

function makeExperience(overrides = {}) {
    return {
        environment: null,
        socialStyle: null,
        difficulty: null,
        experienceStyles: [],
        commitmentType: null,
        intensityLevel: "Low",
        durationMinutes: 90,
        ...overrides
    };
}

function makeContext(preferences = makePreferences()) {
    return {
        child: {
            preferences
        }
    };
}

function makeEvaluation(experience = makeExperience(), overrides = {}) {
    return {
        candidate: {
            evidence: {
                interests: [],
                goals: [],
                summary: []
            },
            currentActivity: {
                experience
            }
        },
        eligibility: {
            eligible: true,
            failedConstraints: []
        },
        eligibleSessions: [],
        sessionEvaluations: [],
        missingInformation: [],
        ...overrides
    };
}

function assertAvailable(result, expectedScore) {
    assert.strictEqual(result.factor, "preference");
    assert.strictEqual(result.available, true);
    assertClose("Preference score", result.score, expectedScore);
    assert(Array.isArray(result.evidence), "evidence must be an Array");
}

function assertUnavailable(result) {
    assert.strictEqual(result.factor, "preference");
    assert.strictEqual(result.available, false);
    assert.strictEqual(result.score, null);
    assert.deepStrictEqual(result.evidence, []);
}

function calculateSingleDimension({
    preferences,
    experience
}) {
    return calculatePreferenceFactor(
        makeContext(makePreferences(preferences)),
        makeEvaluation(makeExperience(experience))
    );
}

function testEnvironmentExactMatch() {
    assertAvailable(
        calculateSingleDimension({
            preferences: {
                environment: preference("Indoor", 1)
            },
            experience: {
                environment: "Indoor"
            }
        }),
        1
    );
}

function testEnvironmentExplicitMismatch() {
    assertAvailable(
        calculateSingleDimension({
            preferences: {
                environment: preference("Indoor", 1)
            },
            experience: {
                environment: "Outdoor"
            }
        }),
        0
    );
}

function testLowConfidenceMatch() {
    assertAvailable(
        calculateSingleDimension({
            preferences: {
                environment: preference("Indoor", 0.1)
            },
            experience: {
                environment: "Indoor"
            }
        }),
        0.55
    );
}

function testLowConfidenceMismatch() {
    assertAvailable(
        calculateSingleDimension({
            preferences: {
                environment: preference("Indoor", 0.1)
            },
            experience: {
                environment: "Outdoor"
            }
        }),
        0.45
    );
}

function testConfidenceZero() {
    assertAvailable(
        calculateSingleDimension({
            preferences: {
                environment: preference("Indoor", 0)
            },
            experience: {
                environment: "Indoor"
            }
        }),
        0.5
    );
}

function testSocialStyleMixedChild() {
    assertAvailable(
        calculateSingleDimension({
            preferences: {
                socialStyle: preference("Mixed", 1)
            },
            experience: {
                socialStyle: "Team"
            }
        }),
        1
    );
}

function testSocialStyleMixedActivity() {
    assertAvailable(
        calculateSingleDimension({
            preferences: {
                socialStyle: preference("Individual", 1)
            },
            experience: {
                socialStyle: "Mixed"
            }
        }),
        1
    );
}

function testEnvironmentMixedChild() {
    assertAvailable(
        calculateSingleDimension({
            preferences: {
                environment: preference("Mixed", 1)
            },
            experience: {
                environment: "Outdoor"
            }
        }),
        1
    );
}

function testEnvironmentMixedActivity() {
    assertAvailable(
        calculateSingleDimension({
            preferences: {
                environment: preference("Indoor", 1)
            },
            experience: {
                environment: "Mixed"
            }
        }),
        1
    );
}

function testDifficultyExactMatch() {
    assertAvailable(
        calculateSingleDimension({
            preferences: {
                difficulty: preference("Intermediate", 1)
            },
            experience: {
                difficulty: "Intermediate"
            }
        }),
        1
    );
}

function testDifficultyMismatch() {
    assertAvailable(
        calculateSingleDimension({
            preferences: {
                difficulty: preference("Beginner", 1)
            },
            experience: {
                difficulty: "Intermediate"
            }
        }),
        0
    );
}

function testExperienceStyleArrayMatch() {
    assertAvailable(
        calculateSingleDimension({
            preferences: {
                experienceStyle: preference("Structured", 1)
            },
            experience: {
                experienceStyles: ["Creative", "Structured"]
            }
        }),
        1
    );
}

function testExperienceStyleArrayMismatch() {
    assertAvailable(
        calculateSingleDimension({
            preferences: {
                experienceStyle: preference("Structured", 1)
            },
            experience: {
                experienceStyles: ["Creative", "Exploratory"]
            }
        }),
        0
    );
}

function testExperienceStyleChildMixed() {
    assertAvailable(
        calculateSingleDimension({
            preferences: {
                experienceStyle: preference("Mixed", 1)
            },
            experience: {
                experienceStyles: ["Creative"]
            }
        }),
        1
    );
}

function testExperienceStyleEmptyArray() {
    assertUnavailable(
        calculateSingleDimension({
            preferences: {
                experienceStyle: preference("Structured", 1)
            },
            experience: {
                experienceStyles: []
            }
        })
    );
}

function testActivityArrayMixedNotSpecial() {
    assertAvailable(
        calculateSingleDimension({
            preferences: {
                experienceStyle: preference("Structured", 1)
            },
            experience: {
                experienceStyles: ["Mixed"]
            }
        }),
        0
    );
}

function testCommitmentExactMatch() {
    assertAvailable(
        calculateSingleDimension({
            preferences: {
                commitmentPreference: preference("OneTime", 1)
            },
            experience: {
                commitmentType: "OneTime"
            }
        }),
        1
    );
}

function testCommitmentMismatch() {
    assertAvailable(
        calculateSingleDimension({
            preferences: {
                commitmentPreference: preference("Weekly", 1)
            },
            experience: {
                commitmentType: "OneTime"
            }
        }),
        0
    );
}

function testMissingChildValue() {
    assertUnavailable(
        calculateSingleDimension({
            preferences: {
                environment: preference(null, 1)
            },
            experience: {
                environment: "Indoor"
            }
        })
    );
}

function testMissingActivityValue() {
    assertUnavailable(
        calculateSingleDimension({
            preferences: {
                environment: preference("Indoor", 1)
            },
            experience: {
                environment: null
            }
        })
    );
}

function testMissingConfidence() {
    assertUnavailable(
        calculateSingleDimension({
            preferences: {
                environment: {
                    value: "Indoor",
                    source: "Onboarding",
                    updatedAt: new Date("2026-09-01T00:00:00.000Z")
                }
            },
            experience: {
                environment: "Indoor"
            }
        })
    );
}

function testInvalidConfidence() {
    for (const confidenceScore of [
        NaN,
        Infinity,
        -0.1,
        1.1,
        "0.8"
    ]) {
        assertUnavailable(
            calculateSingleDimension({
                preferences: {
                    environment: preference("Indoor", confidenceScore)
                },
                experience: {
                    environment: "Indoor"
                }
            })
        );
    }
}

function testMultiplePerfectMatches() {
    const result = calculatePreferenceFactor(
        makeContext(makePreferences({
            environment: preference("Indoor", 0.8),
            socialStyle: preference("Team", 0.3),
            difficulty: preference("Beginner", 0.9)
        })),
        makeEvaluation(makeExperience({
            environment: "Indoor",
            socialStyle: "Team",
            difficulty: "Beginner"
        }))
    );
    const expected = (0.9 + 0.65 + 0.95) / 3;

    assertAvailable(result, expected);
}

function testStrongWeakSignalDilation() {
    const result = calculatePreferenceFactor(
        makeContext(makePreferences({
            environment: preference("Indoor", 0.9),
            socialStyle: preference("Team", 0),
            difficulty: preference("Beginner", 0)
        })),
        makeEvaluation(makeExperience({
            environment: "Indoor",
            socialStyle: "Individual",
            difficulty: "Advanced"
        }))
    );

    assertAvailable(result, (0.95 + 0.5 + 0.5) / 3);
}

function testTwoDimensionExample() {
    const result = calculatePreferenceFactor(
        makeContext(makePreferences({
            environment: preference("Indoor", 0.8),
            difficulty: preference("Beginner", 0.4)
        })),
        makeEvaluation(makeExperience({
            environment: "Indoor",
            difficulty: "Intermediate"
        }))
    );

    assertAvailable(result, 0.6);
}

function testZeroConfidenceDimensionParticipates() {
    const result = calculatePreferenceFactor(
        makeContext(makePreferences({
            environment: preference("Indoor", 1),
            difficulty: preference("Beginner", 0)
        })),
        makeEvaluation(makeExperience({
            environment: "Indoor",
            difficulty: "Advanced"
        }))
    );

    assertAvailable(result, 0.75);
}

function testPartialDataDoesNotPunish() {
    const result = calculatePreferenceFactor(
        makeContext(makePreferences({
            environment: preference("Indoor", 1),
            difficulty: preference("Beginner", 1)
        })),
        makeEvaluation(makeExperience({
            environment: null,
            difficulty: "Beginner"
        }))
    );

    assertAvailable(result, 1);
}

function testAllChildPreferencesMissing() {
    assertUnavailable(
        calculatePreferenceFactor(
            makeContext(makePreferences()),
            makeEvaluation(makeExperience({
                environment: "Indoor",
                socialStyle: "Team",
                difficulty: "Beginner",
                experienceStyles: ["Structured"],
                commitmentType: "Weekly"
            }))
        )
    );
}

function testActivityExperienceMissing() {
    assertUnavailable(
        calculatePreferenceFactor(
            makeContext(makePreferences({
                environment: preference("Indoor", 1)
            })),
            makeEvaluation(null)
        )
    );
}

function testSourceHasNoNumericEffect() {
    const scores = ["Onboarding", "Behavior", "Feedback"].map((source) =>
        calculateSingleDimension({
            preferences: {
                environment: preference("Indoor", 0.8, source)
            },
            experience: {
                environment: "Indoor"
            }
        }).score
    );

    assert.strictEqual(scores[0], scores[1]);
    assert.strictEqual(scores[1], scores[2]);
}

function testIntensityIgnored() {
    const context = makeContext(makePreferences({
        environment: preference("Indoor", 1)
    }));
    const low = calculatePreferenceFactor(
        context,
        makeEvaluation(makeExperience({
            environment: "Indoor",
            intensityLevel: "Low"
        }))
    );
    const high = calculatePreferenceFactor(
        context,
        makeEvaluation(makeExperience({
            environment: "Indoor",
            intensityLevel: "High"
        }))
    );

    assert.strictEqual(low.score, high.score);
}

function testDurationIgnored() {
    const context = makeContext(makePreferences({
        environment: preference("Indoor", 1)
    }));
    const short = calculatePreferenceFactor(
        context,
        makeEvaluation(makeExperience({
            environment: "Indoor",
            durationMinutes: 30
        }))
    );
    const long = calculatePreferenceFactor(
        context,
        makeEvaluation(makeExperience({
            environment: "Indoor",
            durationMinutes: 120
        }))
    );

    assert.strictEqual(short.score, long.score);
}

function testIneligibleCandidate() {
    assertThrows("ineligible candidate should throw", () => {
        calculatePreferenceFactor(
            makeContext(),
            makeEvaluation(makeExperience(), {
                eligibility: {
                    eligible: false,
                    failedConstraints: []
                }
            })
        );
    });
}

function testNullContext() {
    assertThrows("null context should throw", () => {
        calculatePreferenceFactor(null, makeEvaluation());
    });
}

function testEvidenceShape() {
    const result = calculateSingleDimension({
        preferences: {
            environment: preference("Indoor", 1, "Feedback")
        },
        experience: {
            environment: "Indoor"
        }
    });

    assert.deepStrictEqual(Object.keys(result.evidence[0]), [
        "dimension",
        "childValue",
        "activityValue",
        "confidence",
        "source",
        "baseMatch",
        "adjustedScore"
    ]);
}

function testEvidenceOnlyUsedDimensions() {
    const result = calculatePreferenceFactor(
        makeContext(makePreferences({
            environment: preference("Indoor", 1),
            difficulty: preference(null, 1)
        })),
        makeEvaluation(makeExperience({
            environment: "Indoor",
            difficulty: "Beginner"
        }))
    );

    assert.strictEqual(result.evidence.length, 1);
    assert.strictEqual(result.evidence[0].dimension, "environment");
}

function testArrayEvidenceCopy() {
    const experienceStyles = ["Creative", "Structured"];
    const result = calculateSingleDimension({
        preferences: {
            experienceStyle: preference("Structured", 1)
        },
        experience: {
            experienceStyles
        }
    });

    assert.notStrictEqual(result.evidence[0].activityValue, experienceStyles);
    assert.deepStrictEqual(result.evidence[0].activityValue, experienceStyles);
}

function testNoInputMutation() {
    const experienceStyles = ["Creative", "Structured"];
    const context = makeContext(makePreferences({
        environment: preference("Indoor", 1),
        experienceStyle: preference("Structured", 1)
    }));
    const evaluation = makeEvaluation(makeExperience({
        environment: "Indoor",
        experienceStyles
    }));
    const preferences = context.child.preferences;
    const candidate = evaluation.candidate;
    const activity = evaluation.candidate.currentActivity;
    const experience = activity.experience;
    const contextSnapshot = JSON.stringify(context);
    const evaluationSnapshot = JSON.stringify(evaluation);

    calculatePreferenceFactor(context, evaluation);

    assert.strictEqual(JSON.stringify(context), contextSnapshot);
    assert.strictEqual(JSON.stringify(evaluation), evaluationSnapshot);
    assert.strictEqual(context.child.preferences, preferences);
    assert.strictEqual(evaluation.candidate, candidate);
    assert.strictEqual(evaluation.candidate.currentActivity, activity);
    assert.strictEqual(activity.experience, experience);
    assert.strictEqual(activity.experience.experienceStyles, experienceStyles);
}

function testResultContract() {
    const result = calculateSingleDimension({
        preferences: {
            environment: preference("Indoor", 1)
        },
        experience: {
            environment: "Indoor"
        }
    });

    assert.deepStrictEqual(Object.keys(result), [
        "factor",
        "available",
        "score",
        "evidence"
    ]);
    assert.strictEqual(result.factor, "preference");
}

function testSoftScoreOnly() {
    const evaluation = makeEvaluation(makeExperience({
        environment: "Outdoor"
    }));
    const failures = evaluation.eligibility.failedConstraints;

    calculatePreferenceFactor(
        makeContext(makePreferences({
            environment: preference("Indoor", 1)
        })),
        evaluation
    );

    assert.strictEqual(evaluation.eligibility.failedConstraints, failures);
    assert.deepStrictEqual(evaluation.eligibility.failedConstraints, []);
}

function main() {
    testEnvironmentExactMatch();
    testEnvironmentExplicitMismatch();
    testLowConfidenceMatch();
    testLowConfidenceMismatch();
    testConfidenceZero();
    testSocialStyleMixedChild();
    testSocialStyleMixedActivity();
    testEnvironmentMixedChild();
    testEnvironmentMixedActivity();
    testDifficultyExactMatch();
    testDifficultyMismatch();
    testExperienceStyleArrayMatch();
    testExperienceStyleArrayMismatch();
    testExperienceStyleChildMixed();
    testExperienceStyleEmptyArray();
    testActivityArrayMixedNotSpecial();
    testCommitmentExactMatch();
    testCommitmentMismatch();
    testMissingChildValue();
    testMissingActivityValue();
    testMissingConfidence();
    testInvalidConfidence();
    testMultiplePerfectMatches();
    testStrongWeakSignalDilation();
    testTwoDimensionExample();
    testZeroConfidenceDimensionParticipates();
    testPartialDataDoesNotPunish();
    testAllChildPreferencesMissing();
    testActivityExperienceMissing();
    testSourceHasNoNumericEffect();
    testIntensityIgnored();
    testDurationIgnored();
    testIneligibleCandidate();
    testNullContext();
    testEvidenceShape();
    testEvidenceOnlyUsedDimensions();
    testArrayEvidenceCopy();
    testNoInputMutation();
    testResultContract();
    testSoftScoreOnly();

    console.log("========================================");
    console.log("STEP 15C-B - PREFERENCE FACTOR");
    console.log("========================================");
    console.log("");
    console.log("Environment exact match:                PASSED");
    console.log("Environment explicit mismatch:          PASSED");
    console.log("Environment Mixed compatibility:        PASSED");
    console.log("");
    console.log("Social Style Mixed compatibility:       PASSED");
    console.log("");
    console.log("Difficulty exact-only rule:             PASSED");
    console.log("");
    console.log("ExperienceStyle Array match:            PASSED");
    console.log("ExperienceStyle Array mismatch:         PASSED");
    console.log("Child Mixed experience style:           PASSED");
    console.log("Empty experienceStyles skipped:         PASSED");
    console.log("Activity Mixed branch unsupported:      PASSED");
    console.log("");
    console.log("Commitment exact comparison:            PASSED");
    console.log("");
    console.log("Confidence adjustment:                  PASSED");
    console.log("Low-confidence match -> near neutral:   PASSED");
    console.log("Low-confidence mismatch -> near neutral:PASSED");
    console.log("Confidence 0 -> neutral:                PASSED");
    console.log("");
    console.log("Arithmetic dimension mean:              PASSED");
    console.log("Weak-signal neutral dilution:           PASSED");
    console.log("");
    console.log("Missing Child value skipped:            PASSED");
    console.log("Missing Activity value skipped:         PASSED");
    console.log("Missing confidence skipped:             PASSED");
    console.log("");
    console.log("Known mismatch != missing:              PASSED");
    console.log("Missing info != zero:                   PASSED");
    console.log("");
    console.log("Source numeric effect:                  NONE");
    console.log("");
    console.log("Hard filtering:                         NONE");
    console.log("Input mutation:                         NONE");
    console.log("");
    console.log("Final weighted score:                   NONE");
    console.log("Normalization:                          NONE");
    console.log("Ranking:                                NONE");
    console.log("Top-N:                                  NONE");
    console.log("");
    console.log("========================================");
    console.log("STEP 15C-B PREFERENCE FACTOR PASSED");
    console.log("========================================");
}

main();
