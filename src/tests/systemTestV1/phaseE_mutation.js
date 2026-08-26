require("dotenv").config();

const { ObjectId } = require("mongodb");
const { connectMongoDB, getDatabase } = require("../../config/mongodb");
const driver = require("../../config/neo4j");
const graphBuilderService = require("../../services/graphBuilderService");
const traversalService = require("../../traversal/traversalService");
const { toGraphId } = require("../../utils/idUtils");

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

function asNumber(value) {
    if (
        value !== null &&
        value !== undefined &&
        typeof value.toNumber === "function"
    ) {
        return value.toNumber();
    }

    return value;
}

function graphId(document) {
    return toGraphId(document._id);
}

function metadataNow(now) {
    return {
        version: 1,
        createdBy: "System",
        testDataset: DATASET,
        createdAt: now,
        updatedAt: now,
        lastSyncedToGraph: null
    };
}

function candidateTitles(candidates) {
    return candidates
        .map((candidate) => candidate.activity.title)
        .sort();
}

function assertExactTitles(label, candidates, expectedTitles) {
    assertEqual(
        `${label} title count`,
        candidates.length,
        expectedTitles.length
    );

    const actual = candidateTitles(candidates);
    const expected = [...expectedTitles].sort();

    for (let index = 0; index < expected.length; index += 1) {
        assertEqual(
            `${label} title ${index + 1}`,
            actual[index],
            expected[index]
        );
    }
}

function assertUniqueActivityIds(label, candidates) {
    const ids = candidates.map(
        (candidate) => candidate.activity.activityId
    );

    assertEqual(
        `${label} unique activity IDs`,
        new Set(ids).size,
        ids.length
    );
}

function getCandidate(candidates, title) {
    return candidates.find(
        (candidate) => candidate.activity.title === title
    );
}

function requireCandidate(candidates, title, label) {
    const candidate = getCandidate(candidates, title);

    assert(
        candidate,
        `${label}: expected candidate "${title}" was not found`
    );

    return candidate;
}

function findInterest(candidate, name) {
    return (candidate.evidence?.interests ?? []).find(
        (interest) => interest.name === name
    );
}

function requireInterest(candidate, name) {
    const interest = findInterest(candidate, name);

    assert(
        interest,
        `${candidate.activity.title}: missing interest "${name}"`
    );

    return interest;
}

function findGoal(candidate, name) {
    return (candidate.evidence?.goals ?? []).find(
        (goal) => goal.name === name
    );
}

function requireGoal(candidate, name) {
    const goal = findGoal(candidate, name);

    assert(
        goal,
        `${candidate.activity.title}: missing goal "${name}"`
    );

    return goal;
}

function assertNoGoal(candidate, name) {
    assert(
        !findGoal(candidate, name),
        `${candidate.activity.title}: unexpected goal "${name}"`
    );
}

function assertNoInterest(candidate, name) {
    assert(
        !findInterest(candidate, name),
        `${candidate.activity.title}: unexpected interest "${name}"`
    );
}

async function processSyntheticJob(entityType, entityId, operation = "UPDATE") {
    await graphBuilderService.process({
        entityType,
        entityId,
        operation,
        status: "PENDING",
        testDataset: DATASET,
        createdAt: new Date()
    });
}

async function oneRelationship(session, label, query, params) {
    const result = await session.run(query, params);

    assert(
        result.records.length === 1,
        `${label}: expected one aggregate record`
    );

    return {
        count: asNumber(result.records[0].get("count")),
        properties: result.records[0].get("properties")
    };
}

async function assertRelationshipCount(
    session,
    label,
    query,
    params,
    expectedCount
) {
    const relationship = await oneRelationship(
        session,
        label,
        query,
        params
    );

    assertEqual(`${label} count`, relationship.count, expectedCount);

    return relationship;
}

async function assertRelationshipProperties(
    session,
    label,
    query,
    params,
    expectedProperties
) {
    const relationship = await assertRelationshipCount(
        session,
        label,
        query,
        params,
        1
    );

    for (const [property, expected] of Object.entries(expectedProperties)) {
        const actual = relationship.properties?.[property];

        if (typeof expected === "number") {
            assertClose(`${label}.${property}`, actual, expected);
        } else {
            assertEqual(`${label}.${property}`, actual, expected);
        }
    }
}

function likesQuery() {
    return `
        MATCH (c:Child {childId: $childId})
              -[r:LIKES]->
              (s:Subcategory {subcategoryId: $subcategoryId})
        RETURN count(r) AS count,
               head(collect(properties(r))) AS properties
    `;
}

function hasGoalQuery() {
    return `
        MATCH (c:Child {childId: $childId})
              -[r:HAS_GOAL]->
              (g:Goal {goalId: $goalId})
        RETURN count(r) AS count,
               head(collect(properties(r))) AS properties
    `;
}

