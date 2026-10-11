// Deterministic product integration: real APIs/learning/scoring, in-memory Mongo
// semantics and a controlled discovery candidate. This does not verify live Neo4j.
const assert = require('node:assert/strict');
const { isDeepStrictEqual } = require('node:util');
const Module = require('node:module');
const path = require('node:path');
const { ObjectId } = require('mongodb');
const RealDate = Date;
const originalLoad = Module._load;
const instant = RealDate.parse('2026-10-11T10:00:00Z');
class FixedDate extends RealDate {
    constructor(...args) { super(...(args.length ? args : [instant])); }
    static now() { return instant; }
    static [Symbol.hasInstance](value) { return value instanceof RealDate; }
}
function copy(v) {
    if (v instanceof RealDate) return new Date(v.getTime());
    if (v instanceof ObjectId) return new ObjectId(v);
    if (Array.isArray(v)) return v.map(copy);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, copy(x)]));
    return v;
}
function at(v, key) {
    const parts = key.split('.');
    function walk(value, i) {
        if (i === parts.length) return value;
        if (Array.isArray(value)) return value.map(x => walk(x, i)).flat();
        return walk(value?.[parts[i]], i + 1);
    }
    return walk(v, 0);
}
function matches(record, query) {
    return Object.entries(query).every(([key, expected]) => {
        if (key === '$or') return expected.some(q => matches(record, q));
        const actual = at(record, key);
        if (expected && typeof expected === 'object' && Object.keys(expected).some(k => k.startsWith('$'))) {
            return Object.entries(expected).every(([op, value]) => {
                if (op === '$exists') return (actual !== undefined) === value;
                if (op === '$in') return (Array.isArray(actual) ? actual : [actual]).some(x => value.some(y => isDeepStrictEqual(x, y)));
                if (op === '$gte') return actual >= value;
                if (op === '$lte') return actual <= value;
                if (op === '$lt') return actual < value;
                throw new Error(`Unsupported fixture query ${op}`);
            });
        }
        return Array.isArray(actual) && !Array.isArray(expected)
            ? actual.some(value => isDeepStrictEqual(value, expected)) : isDeepStrictEqual(actual, expected);
    });
}
function fixture() {
    const ids = Object.fromEntries(['parent', 'child', 'vendor', 'category', 'subcategory', 'activity', 'session', 'interest'].map(k => [k, new ObjectId()]));
    const pref = value => ({ value, confidenceScore: 1, source: 'Parent', updatedAt: new Date(instant - 86400000) });
    const data = {
        parents: [{ _id: ids.parent, account: { status: 'Active', preferredLanguage: 'en' } }],
        children: [{ _id: ids.child, parentId: ids.parent, status: 'Active', identity: { dateOfBirth: new Date('2018-01-01'), gender: 'Female' },
            preferences: { socialStyle: pref('Team'), difficulty: pref('Beginner'), experienceStyle: pref('Structured'), commitmentPreference: pref('Weekly') }, parentGoals: [], developmentProfile: [] }],
        vendors: [{ _id: ids.vendor, status: 'Active' }],
        categories: [{ _id: ids.category, isActive: true }],
        subcategories: [{ _id: ids.subcategory, categoryId: ids.category, isActive: true }],
        activities: [{ _id: ids.activity, vendorId: ids.vendor, basicInformation: { nameEn: 'Outdoor Team Starter', status: 'Active' },
            classification: { categoryId: ids.category, subcategoryId: ids.subcategory },
            eligibility: { minimumAge: 6, maximumAge: 12, allowedGenders: ['Female'] },
            experience: { environment: 'Outdoor', socialStyle: 'Team', difficulty: 'Beginner', experienceStyles: ['Structured'], commitmentType: 'Weekly' },
            activityConstraints: { accessibilityFeatures: [], safetyRequirements: [] }, learningOutcomes: [] }],
        sessions: [{ _id: ids.session, activityId: ids.activity, vendorId: ids.vendor,
            schedule: { startDateTime: new Date(instant + 7 * 86400000), endDateTime: new Date(instant + 7 * 86400000 + 3600000), bookingDeadline: new Date(instant + 6 * 86400000), timezone: 'UTC' },
            availability: { status: 'Available', registrationOpen: true }, capacity: { totalCapacity: 10, bookedCapacity: 0, remainingCapacity: 10, minimumParticipants: 1 } }],
        child_interests: [{ _id: ids.interest, childId: ids.child, subcategoryId: ids.subcategory,
            interestScore: { currentScore: 0.7, previousScore: 0.7, lastCalculatedAt: new Date(), lastDecayAt: new Date() },
            confidence: { currentScore: 0.6, evidenceCount: 2, lastCalculatedAt: new Date() },
            evidenceSummary: { interactionBreakdown: [] }, scoreHistory: [],
            metadata: { version: 1, createdAt: new Date(), updatedAt: new Date(), createdBy: 'Fixture', lastSyncedToGraph: null } }],
        interactions: [], question_history: [], parent_decisions: [], ai_jobs: [], graph_sync_queue: [], recommendations: [], bookings: [], goal_library: [], learning_outcomes: []
    };
    let staged = null;
    const writes = [];
    let stage = 'setup';
    const session = {
        startTransaction() { assert.equal(staged, null); staged = copy(data); },
        inTransaction: () => staged !== null,
        async commitTransaction() { Object.assign(data, staged); staged = null; },
        async abortTransaction() { staged = null; },
        async endSession() { assert.equal(staged, null); }
    };
    const db = {
        client: { startSession: () => session },
        listCollections: (filter = {}) => ({ toArray: async () => Object.keys(data).filter(name => !filter.name || filter.name === name).map(name => ({ name })) }),
        collection(name) {
            assert.ok(Object.hasOwn(data, name), `Unexpected collection ${name}`);
            const store = options => {
                if (options?.session) { assert.equal(options.session, session); assert.ok(staged); return staged[name]; }
                return data[name];
            };
            const trace = op => writes.push({ stage, name, op, stack: new Error().stack });
            const rows = (query, options) => {
                const result = store(options).filter(x => matches(x, query));
                if (options?.sort) result.sort((a, b) => {
                    for (const [key, direction] of Object.entries(options.sort)) {
                        if (at(a, key) < at(b, key)) return -direction;
                        if (at(a, key) > at(b, key)) return direction;
                    }
                    return 0;
                });
                return copy(result);
            };
            return {
                async findOne(query, options = {}) { return rows(query, options)[0] ?? null; },
                find(query = {}, options = {}) {
                    return { project() { return this; }, async toArray() { return rows(query, options); } };
                },
                async insertOne(document, options = {}) {
                    trace('insert');
                    const record = copy(document); record._id ??= new ObjectId();
                    assert.ok(!store(options).some(x => isDeepStrictEqual(x._id, record._id)), 'duplicate fixture ID');
                    store(options).push(record); return { acknowledged: true, insertedId: record._id };
                },
                async updateOne(query, update, options = {}) {
                    trace('update');
                    const record = store(options).find(x => matches(x, query));
                    if (!record) return { matchedCount: 0, modifiedCount: 0 };
                    if (Array.isArray(update)) {
                        const merge = update[0].$set.preferences.$mergeObjects;
                        record.preferences = { ...(record.preferences ?? {}), ...copy(merge[1].$literal) };
                    } else {
                        assert.deepEqual(Object.keys(update), ['$set']);
                        for (const [key, value] of Object.entries(update.$set)) {
                            const keys = key.split('.');
                            if (keys.includes('$')) {
                                assert.equal(keys[0], 'recommendedItems');
                                keys[keys.indexOf('$')] = String(record.recommendedItems.findIndex(item => isDeepStrictEqual(item.activityId, query['recommendedItems.activityId'])));
                            }
                            const last = keys.pop();
                            const parent = keys.reduce((obj, part) => (obj[part] ??= {}), record);
                            parent[last] = copy(value);
                        }
                    }
                    return { matchedCount: 1, modifiedCount: 1 };
                }
            };
        }
    };
    return { ids, data, db, writes, stage: value => { stage = value; }, assertClosed: () => assert.equal(staged, null) };
}
async function main() {
    global.Date = FixedDate;
    const f = fixture();
    const root = path.resolve(__dirname, '../..');
    let discoveryCalls = 0;
    // Replace only external DB access and candidate discovery. Context building,
    // Mongo revalidation, eligibility and all intelligence calculations stay real.
    Module._load = function(request, parent, isMain) {
        const resolved = Module._resolveFilename(request, parent);
        if (resolved === path.join(root, 'config/mongodb.js')) return { getDatabase: () => f.db };
        if (resolved === path.join(root, 'traversal/traversalService.js')) return {
            async findCandidateActivities(childId) {
                assert.equal(String(childId), String(f.ids.child)); discoveryCalls++;
                return [{ activity: { activityId: String(f.ids.activity) }, evidence: { interests: [], goals: [], summary: [] } }];
            }
        };
        assert.ok(!['neo4j-driver', '@google/genai', 'http', 'https', 'net', 'tls'].includes(request), `External access ${request}`);
        return originalLoad.call(this, request, parent, isMain);
    };
    const { handleChildIntelligence } = require('../../api/v1/childIntelligence');
    const { handleRecommendations } = require('../../api/v1/recommendations');
    const { handleNextQuestion } = require('../../api/v1/adaptiveQuestions');
    const { handleQuestionAnswer } = require('../../api/v1/questionAnswers');
    const { handleInteraction } = require('../../api/v1/interactions');
    const { QUESTION_DEFINITIONS } = require('../../questionLibrary/questionLibrary');
    const { createRecommendationEngine } = require('../../recommendation/recommendationEngineService');
    const { processContinuousLearningSource } = require('../../learning/continuousLearningService');
    const engine = createRecommendationEngine({ languageProvider: null });
    let engineResult;
    const options = { db: f.db, client: f.db.client, async generateRecommendations(...args) {
        engineResult = await engine.generateRecommendations(...args); return engineResult;
    } };
    const childId = String(f.ids.child), activityId = String(f.ids.activity);
    const initialInterest = copy(f.data.child_interests[0]);
    const initialPreferences = copy(f.data.children[0].preferences);
    function ok(response) {
        assert.equal(response.status, 200, JSON.stringify(response)); assert.equal(response.body.success, true);
        assert.deepEqual(Object.keys(response.body).sort(), ['data', 'success']); return response.body.data;
    }
    function mark(label) { console.log(`${label}: PASS`); }
    async function intelligence(stage) {
        f.stage(stage); const before = copy(f.data); const writes = f.writes.length;
        const result = ok(await handleChildIntelligence(childId, options));
        assert.deepEqual(f.data, before); assert.equal(f.writes.length, writes);
        assert.equal(result.childId, childId);
        const interest = f.data.child_interests[0];
        assert.deepEqual(result.interests, [{ subcategoryId: String(interest.subcategoryId), score: interest.interestScore.currentScore,
            confidence: interest.confidence.currentScore, evidenceCount: interest.confidence.evidenceCount, lastUpdated: interest.metadata.updatedAt.toISOString() }]);
        return result;
    }
    async function recommend(stage) {
        f.stage(stage); const interests = copy(f.data.child_interests), jobs = copy(f.data.ai_jobs), interactions = copy(f.data.interactions);
        const result = ok(await handleRecommendations(childId, '1', options));
        assert.equal(result.recommendations.length, 1);
        const recommendation = result.recommendations[0]; assert.equal(recommendation.activityId, activityId);
        const original = engineResult.recommendations[0];
        assert.deepEqual(recommendation, Object.fromEntries(['activityId', 'score', 'rank', 'factors', 'evidence'].map(k => [k, original[k]])));
        assert.deepEqual(f.data.child_interests, interests); assert.deepEqual(f.data.ai_jobs, jobs); assert.deepEqual(f.data.interactions, interactions);
        return copy(recommendation);
    }
    assert.equal(String(f.data.children[0].parentId), String(f.ids.parent));
    assert.ok(f.data.child_interests[0].confidence.evidenceCount > 0);
    assert.equal(f.data.interactions.length, 0); assert.equal(f.data.question_history.length, 0);
    mark('A. Fixture / Initial State');
    const before = await intelligence('D2-before');
    assert.equal(Object.hasOwn(before.preferences, 'environment'), false);
    for (const [dimension, state] of Object.entries(initialPreferences)) assert.equal(before.preferences[dimension].value, state.value);
    mark('B. D2 Before');
    const recBefore = await recommend('D3-before');
    assert.ok(!recBefore.evidence.factors.preference.some(e => e.dimension === 'environment'));
    mark('C. D3 Before');
    f.stage('D4');
    const presentation = ok(await handleNextQuestion(childId, { activityId, sessionId: String(f.ids.session) }, options));
    const question = QUESTION_DEFINITIONS.find(q => q.questionId === 'Q_PREF_ENVIRONMENT_001');
    assert.deepEqual(presentation.question, Object.fromEntries(['questionId', 'fallbackTemplate', 'answerFormat', 'allowedValues'].map(k => [k, question[k]])));
    assert.equal(f.data.question_history.length, 1);
    assert.equal(String(f.data.question_history[0]._id), presentation.questionHistoryId);
    assert.equal(f.data.question_history[0].outcome, 'PRESENTED');
    assert.deepEqual(f.data.children[0].preferences, initialPreferences); assert.deepEqual(f.data.child_interests, [initialInterest]);
    assert.equal(f.data.ai_jobs.length, 0); assert.equal(f.data.interactions.length, 0);
    mark('D. D4 Presentation');
    f.stage('D5');
    assert.deepEqual(ok(await handleQuestionAnswer(presentation.questionHistoryId, { answer: 'Outdoor' }, options)), { questionHistoryId: presentation.questionHistoryId, status: 'ANSWERED' });
    assert.equal(f.data.question_history[0].outcome, 'ANSWERED');
    const preference = f.data.children[0].preferences.environment;
    assert.equal(preference.value, 'Outdoor'); assert.equal(preference.source, 'Parent');
    for (const [dimension, state] of Object.entries(initialPreferences)) assert.deepEqual(f.data.children[0].preferences[dimension], state);
    assert.deepEqual(f.data.child_interests, [initialInterest]);
    assert.equal(f.data.parent_decisions.length, 1); assert.equal(f.data.parent_decisions[0].decisionType, 'PreferenceUpdated');
    assert.equal(f.data.parent_decisions[0].context.source, 'QuestionAnswer');
    assert.equal(f.data.ai_jobs.length, 1); assert.equal(f.data.ai_jobs[0].audit.source, 'ParentDecision');
    assert.equal(f.data.ai_jobs[0].status, 'COMPLETED'); assert.equal(f.data.ai_jobs[0].outcome, 'APPLIED');
    mark('E. D5 Answer & Learning');
    const afterQuestion = await intelligence('D2-question');
    assert.deepEqual(afterQuestion.preferences.environment, { ...preference, updatedAt: preference.updatedAt.toISOString() });
    mark('F. D2 After Question');
    f.stage('D6');
    let learningResult;
    const interaction = ok(await handleInteraction(childId, { activityId, interactionType: 'View' }, { ...options,
        async processContinuousLearningSource(type, source, opts) {
            assert.equal(f.data.interactions.length, 1); assert.deepEqual(source, f.data.interactions[0]);
            learningResult = await processContinuousLearningSource(type, source, opts); return learningResult;
        } }));
    const source = f.data.interactions[0];
    assert.equal(f.data.interactions.length, 1); assert.ok(source._id instanceof ObjectId); assert.ok(source.timestamp instanceof Date);
    assert.deepEqual(interaction, { interactionId: String(source._id), status: 'RECORDED' });
    assert.deepEqual(source, { _id: source._id, actor: { childId: f.ids.child }, targetEntity: { entityId: f.ids.activity }, interactionDetails: { interactionType: 'View' }, timestamp: new Date() });
    assert.equal(learningResult.results[0].status, 'APPLIED');
    const job = f.data.ai_jobs.find(j => j.idempotencyKey === `interaction:${source._id}:View`);
    assert.equal(job.status, 'COMPLETED'); assert.equal(job.outcome, 'APPLIED');
    const learned = f.data.child_interests[0];
    assert.ok(learned.confidence.evidenceCount > initialInterest.confidence.evidenceCount);
    assert.ok(learned.scoreHistory.some(e => e.eventId === String(source._id) && e.eventType === 'View'));
    assert.equal(f.data.graph_sync_queue.length, 1); assert.equal(f.data.graph_sync_queue[0].status, 'PENDING');
    mark('G. D6 Interaction & Learning');
    await intelligence('D2-interaction'); mark('H. D2 After Interaction');
    const recAfter = await recommend('D3-after');
    const environment = recAfter.evidence.factors.preference.find(e => e.dimension === 'environment');
    assert.equal(environment.childValue, 'Outdoor'); assert.equal(environment.activityValue, 'Outdoor');
    const interestEvidence = recAfter.evidence.factors.interest.find(e => e.type === 'exact_subcategory_interest');
    assert.equal(String(interestEvidence.subcategoryId), String(learned.subcategoryId));
    assert.equal(interestEvidence.score, learned.interestScore.currentScore); assert.equal(interestEvidence.confidence, learned.confidence.currentScore);
    assert.deepEqual(Object.keys(recAfter.factors).sort(), ['behavior', 'exploration', 'goal', 'interest', 'preference', 'session']);
    assert.equal(discoveryCalls, 2); mark('I. D3 After');
    const allowed = { 'D3-before': ['recommendations'], 'D3-after': ['recommendations'], D4: ['question_history'],
        D5: ['parent_decisions', 'children', 'ai_jobs', 'question_history'], D6: ['interactions', 'child_interests', 'ai_jobs', 'graph_sync_queue'] };
    for (const write of f.writes) {
        assert.ok(allowed[write.stage]?.includes(write.name), `${write.stage}: ${write.name}`);
        if (['children', 'child_interests', 'ai_jobs', 'graph_sync_queue'].includes(write.name)) assert.match(write.stack, /[\\/]learning[\\/]/);
    }
    const answerWrites = f.writes.filter(w => w.stage === 'D5');
    assert.equal(answerWrites.at(-1).name, 'question_history');
    assert.equal(f.writes.filter(w => w.stage === 'D6')[0].name, 'interactions');
    assert.equal(f.writes.filter(w => w.stage === 'D4').length, 1);
    mark('J. Ownership / Isolation');
    f.assertClosed();
    console.log(`BEFORE score/rank: ${recBefore.score}/${recBefore.rank}`);
    console.log(`AFTER score/rank: ${recAfter.score}/${recAfter.rank}`);
    console.log(`Score movement: ${recAfter.score !== recBefore.score}; rank movement: ${recAfter.rank !== recBefore.rank}. Neither is required.`);
    console.log('Infrastructure: in-memory transactional DB; controlled discovery; real context, persistence, scoring and fallback explanations. No live MongoDB/Neo4j or LLM calls.');
}
main().then(() => {
    Module._load = originalLoad; global.Date = RealDate;
    assert.equal(Module._load, originalLoad); assert.equal(global.Date, RealDate);
    console.log('K. Cleanup / Infrastructure Boundary: PASS (isolated store; hooks restored)');
    console.log('D7B PRODUCT CLOSED LOOP: PASS');
}).catch(error => { console.error(error); console.log('D7B PRODUCT CLOSED LOOP: FAIL'); process.exitCode = 1; })
    .finally(() => { Module._load = originalLoad; global.Date = RealDate; });
