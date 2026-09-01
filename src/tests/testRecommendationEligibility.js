const {
    ELIGIBILITY_SCOPES
} = require("../recommendation/eligibilityResult");
const {
    evaluateRecommendationEligibility
} = require("../recommendation/recommendationEligibilityService");

const evaluationTime = new Date("2026-09-01T12:00:00.000Z");

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

function assertThrows(label, fn) {
    let threw = false;

    try {
        fn();
    } catch (error) {
        threw = true;
    }

    assert(threw, `${label}: expected error`);
}

function makeSession(id = "session-1", overrides = {}) {
    return {
        _id: id,
        availability: {
            status: "Available",
            registrationOpen: true
        },
        capacity: {
            remainingCapacity: 5
        },
        schedule: {
            bookingDeadline: new Date("2026-09-02T12:00:00.000Z"),
            startDateTime: new Date("2026-09-10T15:00:00.000Z"),
            timezone: "Asia/Riyadh"
        },
        ...overrides
    };
}

function makeCandidate(id = "activity-1", overrides = {}) {
    return {
        activity: {
            activityId: id
        },
        currentActivity: {
            _id: id,
            basicInformation: {
                status: "Published"
            },
            eligibility: {
                minimumAge: 7,
                maximumAge: 12,
                allowedGenders: ["Male", "Female"]
            },
            activityConstraints: {
                accessibilityFeatures: [],
                safetyRequirements: []
            }
        },
        currentSessions: [
            makeSession(`${id}-session-1`)
        ],
        ...overrides
    };
}

function makeContext(candidates = [makeCandidate()], overrides = {}) {
    const childId = "child-1";
    const parentId = "parent-1";

    return {
        child: {
            _id: childId,
            parentId,
            status: "Active",
            identity: {
                dateOfBirth: new Date("2017-05-10T00:00:00.000Z"),
                gender: "Female"
            }
        },
        parent: {
            _id: parentId,
            account: {
                status: "Active"
            },
            recommendationPreferences: {
                excludedActivityIds: [],
                excludedVendorIds: []
            },
            hardRequirements: {
                accessibilityRequirements: [],
                safetyRequirements: []
            }
        },
        candidates,
        ...overrides
    };
}

function findFailure(result, code, fieldPath = undefined) {
    return result.failedConstraints.find(failure => (
        failure.code === code &&
        (
            fieldPath === undefined ||
            failure.fieldPath === fieldPath
        )
    ));
}

function findMissing(records, code) {
    return records.find(record => record.code === code);
}

function assertRootShape(result) {
    const keys = Object.keys(result);

    assertEqual("top-level key count", keys.length, 3);
    assert(keys.includes("requestEligibility"), "missing requestEligibility");
    assert(keys.includes("candidateEvaluations"), "missing candidateEvaluations");
    assert(keys.includes("eligibleCandidates"), "missing eligibleCandidates");
}

function assertEvaluationShape(evaluation) {
    const keys = Object.keys(evaluation);

    assertEqual("evaluation key count", keys.length, 5);
    assert(keys.includes("candidate"), "missing candidate");
    assert(keys.includes("eligibility"), "missing eligibility");
    assert(keys.includes("eligibleSessions"), "missing eligibleSessions");
    assert(keys.includes("sessionEvaluations"), "missing sessionEvaluations");
    assert(keys.includes("missingInformation"), "missing missingInformation");

    for (const forbidden of [
        "score",
        "rank",
        "finalScore",
        "factors",
        "selectedSession",
        "bestSession",
        "sessionSuitability"
    ]) {
        assert(
            !keys.includes(forbidden),
            `${forbidden} must not be returned`
        );
    }
}

function assertRequestPassed(result) {
    assertEqual("request eligible", result.requestEligibility.eligible, true);
    assertEqual(
        "request failedConstraints length",
        result.requestEligibility.failedConstraints.length,
        0
    );
}

function assertCandidateFailure(evaluation, code, fieldPath = undefined) {
    assertEqual("candidate eligible", evaluation.eligibility.eligible, false);
    assert(
        findFailure(evaluation.eligibility, code, fieldPath),
        `missing candidate failure ${code} at ${fieldPath}`
    );
}