function supportsOutcomeQuery() {
    return `
        MATCH (a:Activity {activityId: $activityId})
              -[r:SUPPORTS_OUTCOME]->
              (o:LearningOutcome {outcomeId: $outcomeId})
        RETURN count(r) AS count,
               head(collect(properties(r))) AS properties
    `;
}

function classifiedAsQuery() {
    return `
        MATCH (a:Activity {activityId: $activityId})
              -[r:CLASSIFIED_AS]->
              (s:Subcategory {subcategoryId: $subcategoryId})
        RETURN count(r) AS count,
               head(collect(properties(r))) AS properties
    `;
}

async function deleteTemporaryLikes(session, omarId, strategyGamesId) {
    // TEST CLEANUP ONLY: GraphBuilderService does not implement
    // ChildInterest deletion/stale-LIKES synchronization.
    await session.run(
        `
        MATCH (c:Child {childId: $childId})
              -[r:LIKES]->
              (s:Subcategory {subcategoryId: $subcategoryId})
        DELETE r
        `,
        {
            childId: omarId,
            subcategoryId: strategyGamesId
        }
    );
}

async function loadRequiredDataset(db) {
    const [children, subcategories, goals, outcomes, activities] =
        await Promise.all([
            db.collection("children")
                .find({ "metadata.testDataset": DATASET })
                .toArray(),
            db.collection("subcategories")
                .find({ "metadata.testDataset": DATASET })
                .toArray(),
            db.collection("goal_library")
                .find({ "metadata.testDataset": DATASET })
                .toArray(),
            db.collection("learning_outcomes")
                .find({ "metadata.testDataset": DATASET })
                .toArray(),
            db.collection("activities")
                .find({ "metadata.testDataset": DATASET })
                .toArray()
        ]);

    function byName(items, name, getter) {
        const item = items.find((document) => getter(document) === name);

        assert(item, `${name} not found in SYSTEM_TEST_V1`);

        return item;
    }

    const sara = byName(children, "Sara", (child) =>
        child.identity?.firstName
    );
    const omar = byName(children, "Omar", (child) =>
        child.identity?.firstName
    );
    const lina = byName(children, "Lina", (child) =>
        child.identity?.firstName
    );

    const robotics = byName(subcategories, "Robotics", (item) => item.name);
    const painting = byName(subcategories, "Painting", (item) => item.name);
    const football = byName(subcategories, "Football", (item) => item.name);
    const strategyGames = byName(
        subcategories,
        "Strategy Games",
        (item) => item.name
    );

    const problemSolvingGoal = byName(
        goals,
        "Improve Problem Solving",
        (goal) => goal.name
    );
    const teamworkGoal = byName(
        goals,
        "Build Teamwork",
        (goal) => goal.name
    );
    const creativityGoal = byName(
        goals,
        "Grow Creativity",
        (goal) => goal.name
    );

    const problemSolvingOutcome = byName(
        outcomes,
        "Problem Solving",
        (outcome) => outcome.name
    );
    const teamworkOutcome = byName(outcomes, "Teamwork", (outcome) =>
        outcome.name
    );
    const creativityOutcome = byName(outcomes, "Creativity", (outcome) =>
        outcome.name
    );

    const roboticsLab = byName(
        activities,
        "Robotics Lab",
        (activity) => activity.basicInformation?.nameEn
    );
    const paintingStudio = byName(
        activities,
        "Painting Studio",
        (activity) => activity.basicInformation?.nameEn
    );
    const footballTeamCamp = byName(
        activities,
        "Football Team Camp",
        (activity) => activity.basicInformation?.nameEn
    );
    const strategyEscapeChallenge = byName(
        activities,
        "Strategy Escape Challenge",
        (activity) => activity.basicInformation?.nameEn
    );
    const creativeRobotics = byName(
        activities,
        "Creative Robotics",
        (activity) => activity.basicInformation?.nameEn
    );

    const childInterests = db.collection("child_interests");

    const saraRoboticsInterest = await childInterests.findOne({
        childId: sara._id,
        subcategoryId: robotics._id,
        "metadata.testDataset": DATASET
    });

    const saraPaintingInterest = await childInterests.findOne({
        childId: sara._id,
        subcategoryId: painting._id,
        "metadata.testDataset": DATASET
    });

    const omarFootballInterest = await childInterests.findOne({
        childId: omar._id,
        subcategoryId: football._id,
        "metadata.testDataset": DATASET
    });

    const omarStrategyInterest = await childInterests.findOne({
        childId: omar._id,
        subcategoryId: strategyGames._id,
        "metadata.testDataset": DATASET
    });

    assert(saraRoboticsInterest, "Sara Robotics interest missing");
    assert(saraPaintingInterest, "Sara Painting interest missing");
    assert(omarFootballInterest, "Omar Football interest missing");
    assert(
        !omarStrategyInterest,
        "Dirty baseline: Omar already has a SYSTEM_TEST_V1 " +
        "Strategy Games ChildInterest"
    );

    for (const parentGoal of sara.parentGoals ?? []) {
        assert(
            parentGoal.goalId instanceof ObjectId,
            "Dirty baseline: Sara parentGoals.goalId must be ObjectId " +
            "before Phase E mutates data"
        );
        assert(
            parentGoal.selectedAt instanceof Date,
            "Dirty baseline: Sara parentGoals.selectedAt must be Date " +
            "before Phase E mutates data"
        );
    }

    for (const learningOutcome of creativeRobotics.learningOutcomes ?? []) {
        assert(
            learningOutcome.outcomeId instanceof ObjectId,
            "Dirty baseline: Creative Robotics learningOutcomes.outcomeId " +
            "must be ObjectId before Phase E mutates data"
        );
    }

    assert(
        saraRoboticsInterest.childId instanceof ObjectId,
        "Dirty baseline: Sara Robotics interest childId must be ObjectId"
    );
    assert(
        saraRoboticsInterest.subcategoryId instanceof ObjectId,
        "Dirty baseline: Sara Robotics interest subcategoryId must be ObjectId"
    );
    assert(
        saraRoboticsInterest.metadata?.updatedAt instanceof Date,
        "Dirty baseline: Sara Robotics interest metadata.updatedAt " +
        "must be Date"
    );

    return {
        sara,
        omar,
        lina,
        robotics,
        painting,
        football,
        strategyGames,
        problemSolvingGoal,
        teamworkGoal,
        creativityGoal,
        problemSolvingOutcome,
        teamworkOutcome,
        creativityOutcome,
        roboticsLab,
        paintingStudio,
        footballTeamCamp,
        strategyEscapeChallenge,
        creativeRobotics,
        saraRoboticsInterest,
        saraPaintingInterest,
        omarFootballInterest
    };
}

