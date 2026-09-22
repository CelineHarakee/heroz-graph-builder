const assert = require('assert');
const { ObjectId } = require('mongodb');
const { isDeepStrictEqual } = require('util');
const { processContinuousLearningSource: processSource } = require('../learning/continuousLearningService');
const { normalizeParentDecision } = require('../learning/eventNormalizer');
const { checkParentDecisionPreflight } = require('../learning/parentDecisionPreflightService');
const { calculateNextPreferences } = require('../learning/preferenceDecisionTransition');
const { calculateNextParentGoals } = require('../learning/goalDecisionTransition');
const parentId = new ObjectId(), childId = new ObjectId(), goalId = new ObjectId();
const date = (hour) => new Date(Date.UTC(2026, 8, 20, hour));
const conflict = { status: 'NOT_APPLIED', reasonCode: 'CONCURRENT_STATE_CHANGE', retryable: true };
const copy = (v) => v instanceof ObjectId ? new ObjectId(v) : v instanceof Date ? new Date(v) :
    Array.isArray(v) ? v.map(copy) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k,x]) => [k,copy(x)])) : v;
function source(type = 'PreferenceUpdated', hour = 15) {
    return { _id: new ObjectId(), parentId, childId, decisionType: type, occurredAt: date(hour),
        decisionData: type === 'PreferenceUpdated' ? { dimension: 'environment', value: 'Indoor' } :
            { goalId, ...(type === 'GoalRemoved' ? {} : { priority: 1 }) } };
}
function job(s) {
    return { _id: s._id, jobType: 'ContinuousLearning', status: 'COMPLETED', outcome: 'APPLIED', resultStatus: 'APPLIED',
        idempotencyKey: `parentDecision:${s._id}:${s.decisionType}`,
        components: { [s.decisionType === 'PreferenceUpdated' ? 'preference' : 'goals']: { status: 'APPLIED', completedAt: date(16) } },
        audit: { source: 'ParentDecision', decisionId: s._id, childId, occurredAt: s.occurredAt,
            target: s.decisionType === 'PreferenceUpdated' ? { type: 'preference', key: 'environment' } : { type: 'goal', key: String(goalId) },
            sourceSnapshot: { decisionId: s._id, parentId, childId, decisionType: s.decisionType, decisionData: copy(s.decisionData), occurredAt: s.occurredAt } } };
}
const active = (priority = 2) => [{ goalId, priority, status: 'Active', selectedBy: 'Parent', selectedAt: date(1), targetDate: null }];
function fixture(type = 'PreferenceUpdated') {
    const f = { raw: source(type), jobs: [], trace: [], attempts: [], calculations: [], child: { _id: childId, parentId, parentGoals: [] }, forbidden: [] };
    f.stored = f.raw;
    const at = (d,k) => k.split('.').reduce((v,p) => v?.[p],d);
    f.db = { client: {}, collection(name) {
        assert(['parent_decisions','ai_jobs','children','parents','goal_library'].includes(name));
        return { async findOne(query, options) {
            if (name === 'children') { f.trace.push('child'); return copy(f.child); }
            if (name === 'parents') return { _id: parentId };
            if (name === 'goal_library') return { _id: goalId, isActive: true };
            if (name === 'parent_decisions') return copy(f.stored);
            const matches = f.jobs.filter(j => Object.entries(query).every(([k,v]) => isDeepStrictEqual(at(j,k),v)));
            if (options?.sort) matches.sort((a,b) => b.audit.occurredAt-a.audit.occurredAt);
            return copy(matches[0] ?? null);
        } };
    } };
    f.dependencies = {
        async processLearningSource(type, raw, options) { f.trace.push('D7C'); assert.strictEqual(type,'ParentDecision'); assert.strictEqual(options.db,f.db);
            return f.checked || [{ status: 'VALID', event: normalizeParentDecision(raw) }]; },
        async checkParentDecisionPreflight(args) { f.trace.push('preflight'); return checkParentDecisionPreflight(args); },
        calculateNextPreferences(state,event) { f.trace.push('preference'); const t = calculateNextPreferences(state,event); f.calculations.push({state,t}); return t; },
        calculateNextParentGoals(state,event) { f.trace.push('goals'); const t = calculateNextParentGoals(state,event); f.calculations.push({state,t}); return t; },
        async persistParentDecision(args) {
            f.trace.push('persist'); f.attempts.push(args);
            assert.strictEqual(args.db,f.db); assert.strictEqual(args.client,f.db.client);
            assert.strictEqual(args.transition,f.calculations.at(-1).t);
            assert.strictEqual(args.event.eventType === 'PreferenceUpdated' ? args.currentPreferences : args.currentParentGoals,f.calculations.at(-1).state);
            return f.onPersist ? f.onPersist(args) : { status: 'APPLIED', reasonCode: 'PARENT_DECISION_PERSISTED', queueIntentCreated: type !== 'PreferenceUpdated', private: 'secret' };
        }
    };
    for (const name of ['getLearningInstruction','calculateNextInterestState','resolveOutcomeLearningContext','getOutcomeLearningInstruction','calculateNextDevelopmentProfile','persistAppliedInterestLearning','persistAppliedContinuousLearning']) {
        f.dependencies[name] = () => { f.forbidden.push(name); throw Error('Cross-family call'); };
    }
    return f;
}
async function run(f) {
    const before = copy(f.raw);
    const response = await processSource('ParentDecision',f.raw,{db:f.db,dependencies:f.dependencies});
    assert.deepStrictEqual(f.raw,before); assert.deepStrictEqual(f.forbidden,[]);
    assert.strictEqual(response.status,'COMPLETED'); assert.strictEqual(response.results.length,1);
    const r = response.results[0];
    assert(!JSON.stringify(r).includes('secret')); assert(!Object.hasOwn(r,'audit'));
    assert.strictEqual(r.source,'ParentDecision');
    return r;
}
async function main() {
    for (const type of ['PreferenceUpdated','GoalSelected','GoalUpdated','GoalRemoved']) {
        const f = fixture(type);
        if (['GoalUpdated','GoalRemoved'].includes(type)) f.child.parentGoals = active();
        const r = await run(f);
        assert.strictEqual(r.status,'APPLIED');
        assert.deepStrictEqual(f.trace,['D7C','preflight','child',type === 'PreferenceUpdated' ? 'preference' : 'goals','persist']);
        assert.strictEqual(r.queueIntentCreated,type !== 'PreferenceUpdated');
        assert.strictEqual(r.idempotencyKey,normalizeParentDecision(f.raw).processing.idempotencyKey);
        assert.strictEqual(r.component,type === 'PreferenceUpdated' ? 'preference' : 'goals');
        const replay = fixture(type); replay.jobs = [job(replay.raw),job(source(type,20))];
        assert.strictEqual((await run(replay)).reasonCode,'DUPLICATE_EVENT');
        assert.deepStrictEqual(replay.trace,['D7C','preflight']); assert.strictEqual(replay.attempts.length,0);
    }
    for (const provenance of ['Onboarding','Parent']) {
        const f = fixture(); f.child.preferences = { environment: {value:'Indoor',confidenceScore:0.5,source:provenance,updatedAt:date(provenance === 'Onboarding' ? 20 : 1)} };
        assert.strictEqual((await run(f)).status,'APPLIED'); assert.strictEqual(f.attempts.length,1);
        assert.strictEqual(f.attempts[0].transition.nextState.source,'Parent');
    }
    const invalid = fixture(); invalid.child.preferences = [];
    assert.strictEqual((await run(invalid)).reasonCode,'INVALID_EXISTING_PREFERENCE_STATE'); assert.strictEqual(invalid.attempts.length,0);
    for (const [type,goals,reason] of [['GoalSelected',active(),'DUPLICATE_GOAL_SELECTION'],['GoalRemoved',[],'GOAL_NOT_SELECTED'],
        ['GoalUpdated',[],'GOAL_NOT_SELECTED'],['GoalUpdated',active(1),'NO_GOAL_CHANGE']]) {
        const f = fixture(type); f.child.parentGoals = goals; f.jobs = [job(source('GoalSelected',2))];
        const before = copy(f.jobs); const r = await run(f);
        assert.strictEqual(r.status,'IGNORED'); assert.strictEqual(r.reasonCode,reason); assert.strictEqual(f.attempts.length,0);
        assert.deepStrictEqual(f.jobs,before); assert.strictEqual(r.persistence,null); assert.strictEqual(r.queueIntentCreated,false);
    }
    for (const type of ['GoalSelected','GoalUpdated','GoalRemoved']) {
        const f = fixture(type); f.raw.occurredAt = date(13);
        f.jobs = [job(source('GoalSelected',10)),job(source('GoalUpdated',12)),job(source('GoalRemoved',14))];
        const r = await run(f); assert.strictEqual(r.reasonCode,'OUT_OF_ORDER_PARENT_DECISION');
        assert.deepStrictEqual(f.trace,['D7C','preflight']);
    }
    for (const missing of [true,false]) {
        const f = fixture(); f.stored = missing ? null : {...f.raw, parentId:new ObjectId()};
        assert.strictEqual((await run(f)).reasonCode,missing ? 'PARENT_DECISION_SOURCE_MISSING' : 'PARENT_DECISION_SOURCE_CONFLICT');
        assert.deepStrictEqual(f.trace,['D7C','preflight']);
    }
    for (const reason of ['DUPLICATE_EVENT','OUT_OF_ORDER_PARENT_DECISION','PARENT_DECISION_SOURCE_MISSING','PARENT_DECISION_SOURCE_CONFLICT','INVALID_PARENT_AUTHORITY','DATABASE_ERROR','CONCURRENT_STATE_CHANGE']) {
        const f = fixture(); const status = reason === 'DUPLICATE_EVENT' ? 'IGNORED' : reason === 'DATABASE_ERROR' ? 'FAILED' : 'NOT_APPLIED';
        f.onPersist = () => ({status,reasonCode:reason,retryable:reason === 'DATABASE_ERROR',error:new Error('secret')});
        const r = await run(f); assert.strictEqual(r.reasonCode,reason); assert.strictEqual(r.status,status); assert.strictEqual(f.attempts.length,1);
    }
    const fresh = fixture();
    fresh.onPersist = () => { if (fresh.attempts.length === 1) { fresh.child.preferences = {environment:{value:'Outdoor',confidenceScore:1,source:'Parent',updatedAt:date(2)}}; return conflict; }
        return {status:'APPLIED',reasonCode:'PARENT_DECISION_PERSISTED'}; };
    assert.strictEqual((await run(fresh)).status,'APPLIED'); assert.strictEqual(fresh.attempts.length,2);
    assert.strictEqual(fresh.attempts[0].currentPreferences,undefined); assert.strictEqual(fresh.attempts[1].currentPreferences.environment.value,'Outdoor');
    assert.notStrictEqual(fresh.attempts[0].transition,fresh.attempts[1].transition);
    assert.deepStrictEqual(fresh.trace,['D7C','preflight','child','preference','persist','preflight','child','preference','persist']);
    const stale = fixture(); stale.onPersist = () => { stale.jobs.push(job(source('PreferenceUpdated',20))); return conflict; };
    assert.strictEqual((await run(stale)).reasonCode,'OUT_OF_ORDER_PARENT_DECISION');
    assert.deepStrictEqual(stale.trace,['D7C','preflight','child','preference','persist','preflight']);
    const noop = fixture('GoalSelected'); noop.onPersist = () => { noop.child.parentGoals = active(); return conflict; };
    assert.strictEqual((await run(noop)).reasonCode,'DUPLICATE_GOAL_SELECTION'); assert.strictEqual(noop.attempts.length,1); assert.strictEqual(noop.calculations.length,2);
    const exhausted = fixture(); exhausted.onPersist = () => conflict;
    const exhaustedResult = await run(exhausted);
    assert.strictEqual(exhaustedResult.status,'FAILED'); assert.strictEqual(exhaustedResult.reasonCode,'CONCURRENT_RETRY_EXHAUSTED');
    assert.strictEqual(exhausted.attempts.length,3); assert.strictEqual(exhausted.trace.filter(x=>x==='preflight').length,3);
    for (const status of ['IGNORED','REJECTED','FAILED']) {
        const f = fixture(); f.checked = [{status,reasonCode:'STOP',event:normalizeParentDecision(f.raw),error:'secret'}];
        assert.strictEqual((await run(f)).status,status); assert.deepStrictEqual(f.trace,['D7C']);
    }
    const missingChild = fixture(); missingChild.child = null;
    assert.strictEqual((await run(missingChild)).reasonCode,'CHILD_NOT_FOUND'); assert.strictEqual(missingChild.attempts.length,0);
    for (const stage of ['checkParentDecisionPreflight','persistParentDecision','calculateNextPreferences']) {
        const f = fixture(); f.dependencies[stage] = () => {throw Error('secret');};
        assert.strictEqual((await run(f)).reasonCode,stage === 'calculateNextPreferences' ? 'PROCESSING_ERROR' : 'DATABASE_ERROR');
    }
    // Real D7C with fake references, real preflight and transition; only persistence is injected.
    const real = fixture('GoalSelected'); delete real.dependencies.processLearningSource;
    assert.strictEqual((await run(real)).status,'APPLIED');
    // Activity paths must never call a ParentDecision dependency, including unsupported Complete.
    for (const [sourceType,type] of [['Interaction','View'],['Interaction','Click'],['Interaction','Save'],['Interaction','Unsave'],['Interaction','Dismiss'],['Interaction','Rate'],['Booking','Book'],['Booking','Attend'],['Interaction','Complete']]) {
        let cross = 0, interest = 0, combined = 0;
        const event = {eventId:String(new ObjectId()),eventType:type,childId:String(childId),
            subcategoryId:String(goalId),activityId:String(parentId),occurredAt:date(15),eventData:{ratingValue:5}};
        const persist = (args, both) => {
            if (both) combined++; else interest++;
            return {status:'APPLIED',reasonCode:'PERSISTED',state:{...(both ? args.nextInterestState : args.nextState),_id:new ObjectId()}};
        };
        const dependencies = {processLearningSource:async()=>[{status:'VALID',event}],
            resolveOutcomeLearningContext:async()=>({status:'NOT_APPLICABLE',reasonCode:'NO_MAPPED_OUTCOMES'}),
            persistAppliedInterestLearning:async args=>persist(args,false),
            persistAppliedContinuousLearning:async args=>persist(args,true)};
        for (const name of ['checkParentDecisionPreflight','calculateNextPreferences','calculateNextParentGoals','persistParentDecision']) dependencies[name] = () => {cross++; throw Error('Cross-family');};
        const db = {client:{},collection(name) {assert(['children','child_interests'].includes(name));
            return {findOne:async()=>name === 'children' ? {developmentProfile:[]} : null};}};
        const response = await processSource(sourceType,{}, {db,dependencies});
        const r = response.results[0];
        assert.strictEqual(cross,0);
        if (type === 'Complete') { assert.strictEqual(r.reasonCode,'UNSUPPORTED_EVENT_TYPE'); assert.strictEqual(interest+combined,0); }
        else {
            assert.strictEqual(r.status,'APPLIED');
            assert.deepStrictEqual(r.requiredComponents,type === 'Attend' ? ['interest','outcomes'] : ['interest']);
            assert.strictEqual(combined,type === 'Attend' ? 1 : 0); assert.strictEqual(interest,type === 'Attend' ? 0 : 1);
        }
    }
    const unsupported = await processSource('Other',{},{});
    assert.strictEqual(unsupported.results[0].reasonCode,'UNSUPPORTED_SOURCE');
    console.log('Parent decision continuous learning unit tests: PASSED');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
