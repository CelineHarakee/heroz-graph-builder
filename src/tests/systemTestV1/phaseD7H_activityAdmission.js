// Explicit isolated development verification. No app, graph or worker imports.
// node src/tests/systemTestV1/phaseD7H_activityAdmission.js --run-live-development
const assert = require('assert');
const { randomUUID } = require('crypto');
const { ObjectId } = require('mongodb');
const { processContinuousLearningSource } = require('../../learning/continuousLearningService');
const { processLearningSource } = require('../../learning/learningEventProcessor');
const { getLearningInstruction } = require('../../learning/learningRuleEngine');
const names = ['children','child_interests','interactions','bookings','activities','subcategories','learning_outcomes','ai_jobs','graph_sync_queue','parents','goal_library','parent_decisions','recommendations'];
const mutable = ['graph_sync_queue','ai_jobs','child_interests','interactions','bookings','children','activities','subcategories','learning_outcomes'];
const counts = data => Object.fromEntries(names.map(n=>[n,data[n].length]));
async function snapshot(db) {
    const data={}; for(const name of names)data[name]=await db.collection(name).find({}).sort({_id:1}).toArray(); return data;
}
async function indexes(db) {
    const all={},existing=new Set((await db.listCollections({}, {nameOnly:true}).toArray()).map(c=>c.name));
    for(const n of names)all[n]=existing.has(n)?await db.collection(n).listIndexes().toArray():[];
    for(const [collection,name,key] of [['child_interests','uniq_child_interest',{childId:1,subcategoryId:1}],['ai_jobs','uniq_learning_idempotency',{jobType:1,idempotencyKey:1}]]) {
        const index=all[collection].find(i=>i.name===name);assert(index?.unique);assert.deepStrictEqual(index.key,key);
    }
    return all;
}
async function main() {
    if(process.argv.length!==3||process.argv[2]!=='--run-live-development') {
        console.log('D7H live verification skipped: --run-live-development is required; no database access.');return;
    }
    const config=require('../../config/mongodb');
    const marker=`D7H_ACTIVITY_ADMISSION_${randomUUID()}`;
    const captured=Object.fromEntries(names.map(n=>[n,new Map()]));
    const report={marker,scenarios:{}};
    let db,client,baseline,beforeIndexes,failure,existingCollections,rollback=false,injected=false;
    const remember=(name,id)=>{captured[name].set(String(id),id);console.log(JSON.stringify({capture:name,id:String(id),marker}));};
    const testDb={collection(name){
        assert(names.includes(name)); const col=db.collection(name);
        return new Proxy(col,{get(target,key){
            if(key==='insertOne')return async(document,options)=>{
                assert(['child_interests','ai_jobs','graph_sync_queue'].includes(name));assert(options?.session?.inTransaction());
                if(name==='child_interests')assert(captured.children.has(String(document.childId)));
                if(name==='ai_jobs')assert(captured.children.has(document.event.childId));
                if(name==='graph_sync_queue'){assert.strictEqual(document.entityType,'ChildInterest');assert(captured.child_interests.has(String(document.entityId)));}
                remember(name,document._id);const result=await target.insertOne(document,options);
                if(name==='graph_sync_queue'&&rollback){injected=true;throw Error('D7H controlled rollback after queue write');}return result;
            };
            if(key==='updateOne')return async(filter,update,options)=>{
                assert(['children','child_interests'].includes(name));assert(captured[name].has(String(filter._id)));assert(options?.session?.inTransaction());
                return target.updateOne(filter,update,options);
            };
            if(['deleteOne','deleteMany','updateMany','bulkWrite','replaceOne','findOneAndUpdate','createIndex','createIndexes','drop'].includes(key))return ()=>{throw Error('Unexpected mutation');};
            const value=target[key];return typeof value==='function'?value.bind(target):value;
        }});
    }};
    async function insert(name,fields) {
        const document={_id:new ObjectId(),...fields,testDataset:marker};remember(name,document._id);await db.collection(name).insertOne(document);return document;
    }
    const time=n=>new Date(Date.UTC(2026,8,19)+n*3600000);
    let sub,outcome,activity;
    async function fixture(label) {
        const child=await insert('children',{identity:{firstName:`${marker}_${label}`,dateOfBirth:new Date('2018-01-01'),gender:'Female'},status:'Active',developmentProfile:[],preferences:{},parentGoals:[]});
        return {child,activity};
    }
    const interaction=(f,type,n=12)=>insert('interactions',{actor:{childId:f.child._id,actorType:'Child'},targetEntity:{entityType:'Activity',entityId:f.activity._id},
        interactionDetails:{interactionType:type,...(type==='Rate'?{ratingValue:5}:{})},timestamp:time(n),metadata:{version:1}});
    async function pair(f,type,n=12) {
        const a=await interaction(f,type,n),b=await interaction(f,type,n);return [a,b].sort((x,y)=>String(x._id).localeCompare(String(y._id)));
    }
    const booking=(f,n,attend=false)=>insert('bookings',{bookingDetails:{childId:f.child._id,activityId:f.activity._id,status:attend?'Completed':'Confirmed',bookedAt:time(n)},
        ...(attend?{attendance:{status:'Attended',checkedInAt:time(n)}}:{})});
    async function state(f) {
        const interests=await db.collection('child_interests').find({childId:f.child._id}).sort({_id:1}).toArray();
        return {child:await db.collection('children').findOne({_id:f.child._id}),interests,
            jobs:await db.collection('ai_jobs').find({'event.childId':String(f.child._id)}).sort({_id:1}).toArray(),
            queue:await db.collection('graph_sync_queue').find({entityId:{$in:interests.map(i=>i._id)}}).sort({_id:1}).toArray()};
    }
    function metrics(s) {return {child_interests:s.interests.length,scoreHistory:s.interests.reduce((n,i)=>n+i.scoreHistory.length,0),
        evidenceCount:s.interests.reduce((n,i)=>n+i.confidence.evidenceCount,0),ai_jobs:s.jobs.length,graph_sync_queue:s.queue.length};}
    const close=(a,b)=>assert(Math.abs(a-b)<1e-10,`${a} != ${b}`);
    async function call(label,f,doc,status,reason,checked) {
        const before=await state(f),source=doc.bookingDetails?'Booking':'Interaction';
        const options={client,db:testDb};
        // For explicit interleaving cases only: preserve the actual earlier D7C
        // result; all calculation, transaction, reads and writes remain real.
        if(checked)options.dependencies={processLearningSource:async()=>[checked]};
        const response=await processContinuousLearningSource(source,doc,options);assert.strictEqual(response.results.length,1);
        const r=response.results[0];assert.strictEqual(r.status,status,`${label}: ${r.status}/${r.reasonCode}`);assert.strictEqual(r.reasonCode,reason,label);
        const after=await state(f),a=metrics(after),b=metrics(before),delta=Object.fromEntries(Object.keys(a).map(k=>[k,a[k]-b[k]]));
        if(status==='APPLIED') {
            assert.deepStrictEqual(delta,{child_interests:before.interests.length?0:1,scoreHistory:1,evidenceCount:1,ai_jobs:1,graph_sync_queue:1});
            const learned=after.interests[0],previous=before.interests[0];
            const instruction=getLearningInstruction({eventType:r.eventType,eventData:{ratingValue:5}}).learning;
            close(learned.interestScore.currentScore,(previous?.interestScore.currentScore??0.5)+instruction.interestDelta);
            close(learned.confidence.currentScore,(previous?.confidence.currentScore??0.2)+instruction.confidenceDelta);
            const job=after.jobs.find(j=>!before.jobs.some(p=>p._id.equals(j._id)));
            assert.strictEqual(job.jobType,'ContinuousLearning');assert.strictEqual(job.status,'COMPLETED');assert.strictEqual(job.outcome,'APPLIED');
            assert.strictEqual(job.source.documentId,String(doc._id));assert.strictEqual(job.source.eventType,r.eventType);
            assert.strictEqual(job.idempotencyKey,`${source==='Booking'?'booking':'interaction'}:${doc._id}:${r.eventType}`);
            assert(job.event.occurredAt instanceof Date);assert(job.processing.completedAt instanceof Date);assert(job.metadata.createdAt instanceof Date);assert(job.metadata.updatedAt instanceof Date);
            assert.strictEqual(job.event.childId,String(f.child._id));assert.strictEqual(job.event.activityId,String(f.activity._id));assert.strictEqual(job.event.subcategoryId,String(sub._id));
            assert.deepStrictEqual(Object.keys(job.components),r.eventType==='Attend'?['interest','outcomes']:['interest']);
            for(const component of Object.values(job.components)){assert.strictEqual(component.status,'APPLIED');assert(component.completedAt instanceof Date);}
            if(r.eventType==='Attend') {
                const profile=after.child.developmentProfile;assert.strictEqual(profile.length,1);assert(profile[0].outcomeId instanceof ObjectId);assert(profile[0].outcomeId.equals(outcome._id));
                close(profile[0].score,(before.child.developmentProfile[0]?.score??0)+0.1);close(profile[0].confidenceScore,(before.child.developmentProfile[0]?.confidenceScore??0)+0.05);
                assert(profile[0].lastEvidenceAt instanceof Date);assert(profile[0].lastUpdated instanceof Date);assert(profile[0].history.at(-1).timestamp instanceof Date);
                assert.deepStrictEqual({...after.child,developmentProfile:null},{...before.child,developmentProfile:null});
            } else assert.deepStrictEqual(after.child,before.child);
            for(const key of ['_id','childId','subcategoryId'])assert(learned[key] instanceof ObjectId);
            for(const value of [learned.interestScore.lastCalculatedAt,learned.interestScore.lastDecayAt,learned.confidence.lastCalculatedAt,learned.metadata.createdAt,learned.metadata.updatedAt])assert(value instanceof Date);
            for(const h of learned.scoreHistory)assert(h.timestamp instanceof Date);
            assert.strictEqual(learned.scoreHistory.at(-1).eventId,String(doc._id));
            for(const q of after.queue){assert(q._id instanceof ObjectId);assert(q.entityId instanceof ObjectId);assert(q.createdAt instanceof Date);assert.strictEqual(q.entityType,'ChildInterest');assert.strictEqual(q.status,'PENDING');}
        } else {assert.deepStrictEqual(after,before,`${label}: side effects on non-applied result`);assert(Object.values(delta).every(n=>n===0));}
        if(checked&&status!=='APPLIED')assert.strictEqual(r.persistence?.reasonCode,reason,`${label}: must stop inside persistence`);
        report.scenarios[label]={status:r.status,reasonCode:r.reasonCode,delta};console.log(JSON.stringify({scenario:label,...report.scenarios[label]}));return r;
    }
    const applied=(label,f,d,checked)=>call(label,f,d,'APPLIED',d.attendance?'CONTINUOUS_LEARNING_PERSISTED':'INTEREST_LEARNING_PERSISTED',checked);
    try {
        await config.connectMongoDB();db=config.getDatabase();client=db.client;report.database=db.databaseName;
        console.log(JSON.stringify({configuredDatabase:db.databaseName,expectedDevelopmentDatabase:'heroz'}));assert.strictEqual(db.databaseName,'heroz');
        baseline=await snapshot(db);beforeIndexes=await indexes(db);report.baselineCounts=counts(baseline);console.log(JSON.stringify({baselineCounts:report.baselineCounts}));
        existingCollections=new Set((await db.listCollections({}, {nameOnly:true}).toArray()).map(c=>c.name));
        sub=await insert('subcategories',{name:marker,isActive:true});outcome=await insert('learning_outcomes',{name:marker,isActive:true});
        activity=await insert('activities',{name:marker,classification:{subcategoryId:sub._id},learningOutcomes:[{outcomeId:outcome._id}]});
        for(const [label,type] of [['A','View'],['B','Click'],['C','Dismiss']]) {
            const f=await fixture(label),[a,b]=await pair(f,type);await applied(`${label}_first`,f,a);await call(`${label}_second`,f,b,'IGNORED','REPEAT_LIMIT_REACHED');
        }
        const d=await fixture('D');await applied('D_before_midnight',d,await interaction(d,'View',23.999999));await applied('D_after_midnight',d,await interaction(d,'View',24));
        let replay;
        for(const [label,type,reverse] of [['E','Save',false],['F','Save',true],['G','Unsave',false],['H','Unsave',true]]) {
            const f=await fixture(label);if(type==='Unsave')await applied(`${label}_seed`,f,await interaction(f,'Save',11));
            const docs=await pair(f,type);if(reverse)docs.reverse();await applied(`${label}_first`,f,docs[0]);
            await call(`${label}_second`,f,docs[1],reverse?'REJECTED':'IGNORED',reverse?'OUT_OF_ORDER_EVENT':'NO_STATE_TRANSITION');replay={f,doc:docs[0]};
        }
        for(const [label,first,second] of [['I','Save','Unsave'],['J','Unsave','Save']]) {
            const f=await fixture(label);if(first==='Unsave')await applied(`${label}_seed`,f,await interaction(f,'Save',11));
            const a=await interaction(f,first),b=await interaction(f,second);assert(String(a._id)<String(b._id));await applied(`${label}_first`,f,a);await applied(`${label}_second`,f,b);
        }
        await call('K_replay',replay.f,replay.doc,'IGNORED','DUPLICATE_EVENT');
        const l=await fixture('L');await call('L_absent_unsave',l,await interaction(l,'Unsave',14),'IGNORED','NO_STATE_TRANSITION');
        await applied('L_save',l,await interaction(l,'Save',12));await call('L_duplicate_save',l,await interaction(l,'Save',15),'IGNORED','NO_STATE_TRANSITION');
        await applied('L_unsave',l,await interaction(l,'Unsave',13));
        // Actual durable ordering history contains only the two applied transitions.
        assert.deepStrictEqual((await state(l)).jobs.map(j=>j.event.eventType),['Save','Unsave']);
        for(const type of ['Book','Attend','Rate']) {
            const f=await fixture(type),doc=type==='Rate'?await interaction(f,type):await booking(f,12,type==='Attend');
            await applied(`${type}_apply`,f,doc);await call(`${type}_replay`,f,doc,'IGNORED','DUPLICATE_EVENT');
        }
        // Both events pass real D7C before A commits. B then calculates from fresh
        // state; only the new transactional admission check can reject it.
        for(const type of ['View','Click','Dismiss','Save','Unsave']) {
            const f=await fixture(`TX_${type}`);if(type==='Unsave')await applied('TX_Unsave_seed',f,await interaction(f,'Save',11));
            const [a,b]=await pair(f,type);const ca=(await processLearningSource('Interaction',a,{db:testDb}))[0],cb=(await processLearningSource('Interaction',b,{db:testDb}))[0];
            assert.strictEqual(ca.status,'VALID');assert.strictEqual(cb.status,'VALID');await applied(`TX_${type}_winner`,f,a,ca);
            await call(`TX_${type}_loser`,f,b,'IGNORED',['Save','Unsave'].includes(type)?'NO_STATE_TRANSITION':'REPEAT_LIMIT_REACHED',cb);
        }
        const r=await fixture('rollback');await applied('Rollback_seed_Attend',r,await booking(r,11,true));
        rollback=true;try {await call('Rollback_after_writes',r,await booking(r,12,true),'FAILED','DATABASE_ERROR');} finally {rollback=false;}
        assert(injected);report.rollbackVerified=true;
        report.createdCounts=Object.fromEntries(await Promise.all(mutable.map(async n=>[n,await db.collection(n).countDocuments({_id:{$in:[...captured[n].values()]}})])));
        report.bsonTypesVerified=true;report.sourceIdentityContract='ai_jobs.source.documentId and job event IDs are canonical strings; source document _id and state/queue references are ObjectIds; timestamps are BSON Dates';
        assert(!Object.keys(require.cache).some(p=>/\/(queueWorker|graphBuilderService)\.js$|\/config\/neo4j\.js$/.test(p)));
    } catch(error) {failure=error;report.failure={name:error.name,message:error instanceof assert.AssertionError?error.message:'Database/verification operation failed; details suppressed'};}
    finally {
        if(db&&baseline) {
            report.cleanup={};for(const name of mutable)try {const ids=[...captured[name].values()];report.cleanup[name]=ids.length?(await db.collection(name).deleteMany({_id:{$in:ids}})).deletedCount:0;} catch(_){failure ||= Error('Cleanup failed');report.cleanup[name]='FAILED';}
            try {
                report.temporaryCollectionsRemoved=[];
                for(const name of mutable)if(existingCollections&&!existingCollections.has(name)&&captured[name].size){
                    assert.strictEqual(await db.collection(name).countDocuments({}),0);
                    if((await db.listCollections({name},{nameOnly:true}).toArray()).length){await db.collection(name).drop();report.temporaryCollectionsRemoved.push(name);}
                }
                const restored=await snapshot(db);report.restoredCounts=counts(restored);
                for(const name of names){assert.deepStrictEqual(restored[name],baseline[name],`${name}: baseline changed`);assert.strictEqual(await db.collection(name).countDocuments({testDataset:marker}),0);
                    const ids=[...captured[name].values()];if(ids.length)assert.strictEqual(await db.collection(name).countDocuments({_id:{$in:ids}}),0);}
                assert.deepStrictEqual(await indexes(db),beforeIndexes);report.cleanupVerified=true;report.zeroMarkersAndIds=true;report.existingDocumentsUnchanged=true;report.indexesUnchanged=true;
            } catch(_){failure ||= Error('Baseline restoration check failed');report.cleanupVerified=false;}
            console.log(JSON.stringify({cleanup:report.cleanup,restoredCounts:report.restoredCounts,cleanupVerified:report.cleanupVerified}));
        }
        if(client)await client.close();
    }
    console.log(JSON.stringify(report,null,2));
    if(failure){process.exitCode=1;console.log('D7H activity admission live verification: FAILED');return;}
    console.log('D7H activity admission live verification: PASSED (A-L, Book/Attend/Rate, transactional interleavings, rollback and cleanup)');
}
main().catch(()=>{console.error('D7H verification failed before completion; inspect captured IDs and cleanup report.');process.exitCode=1;});