function testValidCandidate() {
    const result = evaluateRecommendationEligibility(
        makeContext(),
        evaluationTime
    );

    assertRequestPassed(result);
    assertEqual("candidateEvaluations length", result.candidateEvaluations.length, 1);
    assertEqual("eligibleCandidates length", result.eligibleCandidates.length, 1);
    assertEqual(
        "candidate eligible",
        result.candidateEvaluations[0].eligibility.eligible,
        true
    );
    assertEqual(
        "eligibleSessions length",
        result.candidateEvaluations[0].eligibleSessions.length,
        1
    );
}

function testSharedEvaluationReference() {
    const result = evaluateRecommendationEligibility(
        makeContext(),
        evaluationTime
    );

    assertEqual(
        "shared evaluation reference",
        result.eligibleCandidates[0],
        result.candidateEvaluations[0]
    );
}

function testOriginalCandidateReferencePreserved() {
    const candidate = makeCandidate();
    const result = evaluateRecommendationEligibility(
        makeContext([candidate]),
        evaluationTime
    );

    assertEqual(
        "original candidate reference",
        result.candidateEvaluations[0].candidate,
        candidate
    );
}

function testActivityStatusIgnored() {
    const candidates = [
        makeCandidate("published", {
            currentActivity: {
                ...makeCandidate("published").currentActivity,
                basicInformation: {
                    status: "Published"
                }
            }
        }),
        makeCandidate("draft", {
            currentActivity: {
                ...makeCandidate("draft").currentActivity,
                basicInformation: {
                    status: "Draft"
                }
            }
        }),
        makeCandidate("archived", {
            currentActivity: {
                ...makeCandidate("archived").currentActivity,
                basicInformation: {
                    status: "Archived"
                }
            }
        })
    ];
    const result = evaluateRecommendationEligibility(
        makeContext(candidates),
        evaluationTime
    );

    assertEqual("eligibleCandidates length", result.eligibleCandidates.length, 3);

    for (const evaluation of result.candidateEvaluations) {
        assertEqual("candidate eligible", evaluation.eligibility.eligible, true);
        assert(
            !findFailure(evaluation.eligibility, "ACTIVITY_NOT_PUBLISHED"),
            "Activity lifecycle status must not create hard failure"
        );
    }
}

function testGenderMismatchFiltered() {
    const candidate = makeCandidate("gender", {
        currentActivity: {
            _id: "gender",
            basicInformation: {
                status: "Published"
            },
            eligibility: {
                minimumAge: 7,
                maximumAge: 12,
                allowedGenders: ["Male"]
            },
            activityConstraints: {
                accessibilityFeatures: [],
                safetyRequirements: []
            }
        }
    });
    const result = evaluateRecommendationEligibility(
        makeContext([candidate]),
        evaluationTime
    );

    assertCandidateFailure(
        result.candidateEvaluations[0],
        "GENDER_NOT_ELIGIBLE",
        "eligibility.allowedGenders"
    );
    assertEqual("eligibleCandidates length", result.eligibleCandidates.length, 0);
}

function testAccessibilityMismatchFiltered() {
    const candidate = makeCandidate("accessibility", {
        currentActivity: {
            _id: "accessibility",
            basicInformation: {
                status: "Published"
            },
            eligibility: {
                minimumAge: 7,
                maximumAge: 12,
                allowedGenders: ["Male", "Female"]
            },
            activityConstraints: {
                accessibilityFeatures: ["Stairs Only"],
                safetyRequirements: []
            }
        }
    });
    const result = evaluateRecommendationEligibility(
        makeContext([candidate], {
            parent: {
                _id: "parent-1",
                account: {
                    status: "Active"
                },
                hardRequirements: {
                    accessibilityRequirements: ["Wheelchair Accessible"],
                    safetyRequirements: []
                }
            }
        }),
        evaluationTime
    );

    assertCandidateFailure(
        result.candidateEvaluations[0],
        "REQUIREMENT_NOT_MET",
        "activityConstraints.accessibilityFeatures"
    );
    assertEqual("eligibleCandidates length", result.eligibleCandidates.length, 0);
}

