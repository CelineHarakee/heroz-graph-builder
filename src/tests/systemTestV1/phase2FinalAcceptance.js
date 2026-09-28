// Final Phase 2 live acceptance test. Intentionally opt-in because it writes
// temporary fixture data to the configured MongoDB and Neo4j databases.
// node src/tests/systemTestV1/phase2FinalAcceptance.js --run-live-development
require("dotenv").config();

const assert = require("assert");
const { randomUUID } = require("crypto");
const { ObjectId } = require("mongodb");

const mongoConfig = require("../../config/mongodb");
const driver = require("../../config/neo4j");
const { processQueue } = require("../../workers/queueWorker");
const traversalService = require("../../traversal/traversalService");
const { processContinuousLearningSource } =
    require("../../learning/continuousLearningService");
const { createRecommendationEngine } =
    require("../../recommendation/recommendationEngineService");
const { buildRecommendationContext } =
    require("../../recommendation/recommendationContextService");
const { evaluateRecommendationEligibility } =
    require("../../recommendation/recommendationEligibilityService");
const { SCORING_FACTORS, SCORING_WEIGHTS } =
    require("../../recommendation/scoringContract");

const COLLECTIONS = [
    "parents",
    "children",
    "categories",
    "subcategories",
    "learning_outcomes",
    "goal_library",
    "vendors",
    "activities",
    "sessions",
    "child_interests",
    "interactions",
    "bookings",
    "recommendations",
    "ai_jobs",
    "graph_sync_queue"
];
const FACTORS = Object.values(SCORING_FACTORS);
const EXPECTED_WEIGHTS = {
    interest: 0.33,
    preference: 0.16,
    goal: 0.16,
    exploration: 0.13,
    behavior: 0.13,
    session: 0.09
};

function normalize(value) {
    if (value && typeof value.toNumber === "function") {
        return value.toNumber();
    }

    if (Array.isArray(value)) {
        return value.map(normalize);
    }

    if (value && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value).map(([key, item]) => [key, normalize(item)])
        );
    }

    return value;
}

function close(actual, expected, label, tolerance = 1e-10) {
    assert(
        typeof actual === "number" &&
            Math.abs(actual - expected) <= tolerance,
        `${label}: expected ${expected}, found ${actual}`
    );
}

function json(value) {
    return JSON.parse(JSON.stringify(value));
}

function oid() {
    return new ObjectId();
}

function id(value) {
    return String(value);
}

function metadata(marker, now) {
    return {
        version: 1,
        createdBy: "Phase2FinalAcceptance",
        createdAt: now,
        updatedAt: now,
        testDataset: marker
    };
}

function nextWeekday(base, weekday) {
    const targetByName = {
        Sunday: 0,
        Monday: 1,
        Tuesday: 2,
        Wednesday: 3,
        Thursday: 4,
        Friday: 5,
        Saturday: 6
    };
    const target = targetByName[weekday];
    assert(Number.isInteger(target), `Unsupported weekday ${weekday}`);

    const date = new Date(base.getTime());
    date.setUTCHours(9, 0, 0, 0);
    const offset = (target - date.getUTCDay() + 7) % 7 || 7;
    date.setUTCDate(date.getUTCDate() + offset);

    return date;
}

function sessionFor({ activity, vendor, weekday, status = "Available", open = true, remaining = 8, now }) {
    const startDateTime = nextWeekday(
        new Date(now.getTime() + (21 * 24 * 60 * 60 * 1000)),
        weekday
    );

    return {
        _id: oid(),
        activityId: activity._id,
        vendorId: vendor._id,
        schedule: {
            startDateTime,
            endDateTime: new Date(startDateTime.getTime() + (2 * 60 * 60 * 1000)),
            timezone: "UTC",
            bookingDeadline: new Date(startDateTime.getTime() - (2 * 24 * 60 * 60 * 1000))
        },
        availability: {
            status,
            registrationOpen: open,
            cancellationReason: null
        },
        capacity: {
            totalCapacity: 12,
            bookedCapacity: 4,
            remainingCapacity: remaining,
            minimumParticipants: 1
        }
    };
}

function activity({
    marker,
    title,
    vendor,
    category,
    subcategory,
    outcome,
    gender = ["Female"],
    minAge = 6,
    maxAge = 12,
    env = "Indoor",
    social = "SmallGroup",
    difficulty = "Beginner",
    styles = ["HandsOn"],
    commitment = "DropIn",
    accessibility = ["Wheelchair"],
    safety = ["CertifiedInstructor"],
    now
}) {
    return {
        _id: oid(),
        vendorId: vendor._id,
        basicInformation: {
            nameEn: `${marker} ${title}`,
            nameAr: `${marker} ${title}`,
            status: "Active"
        },
        classification: {
            categoryId: category._id,
            subcategoryId: subcategory._id
        },
        eligibility: {
            minimumAge: minAge,
            maximumAge: maxAge,
            allowedGenders: gender
        },
        experience: {
            environment: env,
            socialStyle: social,
            difficulty,
            experienceStyles: styles,
            commitmentType: commitment
        },
        activityConstraints: {
            accessibilityFeatures: accessibility,
            safetyRequirements: safety
        },
        learningOutcomes: [
            {
                outcomeId: outcome._id,
                evidenceGuidance: "Fixture activity supports the selected outcome."
            }
        ],
        metadata: metadata(marker, now)
    };
}

async function graph(query, params = {}) {
    const session = driver.session();

    try {
        const result = await session.run(query, params);

        return result.records.map((record) => normalize(record.toObject()));
    } finally {
        await session.close();
    }
}