function validateBaselineD4(context, candidatesByChild) {
    const saraCandidates = candidatesByChild.sara;
    const omarCandidates = candidatesByChild.omar;
    const linaCandidates = candidatesByChild.lina;

    assertEqual("Sara baseline candidates", saraCandidates.length, 5);
    assertEqual("Omar baseline candidates", omarCandidates.length, 3);
    assertEqual("Lina baseline candidates", linaCandidates.length, 2);

    const saraRoboticsLab = requireCandidate(
        saraCandidates,
        "Robotics Lab",
        "Sara baseline"
    );
    assertClose(
        "Sara Robotics Lab Robotics score",
        requireInterest(saraRoboticsLab, "Robotics").score,
        0.88
    );
    requireGoal(saraRoboticsLab, "Build Teamwork");

    const saraCreativeRobotics = requireCandidate(
        saraCandidates,
        "Creative Robotics",
        "Sara baseline"
    );
    const saraCreativeProblemSolving =
        requireGoal(saraCreativeRobotics, "Improve Problem Solving");
    assertClose(
        "Sara Creative Robotics Problem Solving activityOutcomeWeight",
        saraCreativeProblemSolving.activityOutcomeWeight,
        0.80
    );

    const omarStrategy = requireCandidate(
        omarCandidates,
        "Strategy Escape Challenge",
        "Omar baseline"
    );
    requireGoal(omarStrategy, "Build Teamwork");
    assertEqual(
        "Omar Strategy Escape Challenge baseline interests",
        omarStrategy.evidence?.interests?.length ?? 0,
        0
    );

    const linaCreativeRobotics = requireCandidate(
        linaCandidates,
        "Creative Robotics",
        "Lina baseline"
    );
    const linaCreativity =
        requireGoal(linaCreativeRobotics, "Grow Creativity");
    assertClose(
        "Lina Creative Robotics activityOutcomeWeight",
        linaCreativity.activityOutcomeWeight,
        0.60
    );

    assert(context, "Baseline context missing");
}

async function runD4ForAll(context) {
    return {
        sara: await traversalService.findCandidateActivities(
            context.sara._id
        ),
        omar: await traversalService.findCandidateActivities(
            context.omar._id
        ),
        lina: await traversalService.findCandidateActivities(
            context.lina._id
        )
    };
}