function testSafetyMismatchFiltered() {
    const candidate = makeCandidate("safety", {
        currentActivity: {
            _id: "safety",
            basicInformation: {
                status: "Published"
            },
            eligibility: {
                minimumAge: 7,
                maximumAge: 12,
                allowedGenders: ["Male", "Female"]
            },
            activityConstraints: {
                accessibilityFeatures: [],
                safetyRequirements: ["No First Aid"]
            }
        }
    });
    const result = evaluateRecommendationEligibility(
        makeContext([candidate], {
            parent: {
                _id: "parent-1",
                account: {
                    status: "Active"
                },
                hardRequirements: {
                    accessibilityRequirements: [],
                    safetyRequirements: ["First Aid Available"]
                }
            }
        }),
        evaluationTime
    );

    assertCandidateFailure(
        result.candidateEvaluations[0],
        "REQUIREMENT_NOT_MET",
        "activityConstraints.safetyRequirements"
    );
    assertEqual("eligibleCandidates length", result.eligibleCandidates.length, 0);
}

function testZeroSessionsFiltered() {
    const result = evaluateRecommendationEligibility(
        makeContext([
            makeCandidate("no-session", {
                currentSessions: []
            })
        ]),
        evaluationTime
    );

    assertCandidateFailure(
        result.candidateEvaluations[0],
        "NO_ELIGIBLE_SESSION",
        "currentSessions"
    );
    assertEqual("eligibleCandidates length", result.eligibleCandidates.length, 0);
}

function testFailedSessionFiltered() {
    const result = evaluateRecommendationEligibility(
        makeContext([
            makeCandidate("full-session", {
                currentSessions: [
                    makeSession("full-session-1", {
                        availability: {
                            status: "Full",
                            registrationOpen: true
                        }
                    })
                ]
            })
        ]),
        evaluationTime
    );
    const evaluation = result.candidateEvaluations[0];

    assertCandidateFailure(evaluation, "NO_ELIGIBLE_SESSION", "currentSessions");
    assert(
        findFailure(
            evaluation.sessionEvaluations[0].eligibility,
            "SESSION_UNAVAILABLE",
            "availability.status"
        ),
        "Session failure must be preserved"
    );
}

function testOneEligibleSessionSurvives() {
    const passingSession = makeSession("session-pass");
    const result = evaluateRecommendationEligibility(
        makeContext([
            makeCandidate("mixed-sessions", {
                currentSessions: [
                    makeSession("session-full", {
                        availability: {
                            status: "Full",
                            registrationOpen: true
                        }
                    }),
                    passingSession
                ]
            })
        ]),
        evaluationTime
    );

    assertEqual("candidate eligible", result.candidateEvaluations[0].eligibility.eligible, true);
    assertEqual("eligibleSessions length", result.candidateEvaluations[0].eligibleSessions.length, 1);
    assertEqual("sessionEvaluations length", result.candidateEvaluations[0].sessionEvaluations.length, 2);
    assertEqual(
        "passing Session reference",
        result.candidateEvaluations[0].eligibleSessions[0],
        passingSession
    );
}

function testAgeMismatchFiltered() {
    const result = evaluateRecommendationEligibility(
        makeContext([
            makeCandidate("age", {
                currentSessions: [
                    makeSession("age-session", {
                        schedule: {
                            bookingDeadline: new Date("2026-09-02T12:00:00.000Z"),
                            startDateTime: new Date("2024-05-09T15:00:00.000Z"),
                            timezone: "Asia/Riyadh"
                        }
                    })
                ]
            })
        ]),
        evaluationTime
    );
    const evaluation = result.candidateEvaluations[0];

    assertCandidateFailure(evaluation, "NO_ELIGIBLE_SESSION", "currentSessions");
    assert(
        findFailure(
            evaluation.sessionEvaluations[0].eligibility,
            "AGE_NOT_ELIGIBLE",
            "eligibility.minimumAge"
        ),
        "Session age failure must be preserved"
    );
}