async function graphSnapshot() {
    return {
        nodes: await graph(
            "MATCH (n) RETURN elementId(n) AS id, labels(n) AS labels, properties(n) AS properties ORDER BY id"
        ),
        relationships: await graph(
            "MATCH (a)-[r]->(b) RETURN elementId(r) AS id, elementId(a) AS source, elementId(b) AS target, type(r) AS type, properties(r) AS properties ORDER BY id"
        )
    };
}

async function graphSchema() {
    return {
        indexes: await graph(
            "SHOW INDEXES YIELD name, type, entityType, labelsOrTypes, properties, owningConstraint RETURN name, type, entityType, labelsOrTypes, properties, owningConstraint ORDER BY name"
        ),
        constraints: await graph(
            "SHOW CONSTRAINTS YIELD name, type, entityType, labelsOrTypes, properties RETURN name, type, entityType, labelsOrTypes, properties ORDER BY name"
        )
    };
}

async function collectionSnapshot(db) {
    const snapshot = {};

    for (const name of COLLECTIONS) {
        snapshot[name] = await db.collection(name).find({}).sort({ _id: 1 }).toArray();
    }

    return snapshot;
}

async function indexSnapshot(db) {
    const present = new Set(
        (await db.listCollections({}, { nameOnly: true }).toArray()).map(
            (collection) => collection.name
        )
    );
    const snapshot = {};

    for (const name of COLLECTIONS) {
        snapshot[name] = present.has(name)
            ? await db.collection(name).listIndexes().toArray()
            : [];
    }

    return snapshot;
}

function makeGuardedDb(db, owned) {
    return {
        collection(name) {
            assert(COLLECTIONS.includes(name), `Unexpected collection ${name}`);
            const collection = db.collection(name);

            return new Proxy(collection, {
                get(target, key) {
                    if (key === "insertOne") {
                        return async (doc, options) => {
                            assert(options?.session?.inTransaction());
                            assert(["ai_jobs", "graph_sync_queue"].includes(name));
                            owned[name].set(id(doc._id), doc._id);

                            return target.insertOne(doc, options);
                        };
                    }

                    if (key === "updateOne") {
                        return async (filter, update, options) => {
                            assert(options?.session?.inTransaction());
                            assert.strictEqual(name, "child_interests");
                            assert(owned.child_interests.has(id(filter._id)));

                            return target.updateOne(filter, update, options);
                        };
                    }

                    if (
                        [
                            "deleteOne",
                            "deleteMany",
                            "updateMany",
                            "bulkWrite",
                            "replaceOne",
                            "findOneAndUpdate",
                            "drop"
                        ].includes(key)
                    ) {
                        return () => {
                            throw new Error(`Unexpected production mutation: ${name}.${key}`);
                        };
                    }

                    const value = target[key];

                    return typeof value === "function" ? value.bind(target) : value;
                }
            });
        }
    };
}