async function restoreBaseline(
    db,
    session,
    originals,
    insertedOmarStrategyInterestId
) {
    if (!originals) {
        return;
    }

    console.log("\n========================================");
    console.log("RESTORING SYSTEM_TEST_V1 DATASET");
    console.log("========================================");

    await db.collection("child_interests").updateOne(
        { _id: originals.saraRoboticsInterest._id },
        {
            $set: {
                interestScore: originals.saraRoboticsInterest.interestScore,
                confidence: originals.saraRoboticsInterest.confidence,
                metadata: originals.saraRoboticsInterest.metadata
            }
        }
    );

    await db.collection("children").updateOne(
        { _id: originals.sara._id },
        {
            $set: {
                parentGoals: originals.sara.parentGoals,
                "metadata.updatedAt": originals.sara.metadata.updatedAt
            }
        }
    );

    await db.collection("activities").updateOne(
        { _id: originals.creativeRobotics._id },
        {
            $set: {
                learningOutcomes:
                    originals.creativeRobotics.learningOutcomes,
                "metadata.updatedAt":
                    originals.creativeRobotics.metadata.updatedAt
            }
        }
    );

    if (insertedOmarStrategyInterestId) {
        await db.collection("child_interests").deleteOne({
            _id: insertedOmarStrategyInterestId
        });
    }

    await processSyntheticJob(
        "ChildInterest",
        originals.saraRoboticsInterest._id
    );
    await processSyntheticJob("Child", originals.sara._id);
    await processSyntheticJob(
        "Activity",
        originals.creativeRobotics._id
    );

    await deleteTemporaryLikes(
        session,
        graphId(originals.omar),
        graphId(originals.strategyGames)
    );

    await assertRelationshipCount(
        session,
        "Omar Strategy Games cleanup",
        likesQuery(),
        {
            childId: graphId(originals.omar),
            subcategoryId: graphId(originals.strategyGames)
        },
        0
    );

    console.log("✅ Restoration operations completed");
}

async function verifyMongoRestoration(db, originals) {
    const restoredSara = await db.collection("children").findOne({
        _id: originals.sara._id
    });
    const restoredCreativeRobotics =
        await db.collection("activities").findOne({
            _id: originals.creativeRobotics._id
        });
    const restoredSaraRoboticsInterest =
        await db.collection("child_interests").findOne({
            _id: originals.saraRoboticsInterest._id
        });

    assertEqual(
        "Restored Sara goal count",
        restoredSara.parentGoals.length,
        originals.sara.parentGoals.length
    );

    for (let index = 0; index < restoredSara.parentGoals.length; index += 1) {
        const actual = restoredSara.parentGoals[index];
        const expected = originals.sara.parentGoals[index];

        assert(
            actual.goalId instanceof ObjectId,
            "Restored Sara parentGoals goalId must be ObjectId"
        );
        assert(
            actual.selectedAt instanceof Date,
            "Restored Sara parentGoals selectedAt must be Date"
        );
        assertEqual(
            `Restored Sara goal ${index} id`,
            toGraphId(actual.goalId),
            toGraphId(expected.goalId)
        );
        assertEqual(
            `Restored Sara goal ${index} priority`,
            actual.priority,
            expected.priority
        );
        assertEqual(
            `Restored Sara goal ${index} status`,
            actual.status,
            expected.status
        );
    }

    assertEqual(
        "Restored Creative Robotics outcome count",
        restoredCreativeRobotics.learningOutcomes.length,
        originals.creativeRobotics.learningOutcomes.length
    );

    for (const outcome of restoredCreativeRobotics.learningOutcomes) {
        assert(
            outcome.outcomeId instanceof ObjectId,
            "Restored Creative Robotics outcomeId must be ObjectId"
        );
    }

    const problemSolving = restoredCreativeRobotics.learningOutcomes.find(
        (outcome) =>
            toGraphId(outcome.outcomeId) ===
            graphId(originals.problemSolvingOutcome)
    );
    const creativity = restoredCreativeRobotics.learningOutcomes.find(
        (outcome) =>
            toGraphId(outcome.outcomeId) ===
            graphId(originals.creativityOutcome)
    );

    assert(problemSolving, "Restored Problem Solving outcome missing");
    assert(creativity, "Restored Creativity outcome missing");
    assertClose("Restored Problem Solving weight", problemSolving.weight, 0.80);
    assertClose("Restored Creativity weight", creativity.weight, 0.60);

    assert(
        restoredSaraRoboticsInterest.childId instanceof ObjectId,
        "Restored Sara Robotics childId must be ObjectId"
    );
    assert(
        restoredSaraRoboticsInterest.subcategoryId instanceof ObjectId,
        "Restored Sara Robotics subcategoryId must be ObjectId"
    );
    assertClose(
        "Restored Sara Robotics score",
        restoredSaraRoboticsInterest.interestScore.currentScore,
        0.88
    );
    assert(
        restoredSaraRoboticsInterest.metadata.updatedAt instanceof Date,
        "Restored Sara Robotics metadata.updatedAt must be Date"
    );
    assertEqual(
        "Restored Sara Robotics metadata.updatedAt",
        restoredSaraRoboticsInterest.metadata.updatedAt.getTime(),
        originals.saraRoboticsInterest.metadata.updatedAt.getTime()
    );
}