function testMissingGenderInfoPreserved() {
    const candidate = makeCandidate("missing-gender", {
        currentActivity: {
            _id: "missing-gender",
            basicInformation: {
                status: "Published"
            },
            eligibility: {
                minimumAge: 7,
                maximumAge: 12
            },
            activityConstraints: {
                accessibilityFeatures: [],
                safetyRequirements: []
            }
        }
    });
    const result = evaluateRecommendationEligibility(
        makeContext([candidate]),
        evaluationTime
    );
    const evaluation = result.candidateEvaluations[0];

    assertEqual("candidate eligible", evaluation.eligibility.eligible, true);
    assert(findMissing(evaluation.missingInformation, "ALLOWED_GENDERS_UNCONFIRMED"), "missing gender info record");
    assert(
        !findFailure(evaluation.eligibility, "GENDER_NOT_ELIGIBLE"),
        "missing gender info must not hard fail"
    );
}

function testMissingAccessibilityInfoPreserved() {
    const candidate = makeCandidate("missing-accessibility", {
        currentActivity: {
            _id: "missing-accessibility",
            basicInformation: {
                status: "Published"
            },
            eligibility: {
                minimumAge: 7,
                maximumAge: 12,
                allowedGenders: ["Male", "Female"]
            },
            activityConstraints: {
                safetyRequirements: []
            }
        }
    });
    const result = evaluateRecommendationEligibility(
        makeContext([candidate], {
            parent: {
                _id: "parent-1",
                account: {
                    status: "Active"
                },
                hardRequirements: {
                    accessibilityRequirements: ["Wheelchair Accessible"],
                    safetyRequirements: []
                }
            }
        }),
        evaluationTime
    );
    const evaluation = result.candidateEvaluations[0];

    assertEqual("candidate eligible", evaluation.eligibility.eligible, true);
    assert(findMissing(evaluation.missingInformation, "ACCESSIBILITY_INFO_UNCONFIRMED"), "missing accessibility info record");
    assert(
        !findFailure(evaluation.eligibility, "REQUIREMENT_NOT_MET"),
        "missing accessibility info must not hard fail"
    );
}

function testMissingSafetyInfoPreserved() {
    const candidate = makeCandidate("missing-safety", {
        currentActivity: {
            _id: "missing-safety",
            basicInformation: {
                status: "Published"
            },
            eligibility: {
                minimumAge: 7,
                maximumAge: 12,
                allowedGenders: ["Male", "Female"]
            },
            activityConstraints: {
                accessibilityFeatures: []
            }
        }
    });
    const result = evaluateRecommendationEligibility(
        makeContext([candidate], {
            parent: {
                _id: "parent-1",
                account: {
                    status: "Active"
                },
                hardRequirements: {
                    accessibilityRequirements: [],
                    safetyRequirements: ["First Aid Available"]
                }
            }
        }),
        evaluationTime
    );
    const evaluation = result.candidateEvaluations[0];

    assertEqual("candidate eligible", evaluation.eligibility.eligible, true);
    assert(findMissing(evaluation.missingInformation, "SAFETY_INFO_UNCONFIRMED"), "missing safety info record");
    assert(
        !findFailure(evaluation.eligibility, "REQUIREMENT_NOT_MET"),
        "missing safety info must not hard fail"
    );
}

function testMultipleHardFailuresPreserved() {
    const candidate = makeCandidate("multiple", {
        currentActivity: {
            _id: "multiple",
            basicInformation: {
                status: "Draft"
            },
            eligibility: {
                minimumAge: 7,
                maximumAge: 12,
                allowedGenders: ["Male"]
            },
            activityConstraints: {
                accessibilityFeatures: ["Stairs Only"],
                safetyRequirements: []
            }
        },
        currentSessions: []
    });
    const result = evaluateRecommendationEligibility(
        makeContext([candidate], {
            parent: {
                _id: "parent-1",
                account: {
                    status: "Active"
                },
                hardRequirements: {
                    accessibilityRequirements: ["Wheelchair Accessible"],
                    safetyRequirements: []
                }
            }
        }),
        evaluationTime
    );
    const evaluation = result.candidateEvaluations[0];

    assertCandidateFailure(evaluation, "GENDER_NOT_ELIGIBLE");
    assertCandidateFailure(evaluation, "REQUIREMENT_NOT_MET");
    assertCandidateFailure(evaluation, "NO_ELIGIBLE_SESSION");
    assertEqual("eligibleCandidates length", result.eligibleCandidates.length, 0);
}

