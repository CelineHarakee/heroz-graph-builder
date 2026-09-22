const assert = require('assert');
const { ObjectId } = require('mongodb');
const { isDeepStrictEqual } = require('util');
const { processLearningSource } = require('../learning/learningEventProcessor');
const { processContinuousLearningSource } = require('../learning/continuousLearningService');
const { evaluateRepeatLimit } = require('../learning/repeatLimitService');
const { getLearningInstruction } = require('../learning/learningRuleEngine');
const { calculateNextInterestState } = require('../learning/interestStateTransition');
const { persistAppliedInterestLearning } = require('../learning/learningPersistenceService');
const id = n => new ObjectId(n.toString(16).padStart(24,'0'));
const child = id(1), activity = id(2), subcategory = id(3);
const instant = new Date('2026-09-20T12:00:00Z');
const copy = v => v instanceof ObjectId ? new ObjectId(v) : v instanceof Date ? new Date(v) :
    Array.isArray(v) ? v.map(copy) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k,x])=>[k,copy(x)])) : v;
function raw(type,n,time=instant) {
    return {_id:id(n),actor:{childId:child},targetEntity:{entityType:'Activity',entityId:activity},
        interactionDetails:{interactionType:type,ratingValue:5},timestamp:new Date(time)};
}
function fixture() {
    const f = {data:{children:[{_id:child,developmentProfile:[]}],activities:[{_id:activity,classification:{subcategoryId:subcategory}}],
        subcategories:[{_id:subcategory}],child_interests:[],ai_jobs:[],graph_sync_queue:[]},admissions:0,commits:0,aborts:0,writes:0};
    let staged,active=false;
    const session = {startTransaction(){assert(!active);staged=copy(f.data);active=true;},inTransaction:()=>active,
        async commitTransaction(){f.data=staged;active=false;f.commits++;},async abortTransaction(){active=false;staged=null;f.aborts++;},async endSession(){}};
    f.client = {startSession:()=>session};
    const at = (d,k)=>k.split('.').reduce((v,p)=>v?.[p],d);
    function matches(d,q) {return Object.entries(q).every(([k,v])=>{
        const actual=at(d,k);
        if(v?.$exists===false)return actual===undefined;
        if(v?.$in)return v.$in.some(x=>isDeepStrictEqual(x,actual));
        if(v?.$gte)return actual>=v.$gte&&actual<=v.$lte;
        return isDeepStrictEqual(actual,v);
    });}
    function store(options) {
        if(active){assert.strictEqual(options?.session,session,'Every transactional read/write must use the real active session');return staged;}
        assert(!options?.session);return f.data;
    }
    f.db={client:f.client,collection(name){assert(Object.hasOwn(f.data,name));return {
        async findOne(q,options){const data=store(options);if(active&&name==='ai_jobs'&&!q.idempotencyKey){f.admissions++;if(f.failAdmission)throw Error('private database error');}
            return copy(data[name].find(d=>matches(d,q))??null);},
        find(q,options){const data=store(options);if(active){f.admissions++;if(f.failAdmission)throw Error('private database error');}
            return {toArray:async()=>copy(data[name].filter(d=>matches(d,q)))};},
        async insertOne(d,options){assert(active);store(options)[name].push(copy(d));f.writes++;return {insertedId:d._id};},
        async updateOne(q,u,options){assert(active);const d=store(options)[name].find(d=>matches(d,q));if(!d)return {matchedCount:0};Object.assign(d,copy(u.$set));f.writes++;return {matchedCount:1};}
    };}};
    return f;
}
async function early(f,doc) {return (await processLearningSource('Interaction',doc,{db:f.db}))[0];}
async function run(f,doc,checked) {
    const options={db:f.db,client:f.client};
    if(checked)options.dependencies={processLearningSource:async()=>[checked]};
    return (await processContinuousLearningSource('Interaction',doc,options)).results[0];
}
async function seedSaved(f) {assert.strictEqual((await run(f,raw('Save',50,new Date(+instant-3600000)))).status,'APPLIED');}
async function sameTypeRace(type,reverse=false,offset=0) {
    const f=fixture();if(type==='Unsave')await seedSaved(f);
    const baseline=copy(f.data);
    const a=raw(type,reverse?200:100),b=raw(type,reverse?100:200,new Date(+instant+offset));
    const gateA=await early(f,a),gateB=await early(f,b);
    assert.strictEqual(gateA.status,'VALID');assert.strictEqual(gateB.status,'VALID');
    assert.strictEqual((await run(f,a,gateA)).status,'APPLIED');
    const committed=copy(f.data),writes=f.writes,checks=f.admissions;
    const result=await run(f,b,gateB);
    const transition=['Save','Unsave'].includes(type);
    const reason=transition?(reverse?'OUT_OF_ORDER_EVENT':'NO_STATE_TRANSITION'):'REPEAT_LIMIT_REACHED';
    assert.strictEqual(result.reasonCode,reason);assert.strictEqual(result.status,reverse&&transition?'REJECTED':'IGNORED');
    assert.strictEqual(result.persistence.reasonCode,reason);assert.strictEqual(result.retryable,false);
    assert.strictEqual(f.admissions,checks+1,'A transactional rejection must not retry');
    assert.strictEqual(f.writes,writes);assert.deepStrictEqual(f.data,committed);
    const state=f.data.child_interests[0],prior=baseline.child_interests[0];
    assert.strictEqual(state.scoreHistory.length,(prior?.scoreHistory.length??0)+1);
    assert.strictEqual(state.confidence.evidenceCount,(prior?.confidence.evidenceCount??0)+1);
    const delta=getLearningInstruction(gateA.event).learning;
    assert(Math.abs(state.interestScore.currentScore-(prior?.interestScore.currentScore??0.5)-delta.interestDelta)<1e-12);
    assert(Math.abs(state.confidence.currentScore-(prior?.confidence.currentScore??0.2)-delta.confidenceDelta)<1e-12);
    assert.strictEqual(f.data.ai_jobs.length,baseline.ai_jobs.length+1);assert.strictEqual(f.data.graph_sync_queue.length,baseline.graph_sync_queue.length+1);
    assert.deepStrictEqual(f.data.children,baseline.children);
    const beforeReplay=f.admissions;
    assert.strictEqual((await run(f,a,gateA)).reasonCode,'DUPLICATE_EVENT');
    assert.strictEqual(f.admissions,beforeReplay,'Transactional replay must precede admission');
    assert.deepStrictEqual(f.data,committed);
}
async function main() {
    for(const type of ['View','Click','Dismiss'])for(const offset of [0,1000])await sameTypeRace(type,false,offset);
    for(const type of ['Save','Unsave'])for(const reverse of [false,true])await sameTypeRace(type,reverse);
    // UTC boundaries remain separate days even when expressed with an offset.
    for(const type of ['View','Click','Dismiss']) {
        const f=fixture();
        assert.strictEqual((await run(f,raw(type,100,'2026-09-20T23:59:59.999Z'))).status,'APPLIED');
        assert.strictEqual((await run(f,raw(type,200,'2026-09-21T03:00:00+03:00'))).status,'APPLIED');
        assert.strictEqual(f.data.ai_jobs.length,2);
    }
    for(const [first,second,saved] of [['Save','Unsave',false],['Unsave','Save',true]]) {
        const f=fixture();if(saved)await seedSaved(f);
        assert.strictEqual((await run(f,raw(first,100))).status,'APPLIED');
        assert.strictEqual((await run(f,raw(second,200))).status,'APPLIED');
        assert.strictEqual(f.data.ai_jobs.length,saved?3:2);
        // Replay of the earlier transition still wins over a newer checkpoint.
        const before=copy(f.data),queries=f.admissions;
        assert.strictEqual((await run(f,raw(first,100))).reasonCode,'DUPLICATE_EVENT');
        assert.strictEqual(f.admissions,queries);assert.deepStrictEqual(f.data,before);
    }
    // Time precedes identity; newer low ID accepted, older high ID stale.
    const ordered=fixture();assert.strictEqual((await run(ordered,raw('Save',200))).status,'APPLIED');
    assert.strictEqual((await run(ordered,raw('Unsave',100,new Date(+instant+1000)))).status,'APPLIED');
    assert.strictEqual((await run(ordered,raw('Save',300,instant))).reasonCode,'OUT_OF_ORDER_EVENT');
    // Ignore non-applied jobs even if their checkpoint would otherwise be newer.
    for(const change of [{status:'FAILED'},{status:'REJECTED'},{status:'PROCESSING'},{outcome:'IGNORED'}]) {
        const f=fixture();await seedSaved(f);
        f.data.ai_jobs.push({...copy(f.data.ai_jobs[0]),_id:id(800),idempotencyKey:'other',...change,
            source:{documentId:String(id(900))},event:{...f.data.ai_jobs[0].event,eventType:'Unsave',occurredAt:new Date(+instant+1000)}});
        assert.strictEqual((await run(f,raw('Unsave',100))).status,'APPLIED');
    }
    // Canonical ordering is independent of job IDs, BSON type, hex case and storage order.
    for(const object of [false,true]) {
        const f=fixture();await seedSaved(f);
        const seed=f.data.ai_jobs[0];seed.source.documentId=object?id(0xab):String(id(0xab)).toUpperCase();seed.event.occurredAt=instant;
        const e={...(await early(f,raw('Unsave',0xac))).event,eventId:object?id(0xac):String(id(0xac)).toUpperCase()};
        assert.strictEqual((await evaluateRepeatLimit(e,{db:f.db})).status,'VALID');
        seed.source.documentId=object?id(0xad):String(id(0xad)).toUpperCase();
        assert.strictEqual((await evaluateRepeatLimit(e,{db:f.db})).reasonCode,'OUT_OF_ORDER_EVENT');
        const earlier=copy(seed);earlier._id=id(999);earlier.source.documentId=String(id(0xaa));earlier.event.eventType='Unsave';
        f.data.ai_jobs.push(earlier);
        assert.strictEqual((await evaluateRepeatLimit({...e,eventId:String(id(0xae))},{db:f.db})).status,'VALID');
    }
    // An ignored absent Unsave creates no checkpoint and is never retroactively applied.
    const ignored=fixture();
    assert.strictEqual((await run(ignored,raw('Unsave',200))).reasonCode,'NO_STATE_TRANSITION');
    assert.strictEqual(ignored.data.ai_jobs.length,0);
    assert.strictEqual((await run(ignored,raw('Save',100))).status,'APPLIED');
    assert.strictEqual(ignored.data.ai_jobs.length,1);
    // An unusable durable identity fails closed; no job-ID fallback is invented.
    const malformed=fixture();await seedSaved(malformed);
    const validUnsave=await early(malformed,raw('Unsave',100));
    delete malformed.data.ai_jobs[0].source.documentId;
    const malformedBefore=copy(malformed.data);
    assert.strictEqual((await run(malformed,raw('Unsave',100),validUnsave)).reasonCode,'INVALID_PROCESSING_STATE');
    assert.deepStrictEqual(malformed.data,malformedBefore);
    // Revalidation read errors abort without exposing internal errors or writing.
    const failed=fixture(),doc=raw('View',100),gate=await early(failed,doc),before=copy(failed.data);
    failed.failAdmission=true;const failure=await run(failed,doc,gate);
    assert.strictEqual(failure.reasonCode,'DATABASE_ERROR');assert(!JSON.stringify(failure).includes('private'));assert.deepStrictEqual(failed.data,before);assert.strictEqual(failed.writes,0);
    // Stale supplied state remains concurrency, not repeat rejection; retry can recheck admission.
    const stale=fixture(),a=raw('View',100),b=raw('View',200);const checked=await early(stale,b);
    const instruction=getLearningInstruction(checked.event),calculated=calculateNextInterestState(null,instruction,checked.event);
    await run(stale,a);
    const r=await persistAppliedInterestLearning({client:stale.client,db:stale.db,event:checked.event,instruction,currentState:null,nextState:calculated.state});
    assert.strictEqual(r.reasonCode,'CONCURRENT_STATE_CHANGE');
    // Uncapped families make no admission reads and retain per-source idempotency.
    for(const type of ['Book','Attend','Rate']) {
        const noReads={collection(){throw Error('Admission must not query this family');}};
        assert.strictEqual((await evaluateRepeatLimit({eventType:type},{db:noReads})).status,'VALID');
    }
    console.log('D7H activity admission concurrency tests: PASSED');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