async function verifyNeo4jRestoration(session, originals) {
    await assertRelationshipProperties(
        session,
        "Sara Improve Problem Solving restored",
        hasGoalQuery(),
        {
            childId: graphId(originals.sara),
            goalId: graphId(originals.problemSolvingGoal)
        },
        {
            priority: 1,
            status: "Active"
        }
    );

    await assertRelationshipProperties(
        session,
        "Sara Build Teamwork restored",
        hasGoalQuery(),
        {
            childId: graphId(originals.sara),
            goalId: graphId(originals.teamworkGoal)
        },
        {
            priority: 2,
            status: "Active"
        }
    );

    await assertRelationshipProperties(
        session,
        "Sara Robotics LIKES restored",
        likesQuery(),
        {
            childId: graphId(originals.sara),
            subcategoryId: graphId(originals.robotics)
        },
        {
            score: 0.88,
            confidence: 0.82,
            evidenceCount: 12,
            lastUpdated:
                originals.saraRoboticsInterest.metadata.updatedAt
                    .toISOString()
        }
    );

    await assertRelationshipProperties(
        session,
        "Creative Robotics Problem Solving restored",
        supportsOutcomeQuery(),
        {
            activityId: graphId(originals.creativeRobotics),
            outcomeId: graphId(originals.problemSolvingOutcome)
        },
        { weight: 0.80 }
    );

    await assertRelationshipProperties(
        session,
        "Creative Robotics Creativity restored",
        supportsOutcomeQuery(),
        {
            activityId: graphId(originals.creativeRobotics),
            outcomeId: graphId(originals.creativityOutcome)
        },
        { weight: 0.60 }
    );

    await assertRelationshipCount(
        session,
        "Omar Strategy Games restored",
        likesQuery(),
        {
            childId: graphId(originals.omar),
            subcategoryId: graphId(originals.strategyGames)
        },
        0
    );
}

function verifyFinalD4Baseline(context, candidatesByChild) {
    validateBaselineD4(context, candidatesByChild);

    const saraRoboticsLab = requireCandidate(
        candidatesByChild.sara,
        "Robotics Lab",
        "Sara restored"
    );
    assertClose(
        "Sara restored Robotics Lab interest",
        requireInterest(saraRoboticsLab, "Robotics").score,
        0.88
    );
    requireGoal(saraRoboticsLab, "Improve Problem Solving");
    requireGoal(saraRoboticsLab, "Build Teamwork");

    requireCandidate(
        candidatesByChild.sara,
        "Football Team Camp",
        "Sara restored"
    );

    const saraCreativeRobotics = requireCandidate(
        candidatesByChild.sara,
        "Creative Robotics",
        "Sara restored"
    );
    requireInterest(saraCreativeRobotics, "Robotics");
    const saraProblemSolving =
        requireGoal(saraCreativeRobotics, "Improve Problem Solving");
    assertClose(
        "Sara restored Creative Robotics activityOutcomeWeight",
        saraProblemSolving.activityOutcomeWeight,
        0.80
    );

    const omarStrategy = requireCandidate(
        candidatesByChild.omar,
        "Strategy Escape Challenge",
        "Omar restored"
    );
    requireGoal(omarStrategy, "Build Teamwork");
    assertEqual(
        "Omar restored Strategy interests",
        omarStrategy.evidence?.interests?.length ?? 0,
        0
    );

    const linaCreativeRobotics = requireCandidate(
        candidatesByChild.lina,
        "Creative Robotics",
        "Lina restored"
    );
    const linaCreativity =
        requireGoal(linaCreativeRobotics, "Grow Creativity");
    assertClose(
        "Lina restored Creative Robotics activityOutcomeWeight",
        linaCreativity.activityOutcomeWeight,
        0.60
    );
}