function testMultipleCandidatesFilterCorrectly() {
    const candidateA = makeCandidate("A");
    const candidateB = makeCandidate("B", {
        currentActivity: {
            _id: "B",
            basicInformation: {
                status: "Draft"
            },
            eligibility: {
                minimumAge: 7,
                maximumAge: 12,
                allowedGenders: ["Male", "Female"]
            },
            activityConstraints: {
                accessibilityFeatures: [],
                safetyRequirements: []
            }
        }
    });
    const candidateC = makeCandidate("C", {
        currentActivity: {
            _id: "C",
            basicInformation: {
                status: "Published"
            },
            eligibility: {
                minimumAge: 7,
                maximumAge: 12,
                allowedGenders: ["Male"]
            },
            activityConstraints: {
                accessibilityFeatures: [],
                safetyRequirements: []
            }
        }
    });
    const candidateD = makeCandidate("D", {
        currentSessions: []
    });
    const candidateE = makeCandidate("E", {
        currentActivity: {
            _id: "E",
            basicInformation: {
                status: "Published"
            },
            eligibility: {
                minimumAge: 7,
                maximumAge: 12
            },
            activityConstraints: {
                accessibilityFeatures: [],
                safetyRequirements: []
            }
        }
    });
    const result = evaluateRecommendationEligibility(
        makeContext([
            candidateA,
            candidateB,
            candidateC,
            candidateD,
            candidateE
        ]),
        evaluationTime
    );

    assertEqual("candidateEvaluations length", result.candidateEvaluations.length, 5);
    assertEqual("eligibleCandidates length", result.eligibleCandidates.length, 3);
    assertEqual("first eligible", result.eligibleCandidates[0].candidate, candidateA);
    assertEqual("second eligible", result.eligibleCandidates[1].candidate, candidateB);
    assertEqual("third eligible", result.eligibleCandidates[2].candidate, candidateE);
}

function testInactiveChildRequest() {
    const result = evaluateRecommendationEligibility(
        makeContext([makeCandidate()], {
            child: {
                _id: "child-1",
                parentId: "parent-1",
                status: "Inactive",
                identity: {
                    dateOfBirth: new Date("2017-05-10T00:00:00.000Z"),
                    gender: "Female"
                }
            }
        }),
        evaluationTime
    );

    assertEqual("request eligible", result.requestEligibility.eligible, false);
    assert(findFailure(result.requestEligibility, "CHILD_INACTIVE"), "missing CHILD_INACTIVE");
    assertEqual("candidateEvaluations length", result.candidateEvaluations.length, 0);
    assertEqual("eligibleCandidates length", result.eligibleCandidates.length, 0);
}

function testInactiveParentRequest() {
    const result = evaluateRecommendationEligibility(
        makeContext([makeCandidate()], {
            parent: {
                _id: "parent-1",
                account: {
                    status: "Suspended"
                },
                hardRequirements: {
                    accessibilityRequirements: [],
                    safetyRequirements: []
                }
            }
        }),
        evaluationTime
    );

    assertEqual("request eligible", result.requestEligibility.eligible, false);
    assert(findFailure(result.requestEligibility, "PARENT_INACTIVE"), "missing PARENT_INACTIVE");
    assertEqual("candidateEvaluations length", result.candidateEvaluations.length, 0);
    assertEqual("eligibleCandidates length", result.eligibleCandidates.length, 0);
}

function testParentChildMismatch() {
    const result = evaluateRecommendationEligibility(
        makeContext([makeCandidate()], {
            parent: {
                _id: "parent-2",
                account: {
                    status: "Active"
                },
                hardRequirements: {
                    accessibilityRequirements: [],
                    safetyRequirements: []
                }
            }
        }),
        evaluationTime
    );

    assertEqual("request eligible", result.requestEligibility.eligible, false);
    assert(findFailure(result.requestEligibility, "PARENT_CHILD_MISMATCH"), "missing PARENT_CHILD_MISMATCH");
    assertEqual("candidateEvaluations length", result.candidateEvaluations.length, 0);
    assertEqual("eligibleCandidates length", result.eligibleCandidates.length, 0);
}

