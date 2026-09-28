// Final isolated D1 verification. Requires explicit live-development opt-in.
// node src/tests/systemTestV1/phase3D1FinalVerification.js --run-live-development
const assert = require("assert");
const { randomUUID } = require("crypto");
const { ObjectId } = require("mongodb");
const { evaluateKnowledgeGaps } = require("../../knowledgeGap/knowledgeGapEngineService");
const { calculateFinalScore } = require("../../recommendation/finalScoreService");
const { createCandidateScoringState, createFactorResult } = require("../../recommendation/scoringContract");

const collections = [
    "parents",
    "children",
    "categories",
    "subcategories",
    "activities",
    "learning_outcomes",
    "goal_library",
    "child_interests",
    "interactions",
    "bookings",
    "recommendations",
    "ai_jobs",
    "graph_sync_queue"
];
const fixtureCollections = collections.filter((name) => !["ai_jobs", "graph_sync_queue"].includes(name));

function pref(value, confidenceScore = 1) {
    return { value, confidenceScore, source: "Parent", updatedAt: new Date("2026-01-01T00:00:00Z") };
}

function basePreferences(overrides = {}) {
    return {
        environment: pref("Indoor"),
        socialStyle: pref("Team"),
        difficulty: pref("Beginner"),
        experienceStyle: pref("Structured"),
        commitmentPreference: pref("Weekly"),
        ...overrides
    };
}

function baseExperience(overrides = {}) {
    return {
        environment: "Indoor",
        socialStyle: "Team",
        difficulty: "Beginner",
        experienceStyles: ["Structured"],
        commitmentType: "Weekly",
        ...overrides
    };
}

function close(actual, expected) {
    assert(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);
}

