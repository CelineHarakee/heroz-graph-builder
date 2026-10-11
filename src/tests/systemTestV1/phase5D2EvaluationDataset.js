const assert = require('node:assert/strict');
const Module = require('node:module');
const { ObjectId } = require('mongodb');
const { PREFERENCE_VALUES } = require('../../learning/parentDecisionContract');
const { evaluateRecommendationEligibility } = require('../../recommendation/recommendationEligibilityService');
const { calculateBehaviorFactor } = require('../../recommendation/behaviorFactorService');
const { calculateExplorationFactor } = require('../../recommendation/explorationFactorService');
const datasetPath = require.resolve('../../evaluation/datasets/evaluationDatasetV1');
const originalLoad = Module._load;
let dataset;
try {
    // Dataset construction may import BSON identity only: no DB clients, services,
    // learning, graph builders, filesystem writers or language providers.
    Module._load = function(request, parent, isMain) {
        if (parent?.filename === datasetPath) {
            assert.equal(request, 'mongodb', `Forbidden dataset dependency: ${request}`);
            return { ObjectId };
        }
        return originalLoad.call(this, request, parent, isMain);
    };
    dataset = require(datasetPath);
} finally { Module._load = originalLoad; }
const { createEvaluationDatasetV1 } = dataset;
const data = createEvaluationDatasetV1();
const all = data.cases.flatMap(c => c.candidates);
const byId = key => data.cases.find(c => c.caseId === key);
const same = (a, b) => String(a) === String(b);
const profiles = ['COLD_START', 'PARTIAL_KNOWLEDGE', 'RICH_KNOWLEDGE'];
let passed = 0;
function check(label, fn) { fn(); passed++; console.log(`${label}: PASS`); }
function context(c) {
    const f = c.fixture;
    return { child: f.children[0], parent: f.parents[0],
        candidates: c.candidates.map(annotation => ({ activity: { activityId: annotation.activityId },
            currentActivity: f.activities.find(a => same(a._id, annotation.activityId)), currentVendor: f.vendors[0],
            currentSessions: f.sessions.filter(s => same(s.activityId, annotation.activityId)), evidence: { interests: [], goals: [], summary: [] } })),
        historyContext: { bookings: f.bookings, recommendations: f.recommendations, interactions: f.interactions,
            sources: { bookings: 'available', recommendations: 'available', interactions: 'available' } },
        interestContext: { childInterests: f.child_interests, subcategories: f.subcategories }, goalContext: { goals: f.goal_library } };
}
const evaluations = new Map(data.cases.map(c => [c.caseId, evaluateRecommendationEligibility(context(c), data.evaluatedAt)]));
const frozenGrades = {
    C1: [3, 3, 1, 0, 0, 0], C2: [3, 3, 2, 2, 1, 0], C3: [3, 3, 2, 0, 0, 0], C4: [1, 1, 1, 1, 1, 1],
    P1: [3, 3, 2, 1, 2, 0], P2: [3, 3, 2, 2, 1, 0], P3: [3, 3, 2, 2, 1, 0], P4: [3, 3, 2, 2, 1, 0],
    R1: [3, 3, 2, 2, 1, 0], R2: [3, 3, 3, 3, 2, 0], R3: [3, 3, 2, 2, 1, 0], R4: [3, 3, 3, 2, 2, 0]
};
const explorationIndices = { C1: [2], C2: [3], C3: [2], C4: [0, 1, 2, 3, 4, 5], P1: [3], P2: [3, 4], P3: [3, 4], P4: [2, 3], R1: [3, 4], R2: [4], R3: [3, 4], R4: [4] };
check('A. Dataset identity/version', () => { assert.equal(data.name, 'Evaluation Dataset V1'); assert.equal(data.datasetVersion, 'evaluation-dataset-v1'); assert.equal(data.evaluatedAt.toISOString(), '2026-10-11T10:00:00.000Z'); });
check('B. Exactly 12 cases', () => assert.equal(data.cases.length, 12));
check('C. Four cases per profile state', () => { for (const state of profiles) assert.equal(data.cases.filter(c => c.profileState === state).length, 4); });
check('D. Exact unique case IDs', () => assert.deepEqual(data.cases.map(c => c.caseId), Object.keys(frozenGrades)));
check('E. Six candidates per case / 72 annotations', () => { assert.equal(all.length, 72); data.cases.forEach(c => assert.equal(c.candidates.length, 6)); });
check('F. Unique candidate identities', () => { data.cases.forEach(c => assert.equal(new Set(c.candidates.map(a => a.activityId)).size, 6)); assert.equal(new Set(all.map(a => a.activityId)).size, 72); });
check('G. Frozen integer relevance labels', () => { all.forEach(a => assert.ok(Number.isInteger(a.expectedRelevance) && a.expectedRelevance >= 0 && a.expectedRelevance <= 3)); data.cases.forEach(c => assert.deepEqual(c.candidates.map(a => a.expectedRelevance), frozenGrades[c.caseId])); });
check('H. Human-defined relevance reasons', () => all.forEach(a => assert.ok(typeof a.relevanceReason === 'string' && a.relevanceReason.trim())));
check('I. Frozen independent exploratory annotations', () => data.cases.forEach(c => {
    c.candidates.forEach(a => assert.equal(typeof a.isExploratory, 'boolean'));
    assert.deepEqual(c.candidates.flatMap((a, i) => a.isExploratory ? [i] : []), explorationIndices[c.caseId]);
}));
check('J. Annotation references and D1 activity shape', () => data.cases.forEach(c => c.candidates.forEach(a => {
    assert.ok(same(a.activityId, a.activity._id)); assert.strictEqual(a.activity, c.fixture.activities.find(doc => same(doc._id, a.activityId)));
})));
check('K. Normal candidates pass production eligibility', () => data.cases.forEach(c => {
    const result = evaluations.get(c.caseId); assert.equal(result.requestEligibility.eligible, true);
    assert.equal(result.candidateEvaluations.length, 6);
    result.candidateEvaluations.forEach((e, i) => { if (c.caseId !== 'P2' || i !== 1) { assert.equal(e.eligibility.eligible, true); assert.equal(e.eligibleSessions.length, 1); } });
}));
check('L. Exactly one P2 ineligible candidate', () => assert.equal(evaluations.get('P2').candidateEvaluations.filter(e => !e.eligibility.eligible).length, 1));
check('M. P2 grade-3 Full session rejected by existing rule only', () => {
    const c = byId('P2'), item = c.candidates[1], session = c.fixture.sessions[1], evaluation = evaluations.get('P2').candidateEvaluations[1];
    assert.equal(item.expectedRelevance, 3); assert.equal(session.availability.status, 'Full');
    assert.equal(evaluation.eligibility.eligible, false);
    assert.ok(evaluation.eligibility.failedConstraints.some(f => f.code === 'NO_ELIGIBLE_SESSION'));
    assert.ok(evaluation.sessionEvaluations[0].eligibility.failedConstraints.every(f => f.fieldPath === 'availability.status'));
    // Change only the gate in a fresh instance: all other fields must already work.
    const fresh = createEvaluationDatasetV1().cases.find(c => c.caseId === 'P2');
    fresh.fixture.sessions[1].availability.status = 'Available';
    assert.equal(evaluateRecommendationEligibility(context(fresh), data.evaluatedAt).eligibleCandidates.length, 6);
});
check('N. C4 retains six grade-1 judgments', () => assert.ok(byId('C4').candidates.every(a => a.expectedRelevance === 1)));
check('O. C4 retains six exploratory opportunities', () => assert.ok(byId('C4').candidates.every(a => a.isExploratory)));
check('P. R3 random activity is not exploratory', () => { const a = byId('R3').candidates[5]; assert.equal(a.expectedRelevance, 0); assert.equal(a.isExploratory, false); });
check('Q. Production preference vocabulary', () => data.cases.forEach(c => {
    for (const [dimension, pref] of Object.entries(c.fixture.children[0].preferences)) {
        assert.ok(PREFERENCE_VALUES[dimension].includes(pref.value)); assert.equal(pref.confidenceScore, 1); assert.equal(pref.source, 'Parent');
    }
    for (const a of c.fixture.activities) {
        for (const [dimension, field] of [['environment', 'environment'], ['socialStyle', 'socialStyle'], ['difficulty', 'difficulty'], ['commitmentPreference', 'commitmentType']]) assert.ok(PREFERENCE_VALUES[dimension].includes(a.experience[field]));
        a.experience.experienceStyles.forEach(style => assert.ok(PREFERENCE_VALUES.experienceStyle.includes(style) && style !== 'Mixed'));
    }
}));
check('R. Goal/outcome references and categorical links', () => data.cases.forEach(c => {
    const f = c.fixture;
    for (const g of f.children[0].parentGoals) { assert.equal(g.status, 'Active'); assert.ok([1, 2, 3].includes(g.priority)); assert.ok(f.goal_library.some(doc => same(doc._id, g.goalId) && doc.isActive)); }
    for (const links of [...f.goal_library.map(g => g.relatedOutcomes), ...f.activities.map(a => a.learningOutcomes)]) for (const link of links) {
        assert.deepEqual(Object.keys(link), ['outcomeId']); assert.ok(f.learning_outcomes.some(outcome => same(outcome._id, link.outcomeId)));
    }
}));
check('S. Interest references and persisted state', () => data.cases.forEach(c => c.fixture.child_interests.forEach(i => {
    assert.ok(same(i.childId, c.childId)); assert.ok(c.fixture.subcategories.some(s => same(s._id, i.subcategoryId)));
    assert.ok(i.interestScore.currentScore >= 0 && i.interestScore.currentScore <= 1); assert.ok(i.confidence.currentScore >= 0 && i.confidence.currentScore <= 1); assert.ok(Number.isInteger(i.confidence.evidenceCount));
})));
check('T. Taxonomy references and all diversity relationships', () => {
    const relationships = new Set();
    for (const c of data.cases) {
        const f = c.fixture;
        for (const a of f.activities) {
            const sub = f.subcategories.find(s => same(s._id, a.classification.subcategoryId)); assert.ok(sub); assert.ok(same(sub.categoryId, a.classification.categoryId));
            assert.ok(f.categories.some(cat => same(cat._id, sub.categoryId)));
        }
        for (let i = 0; i < 6; i++) for (let j = i + 1; j < 6; j++) {
            const a = f.activities[i].classification, b = f.activities[j].classification;
            relationships.add(same(a.subcategoryId, b.subcategoryId) ? 0 : same(a.categoryId, b.categoryId) ? 0.5 : 1);
        }
    }
    assert.deepEqual([...relationships].sort(), [0, 0.5, 1]); assert.match(data.taxonomyNote, /not established production vocabulary/);
});
check('U. Historical Save identity and real Behavior evidence', () => data.cases.forEach(c => {
    for (const interaction of c.fixture.interactions) {
        assert.ok(same(interaction.actor.childId, c.childId)); assert.equal(interaction.actor.actorType, 'Child');
        assert.equal(interaction.targetEntity.entityType, 'Activity'); assert.equal(interaction.interactionDetails.interactionType, 'Save');
        const e = evaluations.get(c.caseId).eligibleCandidates.find(e => same(e.candidate.currentActivity._id, interaction.targetEntity.entityId)); assert.ok(e);
        const behavior = calculateBehaviorFactor(context(c), e); assert.equal(behavior.available, true); assert.equal(behavior.evidence[0].selectedInteractionType, 'Save');
    }
    if (c.caseId === 'P4') assert.deepEqual(c.fixture.interactions.map(i => String(i.targetEntity.entityId)), [c.candidates[0].activityId, c.candidates[2].activityId]);
}));
check('V. Development profiles remain empty', () => data.cases.forEach(c => assert.deepEqual(c.fixture.children[0].developmentProfile, [])));
check('W. No benchmark metadata inside Activity documents', () => {
    function inspect(value) {
        if (!value || typeof value !== 'object' || value instanceof Date || value instanceof ObjectId) return;
        for (const [key, v] of Object.entries(value)) { assert.ok(!['expectedRelevance', 'relevanceReason', 'isExploratory', 'caseId', 'profileState', 'datasetVersion'].includes(key)); inspect(v); }
    }
    data.cases.forEach(c => c.fixture.activities.forEach(inspect));
});
check('X. Fresh instances are deeply independent', () => {
    const a = createEvaluationDatasetV1(), b = createEvaluationDatasetV1(); assert.deepEqual(a, b);
    const references = new WeakSet();
    function collect(v) { if (v && typeof v === 'object' && !references.has(v)) { references.add(v); Object.values(v).forEach(collect); } }
    collect(a);
    function separate(v) { if (v && typeof v === 'object') { assert.ok(!references.has(v)); Object.values(v).forEach(separate); } }
    separate(b);
    const before = JSON.stringify(b); a.cases[0].fixture.activities[0].experience.environment = 'Changed';
    a.cases[0].fixture.children[0].identity.dateOfBirth.setUTCFullYear(2000); a.cases[0].candidates[0].expectedRelevance = 0;
    assert.equal(JSON.stringify(b), before); assert.deepEqual(b, createEvaluationDatasetV1());
});
check('Y. BSON IDs and fixed Dates preserved', () => data.cases.forEach(c => {
    for (const docs of Object.values(c.fixture)) for (const doc of docs) assert.ok(doc._id instanceof ObjectId);
    assert.ok(c.fixture.children[0].identity.dateOfBirth instanceof Date);
    for (const s of c.fixture.sessions) { assert.ok(s.schedule.startDateTime instanceof Date); assert.ok(s.schedule.bookingDeadline > data.evaluatedAt); assert.ok(s.schedule.bookingDeadline < s.schedule.startDateTime); }
    c.fixture.interactions.forEach(i => assert.ok(i.timestamp instanceof Date && i.timestamp < data.evaluatedAt));
}));
check('Z. Construction isolation and frozen scenario state', () => {
    assert.equal(Module._load, originalLoad);
    for (const c of data.cases) {
        const f = c.fixture, child = f.children[0];
        for (const name of ['parent_decisions', 'question_history', 'ai_jobs', 'graph_sync_queue', 'bookings']) assert.deepEqual(f[name], []);
        assert.equal(child.status, 'Active'); assert.ok(same(child.parentId, f.parents[0]._id)); assert.equal(f.parents[0].account.status, 'Active');
        if (['C2', 'C3', 'C4'].includes(c.caseId)) assert.deepEqual(f.child_interests, []);
        if (['C1', 'C3', 'C4'].includes(c.caseId)) assert.deepEqual(child.preferences, {});
        if (c.caseId.startsWith('C') || ['P1', 'P2', 'P3'].includes(c.caseId)) assert.deepEqual(f.interactions, []);
        if (!['C3', 'P2', 'R1', 'R4'].includes(c.caseId)) assert.deepEqual(child.parentGoals, []);
        if (c.caseId !== 'R3') assert.deepEqual(f.recommendations, []);
    }
    const c = byId('R3'), e = evaluations.get('R3').candidateEvaluations;
    assert.equal(c.fixture.recommendations.length, 3);
    for (const i of [3, 4]) assert.equal(calculateExplorationFactor(context(c), e[i]).evidence[0].noveltyState, 'new');
    for (const i of [0, 1, 2]) assert.equal(calculateExplorationFactor(context(c), e[i]).evidence[0].noveltyState, 'exposed');
});
assert.equal(passed, 26);
console.log('26/26 dataset validation groups passed; 12 cases / 72 annotations.');
console.log('PHASE 5 D2 EVALUATION DATASET: PASS');