function testMissingContext() {
    const result = evaluateRecommendationEligibility(null, evaluationTime);

    assertEqual("request eligible", result.requestEligibility.eligible, false);
    assert(findFailure(result.requestEligibility, "CONTEXT_MISSING"), "missing CONTEXT_MISSING");
    assertEqual("candidateEvaluations length", result.candidateEvaluations.length, 0);
    assertEqual("eligibleCandidates length", result.eligibleCandidates.length, 0);
}

function testEmptyCandidates() {
    const result = evaluateRecommendationEligibility(
        makeContext([]),
        evaluationTime
    );

    assertRequestPassed(result);
    assertEqual("candidateEvaluations length", result.candidateEvaluations.length, 0);
    assertEqual("eligibleCandidates length", result.eligibleCandidates.length, 0);
}

function testMalformedCandidatesRejected() {
    assertThrows("malformed candidates", () => {
        evaluateRecommendationEligibility(
            makeContext("invalid"),
            evaluationTime
        );
    });
}

function testMissingActivityPreserved() {
    const candidate = {
        activity: {
            activityId: "activity-1"
        },
        currentActivity: null,
        currentSessions: [
            makeSession("session-1")
        ]
    };
    const result = evaluateRecommendationEligibility(
        makeContext([candidate]),
        evaluationTime
    );
    const evaluation = result.candidateEvaluations[0];

    assertCandidateFailure(evaluation, "ACTIVITY_MISSING", "currentActivity");
    assertEqual("eligibleSessions length", evaluation.eligibleSessions.length, 0);
    assertEqual("sessionEvaluations length", evaluation.sessionEvaluations.length, 0);
    assertEqual("missingInformation length", evaluation.missingInformation.length, 0);
    assert(
        !findFailure(evaluation.eligibility, "NO_ELIGIBLE_SESSION"),
        "missing Activity must not produce NO_ELIGIBLE_SESSION"
    );
}

function testContextNotMutated() {
    const candidate = makeCandidate();
    const context = makeContext([candidate]);
    const originalCandidates = context.candidates;
    const originalLength = context.candidates.length;

    evaluateRecommendationEligibility(context, evaluationTime);

    assertEqual("context candidates reference", context.candidates, originalCandidates);
    assertEqual("context candidates length", context.candidates.length, originalLength);
    assertEqual("context candidate reference", context.candidates[0], candidate);
}

function testSessionArrayNotMutated() {
    const sessionA = makeSession("A");
    const sessionB = makeSession("B", {
        availability: {
            status: "Full",
            registrationOpen: true
        }
    });
    const candidate = makeCandidate("sessions", {
        currentSessions: [
            sessionA,
            sessionB
        ]
    });
    const originalSessions = candidate.currentSessions;

    evaluateRecommendationEligibility(
        makeContext([candidate]),
        evaluationTime
    );

    assertEqual("currentSessions reference", candidate.currentSessions, originalSessions);
    assertEqual("first Session reference", candidate.currentSessions[0], sessionA);
    assertEqual("second Session reference", candidate.currentSessions[1], sessionB);
}

function testMissingInfoDoesNotEnterFailedConstraints() {
    const candidate = makeCandidate("missing-all-info", {
        currentActivity: {
            _id: "missing-all-info",
            basicInformation: {
                status: "Published"
            },
            eligibility: {
                minimumAge: 7,
                maximumAge: 12
            },
            activityConstraints: {}
        }
    });
    const result = evaluateRecommendationEligibility(
        makeContext([candidate], {
            parent: {
                _id: "parent-1",
                account: {
                    status: "Active"
                },
                hardRequirements: {
                    accessibilityRequirements: ["Wheelchair Accessible"],
                    safetyRequirements: ["First Aid Available"]
                }
            }
        }),
        evaluationTime
    );
    const evaluation = result.candidateEvaluations[0];

    assertEqual("candidate eligible", evaluation.eligibility.eligible, true);
    assertEqual("failedConstraints length", evaluation.eligibility.failedConstraints.length, 0);
    assertEqual("missingInformation length", evaluation.missingInformation.length, 3);
    assert(findMissing(evaluation.missingInformation, "ALLOWED_GENDERS_UNCONFIRMED"), "missing gender record");
    assert(findMissing(evaluation.missingInformation, "ACCESSIBILITY_INFO_UNCONFIRMED"), "missing accessibility record");
    assert(findMissing(evaluation.missingInformation, "SAFETY_INFO_UNCONFIRMED"), "missing safety record");
}

