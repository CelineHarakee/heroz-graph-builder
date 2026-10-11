// Offline evaluation contract tests. Infrastructure adapters only; real context,
// eligibility, factors, scoring, ranking and explanations are preserved.
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const { ObjectId } = require('mongodb');
const metrics = require('../../evaluation/evaluationMetrics');
const { evaluateCases } = require('../../evaluation/evaluationRunner');
const instant = Date.parse('2026-10-11T10:00:00Z');
let checks = 0;
function check(label, fn) { fn(); checks++; console.log(`PASS ${label}`); }
const row = (expectedRelevance, extra = {}) => ({ expectedRelevance, ...extra });
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} != ${b}`);
function makeCase(caseId, profileState, mode = 'normal') {
    let counter = 1;
    const oid = () => new ObjectId((counter++).toString(16).padStart(24, '0'));
    const ids = Object.fromEntries(['parent', 'child', 'vendor', 'category', 'subcategory', 'activity', 'session', 'interest'].map(k => [k, oid()]));
    const pref = value => ({ value, confidenceScore: 1, source: 'Parent', updatedAt: new Date(instant) });
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
            interestScore: { currentScore: 0.7, previousScore: 0.7, lastCalculatedAt: new Date(instant), lastDecayAt: new Date(instant) },
            confidence: { currentScore: 0.6, evidenceCount: 2, lastCalculatedAt: new Date(instant) },
            evidenceSummary: { interactionBreakdown: [] }, scoreHistory: [],
            metadata: { version: 1, createdAt: new Date(instant), updatedAt: new Date(instant), createdBy: 'Fixture', lastSyncedToGraph: null } }],
        interactions: [], question_history: [], parent_decisions: [], ai_jobs: [], graph_sync_queue: [], recommendations: [], bookings: [], goal_library: [], learning_outcomes: []
    };
    const candidates = [];
    const baseActivity = data.activities[0], baseSession = data.sessions[0], baseInterest = data.child_interests[0];
    data.activities = []; data.sessions = []; data.child_interests = []; data.subcategories = [];
    for (let index = 0; index < 4; index++) {
        const subcategoryId = oid(), activityId = oid();
        const activity = { ...baseActivity, _id: activityId, classification: { categoryId: ids.category, subcategoryId },
            eligibility: { ...baseActivity.eligibility, allowedGenders: index === 3 ? ['Male'] : ['Female'] } };
        data.activities.push(activity);
        data.sessions.push({ ...baseSession, _id: oid(), activityId });
        data.subcategories.push({ _id: subcategoryId, categoryId: ids.category, isActive: true });
        data.child_interests.push({ ...baseInterest, _id: oid(), subcategoryId,
            interestScore: { ...baseInterest.interestScore, currentScore: [0.9, 0.6, 0.2, 1][index] } });
        candidates.push({ activity, expectedRelevance: mode === 'unknown' ? null : [1, 0, 3, 3][index],
            relevanceReason: 'Human-defined test judgment, independent of engine output', isExploratory: index === 1 });
    }
    if (profileState === 'COLD_START') { data.children[0].preferences = {}; data.child_interests = []; }
    if (profileState === 'RICH_KNOWLEDGE') data.children[0].preferences.environment = pref('Outdoor');
    if (mode === 'empty') candidates.length = 0;
    return { caseId, profileState, childId: String(ids.child), candidates, fixture: data };
}
async function main() {
    check('Relevance grades, effectiveK, empty and unknown', () => {
        assert.equal(metrics.relevanceAtK([row(0), row(1), row(2), row(3)], 10), 0.75);
        assert.equal(metrics.relevanceAtK([], 3), null);
        assert.equal(metrics.relevanceAtK([row(3), row(null)], 3), null);
        assert.equal(metrics.relevanceAtK([row(3), row(null)], 1), 1);
        assert.throws(() => metrics.relevanceAtK([row(4)], 1));
        assert.throws(() => metrics.relevanceAtK([], 0));
    });
    check('NDCG ideal, graded order, omitted eligible relevance and unknown', () => {
        const ideal = [row(3), row(2), row(0)];
        assert.equal(metrics.ndcgAtK(ideal, ideal, 3), 1);
        close(metrics.ndcgAtK([row(2), row(3)], ideal, 2), (3 + 7 / Math.log2(3)) / (7 + 3 / Math.log2(3)));
        assert.equal(metrics.ndcgAtK([row(1)], [row(1), row(3)], 5), 1 / 7);
        assert.equal(metrics.ndcgAtK([row(0)], [row(0)], 2), null);
        assert.equal(metrics.ndcgAtK([], ideal, 2), null);
        assert.equal(metrics.ndcgAtK([row(3)], [row(3), row()], 1), null);
        assert.equal(metrics.ndcgAtK([row()], ideal, 1), null);
    });
    check('Diversity distances, average, short and unknown', () => {
        const a = { categoryId: 'A', subcategoryId: 'a' }, b = { categoryId: 'A', subcategoryId: 'b' }, c = { categoryId: 'B', subcategoryId: 'c' };
        assert.equal(metrics.diversityAtK([a, a], 2), 0);
        assert.equal(metrics.diversityAtK([a, b], 2), 0.5);
        assert.equal(metrics.diversityAtK([a, c], 2), 1);
        close(metrics.diversityAtK([a, b, c], 3), 2.5 / 3);
        assert.equal(metrics.diversityAtK([a], 2), null);
        assert.equal(metrics.diversityAtK([a, {}], 2), null);
    });
    check('Exploration uses independent annotations and applicable labels only', () => {
        assert.equal(metrics.explorationRelevanceRate([row(3, { factors: { exploration: { score: 1 } } })]), null);
        assert.equal(metrics.explorationRelevanceRate([row(0, { isExploratory: true }), row(2, { isExploratory: true }), row(null, { isExploratory: true }), row(3)]), 0.5);
        assert.equal(metrics.explorationRelevanceRate([row(null, { isExploratory: true })]), null);
        assert.equal(metrics.explorationRelevanceRate([]), null);
        assert.equal(metrics.explorationRelevanceRate([1, 2, 3].map(value => row(value, { isExploratory: true }))), 1);
    });
    const cases = [makeCase('partial', 'PARTIAL_KNOWLEDGE'), makeCase('empty', 'COLD_START', 'empty'),
        makeCase('cold', 'COLD_START'), makeCase('unknown', 'RICH_KNOWLEDGE', 'unknown')];
    const baseline = JSON.stringify(cases);
    const originalLoad = Module._load;
    const root = path.resolve(__dirname, '../..');
    let current, discoveryCalls = 0, reads = 0;
    function matches(record, query) {
        return Object.entries(query).every(([key, expected]) => {
            const actual = key.split('.').reduce((v, part) => v?.[part], record);
            if (expected?.$in) return expected.$in.some(item => String(item) === String(actual));
            return String(actual) === String(expected);
        });
    }
    const db = {
        listCollections: (filter = {}) => ({ toArray: async () => Object.keys(current.fixture).filter(name => !filter.name || name === filter.name).map(name => ({ name })) }),
        collection(name) {
            assert.ok(Object.hasOwn(current.fixture, name), name);
            const methods = {
                async findOne(query) { reads++; return current.fixture[name].find(record => matches(record, query)) ?? null; },
                find(query = {}) { reads++; return { project() { return this; }, async toArray() { return current.fixture[name].filter(record => matches(record, query)); } }; }
            };
            return new Proxy(methods, { get(target, key) { assert.ok(Object.hasOwn(target, key), `Forbidden DB operation: ${name}.${String(key)}`); return target[key]; } });
        }
    };
    Module._load = function(request, parent, isMain) {
        const resolved = Module._resolveFilename(request, parent);
        if (resolved === path.join(root, 'config/mongodb.js')) return { getDatabase: () => db };
        if (resolved === path.join(root, 'traversal/traversalService.js')) return { async findCandidateActivities(childId) {
            assert.equal(String(childId), current.childId); discoveryCalls++;
            return current.candidates.map(c => ({ activity: { activityId: String(c.activity._id) }, evidence: { interests: [], goals: [], summary: [] } }));
        } };
        assert.ok(!['neo4j-driver', '@google/genai', 'http', 'https', 'net', 'tls'].includes(request), `External dependency ${request}`);
        if (typeof resolved === 'string' && resolved.startsWith(root + path.sep)) assert.ok(!/^(learning|questionLearning|questionEligibility|workers|builders)\//.test(path.relative(root, resolved)));
        return originalLoad.call(this, request, parent, isMain);
    };
    try {
        const parameters = { cases, ks: [1, 2], datasetVersion: 'D1-contract-fixture-v1', evaluatedAt: new Date(instant),
            async withCaseEnvironment(c, execute) {
                assert.equal(current, undefined); current = c;
                const before = JSON.stringify(c);
                try { await execute(); } finally { assert.equal(JSON.stringify(c), before, 'Evaluation mutated fixture'); current = undefined; }
            } };
        const first = await evaluateCases(parameters);
        const second = await evaluateCases(parameters);
        check('Identical clean benchmarks are deterministic and read-only', () => {
            assert.deepEqual(second, first); assert.equal(JSON.stringify(cases), baseline);
            assert.equal(discoveryCalls, 8); assert.ok(reads > 0);
        });
        check('Real context, eligibility, ranking and independent details', () => {
            const c = first.cases[0];
            assert.equal(c.eligibleActivityIds.length, 3);
            assert.ok(!c.eligibleActivityIds.includes(String(cases[0].candidates[3].activity._id)), 'Ineligible candidate excluded by real engine');
            assert.equal(c.recommendations.length, 2);
            assert.equal(c.recommendations[0].activityId, String(cases[0].candidates[0].activity._id));
            assert.equal(c.recommendations[1].activityId, String(cases[0].candidates[1].activity._id));
            assert.equal(c.recommendations[0].rank, 1); assert.equal(c.recommendations[1].rank, 2);
            assert.ok(c.recommendations[0].score > c.recommendations[1].score);
            assert.equal(c.recommendations[0].expectedRelevance, 1);
            assert.equal(c.recommendations[0].categoryId, String(cases[0].candidates[0].activity.classification.categoryId));
            assert.ok(c.recommendations[0].factors.interest.available);
            assert.ok(c.recommendations[0].evidence.factors.interest.length);
            assert.equal(c.metricsByK[1].ndcg, 1 / 7, 'Omitted eligible grade 3 remains in IDCG');
            assert.equal(c.metricsByK[2].relevance, 0.5);
            close(c.metricsByK[2].ndcg, 1 / (7 + 1 / Math.log2(3)));
            assert.ok(['generated', 'fallback'].includes(c.recommendations[0].explanation.source));
            assert.equal(typeof c.recommendations[0].explanation.text, 'string');
            assert.equal(c.metricsByK[2].diversity, 0.5);
            assert.equal(c.explorationRelevanceRate, 0);
            assert.equal(c.isolatedOutputCount, 3);
            assert.equal(first.cases[1].isolatedOutputCount, 0);
        });
        check('Coverage, segments and applicable-only means', () => {
            assert.equal(first.overall.recommendationCoverage, 0.75);
            assert.equal(first.segments.COLD_START.recommendationCoverage, 0.5);
            assert.equal(first.segments.PARTIAL_KNOWLEDGE.recommendationCoverage, 1);
            assert.equal(first.segments.RICH_KNOWLEDGE.recommendationCoverage, 1);
            assert.equal(first.cases[1].metricsByK[1].relevance, null);
            assert.equal(first.cases[3].metricsByK[1].relevance, null);
            assert.equal(first.overall.metricsByK[1].relevance.applicableCases, 2);
            close(first.overall.metricsByK[1].relevance.value, (first.cases[0].metricsByK[1].relevance + first.cases[2].metricsByK[1].relevance) / 2);
            assert.deepEqual(first.recommendationConfiguration.weights, { interest: 0.33, preference: 0.16, goal: 0.16, exploration: 0.13, behavior: 0.13, session: 0.09 });
            assert.equal(metrics.recommendationCoverage([]), null);
            assert.equal(metrics.applicableMean([null, 0, 1]), 0.5);
        });
        const empty = await evaluateCases({ ...parameters, cases: [] });
        assert.equal(empty.overall.recommendationCoverage, null);
        assert.equal(empty.segments.RICH_KNOWLEDGE.metricsByK[1].relevance.value, null);
        assert.equal(empty.segments.RICH_KNOWLEDGE.explorationRelevanceRate.applicableCases, 0);
        await assert.rejects(evaluateCases({ ...parameters, withCaseEnvironment: undefined }));
        await assert.rejects(evaluateCases({ ...parameters, cases: [cases[0], cases[0]] }));
        await assert.rejects(evaluateCases({ ...parameters, withCaseEnvironment: async () => {} }));
        console.log('PASS required environment and case validation'); checks++;
    } finally { Module._load = originalLoad; }
    assert.equal(Module._load, originalLoad);
    console.log(`${checks} grouped evaluation checks passed; no external writes or LLM execution.`);
    console.log('PHASE 5 D1 EVALUATION FRAMEWORK: PASS');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
