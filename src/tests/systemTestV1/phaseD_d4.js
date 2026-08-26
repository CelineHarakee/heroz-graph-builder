require("dotenv").config();

const { connectMongoDB, getDatabase } = require("../../config/mongodb");
const driver = require("../../config/neo4j");
const traversalService = require("../../traversal/traversalService");
const { toGraphId } = require("../../utils/idUtils");

const DATASET = "SYSTEM_TEST_V1";

function assertEqual(label, actual, expected) {
    if (actual !== expected) {
        throw new Error(
            `${label}: expected ${expected}, found ${actual}`
        );
    }
}

function assert(condition, message) {
    if (!condition) {
        throw new Error(message);
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

function getActivityByTitle(candidates, title) {
    return candidates.find(
        (candidate) => candidate.activity.title === title
    );
}

function assertUniqueActivityIds(childName, candidates) {
    const ids = candidates.map(
        (candidate) => candidate.activity.activityId
    );

    const uniqueIds = new Set(ids);

    assertEqual(
        `${childName} unique activity IDs`,
        uniqueIds.size,
        ids.length
    );
}

function assertNoRecommendationFields(childName, candidates) {
    for (const candidate of candidates) {
        const title =
            candidate.activity?.title ?? "Unknown Activity";

        const forbiddenFields = [
            "score",
            "rank",
            "finalScore",
            "eligible",
            "eligibility",
            "eligibilityStatus"
        ];

        for (const field of forbiddenFields) {
            assert(
                !Object.prototype.hasOwnProperty.call(
                    candidate,
                    field
                ),
                `${childName} ${title}: D4 must not return "${field}"`
            );
        }
    }
}

function assertInterestEvidence(
    candidate,
    expectedInterest
) {
    const interests = candidate.evidence?.interests ?? [];

    assertEqual(
        `${candidate.activity.title} interest evidence count`,
        interests.length,
        expectedInterest ? 1 : 0
    );

    if (!expectedInterest) {
        return;
    }

    const interest = interests[0];

    assertEqual(
        `${candidate.activity.title} interest name`,
        interest.name,
        expectedInterest.name
    );

    assertEqual(
        `${candidate.activity.title} interest subcategoryId`,
        interest.subcategoryId,
        expectedInterest.subcategoryId
    );

    assertClose(
        `${candidate.activity.title} interest score`,
        interest.score,
        expectedInterest.score
    );

    assertClose(
        `${candidate.activity.title} interest confidence`,
        interest.confidence,
        expectedInterest.confidence
    );

    assertEqual(
        `${candidate.activity.title} interest evidenceCount`,
        interest.evidenceCount,
        expectedInterest.evidenceCount
    );

    assertEqual(
        `${candidate.activity.title} interest lastUpdated`,
        interest.lastUpdated,
        expectedInterest.lastUpdated
    );
}

function assertGoalEvidence(
    candidate,
    expectedGoals
) {
    const goals = candidate.evidence?.goals ?? [];

    assertEqual(
        `${candidate.activity.title} goal evidence count`,
        goals.length,
        expectedGoals.length
    );

    for (const expectedGoal of expectedGoals) {
        const actualGoal = goals.find(
            (goal) => goal.name === expectedGoal.name
        );

        assert(
            actualGoal,
            `${candidate.activity.title}: missing goal evidence ` +
            `"${expectedGoal.name}"`
        );

        assertEqual(
            `${candidate.activity.title} ${expectedGoal.name} goalId`,
            actualGoal.goalId,
            expectedGoal.goalId
        );

        assertEqual(
            `${candidate.activity.title} ${expectedGoal.name} priority`,
            actualGoal.priority,
            expectedGoal.priority
        );

        assertEqual(
            `${candidate.activity.title} ${expectedGoal.name} status`,
            actualGoal.status,
            expectedGoal.status
        );

        assertEqual(
            `${candidate.activity.title} ${expectedGoal.name} outcome`,
            actualGoal.learningOutcome.name,
            expectedGoal.outcome
        );

        assertEqual(
            `${candidate.activity.title} ${expectedGoal.name} outcomeId`,
            actualGoal.learningOutcome.outcomeId,
            expectedGoal.outcomeId
        );

        assertClose(
            `${candidate.activity.title} ${expectedGoal.name} ` +
            `goalOutcomeWeight`,
            actualGoal.goalOutcomeWeight,
            expectedGoal.goalOutcomeWeight
        );

        assertClose(
            `${candidate.activity.title} ${expectedGoal.name} ` +
            `activityOutcomeWeight`,
            actualGoal.activityOutcomeWeight,
            expectedGoal.activityOutcomeWeight
        );
    }
}

function assertSummary(candidate, expectedSummary) {
    const summary = candidate.evidence?.summary ?? [];

    assertEqual(
        `${candidate.activity.title} summary count`,
        summary.length,
        expectedSummary.length
    );

    for (const expectedLine of expectedSummary) {
        assert(
            summary.includes(expectedLine),
            `${candidate.activity.title}: missing summary "${expectedLine}"`
        );
    }
}

function verifyCandidate(
    childName,
    candidates,
    title,
    {
        interest = null,
        goals = [],
        summary = []
    }
) {
    const candidate = getActivityByTitle(candidates, title);

    assert(
        candidate,
        `${childName}: expected candidate "${title}" was not found`
    );

    assertInterestEvidence(candidate, interest);
    assertGoalEvidence(candidate, goals);
    assertSummary(candidate, summary);

    return candidate;
}

async function loadDatasetCollection(
    db,
    collectionName,
    expectedCount
) {
    const documents = await db
        .collection(collectionName)
        .find({
            "metadata.testDataset": DATASET
        })
        .toArray();

    assertEqual(
        `${collectionName} SYSTEM_TEST_V1 documents`,
        documents.length,
        expectedCount
    );

    return documents;
}

async function main() {
    await connectMongoDB();

    const db = getDatabase();

    try {
        console.log("🚀 Starting Step 9 — Phase D");
        console.log("🔍 Testing D4 candidate discovery");

        // ==================================================
        // 1. Load the exact SYSTEM_TEST_V1 Mongo dataset
        // ==================================================

        const children = await loadDatasetCollection(
            db,
            "children",
            3
        );

        const subcategories = await loadDatasetCollection(
            db,
            "subcategories",
            4
        );

        const goals = await loadDatasetCollection(
            db,
            "goal_library",
            3
        );

        const outcomes = await loadDatasetCollection(
            db,
            "learning_outcomes",
            3
        );

        const activities = await loadDatasetCollection(
            db,
            "activities",
            5
        );

        const childInterests = await loadDatasetCollection(
            db,
            "child_interests",
            3
        );

        // ==================================================
        // 2. Build lookup maps from Mongo
        // ==================================================

        const childrenByName = new Map(
            children.map((child) => [
                child.identity?.firstName,
                child
            ])
        );

        const subcategoriesById = new Map(
            subcategories.map((subcategory) => [
                toGraphId(subcategory._id),
                subcategory
            ])
        );

        const goalsById = new Map(
            goals.map((goal) => [
                toGraphId(goal._id),
                goal
            ])
        );

        const outcomesById = new Map(
            outcomes.map((outcome) => [
                toGraphId(outcome._id),
                outcome
            ])
        );

        const activitiesByTitle = new Map(
            activities.map((activity) => [
                activity.basicInformation?.nameEn,
                activity
            ])
        );

        const interestsByChildAndSubcategory = new Map(
            childInterests.map((interest) => [
                `${toGraphId(interest.childId)}::` +
                `${toGraphId(interest.subcategoryId)}`,
                interest
            ])
        );

        // ==================================================
        // 3. Resolve expected IDs
        // ==================================================

        function subcategoryIdByName(name) {
            const subcategory = subcategories.find(
                (item) => item.name === name
            );

            assert(
                subcategory,
                `Subcategory "${name}" not found in SYSTEM_TEST_V1`
            );

            return toGraphId(subcategory._id);
        }

        function goalIdByName(name) {
            const goal = goals.find(
                (item) => item.name === name
            );

            assert(
                goal,
                `Goal "${name}" not found in SYSTEM_TEST_V1`
            );

            return toGraphId(goal._id);
        }

        function outcomeIdByName(name) {
            const outcome = outcomes.find(
                (item) => item.name === name
            );

            assert(
                outcome,
                `LearningOutcome "${name}" not found in SYSTEM_TEST_V1`
            );

            return toGraphId(outcome._id);
        }

        // ==================================================
        // 4. Expected interest evidence
        // ==================================================

        function expectedInterest(
            child,
            subcategoryName
        ) {
            const subcategoryId =
                subcategoryIdByName(subcategoryName);

            const interest =
                interestsByChildAndSubcategory.get(
                    `${toGraphId(child._id)}::${subcategoryId}`
                );

            assert(
                interest,
                `Missing Mongo child interest for ` +
                `${child.identity?.firstName} → ${subcategoryName}`
            );

            return {
                subcategoryId,
                name: subcategoryName,
                score:
                    interest.interestScore?.currentScore,
                confidence:
                    interest.confidence?.currentScore,
                evidenceCount:
                    interest.confidence?.evidenceCount,
                lastUpdated:
                    interest.metadata?.updatedAt
                        ? interest.metadata.updatedAt.toISOString()
                        : null
            };
        }

        // ==================================================
        // 5. Expected goal evidence
        // ==================================================

        function expectedGoal(
            child,
            goalName
        ) {
            const goalId = goalIdByName(goalName);

            const parentGoal =
                (child.parentGoals ?? []).find(
                    (item) =>
                        toGraphId(item.goalId) === goalId
                );

            assert(
                parentGoal,
                `${child.identity?.firstName} does not have goal "${goalName}"`
            );

            const goal = goalsById.get(goalId);

            assert(
                goal,
                `Goal "${goalName}" not found`
            );

            assert(
                Array.isArray(goal.relatedOutcomes),
                `Goal "${goalName}" has invalid relatedOutcomes`
            );

            const expectedGoals = [];

            for (const relatedOutcome of goal.relatedOutcomes) {
                const outcome = outcomesById.get(
                    toGraphId(relatedOutcome.outcomeId)
                );

                assert(
                    outcome,
                    `Outcome for goal "${goalName}" not found`
                );

                const matchingActivities = [];

                for (const activity of activities) {
                    const learningOutcome =
                        (activity.learningOutcomes ?? []).find(
                            (item) =>
                                toGraphId(item.outcomeId) ===
                                toGraphId(relatedOutcome.outcomeId)
                        );

                    if (learningOutcome) {
                        matchingActivities.push({
                            activity,
                            learningOutcome
                        });
                    }
                }

                expectedGoals.push({
                    goalId,
                    name: goalName,
                    priority: parentGoal.priority,
                    status: parentGoal.status,
                    outcomeId: toGraphId(outcome._id),
                    outcome: outcome.name,
                    goalOutcomeWeight:
                        relatedOutcome.weight,
                    matchingActivities
                });
            }

            return expectedGoals;
        }

        // ==================================================
        // 6. Sara
        // ==================================================

        const sara = childrenByName.get("Sara");

        assert(sara, "Sara not found");

        console.log("\n========================================");
        console.log("PHASE D1 — SARA");
        console.log("========================================");

        const saraCandidates =
            await traversalService.findCandidateActivities(
                sara._id
            );

        console.log(
            `Sara candidates: ${saraCandidates.length}`
        );

        assertEqual(
            "Sara candidate count",
            saraCandidates.length,
            5
        );

        assertUniqueActivityIds(
            "Sara",
            saraCandidates
        );

        assertNoRecommendationFields(
            "Sara",
            saraCandidates
        );

        const saraRobotics =
            expectedInterest(sara, "Robotics");

        const saraPainting =
            expectedInterest(sara, "Painting");

        const saraProblemSolving =
            expectedGoal(
                sara,
                "Improve Problem Solving"
            );

        const saraTeamwork =
            expectedGoal(
                sara,
                "Build Teamwork"
            );

        verifyCandidate(
            "Sara",
            saraCandidates,
            "Robotics Lab",
            {
                interest: saraRobotics,
                goals: [
                    {
                        name: saraProblemSolving[0].name,
                        goalId: saraProblemSolving[0].goalId,
                        priority: saraProblemSolving[0].priority,
                        status: saraProblemSolving[0].status,
                        outcomeId: saraProblemSolving[0].outcomeId,
                        outcome: saraProblemSolving[0].outcome,
                        goalOutcomeWeight:
                            saraProblemSolving[0].goalOutcomeWeight,
                        activityOutcomeWeight: 0.90
                    },
                    {
                        name: saraTeamwork[0].name,
                        goalId: saraTeamwork[0].goalId,
                        priority: saraTeamwork[0].priority,
                        status: saraTeamwork[0].status,
                        outcomeId: saraTeamwork[0].outcomeId,
                        outcome: saraTeamwork[0].outcome,
                        goalOutcomeWeight:
                            saraTeamwork[0].goalOutcomeWeight,
                        activityOutcomeWeight: 0.50
                    }
                ],
                summary: [
                    "Matched child interest: Robotics",
                    "Supports parent goal: Improve Problem Solving",
                    "Supports parent goal: Build Teamwork"
                ]
            }
        );

        verifyCandidate(
            "Sara",
            saraCandidates,
            "Painting Studio",
            {
                interest: saraPainting,
                goals: [],
                summary: [
                    "Matched child interest: Painting"
                ]
            }
        );

        verifyCandidate(
            "Sara",
            saraCandidates,
            "Football Team Camp",
            {
                goals: [
                    {
                        name: saraTeamwork[0].name,
                        goalId: saraTeamwork[0].goalId,
                        priority: saraTeamwork[0].priority,
                        status: saraTeamwork[0].status,
                        outcomeId: saraTeamwork[0].outcomeId,
                        outcome: saraTeamwork[0].outcome,
                        goalOutcomeWeight:
                            saraTeamwork[0].goalOutcomeWeight,
                        activityOutcomeWeight: 0.95
                    }
                ],
                summary: [
                    "Supports parent goal: Build Teamwork"
                ]
            }
        );

        verifyCandidate(
            "Sara",
            saraCandidates,
            "Strategy Escape Challenge",
            {
                goals: [
                    {
                        name: saraProblemSolving[0].name,
                        goalId: saraProblemSolving[0].goalId,
                        priority: saraProblemSolving[0].priority,
                        status: saraProblemSolving[0].status,
                        outcomeId: saraProblemSolving[0].outcomeId,
                        outcome: saraProblemSolving[0].outcome,
                        goalOutcomeWeight:
                            saraProblemSolving[0].goalOutcomeWeight,
                        activityOutcomeWeight: 0.85
                    },
                    {
                        name: saraTeamwork[0].name,
                        goalId: saraTeamwork[0].goalId,
                        priority: saraTeamwork[0].priority,
                        status: saraTeamwork[0].status,
                        outcomeId: saraTeamwork[0].outcomeId,
                        outcome: saraTeamwork[0].outcome,
                        goalOutcomeWeight:
                            saraTeamwork[0].goalOutcomeWeight,
                        activityOutcomeWeight: 0.70
                    }
                ],
                summary: [
                    "Supports parent goal: Improve Problem Solving",
                    "Supports parent goal: Build Teamwork"
                ]
            }
        );

        verifyCandidate(
            "Sara",
            saraCandidates,
            "Creative Robotics",
            {
                interest: saraRobotics,
                goals: [
                    {
                        name: saraProblemSolving[0].name,
                        goalId: saraProblemSolving[0].goalId,
                        priority: saraProblemSolving[0].priority,
                        status: saraProblemSolving[0].status,
                        outcomeId: saraProblemSolving[0].outcomeId,
                        outcome: saraProblemSolving[0].outcome,
                        goalOutcomeWeight:
                            saraProblemSolving[0].goalOutcomeWeight,
                        activityOutcomeWeight: 0.80
                    }
                ],
                summary: [
                    "Matched child interest: Robotics",
                    "Supports parent goal: Improve Problem Solving"
                ]
            }
        );

        console.log("✅ Sara D4 validation PASSED");

        // ==================================================
        // 7. Omar
        // ==================================================

        const omar = childrenByName.get("Omar");

        assert(omar, "Omar not found");

        console.log("\n========================================");
        console.log("PHASE D2 — OMAR");
        console.log("========================================");

        const omarCandidates =
            await traversalService.findCandidateActivities(
                omar._id
            );

        console.log(
            `Omar candidates: ${omarCandidates.length}`
        );

        assertEqual(
            "Omar candidate count",
            omarCandidates.length,
            3
        );

        assertUniqueActivityIds(
            "Omar",
            omarCandidates
        );

        assertNoRecommendationFields(
            "Omar",
            omarCandidates
        );

        const omarFootball =
            expectedInterest(omar, "Football");

        const omarTeamwork =
            expectedGoal(
                omar,
                "Build Teamwork"
            );

        verifyCandidate(
            "Omar",
            omarCandidates,
            "Robotics Lab",
            {
                goals: [
                    {
                        name: omarTeamwork[0].name,
                        goalId: omarTeamwork[0].goalId,
                        priority: omarTeamwork[0].priority,
                        status: omarTeamwork[0].status,
                        outcomeId: omarTeamwork[0].outcomeId,
                        outcome: omarTeamwork[0].outcome,
                        goalOutcomeWeight:
                            omarTeamwork[0].goalOutcomeWeight,
                        activityOutcomeWeight: 0.50
                    }
                ],
                summary: [
                    "Supports parent goal: Build Teamwork"
                ]
            }
        );

        verifyCandidate(
            "Omar",
            omarCandidates,
            "Football Team Camp",
            {
                interest: omarFootball,
                goals: [
                    {
                        name: omarTeamwork[0].name,
                        goalId: omarTeamwork[0].goalId,
                        priority: omarTeamwork[0].priority,
                        status: omarTeamwork[0].status,
                        outcomeId: omarTeamwork[0].outcomeId,
                        outcome: omarTeamwork[0].outcome,
                        goalOutcomeWeight:
                            omarTeamwork[0].goalOutcomeWeight,
                        activityOutcomeWeight: 0.95
                    }
                ],
                summary: [
                    "Matched child interest: Football",
                    "Supports parent goal: Build Teamwork"
                ]
            }
        );

        verifyCandidate(
            "Omar",
            omarCandidates,
            "Strategy Escape Challenge",
            {
                goals: [
                    {
                        name: omarTeamwork[0].name,
                        goalId: omarTeamwork[0].goalId,
                        priority: omarTeamwork[0].priority,
                        status: omarTeamwork[0].status,
                        outcomeId: omarTeamwork[0].outcomeId,
                        outcome: omarTeamwork[0].outcome,
                        goalOutcomeWeight:
                            omarTeamwork[0].goalOutcomeWeight,
                        activityOutcomeWeight: 0.70
                    }
                ],
                summary: [
                    "Supports parent goal: Build Teamwork"
                ]
            }
        );

        console.log("✅ Omar D4 validation PASSED");

        // ==================================================
        // 8. Lina
        // ==================================================

        const lina = childrenByName.get("Lina");

        assert(lina, "Lina not found");

        console.log("\n========================================");
        console.log("PHASE D3 — LINA");
        console.log("========================================");

        const linaCandidates =
            await traversalService.findCandidateActivities(
                lina._id
            );

        console.log(
            `Lina candidates: ${linaCandidates.length}`
        );

        assertEqual(
            "Lina candidate count",
            linaCandidates.length,
            2
        );

        assertUniqueActivityIds(
            "Lina",
            linaCandidates
        );

        assertNoRecommendationFields(
            "Lina",
            linaCandidates
        );

        const linaCreativity =
            expectedGoal(
                lina,
                "Grow Creativity"
            );

        verifyCandidate(
            "Lina",
            linaCandidates,
            "Painting Studio",
            {
                goals: [
                    {
                        name: linaCreativity[0].name,
                        goalId: linaCreativity[0].goalId,
                        priority: linaCreativity[0].priority,
                        status: linaCreativity[0].status,
                        outcomeId: linaCreativity[0].outcomeId,
                        outcome: linaCreativity[0].outcome,
                        goalOutcomeWeight:
                            linaCreativity[0].goalOutcomeWeight,
                        activityOutcomeWeight: 0.90
                    }
                ],
                summary: [
                    "Supports parent goal: Grow Creativity"
                ]
            }
        );

        verifyCandidate(
            "Lina",
            linaCandidates,
            "Creative Robotics",
            {
                goals: [
                    {
                        name: linaCreativity[0].name,
                        goalId: linaCreativity[0].goalId,
                        priority: linaCreativity[0].priority,
                        status: linaCreativity[0].status,
                        outcomeId: linaCreativity[0].outcomeId,
                        outcome: linaCreativity[0].outcome,
                        goalOutcomeWeight:
                            linaCreativity[0].goalOutcomeWeight,
                        activityOutcomeWeight: 0.60
                    }
                ],
                summary: [
                    "Supports parent goal: Grow Creativity"
                ]
            }
        );

        for (const candidate of linaCandidates) {
            assertEqual(
                `Lina ${candidate.activity.title} interest evidence`,
                candidate.evidence?.interests?.length ?? 0,
                0
            );
        }

        console.log(
            "✅ Lina D4 validation PASSED"
        );

        // ==================================================
        // SUCCESS
        // ==================================================

        const totalCandidates =
            saraCandidates.length +
            omarCandidates.length +
            linaCandidates.length;

        assertEqual(
            "Total D4 candidate results",
            totalCandidates,
            10
        );

        console.log("\n========================================");
        console.log("✅ PHASE D PASSED");
        console.log("========================================");
        console.log("Sara candidates:       5 / 5");
        console.log("Omar candidates:       3 / 3");
        console.log("Lina candidates:       2 / 2");
        console.log("Total candidate rows:  10");
        console.log("Duplicate activities: 0");
        console.log("Interest evidence:     VALID");
        console.log("Goal evidence:         VALID");
        console.log("No D5 fields:          VALID");
        console.log("Evidence merging:      VALID");
        console.log("Evidence summaries:    VALID");
        console.log("D4 candidate discovery: PASSED");
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
        console.error("\n❌ PHASE D FAILED");
        console.error(error);
        process.exit(1);
    });