function testActivityParentExcluded() {
    const candidate = makeCandidate("excluded-activity");
    const result = evaluateRecommendationEligibility(
        makeContext([candidate], {
            parent: {
                _id: "parent-1",
                account: {
                    status: "Active"
                },
                recommendationPreferences: {
                    excludedActivityIds: ["excluded-activity"],
                    excludedVendorIds: []
                },
                hardRequirements: {
                    accessibilityRequirements: [],
                    safetyRequirements: []
                }
            }
        }),
        evaluationTime
    );

    assertCandidateFailure(
        result.candidateEvaluations[0],
        "PARENT_EXCLUDED",
        "recommendationPreferences.excludedActivityIds"
    );
    assertEqual("eligibleCandidates length", result.eligibleCandidates.length, 0);
}

function testVendorParentExcluded() {
    const candidate = makeCandidate("excluded-vendor", {
        currentActivity: {
            _id: "excluded-vendor",
            vendorId: "vendor-1",
            basicInformation: {
                status: "Published"
            },
            eligibility: {
                minimumAge: 7,
                maximumAge: 12,
                allowedGenders: ["Male", "Female"]
            },
            activityConstraints: {
                accessibilityFeatures: [],
                safetyRequirements: []
            }
        }
    });
    const result = evaluateRecommendationEligibility(
        makeContext([candidate], {
            parent: {
                _id: "parent-1",
                account: {
                    status: "Active"
                },
                recommendationPreferences: {
                    excludedActivityIds: [],
                    excludedVendorIds: ["vendor-1"]
                },
                hardRequirements: {
                    accessibilityRequirements: [],
                    safetyRequirements: []
                }
            }
        }),
        evaluationTime
    );

    assertCandidateFailure(
        result.candidateEvaluations[0],
        "PARENT_EXCLUDED",
        "recommendationPreferences.excludedVendorIds"
    );
    assertEqual("eligibleCandidates length", result.eligibleCandidates.length, 0);
}

function testSoftRecommendationPreferencesRemainEligible() {
    const result = evaluateRecommendationEligibility(
        makeContext([makeCandidate("soft-preferences")], {
            parent: {
                _id: "parent-1",
                account: {
                    status: "Active"
                },
                recommendationPreferences: {
                    preferredDays: ["Monday"],
                    preferredTimeRanges: ["Morning"],
                    preferredTravelDistanceKm: 1,
                    budget: {
                        preferredMaximumAmount: 0
                    },
                    preferredActivityIds: ["other-activity"],
                    preferredVendorIds: ["other-vendor"],
                    transportationPreferred: true,
                    excludedActivityIds: [],
                    excludedVendorIds: []
                },
                hardRequirements: {
                    accessibilityRequirements: [],
                    safetyRequirements: []
                }
            }
        }),
        evaluationTime
    );

    assertEqual("candidate eligible", result.candidateEvaluations[0].eligibility.eligible, true);
    assertEqual("eligibleCandidates length", result.eligibleCandidates.length, 1);
}

function testNoScoringOrRankingFields() {
    const result = evaluateRecommendationEligibility(
        makeContext(),
        evaluationTime
    );

    assertRootShape(result);
    assertEvaluationShape(result.candidateEvaluations[0]);
}

function testInvalidEvaluationTime() {
    assertThrows("invalid evaluationTime", () => {
        evaluateRecommendationEligibility(
            makeContext(),
            new Date("invalid")
        );
    });
}