async function main() {
    await connectMongoDB();

    const db = getDatabase();
    const session = driver.session();

    let originals = null;
    let insertedOmarStrategyInterestId = null;
    let restoredD4 = null;
    let testError = null;
    let restoreError = null;

    try {
        console.log("🚀 Starting Step 9 — Phase E");
        console.log("🔄 Testing canonical mutation + resynchronization");

        originals = await loadRequiredDataset(db);

        console.log("\n========================================");
        console.log("PHASE E0 — BASELINE D4 CHECK");
        console.log("========================================");

        const baselineD4 = await runD4ForAll(originals);
        validateBaselineD4(originals, baselineD4);
        console.log("✅ Baseline D4 validation PASSED");

        const saraId = graphId(originals.sara);
        const omarId = graphId(originals.omar);
        const roboticsId = graphId(originals.robotics);
        const strategyGamesId = graphId(originals.strategyGames);
        const problemSolvingGoalId = graphId(originals.problemSolvingGoal);
        const teamworkGoalId = graphId(originals.teamworkGoal);
        const problemSolvingOutcomeId = graphId(
            originals.problemSolvingOutcome
        );
        const creativityOutcomeId = graphId(originals.creativityOutcome);
        const creativeRoboticsId = graphId(originals.creativeRobotics);

        // ==================================================
        // E1 — Sara Robotics interest update
        // ==================================================

        console.log("\n========================================");
        console.log("PHASE E1 — INTEREST SCORE UPDATE");
        console.log("========================================");

        assertClose(
            "Sara Robotics original interest score",
            originals.saraRoboticsInterest.interestScore.currentScore,
            0.88
        );

        const e1UpdatedAt = new Date();

        await db.collection("child_interests").updateOne(
            { _id: originals.saraRoboticsInterest._id },
            {
                $set: {
                    "interestScore.currentScore": 0.94,
                    "metadata.updatedAt": e1UpdatedAt
                }
            }
        );

        await processSyntheticJob(
            "ChildInterest",
            originals.saraRoboticsInterest._id
        );

        await assertRelationshipProperties(
            session,
            "Sara Robotics LIKES updated",
            likesQuery(),
            {
                childId: saraId,
                subcategoryId: roboticsId
            },
            {
                score: 0.94,
                confidence: 0.82,
                evidenceCount: 12,
                lastUpdated: e1UpdatedAt.toISOString()
            }
        );

        const saraAfterE1 =
            await traversalService.findCandidateActivities(
                originals.sara._id
            );

        assertEqual("Sara E1 candidate count", saraAfterE1.length, 5);
        assertExactTitles(
            "Sara E1 candidate set",
            saraAfterE1,
            candidateTitles(baselineD4.sara)
        );

        for (const title of ["Robotics Lab", "Creative Robotics"]) {
            const candidate = requireCandidate(
                saraAfterE1,
                title,
                "Sara E1"
            );
            assertClose(
                `Sara E1 ${title} Robotics score`,
                requireInterest(candidate, "Robotics").score,
                0.94
            );
        }

        console.log("✅ E1 Interest update propagated to Neo4j + D4");

        // ==================================================
        // E2 — Sara removes Build Teamwork
        // ==================================================

        console.log("\n========================================");
        console.log("PHASE E2 — SARA GOAL REMOVAL");
        console.log("========================================");

        const e2UpdatedAt = new Date();
        const remainingSaraGoals = (originals.sara.parentGoals ?? [])
            .filter((goal) =>
                toGraphId(goal.goalId) !== teamworkGoalId
            )
            .map((goal) => ({ ...goal }));

        assertEqual(
            "Sara E2 remaining goal count",
            remainingSaraGoals.length,
            1
        );
        assertEqual(
            "Sara E2 retained goal",
            toGraphId(remainingSaraGoals[0].goalId),
            problemSolvingGoalId
        );

        await db.collection("children").updateOne(
            { _id: originals.sara._id },
            {
                $set: {
                    parentGoals: remainingSaraGoals,
                    "metadata.updatedAt": e2UpdatedAt
                }
            }
        );

        await processSyntheticJob("Child", originals.sara._id);

        await assertRelationshipCount(
            session,
            "Sara Build Teamwork removed",
            hasGoalQuery(),
            {
                childId: saraId,
                goalId: teamworkGoalId
            },
            0
        );

        await assertRelationshipProperties(
            session,
            "Sara Improve Problem Solving retained",
            hasGoalQuery(),
            {
                childId: saraId,
                goalId: problemSolvingGoalId
            },
            {
                priority: 1,
                status: "Active"
            }
        );

        const saraAfterE2 =
            await traversalService.findCandidateActivities(
                originals.sara._id
            );

        assertEqual("Sara E2 candidate count", saraAfterE2.length, 4);
        assertExactTitles(
            "Sara E2 candidate set",
            saraAfterE2,
            [
                "Robotics Lab",
                "Painting Studio",
                "Strategy Escape Challenge",
                "Creative Robotics"
            ]
        );
        assert(
            !getCandidate(saraAfterE2, "Football Team Camp"),
            "Sara E2 Football Team Camp must disappear"
        );

        const e2RoboticsLab = requireCandidate(
            saraAfterE2,
            "Robotics Lab",
            "Sara E2"
        );
        requireInterest(e2RoboticsLab, "Robotics");
        requireGoal(e2RoboticsLab, "Improve Problem Solving");
        assertNoGoal(e2RoboticsLab, "Build Teamwork");

        const e2Painting = requireCandidate(
            saraAfterE2,
            "Painting Studio",
            "Sara E2"
        );
        requireInterest(e2Painting, "Painting");
        assertEqual(
            "Sara E2 Painting goal count",
            e2Painting.evidence?.goals?.length ?? 0,
            0
        );

        const e2Strategy = requireCandidate(
            saraAfterE2,
            "Strategy Escape Challenge",
            "Sara E2"
        );
        requireGoal(e2Strategy, "Improve Problem Solving");
        assertNoGoal(e2Strategy, "Build Teamwork");

        const e2Creative = requireCandidate(
            saraAfterE2,
            "Creative Robotics",
            "Sara E2"
        );
        requireInterest(e2Creative, "Robotics");
        requireGoal(e2Creative, "Improve Problem Solving");

        console.log("✅ E2 Goal removal propagated to Neo4j + D4");

        // ==================================================
        // E3 — Creative Robotics outcome change
        // ==================================================

        console.log("\n========================================");
        console.log("PHASE E3 — ACTIVITY OUTCOME CHANGE");
        console.log("========================================");

        const originalCreativityOutcome =
            originals.creativeRobotics.learningOutcomes.find(
                (outcome) =>
                    toGraphId(outcome.outcomeId) === creativityOutcomeId
            );

        assert(
            originalCreativityOutcome,
            "Creative Robotics original Creativity outcome missing"
        );

        const e3UpdatedAt = new Date();
        const mutatedCreativeOutcomes = [
            {
                outcomeId: originals.creativityOutcome._id,
                weight: 0.90,
                evidenceGuidance:
                    originalCreativityOutcome.evidenceGuidance
            }
        ];

        await db.collection("activities").updateOne(
            { _id: originals.creativeRobotics._id },
            {
                $set: {
                    learningOutcomes: mutatedCreativeOutcomes,
                    "metadata.updatedAt": e3UpdatedAt
                }
            }
        );

        await processSyntheticJob("Activity", originals.creativeRobotics._id);

        await assertRelationshipCount(
            session,
            "Creative Robotics Problem Solving removed",
            supportsOutcomeQuery(),
            {
                activityId: creativeRoboticsId,
                outcomeId: problemSolvingOutcomeId
            },
            0
        );

        await assertRelationshipProperties(
            session,
            "Creative Robotics Creativity updated",
            supportsOutcomeQuery(),
            {
                activityId: creativeRoboticsId,
                outcomeId: creativityOutcomeId
            },
            { weight: 0.90 }
        );

        await assertRelationshipCount(
            session,
            "Creative Robotics classification retained",
            classifiedAsQuery(),
            {
                activityId: creativeRoboticsId,
                subcategoryId: roboticsId
            },
            1
        );

        const saraAfterE3 =
            await traversalService.findCandidateActivities(
                originals.sara._id
            );

        assertEqual("Sara E3 candidate count", saraAfterE3.length, 4);
        const e3SaraCreative = requireCandidate(
            saraAfterE3,
            "Creative Robotics",
            "Sara E3"
        );
        assertClose(
            "Sara E3 Creative Robotics Robotics score",
            requireInterest(e3SaraCreative, "Robotics").score,
            0.94
        );
        assertEqual(
            "Sara E3 Creative Robotics goal count",
            e3SaraCreative.evidence?.goals?.length ?? 0,
            0
        );

        const linaAfterE3 =
            await traversalService.findCandidateActivities(
                originals.lina._id
            );

        assertEqual("Lina E3 candidate count", linaAfterE3.length, 2);
        assertExactTitles(
            "Lina E3 candidates",
            linaAfterE3,
            ["Painting Studio", "Creative Robotics"]
        );
        const e3LinaCreative = requireCandidate(
            linaAfterE3,
            "Creative Robotics",
            "Lina E3"
        );
        assertClose(
            "Lina E3 Creative Robotics activityOutcomeWeight",
            requireGoal(e3LinaCreative, "Grow Creativity")
                .activityOutcomeWeight,
            0.90
        );

        console.log(
            "✅ E3 Activity outcome mutation propagated to Neo4j + D4"
        );

        // ==================================================
        // E4 — Add Omar Strategy Games interest
        // ==================================================

        console.log("\n========================================");
        console.log("PHASE E4 — OMAR STRATEGY GAMES INTEREST");
        console.log("========================================");

        const e4Now = new Date();
        const omarStrategyInterest = {
            _id: new ObjectId(),
            childId: originals.omar._id,
            subcategoryId: originals.strategyGames._id,

            interestScore: {
                currentScore: 0.72,
                previousScore: null,
                lastCalculatedAt: e4Now,
                lastDecayAt: e4Now
            },

            confidence: {
                currentScore: 0.68,
                evidenceCount: 4,
                lastCalculatedAt: e4Now
            },

            evidenceSummary: {
                interactionBreakdown: []
            },

            scoreHistory: [],

            metadata: metadataNow(e4Now)
        };

        await db.collection("child_interests").insertOne(
            omarStrategyInterest
        );
        insertedOmarStrategyInterestId = omarStrategyInterest._id;

        await processSyntheticJob(
            "ChildInterest",
            insertedOmarStrategyInterestId,
            "CREATE"
        );

        await assertRelationshipProperties(
            session,
            "Omar Strategy Games LIKES",
            likesQuery(),
            {
                childId: omarId,
                subcategoryId: strategyGamesId
            },
            {
                score: 0.72,
                confidence: 0.68,
                evidenceCount: 4,
                lastUpdated: e4Now.toISOString()
            }
        );

        const omarAfterE4 =
            await traversalService.findCandidateActivities(
                originals.omar._id
            );

        assertEqual("Omar E4 candidate count", omarAfterE4.length, 3);
        assertUniqueActivityIds("Omar E4", omarAfterE4);
        assertExactTitles(
            "Omar E4 candidates",
            omarAfterE4,
            [
                "Robotics Lab",
                "Football Team Camp",
                "Strategy Escape Challenge"
            ]
        );

        const e4Strategy = requireCandidate(
            omarAfterE4,
            "Strategy Escape Challenge",
            "Omar E4"
        );
        const strategyInterest =
            requireInterest(e4Strategy, "Strategy Games");
        assertClose("Omar Strategy Games score", strategyInterest.score, 0.72);
        assertClose(
            "Omar Strategy Games confidence",
            strategyInterest.confidence,
            0.68
        );
        assertEqual(
            "Omar Strategy Games evidenceCount",
            strategyInterest.evidenceCount,
            4
        );
        requireGoal(e4Strategy, "Build Teamwork");

        console.log("✅ E4 New interest merged into existing D4 candidate");

    } catch (error) {
        testError = error;
    } finally {
        try {
            await restoreBaseline(
                db,
                session,
                originals,
                insertedOmarStrategyInterestId
            );

            if (originals) {
                await verifyMongoRestoration(db, originals);
                await verifyNeo4jRestoration(session, originals);
                restoredD4 = await runD4ForAll(originals);
                verifyFinalD4Baseline(originals, restoredD4);
            }
        } catch (error) {
            restoreError = error;
        }

        await session.close();
        await driver.close();
    }

    if (restoreError) {
        console.error("\n❌ PHASE E RESTORATION FAILED");
        throw restoreError;
    }

    if (testError) {
        throw testError;
    }

    const totalBaselineCandidates =
        restoredD4.sara.length +
        restoredD4.omar.length +
        restoredD4.lina.length;

    assertEqual(
        "Total restored baseline candidates",
        totalBaselineCandidates,
        10
    );

    console.log("\n========================================");
    console.log("✅ PHASE E PASSED");
    console.log("========================================");
    console.log("E1 Interest score update:        PASSED");
    console.log("Mongo → LIKES update:            PASSED");
    console.log("D4 interest evidence update:     PASSED");
    console.log("");
    console.log("E2 Goal removal:                 PASSED");
    console.log("Stale HAS_GOAL removal:          PASSED");
    console.log("D4 candidate removal:            PASSED");
    console.log("");
    console.log("E3 Activity outcome change:      PASSED");
    console.log("Stale SUPPORTS_OUTCOME removal:  PASSED");
    console.log("Updated outcome weight:          PASSED");
    console.log("D4 evidence change:              PASSED");
    console.log("");
    console.log("E4 New Omar interest:            PASSED");
    console.log("New LIKES creation:              PASSED");
    console.log("D4 evidence merge:               PASSED");
    console.log("Duplicate candidate rows:        NONE");
    console.log("");
    console.log("----------------------------------------");
    console.log("Mongo BSON restoration:          PASSED");
    console.log("Neo4j restoration:               PASSED");
    console.log("D4 baseline restoration:         PASSED");
    console.log("");
    console.log("Sara baseline candidates:        5");
    console.log("Omar baseline candidates:        3");
    console.log("Lina baseline candidates:        2");
    console.log("Total baseline candidates:       10");
    console.log("");
    console.log("SYSTEM_TEST_V1 restored:          YES");
    console.log("========================================");
    console.log("STEP 9 SYSTEM TEST: COMPLETE");
    console.log("========================================");
}

main()
    .then(() => {
        process.exit(0);
    })
    .catch(error => {
        console.error("\n❌ PHASE E FAILED");
        console.error(error);
        process.exit(1);
    });