async function main() {
    if (process.argv.length !== 3 || process.argv[2] !== "--run-live-development") {
        console.log("D1F final verification skipped: --run-live-development is required; no database access.");
        return;
    }

    const config = require("../../config/mongodb");
    const marker = `D1F_FINAL_${randomUUID()}`;
    const owned = Object.fromEntries(collections.map((name) => [name, new Map()]));
    const report = { marker, scenarios: {}, safety: {}, cleanup: {} };
    let db, client, baselineCounts, existingCollections, failure;

    function remember(name, id) {
        owned[name].set(String(id), id);
    }

    async function countMap() {
        const counts = {};
        for (const name of collections) {
            const exists = (await db.listCollections({ name }, { nameOnly: true }).toArray()).length > 0;
            counts[name] = exists ? await db.collection(name).countDocuments({}) : 0;
        }
        return counts;
    }

    async function insert(name, doc) {
        const item = { _id: new ObjectId(), ...doc, testDataset: marker };
        remember(name, item._id);
        await db.collection(name).insertOne(item);
        return item;
    }

    async function scenario(label, setup) {
        const parent = await insert("parents", { account: { firstName: `${marker}_${label}`, status: "Active" } });
        const category = await insert("categories", { name: `${marker}_${label}`, isActive: true });
        const subcategory = await insert("subcategories", { name: `${marker}_${label}`, categoryId: category._id, isActive: true });
        const outcome = await insert("learning_outcomes", { name: `${marker}_${label}`, isActive: true });
        const child = await insert("children", {
            parentId: parent._id,
            identity: { firstName: `${marker}_${label}`, dateOfBirth: new Date("2018-01-01"), gender: "Female" },
            status: "Active",
            preferences: basePreferences(),
            parentGoals: [],
            developmentProfile: []
        });
        const sibling = await insert("children", {
            parentId: parent._id,
            identity: { firstName: `${marker}_${label}_sibling`, dateOfBirth: new Date("2018-01-01"), gender: "Female" },
            status: "Active",
            preferences: basePreferences({ socialStyle: pref("Mixed") }),
            parentGoals: [],
            developmentProfile: []
        });
        const activity = await insert("activities", {
            basicInformation: { nameEn: `${marker}_${label}`, status: "Active" },
            classification: { categoryId: category._id, subcategoryId: subcategory._id },
            experience: baseExperience(),
            learningOutcomes: [],
            eligibility: { minimumAge: 0, maximumAge: 100, allowedGenders: ["Female"] }
        });
        const context = { parent, category, subcategory, outcome, child, sibling, activity };
        await setup(context);
        return { ...context, result: await evaluateKnowledgeGaps(child._id, activity._id, { db }) };
    }

    async function addInterest(ctx, history, extra = {}) {
        return insert("child_interests", {
            childId: ctx.child._id,
            subcategoryId: ctx.subcategory._id,
            interestScore: { currentScore: 0.7, previousScore: 0.6, lastCalculatedAt: new Date("2026-01-03"), lastDecayAt: new Date("2026-01-01") },
            confidence: { currentScore: 0.4, evidenceCount: history.length || extra.evidenceCount || 0, lastCalculatedAt: new Date("2026-01-03") },
            evidenceSummary: { interactionBreakdown: [] },
            scoreHistory: history,
            metadata: { version: 1, createdAt: new Date("2026-01-01"), updatedAt: new Date("2026-01-03"), lastSyncedToGraph: null },
            ...extra
        });
    }

    async function addInteraction(ctx, type, fields = {}) {
        return insert("interactions", {
            actor: { childId: fields.childId ?? ctx.child._id, actorType: "Child" },
            targetEntity: { entityType: "Activity", entityId: fields.activityId ?? ctx.activity._id },
            interactionDetails: { interactionType: type, ...(type === "Rate" ? { ratingValue: fields.ratingValue ?? 5 } : {}) },
            timestamp: fields.timestamp ?? new Date("2026-01-01T00:00:00Z"),
            metadata: { version: 1 }
        });
    }

    async function addBooking(ctx, fields = {}) {
        return insert("bookings", {
            bookingDetails: {
                childId: fields.childId ?? ctx.child._id,
                activityId: fields.activityId ?? ctx.activity._id,
                status: fields.status ?? "Confirmed",
                bookedAt: fields.bookedAt ?? new Date("2026-01-01T00:00:00Z")
            },
            ...(fields.attendance ? { attendance: fields.attendance } : {})
        });
    }

    function assertNoForbiddenOutput(result) {
        for (const key of ["overallKnowledgeScore", "knowledgeConfidenceScore", "gapScore", "questionPriority", "askNow", "recommendationScore", "ranking"]) {
            assert.strictEqual(Object.hasOwn(result, key), false, key);
        }
    }

    try {
        await config.connectMongoDB();
        db = config.getDatabase();
        client = db.client;
        assert.strictEqual(db.databaseName, "heroz");
        existingCollections = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((item) => item.name));
        baselineCounts = await countMap();

        const cold = await scenario("cold", async (ctx) => {
            await insert("recommendations", {
                childId: ctx.sibling._id,
                recommendedItems: [{ activityId: ctx.activity._id }],
                response: { wasDisplayed: true }
            });
            await db.collection("children").updateOne({ _id: ctx.child._id }, { $set: {
                preferences: { environment: pref(null), socialStyle: pref(null), difficulty: pref(null), experienceStyle: pref(null), commitmentPreference: pref(null) }
            } });
        });
        assert.strictEqual(cold.result.interestCoverage.sufficiencyState, "INSUFFICIENT");
        assert.strictEqual(cold.result.activityFamiliarity.sufficiencyState, "INSUFFICIENT");
        assert.strictEqual(cold.result.developmentalRelevance.applicabilityState, "NOT_APPLICABLE");
        assert.strictEqual(cold.result.exposureContext.status, "NEVER_EXPOSED");
        assertNoForbiddenOutput(cold.result);
        report.scenarios.cold = "PASS";

        const passive = await scenario("passive", async (ctx) => addInterest(ctx, [
            { eventId: "v1", eventType: "View", interestDelta: 0.01, timestamp: new Date("2026-01-01") },
            { eventId: "c1", eventType: "Click", interestDelta: 0.02, timestamp: new Date("2026-01-02") }
        ]));
        assert.strictEqual(passive.result.interestCoverage.sufficiencyState, "UNCERTAIN");
        assert(passive.result.interestCoverage.reasons.includes("PASSIVE_EVIDENCE_ONLY"));
        report.scenarios.passiveInterest = "PASS";

        const corroborated = await scenario("corroborated", async (ctx) => addInterest(ctx, [
            { eventId: "s1", eventType: "Save", interestDelta: 0.05, timestamp: new Date("2026-01-01") },
            { eventId: "a1", eventType: "Attend", interestDelta: 0.1, timestamp: new Date("2026-01-02") }
        ]));
        assert.strictEqual(corroborated.result.interestCoverage.sufficiencyState, "SUFFICIENT");
        report.scenarios.corroboratedInterest = "PASS";

        const conflict = await scenario("conflict", async (ctx) => addInterest(ctx, [
            { eventId: "s1", eventType: "Save", interestDelta: 0.05, timestamp: new Date("2026-01-01") },
            { eventId: "d1", eventType: "Dismiss", interestDelta: -0.05, timestamp: new Date("2026-01-02") }
        ]));
        assert(conflict.result.interestCoverage.reasons.includes("CONFLICTING_INTEREST_EVIDENCE"));
        report.scenarios.conflictingInterest = "PASS";

        const legacy = await scenario("legacy", async (ctx) => addInterest(ctx, [], { confidence: { currentScore: 0.8, evidenceCount: 12, lastCalculatedAt: new Date() } }));
        assert(legacy.result.interestCoverage.reasons.includes("EVIDENCE_PROVENANCE_UNAVAILABLE"));
        assert.strictEqual(legacy.result.interestCoverage.atInitialBaseline, false);
        report.scenarios.legacyInterest = "PASS";

        const fit = await scenario("fit", async (ctx) => {
            await db.collection("activities").updateOne({ _id: ctx.activity._id }, { $set: { experience: baseExperience({ environment: "Outdoor", difficulty: "Advanced" }) } });
        });
        assert.strictEqual(fit.result.experienceFit.coverageState, "AVAILABLE");
        assert.strictEqual(fit.result.experienceFit.sufficiencyState, "SUFFICIENT");
        assert(!fit.result.knowledgeGaps.some((gap) => gap.dimension === "experienceFit"));
        report.scenarios.experienceComplete = "PASS";

        const childGap = await scenario("child_gap", async (ctx) => {
            await db.collection("children").updateOne({ _id: ctx.child._id }, { $set: { "preferences.socialStyle": pref(null) } });
        });
        assert(childGap.result.knowledgeGaps.some((gap) => gap.key === `preference:${childGap.child._id}:socialStyle` && gap.possibleResolvers.includes("PARENT")));
        report.scenarios.experienceChildGap = "PASS";

        const catalogGap = await scenario("catalog_gap", async (ctx) => {
            await db.collection("activities").updateOne({ _id: ctx.activity._id }, { $set: { "experience.difficulty": null } });
        });
        assert(catalogGap.result.knowledgeGaps.some((gap) => gap.key === `catalog:activity:${catalogGap.activity._id}:experience:difficulty` && gap.possibleResolvers.includes("CATALOG")));
        report.scenarios.experienceCatalogGap = "PASS";

        const bothGap = await scenario("both_gap", async (ctx) => {
            await db.collection("children").updateOne({ _id: ctx.child._id }, { $set: { "preferences.environment": pref(null) } });
            await db.collection("activities").updateOne({ _id: ctx.activity._id }, { $set: { "experience.environment": null } });
        });
        assert(bothGap.result.knowledgeGaps.some((gap) => gap.key === `preference:${bothGap.child._id}:environment`));
        assert(bothGap.result.knowledgeGaps.some((gap) => gap.key === `catalog:activity:${bothGap.activity._id}:experience:environment`));
        report.scenarios.experienceBothSides = "PASS";

        const familiarity = await scenario("familiarity", async (ctx) => {
            await addInteraction(ctx, "Dismiss");
            await addInteraction(ctx, "Save", { timestamp: new Date("2026-01-01") });
            await addInteraction(ctx, "Unsave", { timestamp: new Date("2026-01-02") });
            await addInteraction(ctx, "Rate", { ratingValue: 3, timestamp: new Date("2026-01-03") });
        });
        assert.strictEqual(familiarity.result.activityFamiliarity.familiarityStatus, "ESTABLISHED");
        assert.strictEqual(familiarity.result.activityFamiliarity.currentSavedState.saved, false);
        assert.strictEqual(familiarity.result.activityFamiliarity.latestRating.ratingValue, 3);
        report.scenarios.familiarity = "PASS";

        const ambiguousRating = await scenario("ambiguous_rating", async (ctx) => {
            const timestamp = new Date("2026-01-03");
            await addInteraction(ctx, "Rate", { ratingValue: 1, timestamp });
            await addInteraction(ctx, "Rate", { ratingValue: 5, timestamp });
        });
        assert.strictEqual(ambiguousRating.result.activityFamiliarity.latestRating.status, "AMBIGUOUS");
        assert.strictEqual(ambiguousRating.result.activityFamiliarity.sufficiencyState, "SUFFICIENT");
        report.scenarios.ambiguousRating = "PASS";

        const bookAttend = await scenario("book_attend", async (ctx) => {
            const booking = await addBooking(ctx, { attendance: { status: "Attended", checkedInAt: new Date("2026-01-02") } });
            await addBooking(ctx, { status: "Pending", attendance: { status: "NoShow" } });
            ctx.bookingId = booking._id;
        });
        assert(bookAttend.result.activityFamiliarity.events.some((event) => event.eventType === "Book"));
        assert(bookAttend.result.activityFamiliarity.events.some((event) => event.eventType === "Attend"));
        assert.strictEqual(bookAttend.result.activityFamiliarity.events.filter((event) => event.eventType === "Book" || event.eventType === "Attend").length, 2);
        report.scenarios.bookAttendIdentity = "PASS";

        const goalDev = await scenario("goal_dev", async (ctx) => {
            const goal = await insert("goal_library", { name: marker, isActive: true, relatedOutcomes: [{ outcomeId: ctx.outcome._id }] });
            await db.collection("children").updateOne({ _id: ctx.child._id }, { $set: { parentGoals: [{ goalId: goal._id, status: "Active", priority: 1 }] } });
            await db.collection("activities").updateOne({ _id: ctx.activity._id }, { $set: { learningOutcomes: [{ outcomeId: ctx.outcome._id }] } });
        });
        assert.strictEqual(goalDev.result.developmentalRelevance.goalRelevance.status, "PRESENT");
        assert.strictEqual(goalDev.result.developmentalRelevance.sufficiencyState, "SUFFICIENT");
        assert.strictEqual(goalDev.result.interestCoverage.sufficiencyState, "INSUFFICIENT");
        report.scenarios.goalDevelopment = "PASS";

        const profileDev = await scenario("profile_dev", async (ctx) => {
            await db.collection("children").updateOne({ _id: ctx.child._id }, { $set: { developmentProfile: [{ outcomeId: ctx.outcome._id, score: 0.4, confidenceScore: 0.3, evidenceCount: 1, trend: null, history: [] }] } });
            await db.collection("activities").updateOne({ _id: ctx.activity._id }, { $set: { learningOutcomes: [{ outcomeId: ctx.outcome._id }] } });
        });
        assert.strictEqual(profileDev.result.developmentalRelevance.developmentEvidence.status, "PRESENT");
        assert(!JSON.stringify(profileDev.result.developmentalRelevance).match(/mastery|deficiency|diagnosis|abilityLevel/i));
        report.scenarios.profileDevelopment = "PASS";

        const shared = await scenario("shared_outcome", async (ctx) => {
            await db.collection("children").updateOne({ _id: ctx.child._id }, { $set: { developmentProfile: [{ outcomeId: ctx.outcome._id, score: 0.4, confidenceScore: 0.3, evidenceCount: 1, history: [{ eventId: "robotics-booking", eventType: "Attend", activityId: "robotics" }] }] } });
            await db.collection("activities").updateOne({ _id: ctx.activity._id }, { $set: { learningOutcomes: [{ outcomeId: ctx.outcome._id }] } });
        });
        assert.strictEqual(shared.result.developmentalRelevance.developmentEvidence.status, "PRESENT");
        assert.strictEqual(shared.result.interestCoverage.sufficiencyState, "INSUFFICIENT");
        report.scenarios.sharedOutcomeSeparation = "PASS";

        const inactiveGoal = await scenario("inactive_goal", async (ctx) => {
            const goal = await insert("goal_library", { name: marker, isActive: true, relatedOutcomes: [{ outcomeId: ctx.outcome._id }] });
            await db.collection("children").updateOne({ _id: ctx.child._id }, { $set: { parentGoals: ["Paused", "Achieved", "Removed"].map((status) => ({ goalId: goal._id, status, priority: 1 })) } });
            await db.collection("activities").updateOne({ _id: ctx.activity._id }, { $set: { learningOutcomes: [{ outcomeId: ctx.outcome._id }] } });
        });
        assert.strictEqual(inactiveGoal.result.developmentalRelevance.goalRelevance.status, "ABSENT");
        assert(inactiveGoal.result.developmentalRelevance.goalRelevance.inactiveContext.length >= 2);
        report.scenarios.inactiveGoals = "PASS";

        const invalidGoal = await scenario("invalid_goal", async (ctx) => {
            await db.collection("children").updateOne({ _id: ctx.child._id }, { $set: { parentGoals: [{ goalId: new ObjectId(), status: "Active", priority: 1 }] } });
            await db.collection("activities").updateOne({ _id: ctx.activity._id }, { $set: { learningOutcomes: [{ outcomeId: ctx.outcome._id }] } });
        });
        assert.strictEqual(invalidGoal.result.developmentalRelevance.sufficiencyState, "BLOCKED");
        report.scenarios.invalidGoal = "PASS";

        const exposure = await scenario("exposure", async (ctx) => {
            await insert("recommendations", { childId: ctx.child._id, recommendedItems: [{ activityId: ctx.activity._id }], response: { wasDisplayed: true } });
        });
        assert.strictEqual(exposure.result.exposureContext.status, "EXPOSED");
        assert.strictEqual(exposure.result.activityFamiliarity.sufficiencyState, "INSUFFICIENT");
        report.scenarios.exposure = "PASS";

        const unknownExposure = await scenario("unknown_exposure", async () => {});
        unknownExposure.result = await evaluateKnowledgeGaps(unknownExposure.child._id, unknownExposure.activity._id, {
            db: {
                collection: (name) => db.collection(name),
                listCollections: () => ({ toArray: async () => [] })
            }
        });
        assert.strictEqual(unknownExposure.result.exposureContext.status, "UNKNOWN");
        report.scenarios.exposureUnknown = "PASS";

        const overlap = await scenario("overlap", async (ctx) => {
            const booking = await addBooking(ctx, { status: "Cancelled", attendance: { status: "Attended", checkedInAt: new Date("2026-01-02") } });
            await addInterest(ctx, [{ eventId: String(booking._id), eventType: "Attend", interestDelta: 0.1, timestamp: new Date("2026-01-02") }]);
            await db.collection("children").updateOne({ _id: ctx.child._id }, { $set: { developmentProfile: [{ outcomeId: ctx.outcome._id, score: 0.4, confidenceScore: 0.3, evidenceCount: 1, history: [{ eventId: String(booking._id), eventType: "Attend", activityId: String(ctx.activity._id), bookingId: String(booking._id) }] }] } });
            await db.collection("activities").updateOne({ _id: ctx.activity._id }, { $set: { learningOutcomes: [{ outcomeId: ctx.outcome._id }] } });
        });
        assert(overlap.result.overlapGroups.some((group) => group.provenanceStrength === "ID_PROVEN" && group.identity.endsWith(":Attend")));
        report.scenarios.overlap = "PASS";

        const tension = await scenario("tension", async (ctx) => {
            await db.collection("activities").updateOne({ _id: ctx.activity._id }, { $set: { "experience.environment": "Outdoor" } });
            await addInteraction(ctx, "Save");
        });
        assert.strictEqual(tension.result.annotations.preferenceBehaviorTension.status, "PRESENT");
        assert.strictEqual((await db.collection("children").findOne({ _id: tension.child._id })).preferences.environment.value, "Indoor");
        report.scenarios.preferenceBehaviorTension = "PASS";

        const dedupeA = await scenario("dedupe_a", async (ctx) => {
            ctx.second = await insert("activities", {
                basicInformation: { nameEn: `${marker}_dedupe_second`, status: "Active" },
                classification: { categoryId: ctx.category._id, subcategoryId: ctx.subcategory._id },
                experience: baseExperience({ difficulty: null }),
                learningOutcomes: []
            });
            await db.collection("children").updateOne({ _id: ctx.child._id }, { $set: { "preferences.socialStyle": pref(null) } });
            await db.collection("activities").updateOne({ _id: ctx.activity._id }, { $set: { "experience.difficulty": null } });
        });
        const dedupeB = await evaluateKnowledgeGaps(dedupeA.child._id, dedupeA.second._id, { db });
        assert.strictEqual(dedupeA.result.knowledgeGaps.find((gap) => gap.dimension === "interestCoverage").key,
            dedupeB.knowledgeGaps.find((gap) => gap.dimension === "interestCoverage").key);
        assert.strictEqual(dedupeA.result.knowledgeGaps.find((gap) => gap.key.includes(":socialStyle")).key,
            dedupeB.knowledgeGaps.find((gap) => gap.key.includes(":socialStyle")).key);
        assert.notStrictEqual(dedupeA.result.knowledgeGaps.find((gap) => gap.key.includes(":difficulty")).key,
            dedupeB.knowledgeGaps.find((gap) => gap.key.includes(":difficulty")).key);
        assert.strictEqual(new Set(dedupeA.result.knowledgeGaps.map((gap) => gap.key)).size, dedupeA.result.knowledgeGaps.length);
        report.scenarios.gapDeduplication = "PASS";

        const sibling = await scenario("sibling", async (ctx) => {
            await insert("child_interests", { childId: ctx.sibling._id, subcategoryId: ctx.subcategory._id, interestScore: { currentScore: 1 }, confidence: { currentScore: 1, evidenceCount: 2 }, scoreHistory: [{ eventId: "x", eventType: "Save" }, { eventId: "y", eventType: "Attend" }], evidenceSummary: { interactionBreakdown: [] } });
            await addInteraction(ctx, "Save", { childId: ctx.sibling._id });
            await insert("recommendations", { childId: ctx.sibling._id, recommendedItems: [{ activityId: ctx.activity._id }], response: { wasDisplayed: true } });
            await db.collection("children").updateOne({ _id: ctx.sibling._id }, { $set: { parentGoals: [{ goalId: new ObjectId(), status: "Active", priority: 1 }], developmentProfile: [{ outcomeId: ctx.outcome._id, score: 1, confidenceScore: 1, evidenceCount: 9, history: [] }] } });
        });
        assert.strictEqual(sibling.result.interestCoverage.sufficiencyState, "INSUFFICIENT");
        assert.strictEqual(sibling.result.activityFamiliarity.sufficiencyState, "INSUFFICIENT");
        assert.strictEqual(sibling.result.exposureContext.status, "NEVER_EXPOSED");
        report.scenarios.siblingIsolation = "PASS";

        const noOutcome = await scenario("no_outcome", async () => {});
        assert.strictEqual(noOutcome.result.developmentalRelevance.applicabilityState, "NOT_APPLICABLE");
        assert(!noOutcome.result.knowledgeGaps.some((gap) => gap.dimension === "developmentalRelevance"));
        report.scenarios.developmentNotApplicable = "PASS";

        const missingChild = await evaluateKnowledgeGaps(new ObjectId(), cold.activity._id, { db });
        assert.strictEqual(missingChild.evaluation.reason, "CHILD_NOT_FOUND");
        assert.deepStrictEqual(missingChild.knowledgeGaps, []);
        const missingActivity = await evaluateKnowledgeGaps(cold.child._id, new ObjectId(), { db });
        assert.strictEqual(missingActivity.evaluation.reason, "ACTIVITY_NOT_FOUND");
        const noSub = await insert("activities", { basicInformation: { nameEn: marker }, classification: {}, experience: baseExperience(), learningOutcomes: [] });
        const missingSub = await evaluateKnowledgeGaps(cold.child._id, noSub._id, { db });
        assert.strictEqual(missingSub.evaluation.reason, "ACTIVITY_SUBCATEGORY_MISSING");
        const brokenSub = await insert("activities", { basicInformation: { nameEn: marker }, classification: { subcategoryId: new ObjectId() }, experience: baseExperience(), learningOutcomes: [] });
        const brokenSubResult = await evaluateKnowledgeGaps(cold.child._id, brokenSub._id, { db });
        assert.strictEqual(brokenSubResult.evaluation.reason, "SUBCATEGORY_NOT_FOUND");
        report.scenarios.unresolvable = "PASS";

        assert.strictEqual(require.cache[require.resolve("../../config/neo4j")] === undefined, true);
        report.safety.neo4jUntouched = true;

        const scoringState = createCandidateScoringState({
            eligibility: { eligible: true, failedConstraints: [] }
        });
        for (const factor of Object.keys(scoringState.factors)) {
            scoringState.factors[factor] = createFactorResult({
                factor,
                available: ["interest", "exploration"].includes(factor),
                score: factor === "interest" ? 0.8 : factor === "exploration" ? 0.4 : null,
                evidence: []
            });
        }
        const d5 = calculateFinalScore(scoringState);
        close(d5.availableWeight, 0.46);
        close(d5.score, (0.33 * 0.8 + 0.13 * 0.4) / 0.46);
        report.scenarios.d5Normalization = "PASS";

        report.safety.beforeCleanupCounts = await countMap();
    } catch (error) {
        failure = error;
        report.failure = { name: error.name, message: error.message, stack: error.stack };
    } finally {
        if (db) {
            for (const name of fixtureCollections) {
                const ids = [...owned[name].values()];
                report.cleanup[name] = ids.length
                    ? (await db.collection(name).deleteMany({ _id: { $in: ids } })).deletedCount
                    : 0;
            }

            for (const name of fixtureCollections) {
                if (!existingCollections.has(name) && (await db.collection(name).countDocuments({})) === 0) {
                    await db.collection(name).drop();
                }
            }

            const restoredCounts = await countMap();
            report.safety.restoredCounts = restoredCounts;
            for (const [name, count] of Object.entries(baselineCounts ?? {})) {
                assert.strictEqual(restoredCounts[name], count, `${name} count changed`);
                assert.strictEqual(await db.collection(name).countDocuments({ testDataset: marker }), 0, `${name} marker remains`);
            }
            assert.strictEqual(await db.collection("ai_jobs").countDocuments({ testDataset: marker }), 0);
            assert.strictEqual(await db.collection("graph_sync_queue").countDocuments({ testDataset: marker }), 0);
            report.cleanupVerified = true;
        }
        if (client) await client.close();
    }

    console.log(JSON.stringify(report, null, 2));
    if (failure) {
        process.exitCode = 1;
        console.log("D1F final verification: FAILED");
        return;
    }
    console.log("D1F final verification: PASSED");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