async function main() {
    if (process.argv.length !== 3 || process.argv[2] !== "--run-live-development") {
        console.log(
            "Phase 2 final acceptance skipped: --run-live-development is required; no database access."
        );
        return;
    }

    const marker = `PHASE2_FINAL_ACCEPTANCE_${randomUUID()}`;
    const owned = Object.fromEntries(COLLECTIONS.map((name) => [name, new Map()]));
    const graphOwned = [];
    const report = {
        marker,
        stages: {},
        notes: [
            "Current production eligibility has gender, parent exclusions, parent hard requirements, session operational checks, and session age checks. There is no separate non-session activity age rule."
        ]
    };
    let db;
    let baseline;
    let baselineIndexes;
    let baselineGraph;
    let baselineSchema;
    let existingCollections;
    let failure;
    let wrote = false;
    let phase = "baseline";
    let fixtures;

    function remember(collection, objectId) {
        assert(objectId instanceof ObjectId);
        assert(
            !baseline[collection]?.some((doc) => id(doc._id) === id(objectId)),
            `Fixture ${collection} _id collides with baseline`
        );
        owned[collection].set(id(objectId), objectId);
    }

    async function insert(collection, doc) {
        remember(collection, doc._id);
        wrote = true;
        await db.collection(collection).insertOne(doc);
        return doc;
    }

    async function queue(entityType, entityId, operation = "CREATE") {
        return insert("graph_sync_queue", {
            _id: oid(),
            entityType,
            entityId,
            operation,
            status: "PENDING",
            createdAt: new Date()
        });
    }

    async function processJobs(jobIds, label) {
        assert(jobIds.length > 0, `${label}: no jobs supplied`);
        for (const jobId of jobIds) {
            assert(owned.graph_sync_queue.has(id(jobId)), `${label}: unowned job ${jobId}`);
        }

        const before = await db.collection("graph_sync_queue").find({}).sort({ _id: 1 }).toArray();
        await processQueue({ jobIds });
        const after = await db.collection("graph_sync_queue").find({}).sort({ _id: 1 }).toArray();
        assert.strictEqual(after.length, before.length, `${label}: queue length changed`);

        for (const beforeJob of before) {
            const afterJob = after.find((job) => id(job._id) === id(beforeJob._id));
            const selected = jobIds.some((jobId) => id(jobId) === id(beforeJob._id));

            if (!selected || beforeJob.status !== "PENDING") {
                assert.deepStrictEqual(afterJob, beforeJob, `${label}: unrelated queue job changed`);
                continue;
            }

            assert.strictEqual(afterJob.status, "PROCESSED", `${label}: ${afterJob.error}`);
            assert(afterJob.processedAt instanceof Date, `${label}: missing processedAt`);
        }
    }

    async function project(entityType, key, document) {
        const result = await queue(entityType, document._id);
        graphOwned.push({ label: entityType, key, id: id(document._id) });
        await processJobs([result._id], `project ${entityType}`);
    }

    async function projectAll() {
        await project("Parent", "parentId", fixtures.parent);
        await project("Subcategory", "subcategoryId", fixtures.subcategory);
        await project("Subcategory", "subcategoryId", fixtures.otherSubcategory);
        await project("LearningOutcome", "outcomeId", fixtures.outcome);
        await project("LearningOutcome", "outcomeId", fixtures.unrelatedOutcome);
        await project("Goal", "goalId", fixtures.goal);
        for (const item of fixtures.activities) {
            await project("Activity", "activityId", item);
        }
        await project("Child", "childId", fixtures.child);
        await project("ChildInterest", "childInterestId", fixtures.interest);
    }

    function buildFixtures() {
        const now = new Date();
        const parent = {
            _id: oid(),
            account: {
                firstName: marker,
                lastName: "Parent",
                status: "Active",
                preferredLanguage: "en"
            },
            recommendationPreferences: {
                preferredDays: ["Monday"],
                excludedActivityIds: [],
                excludedVendorIds: []
            },
            hardRequirements: {
                accessibilityRequirements: ["Wheelchair"],
                safetyRequirements: ["CertifiedInstructor"]
            },
            metadata: metadata(marker, now)
        };
        const category = {
            _id: oid(),
            name: `${marker} STEM`,
            isActive: true,
            metadata: metadata(marker, now)
        };
        const subcategory = {
            _id: oid(),
            name: `${marker} Robotics`,
            categoryId: category._id,
            isActive: true,
            metadata: metadata(marker, now)
        };
        const otherSubcategory = {
            _id: oid(),
            name: `${marker} Painting`,
            categoryId: category._id,
            isActive: true,
            metadata: metadata(marker, now)
        };
        const outcome = {
            _id: oid(),
            name: `${marker} Problem Solving`,
            outcomeType: "Cognitive",
            description: "Controlled Phase 2 outcome",
            isActive: true,
            metadata: metadata(marker, now)
        };
        const unrelatedOutcome = {
            _id: oid(),
            name: `${marker} Unrelated Outcome`,
            outcomeType: "Creative",
            description: "Should not be discovered",
            isActive: true,
            metadata: metadata(marker, now)
        };
        const goal = {
            _id: oid(),
            name: `${marker} Build Problem Solving`,
            description: "Controlled Phase 2 goal",
            isActive: true,
            relatedOutcomes: [{ outcomeId: outcome._id }],
            metadata: metadata(marker, now)
        };
        const vendor = {
            _id: oid(),
            name: `${marker} Vendor`,
            status: "Active",
            metadata: metadata(marker, now)
        };
        const child = {
            _id: oid(),
            parentId: parent._id,
            identity: {
                firstName: marker,
                dateOfBirth: new Date("2018-01-01T00:00:00.000Z"),
                gender: "Female",
                ageGroup: "Child"
            },
            status: "Active",
            preferences: {
                environment: { value: "Indoor", confidenceScore: 1, source: "Fixture" },
                socialStyle: { value: "SmallGroup", confidenceScore: 1, source: "Fixture" },
                difficulty: { value: "Beginner", confidenceScore: 1, source: "Fixture" },
                experienceStyle: { value: "HandsOn", confidenceScore: 1, source: "Fixture" },
                commitmentPreference: { value: "DropIn", confidenceScore: 1, source: "Fixture" }
            },
            parentGoals: [
                {
                    goalId: goal._id,
                    priority: "High",
                    status: "Active"
                }
            ],
            developmentProfile: [],
            metadata: metadata(marker, now)
        };
        const hero = activity({
            marker,
            title: "A Robotics Lab",
            vendor,
            category,
            subcategory,
            outcome,
            now
        });
        const runnerUp = activity({
            marker,
            title: "B Outdoor Robotics",
            vendor,
            category,
            subcategory,
            outcome,
            env: "Outdoor",
            social: "LargeGroup",
            difficulty: "Advanced",
            styles: ["Performance"],
            commitment: "MultiSession",
            now
        });
        const genderMismatch = activity({
            marker,
            title: "C Gender Mismatch",
            vendor,
            category,
            subcategory,
            outcome,
            gender: ["Male"],
            now
        });
        const ageMismatch = activity({
            marker,
            title: "D Age Mismatch",
            vendor,
            category,
            subcategory,
            outcome,
            minAge: 20,
            maxAge: 25,
            now
        });
        const unavailable = activity({
            marker,
            title: "E Cancelled Session",
            vendor,
            category,
            subcategory,
            outcome,
            now
        });
        const requirementMismatch = activity({
            marker,
            title: "F Requirement Mismatch",
            vendor,
            category,
            subcategory,
            outcome,
            accessibility: ["StairsOnly"],
            now
        });
        const unrelated = activity({
            marker,
            title: "Z Unrelated Painting",
            vendor,
            category,
            subcategory: otherSubcategory,
            outcome: unrelatedOutcome,
            now
        });
        const sessions = [
            sessionFor({ activity: hero, vendor, weekday: "Monday", now }),
            sessionFor({ activity: runnerUp, vendor, weekday: "Tuesday", now }),
            sessionFor({ activity: genderMismatch, vendor, weekday: "Monday", now }),
            sessionFor({ activity: ageMismatch, vendor, weekday: "Monday", now }),
            sessionFor({ activity: unavailable, vendor, weekday: "Monday", status: "Cancelled", now }),
            sessionFor({ activity: requirementMismatch, vendor, weekday: "Monday", now }),
            sessionFor({ activity: unrelated, vendor, weekday: "Monday", now })
        ].map((item) => ({
            ...item,
            metadata: metadata(marker, now)
        }));
        const interest = {
            _id: oid(),
            childId: child._id,
            subcategoryId: subcategory._id,
            interestScore: {
                previousScore: 0.6,
                currentScore: 0.6,
                lastCalculatedAt: now,
                lastDecayAt: now
            },
            confidence: {
                currentScore: 0.25,
                evidenceCount: 1,
                lastCalculatedAt: now
            },
            evidenceSummary: {
                interactionBreakdown: [{ interactionType: "Rate", count: 1 }]
            },
            scoreHistory: [
                {
                    eventId: `${marker}_seed`,
                    eventType: "Rate",
                    previousScore: 0.5,
                    newScore: 0.6,
                    interestDelta: 0.1,
                    previousConfidence: 0.2,
                    newConfidence: 0.25,
                    confidenceDelta: 0.05,
                    timestamp: now
                }
            ],
            metadata: metadata(marker, now)
        };
        const interactions = [
            {
                _id: oid(),
                actor: { childId: child._id, actorType: "Child" },
                targetEntity: { entityType: "Activity", entityId: hero._id },
                interactionDetails: { interactionType: "Rate", ratingValue: 4 },
                timestamp: new Date(now.getTime() - (2 * 60 * 60 * 1000)),
                metadata: metadata(marker, now)
            },
            {
                _id: oid(),
                actor: { childId: child._id, actorType: "Child" },
                targetEntity: { entityType: "Activity", entityId: runnerUp._id },
                interactionDetails: { interactionType: "View" },
                timestamp: new Date(now.getTime() - (3 * 60 * 60 * 1000)),
                metadata: metadata(marker, now)
            }
        ];
        const runnerUpHistory = {
            _id: oid(),
            parentId: parent._id,
            childId: child._id,
            recommendationContext: { requestedAt: new Date(now.getTime() - 86400000) },
            recommendedItems: [
                {
                    activityId: runnerUp._id,
                    eligibleSessionIds: [sessions[1]._id],
                    rank: 1,
                    score: 0.5,
                    factors: Object.fromEntries(
                        FACTORS.map((factor) => [factor, { available: false, score: null }])
                    ),
                    scoring: { availableWeight: 1, availableFactorCount: 1, contributions: [] },
                    evidence: { discovery: { interests: [], goals: [], summary: [] }, factors: Object.fromEntries(FACTORS.map((factor) => [factor, []])) }
                }
            ],
            algorithmVersion: 1,
            response: {
                wasDisplayed: true,
                displayedAt: new Date(now.getTime() - 86400000),
                clickedActivityIds: [],
                savedActivityIds: [],
                bookedSessionIds: [],
                dismissedActivityIds: [],
                lastResponseAt: new Date(now.getTime() - 86400000)
            },
            metadata: metadata(marker, now)
        };
        const bookingSentinel = {
            _id: oid(),
            bookingDetails: {
                childId: child._id,
                activityId: unrelated._id,
                sessionId: sessions[6]._id,
                status: "Cancelled",
                bookedAt: new Date(now.getTime() - 86400000)
            },
            attendance: {
                status: "NotAttended"
            },
            metadata: metadata(marker, now)
        };

        return {
            now,
            parent,
            category,
            subcategory,
            otherSubcategory,
            outcome,
            unrelatedOutcome,
            goal,
            vendor,
            child,
            activities: [
                hero,
                runnerUp,
                genderMismatch,
                ageMismatch,
                unavailable,
                requirementMismatch,
                unrelated
            ],
            namedActivities: {
                hero,
                runnerUp,
                genderMismatch,
                ageMismatch,
                unavailable,
                requirementMismatch,
                unrelated
            },
            sessions,
            interest,
            interactions,
            runnerUpHistory,
            bookingSentinel
        };
    }

    async function insertFixtures() {
        await insert("parents", fixtures.parent);
        await insert("categories", fixtures.category);
        await insert("subcategories", fixtures.subcategory);
        await insert("subcategories", fixtures.otherSubcategory);
        await insert("learning_outcomes", fixtures.outcome);
        await insert("learning_outcomes", fixtures.unrelatedOutcome);
        await insert("goal_library", fixtures.goal);
        await insert("vendors", fixtures.vendor);
        await insert("children", fixtures.child);
        for (const item of fixtures.activities) {
            await insert("activities", item);
        }
        for (const item of fixtures.sessions) {
            await insert("sessions", item);
        }
        await insert("child_interests", fixtures.interest);
        for (const item of fixtures.interactions) {
            await insert("interactions", item);
        }
        await insert("recommendations", fixtures.runnerUpHistory);
        await insert("bookings", fixtures.bookingSentinel);
    }

    async function stageA() {
        const child = await db.collection("children").findOne({ _id: fixtures.child._id });
        const parent = await db.collection("parents").findOne({ _id: fixtures.parent._id });
        const interest = await db.collection("child_interests").findOne({ _id: fixtures.interest._id });
        const goal = await db.collection("goal_library").findOne({ _id: fixtures.goal._id });
        const sessions = await db.collection("sessions").find({
            activityId: { $in: fixtures.activities.map((item) => item._id) }
        }).toArray();

        assert(parent);
        assert(child.parentId.equals(parent._id));
        assert(interest.childId.equals(child._id));
        assert(interest.subcategoryId.equals(fixtures.subcategory._id));
        assert(child.parentGoals[0].goalId.equals(goal._id));
        assert(goal.relatedOutcomes[0].outcomeId.equals(fixtures.outcome._id));
        assert.strictEqual(sessions.length, fixtures.sessions.length);
        for (const item of fixtures.activities) {
            assert(item.classification.subcategoryId instanceof ObjectId);
            assert(item.experience.environment);
            assert(item.learningOutcomes[0].outcomeId instanceof ObjectId);
        }

        report.stages.A = "PASS";
    }

    async function stageB() {
        const childId = id(fixtures.child._id);
        const parentId = id(fixtures.parent._id);
        const subcategoryId = id(fixtures.subcategory._id);
        const goalId = id(fixtures.goal._id);
        const outcomeId = id(fixtures.outcome._id);
        const heroId = id(fixtures.namedActivities.hero._id);
        const counts = await graph(
            `
            MATCH (p:Parent {parentId:$parentId})-[:HAS_CHILD]->(c:Child {childId:$childId})
            MATCH (c)-[likes:LIKES]->(s:Subcategory {subcategoryId:$subcategoryId})
            MATCH (c)-[hg:HAS_GOAL]->(g:Goal {goalId:$goalId})-[:RELATES_TO_OUTCOME]->(o:LearningOutcome {outcomeId:$outcomeId})
            MATCH (a:Activity {activityId:$heroId})-[:CLASSIFIED_AS]->(s)
            MATCH (a)-[:SUPPORTS_OUTCOME]->(o)
            RETURN count(DISTINCT p) AS parents,
                   count(DISTINCT c) AS children,
                   count(DISTINCT likes) AS likes,
                   properties(likes) AS likesProps,
                   count(DISTINCT hg) AS goals,
                   properties(hg) AS goalProps,
                   count(DISTINCT a) AS activities
            `,
            { parentId, childId, subcategoryId, goalId, outcomeId, heroId }
        );

        assert.strictEqual(counts.length, 1);
        assert.strictEqual(counts[0].parents, 1);
        assert.strictEqual(counts[0].children, 1);
        assert.strictEqual(counts[0].likes, 1);
        assert.strictEqual(counts[0].goals, 1);
        assert.strictEqual(counts[0].activities, 1);
        close(counts[0].likesProps.score, 0.6, "graph LIKES score");
        close(counts[0].likesProps.confidence, 0.25, "graph LIKES confidence");
        assert.strictEqual(counts[0].likesProps.evidenceCount, 1);
        assert.strictEqual(counts[0].goalProps.priority, "High");
        assert.strictEqual(counts[0].goalProps.status, "Active");

        const duplicateCheck = await graph(
            `
            MATCH (c:Child {childId:$childId})-[r:LIKES]->(s:Subcategory {subcategoryId:$subcategoryId})
            RETURN count(r) AS likes
            `,
            { childId, subcategoryId }
        );
        assert.strictEqual(duplicateCheck[0].likes, 1);

        report.stages.B = "PASS";
    }

    async function stageC() {
        const candidates = await traversalService.findCandidateActivities(fixtures.child._id);
        const ids = new Set(candidates.map((candidate) => candidate.activity.activityId));

        for (const key of [
            "hero",
            "runnerUp",
            "genderMismatch",
            "ageMismatch",
            "unavailable",
            "requirementMismatch"
        ]) {
            assert(ids.has(id(fixtures.namedActivities[key]._id)), `Missing D4 candidate ${key}`);
        }
        assert(!ids.has(id(fixtures.namedActivities.unrelated._id)));

        const hero = candidates.find(
            (candidate) => candidate.activity.activityId === id(fixtures.namedActivities.hero._id)
        );
        assert(hero.evidence.interests.length > 0);
        assert(hero.evidence.goals.length > 0);

        report.stages.C = "PASS";
    }

    async function stageD(context, eligibility) {
        assert(eligibility.requestEligibility.eligible);
        assert.strictEqual(eligibility.eligibleCandidates.length, 2);

        const byActivity = new Map(
            eligibility.candidateEvaluations.map((evaluation) => [
                id(evaluation.candidate.currentActivity._id),
                evaluation
            ])
        );
        const hasFailureCode = (evaluation, code) => {
            const topLevel = evaluation.eligibility.failedConstraints.some(
                (failureItem) => failureItem.code === code
            );
            const sessionLevel = evaluation.sessionEvaluations.some((sessionEvaluation) => (
                sessionEvaluation.eligibility.failedConstraints.some(
                    (failureItem) => failureItem.code === code
                ) ||
                sessionEvaluation.operationalEligibility.failedConstraints.some(
                    (failureItem) => failureItem.code === code
                ) ||
                sessionEvaluation.ageEligibility.failedConstraints.some(
                    (failureItem) => failureItem.code === code
                )
            ));

            return topLevel || sessionLevel;
        };
        const assertFailure = (activityDoc, code) => {
            const evaluation = byActivity.get(id(activityDoc._id));
            assert(evaluation, `Missing eligibility evaluation for ${activityDoc.basicInformation.nameEn}`);
            assert.strictEqual(evaluation.eligibility.eligible, false);
            assert(
                hasFailureCode(evaluation, code),
                `${activityDoc.basicInformation.nameEn} missing ${code}`
            );
        };

        assert(byActivity.get(id(fixtures.namedActivities.hero._id)).eligibility.eligible);
        assert(byActivity.get(id(fixtures.namedActivities.runnerUp._id)).eligibility.eligible);
        assertFailure(fixtures.namedActivities.genderMismatch, "GENDER_NOT_ELIGIBLE");
        assertFailure(fixtures.namedActivities.ageMismatch, "AGE_NOT_ELIGIBLE");
        assertFailure(fixtures.namedActivities.unavailable, "SESSION_UNAVAILABLE");
        assertFailure(fixtures.namedActivities.requirementMismatch, "REQUIREMENT_NOT_MET");
        assert(
            !context.candidates.some((candidate) =>
                id(candidate.currentActivity?._id) === id(fixtures.namedActivities.unrelated._id)
            )
        );

        report.stages.D = "PASS";
    }

    function expectedScore(factors) {
        const available = Object.entries(factors).filter(([, value]) => value !== null);
        const availableWeight = available.reduce(
            (total, [factor]) => total + SCORING_WEIGHTS[factor],
            0
        );
        const score = available.reduce(
            (total, [factor, value]) => total + ((SCORING_WEIGHTS[factor] / availableWeight) * value),
            0
        );

        return { score, availableWeight, availableFactorCount: available.length };
    }

    function assertRecommendation(item, expected, label) {
        assert.strictEqual(item.activityId, id(expected.activity._id));
        assert.strictEqual(item.rank, expected.rank);

        for (const factor of FACTORS) {
            assert(Object.hasOwn(item.factors, factor), `${label} missing ${factor}`);
            assert(!Object.hasOwn(item.factors, "vendor"));
            if (expected.factors[factor] === null) {
                assert.strictEqual(item.factors[factor].available, false, `${label} ${factor}`);
                assert.strictEqual(item.factors[factor].score, null, `${label} ${factor}`);
            } else {
                assert.strictEqual(item.factors[factor].available, true, `${label} ${factor}`);
                close(item.factors[factor].score, expected.factors[factor], `${label} ${factor}`);
            }
        }

        const expectedFinal = expectedScore(expected.factors);
        close(item.score, expectedFinal.score, `${label} final score`);
        close(item.scoring.availableWeight, expectedFinal.availableWeight, `${label} available weight`);
        assert.strictEqual(item.scoring.availableFactorCount, expectedFinal.availableFactorCount);
        assert.strictEqual(item.eligibleSessionIds.length, 1);
        assert(item.explanation.text.length > 0);
        assert(item.explanation.reasonTypes.length >= 1);
        assert(item.explanation.reasonTypes.length <= 3);
    }

    async function makeEngine() {
        const { persistRecommendationSnapshot } =
            require("../../recommendation/recommendationPersistenceService");
        const { attachRecommendationExplanations } =
            require("../../explanation/explanationOrchestrator");

        return createRecommendationEngine({
            languageProvider: null,
            persistRecommendationSnapshot: async (input) => {
                const result = await persistRecommendationSnapshot(input);
                const stored = await db.collection("recommendations")
                    .findOne({ _id: new ObjectId(result.recommendationId) });
                remember("recommendations", stored._id);
                return result;
            },
            attachRecommendationExplanations: async (input) => {
                const before = json(input.recommendationResults);
                const result = await attachRecommendationExplanations(input);
                assert.deepStrictEqual(input.recommendationResults, before);
                for (let index = 0; index < before.length; index += 1) {
                    const { explanation, ...d5Result } = result.recommendations[index];
                    assert.deepStrictEqual(d5Result, before[index]);
                    const reasonTypes = new Set(explanation.reasonTypes);
                    for (const reasonType of reasonTypes) {
                        assert(
                            before[index].factors[reasonType]?.available === true,
                            `Ungrounded explanation reason ${reasonType}`
                        );
                    }
                }
                return result;
            }
        });
    }

    async function stageEAndF(engine) {
        const response = await engine.generateRecommendations(fixtures.child._id, 2);
        assert.strictEqual(response.recommendations.length, 2);
        const heroExpected = {
            activity: fixtures.namedActivities.hero,
            rank: 1,
            factors: {
                interest: 0.6,
                preference: 1,
                goal: 1,
                exploration: 1,
                behavior: 0.75,
                session: 1
            }
        };
        const runnerExpected = {
            activity: fixtures.namedActivities.runnerUp,
            rank: 2,
            factors: {
                interest: 0.6,
                preference: 0,
                goal: 1,
                exploration: 0.5,
                behavior: 0.5,
                session: 0
            }
        };

        assertRecommendation(response.recommendations[0], heroExpected, "hero before");
        assertRecommendation(response.recommendations[1], runnerExpected, "runner before");
        assert(response.recommendations[0].score > response.recommendations[1].score);
        report.beforeRecommendation = response.recommendations.map((item) => ({
            activityId: item.activityId,
            rank: item.rank,
            score: item.score,
            factors: item.factors
        }));
        report.stages.E = "PASS";
        report.stages.F = "PASS";

        return response;
    }

    async function currentInterest() {
        return db.collection("child_interests").findOne({ _id: fixtures.interest._id });
    }

    async function likes() {
        return graph(
            `
            MATCH (c:Child {childId:$childId})-[r:LIKES]->(s:Subcategory {subcategoryId:$subcategoryId})
            RETURN properties(r) AS properties
            `,
            {
                childId: id(fixtures.child._id),
                subcategoryId: id(fixtures.subcategory._id)
            }
        );
    }

    async function stageGAndH(firstRecommendation) {
        const source = {
            _id: oid(),
            actor: { childId: fixtures.child._id, actorType: "Child" },
            targetEntity: {
                entityType: "Activity",
                entityId: fixtures.namedActivities.hero._id
            },
            interactionDetails: { interactionType: "Rate", ratingValue: 5 },
            context: {
                recommendationId: new ObjectId(firstRecommendation.recommendationId),
                surface: "Phase2Acceptance"
            },
            timestamp: new Date(),
            metadata: metadata(marker, new Date())
        };
        await insert("interactions", source);

        const before = await currentInterest();
        const beforeGraph = await likes();
        const previousQueueIds = new Set(owned.graph_sync_queue.keys());
        const previousJobCount = owned.ai_jobs.size;
        const result = await processContinuousLearningSource("Interaction", source, {
            client: db.client,
            db: makeGuardedDb(db, owned)
        });

        assert.strictEqual(result.results.length, 1);
        assert.strictEqual(result.results[0].status, "APPLIED", JSON.stringify(result));
        assert.strictEqual(owned.ai_jobs.size, previousJobCount + 1);

        const after = await currentInterest();
        close(before.interestScore.currentScore, 0.6, "before learned score");
        close(after.interestScore.previousScore, 0.6, "after previous score");
        close(after.interestScore.currentScore, 0.7, "after learned score");
        close(after.confidence.currentScore, 0.3, "after confidence");
        assert.strictEqual(after.confidence.evidenceCount, 2);
        assert.strictEqual(after.scoreHistory.length, 2);
        assert.strictEqual(after.scoreHistory[1].eventId, id(source._id));
        assert.deepStrictEqual(await likes(), beforeGraph);

        const newQueueIds = [...owned.graph_sync_queue.entries()]
            .filter(([key]) => !previousQueueIds.has(key))
            .map(([, value]) => value);
        assert.strictEqual(newQueueIds.length, 1);
        const queueJob = await db.collection("graph_sync_queue").findOne({ _id: newQueueIds[0] });
        assert.strictEqual(queueJob.entityType, "ChildInterest");
        assert.strictEqual(queueJob.operation, "UPDATE");
        assert.strictEqual(queueJob.status, "PENDING");

        await processJobs(newQueueIds, "D7 graph feedback");
        const postGraph = await likes();
        assert.strictEqual(postGraph.length, 1);
        close(postGraph[0].properties.score, 0.7, "post graph score");
        close(postGraph[0].properties.confidence, 0.3, "post graph confidence");
        assert.strictEqual(postGraph[0].properties.evidenceCount, 2);

        const duplicateCheck = await graph(
            `
            MATCH (c:Child {childId:$childId})-[r:LIKES]->(s:Subcategory {subcategoryId:$subcategoryId})
            RETURN count(r) AS count
            `,
            {
                childId: id(fixtures.child._id),
                subcategoryId: id(fixtures.subcategory._id)
            }
        );
        assert.strictEqual(duplicateCheck[0].count, 1);

        report.learningSourceId = id(source._id);
        report.beforeLearnedState = {
            score: before.interestScore.currentScore,
            confidence: before.confidence.currentScore,
            evidenceCount: before.confidence.evidenceCount
        };
        report.afterLearnedState = {
            score: after.interestScore.currentScore,
            confidence: after.confidence.currentScore,
            evidenceCount: after.confidence.evidenceCount
        };
        report.graphFeedback = {
            before: beforeGraph,
            after: postGraph,
            queueId: id(newQueueIds[0])
        };
        report.stages.G = "PASS";
        report.stages.H = "PASS";

        return source;
    }

    async function stageI(engine, beforeResponse) {
        const response = await engine.generateRecommendations(fixtures.child._id, 2);
        assert.strictEqual(response.recommendations.length, 2);
        const hero = response.recommendations[0];
        const beforeHero = beforeResponse.recommendations[0];
        assert.strictEqual(hero.activityId, id(fixtures.namedActivities.hero._id));
        assert.strictEqual(hero.rank, 1);
        close(hero.factors.interest.score, 0.7, "second cycle interest");
        close(hero.factors.behavior.score, 1, "second cycle behavior");
        for (const factor of ["preference", "goal", "exploration", "session"]) {
            assert.deepStrictEqual(hero.factors[factor], beforeHero.factors[factor]);
        }
        assert(hero.score > beforeHero.score);
        assert(hero.explanation.text.length > 0);
        assert(hero.explanation.reasonTypes.every((reasonType) =>
            hero.factors[reasonType]?.available === true
        ));
        report.afterRecommendation = response.recommendations.map((item) => ({
            activityId: item.activityId,
            rank: item.rank,
            score: item.score,
            factors: item.factors
        }));
        report.scoreDelta = {
            hero: hero.score - beforeHero.score,
            interestDelta: hero.factors.interest.score - beforeHero.factors.interest.score,
            behaviorDelta: hero.factors.behavior.score - beforeHero.factors.behavior.score
        };
        report.stages.I = "PASS";

        return response;
    }

    async function stageJ(source, firstRecommendationId) {
        const before = await currentInterest();
        const recommendationBefore = await db.collection("recommendations")
            .findOne({ _id: new ObjectId(firstRecommendationId) });
        const snapshotBefore = await collectionSnapshot(db);
        const graphBefore = await graphSnapshot();
        const replay = await processContinuousLearningSource("Interaction", source, {
            client: db.client,
            db: makeGuardedDb(db, owned)
        });
        assert.strictEqual(replay.results[0].status, "IGNORED");
        assert.strictEqual(replay.results[0].reasonCode, "DUPLICATE_EVENT");
        assert.deepStrictEqual(await currentInterest(), before);

        const invalid = {
            _id: oid(),
            actor: { childId: fixtures.child._id, actorType: "Child" },
            targetEntity: {
                entityType: "Activity",
                entityId: fixtures.namedActivities.hero._id
            },
            interactionDetails: { interactionType: "FeedbackSubmitted" },
            timestamp: new Date(),
            metadata: metadata(marker, new Date())
        };
        await insert("interactions", invalid);
        const ignored = await processContinuousLearningSource("Interaction", invalid, {
            client: db.client,
            db: makeGuardedDb(db, owned)
        });
        assert.strictEqual(ignored.results[0].status, "IGNORED");
        assert.strictEqual(ignored.results[0].reasonCode, "NON_LEARNING_EVENT");
        assert.deepStrictEqual(await currentInterest(), before);

        const recommendationAfter = await db.collection("recommendations")
            .findOne({ _id: new ObjectId(firstRecommendationId) });
        assert.deepStrictEqual(recommendationAfter, recommendationBefore);
        assert.deepStrictEqual(await graphSnapshot(), graphBefore);

        const snapshotAfter = await collectionSnapshot(db);
        for (const name of COLLECTIONS) {
            if (name === "interactions") {
                continue;
            }
            assert.deepStrictEqual(snapshotAfter[name], snapshotBefore[name], `${name} mutated`);
        }

        report.idempotency = {
            duplicate: replay.results[0],
            invalid: ignored.results[0],
            originalRecommendationUnchanged: true
        };
        report.stages.J = "PASS";
    }

    async function runRegressionSmoke() {
        const { spawnSync } = require("child_process");
        const commands = [
            ["node", ["src/tests/testHardEligibilityBasic.js"]],
            ["node", ["src/tests/testRecommendationEngine.js"]],
            ["node", ["src/tests/testD6FinalEndToEndVerification.js"]],
            ["node", ["src/tests/testLearningRuleEngine.js"]],
            ["node", ["src/tests/testQueueWorker.js"]]
        ];
        const results = [];

        for (const [cmd, args] of commands) {
            const result = spawnSync(cmd, args, {
                cwd: process.cwd(),
                encoding: "utf8"
            });
            results.push({
                command: [cmd, ...args].join(" "),
                status: result.status,
                stdoutTail: result.stdout.trim().split("\n").slice(-3),
                stderrTail: result.stderr.trim().split("\n").slice(-3)
            });
            assert.strictEqual(result.status, 0, `${cmd} ${args.join(" ")} failed`);
        }

        report.regression = results;
        report.stages.K = "PASS";
    }

    try {
        await mongoConfig.connectMongoDB();
        db = mongoConfig.getDatabase();
        existingCollections = new Set(
            (await db.listCollections({}, { nameOnly: true }).toArray()).map(
                (collection) => collection.name
            )
        );
        baseline = await collectionSnapshot(db);
        baselineIndexes = await indexSnapshot(db);
        baselineGraph = await graphSnapshot();
        baselineSchema = await graphSchema();
        report.baseline = {
            mongoCounts: Object.fromEntries(
                COLLECTIONS.map((name) => [name, baseline[name].length])
            ),
            graphNodes: baselineGraph.nodes.length,
            graphRelationships: baselineGraph.relationships.length
        };

        for (const [factor, weight] of Object.entries(EXPECTED_WEIGHTS)) {
            close(SCORING_WEIGHTS[factor], weight, `weight ${factor}`);
        }
        assert.deepStrictEqual(Object.keys(SCORING_WEIGHTS), FACTORS);

        phase = "fixtures";
        fixtures = buildFixtures();
        await insertFixtures();
        await stageA();

        phase = "graph";
        await projectAll();
        await stageB();
        await stageC();

        phase = "d5";
        const context = await buildRecommendationContext(fixtures.child._id);
        const eligibility = evaluateRecommendationEligibility(context);
        await stageD(context, eligibility);
        const engine = await makeEngine();
        const firstRecommendation = await stageEAndF(engine);

        phase = "learning";
        const learningSource = await stageGAndH(firstRecommendation);

        phase = "second-cycle";
        await stageI(engine, firstRecommendation);

        phase = "safety";
        await stageJ(learningSource, firstRecommendation.recommendationId);

        phase = "regression";
        await runRegressionSmoke();
        report.verdict = "PASS";
    } catch (error) {
        failure = error;
        report.verdict = "FAIL";
        report.failure = {
            phase,
            name: error.name,
            message: error.message,
            stack: error.stack
        };
    } finally {
        if (db && wrote) {
            report.cleanup = { graph: false, mongo: false };

            try {
                for (const item of [...graphOwned].reverse()) {
                    await graph(
                        `MATCH (n:${item.label} {${item.key}:$id}) DETACH DELETE n`,
                        { id: item.id }
                    );
                }
                assert.deepStrictEqual(await graphSnapshot(), baselineGraph);
                assert.deepStrictEqual(await graphSchema(), baselineSchema);
                report.cleanup.graph = true;
            } catch (error) {
                failure ||= error;
                report.cleanup.graphError = error.message;
            }

            try {
                for (const name of COLLECTIONS) {
                    const ids = [...owned[name].values()];
                    if (ids.length > 0) {
                        await db.collection(name).deleteMany({ _id: { $in: ids } });
                    }
                }
                for (const name of COLLECTIONS) {
                    const existsNow = (await db.listCollections({ name }, { nameOnly: true }).toArray()).length > 0;
                    if (!existingCollections.has(name) && existsNow) {
                        assert.strictEqual(await db.collection(name).countDocuments({}), 0);
                        await db.collection(name).drop();
                    }
                }
                assert.deepStrictEqual(await collectionSnapshot(db), baseline);
                assert.deepStrictEqual(await indexSnapshot(db), baselineIndexes);
                report.cleanup.mongo = true;
                report.stages.L = "PASS";
            } catch (error) {
                failure ||= error;
                report.cleanup.mongoError = error.message;
                report.stages.L = "FAIL";
            }
        } else {
            report.stages.L = "PASS";
        }

        if (db) {
            await db.client.close();
        }
        await driver.close();
    }

    if (failure) {
        process.exitCode = 1;
    }

    console.log(JSON.stringify(report, null, 2));
    console.log(`PHASE 2 FINAL ACCEPTANCE: ${report.verdict}`);
}

main().catch((error) => {
    console.error("Phase 2 final acceptance crashed:", error);
    process.exitCode = 1;
});