function testDefaultEvaluationTime() {
    const futureDeadline = new Date();
    futureDeadline.setUTCFullYear(futureDeadline.getUTCFullYear() + 1);
    const futureStart = new Date();
    futureStart.setUTCFullYear(futureStart.getUTCFullYear() + 2);

    const result = evaluateRecommendationEligibility(
        makeContext([
            makeCandidate("default-time", {
                currentSessions: [
                    makeSession("default-time-session", {
                        schedule: {
                            bookingDeadline: futureDeadline,
                            startDateTime: futureStart,
                            timezone: "Asia/Riyadh"
                        }
                    })
                ]
            })
        ])
    );

    assertRequestPassed(result);
    assertEqual("candidate eligible", result.candidateEvaluations[0].eligibility.eligible, true);
}

function main() {
    testValidCandidate();
    testSharedEvaluationReference();
    testOriginalCandidateReferencePreserved();
    testActivityStatusIgnored();
    testGenderMismatchFiltered();
    testAccessibilityMismatchFiltered();
    testSafetyMismatchFiltered();
    testZeroSessionsFiltered();
    testFailedSessionFiltered();
    testOneEligibleSessionSurvives();
    testAgeMismatchFiltered();
    testMissingGenderInfoPreserved();
    testMissingAccessibilityInfoPreserved();
    testMissingSafetyInfoPreserved();
    testMissingInfoDoesNotEnterFailedConstraints();
    testActivityParentExcluded();
    testVendorParentExcluded();
    testSoftRecommendationPreferencesRemainEligible();
    testMultipleHardFailuresPreserved();
    testMultipleCandidatesFilterCorrectly();
    testInactiveChildRequest();
    testInactiveParentRequest();
    testParentChildMismatch();
    testMissingContext();
    testEmptyCandidates();
    testMalformedCandidatesRejected();
    testMissingActivityPreserved();
    testContextNotMutated();
    testSessionArrayNotMutated();
    testNoScoringOrRankingFields();
    testInvalidEvaluationTime();
    testDefaultEvaluationTime();

    console.log("========================================");
    console.log("STEP 14H — HARD ELIGIBILITY ORCHESTRATOR");
    console.log("========================================");
    console.log("");
    console.log("Valid candidate:                       PASSED");
    console.log("Shared evaluation reference:           PASSED");
    console.log("Original candidate preserved:          PASSED");
    console.log("");
    console.log("Activity status ignored:               PASSED");
    console.log("Gender mismatch filtered:              PASSED");
    console.log("Accessibility mismatch filtered:       PASSED");
    console.log("Safety mismatch filtered:              PASSED");
    console.log("Zero Sessions filtered:                PASSED");
    console.log("Failed Session filtered:               PASSED");
    console.log("One eligible Session survives:         PASSED");
    console.log("Age mismatch filtered:                 PASSED");
    console.log("");
    console.log("Missing gender info preserved:         PASSED");
    console.log("Missing accessibility info preserved:  PASSED");
    console.log("Missing safety info preserved:         PASSED");
    console.log("Missing info does not hard filter:     PASSED");
    console.log("Activity Parent exclusion:             PASSED");
    console.log("Vendor Parent exclusion:               PASSED");
    console.log("Soft preferences remain soft:          PASSED");
    console.log("");
    console.log("Multiple failures preserved:           PASSED");
    console.log("Five-candidate filtering:              3 / 5 PASSED");
    console.log("");
    console.log("Inactive Child request:                PASSED");
    console.log("Inactive Parent request:               PASSED");
    console.log("Parent/Child mismatch:                 PASSED");
    console.log("Missing context:                       PASSED");
    console.log("");
    console.log("Empty candidates:                      PASSED");
    console.log("Malformed candidates rejected:         PASSED");
    console.log("Missing Activity preserved:            PASSED");
    console.log("");
    console.log("Context mutation:                      NONE");
    console.log("Session mutation:                      NONE");
    console.log("");
    console.log("Scoring:                               NONE");
    console.log("Ranking:                               NONE");
    console.log("Top-N:                                 NONE");
    console.log("Best Session selection:                NONE");
    console.log("");
    console.log("========================================");
    console.log("✅ PHASE 14H PASSED");
    console.log("========================================");
}

main();
