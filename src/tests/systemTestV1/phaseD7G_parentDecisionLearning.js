// Explicit development-only verification; never imports app wiring or graph workers.
// node src/tests/systemTestV1/phaseD7G_parentDecisionLearning.js --run-live-development
const assert = require('assert');
const { randomUUID } = require('crypto');
const { ObjectId } = require('mongodb');
const { processContinuousLearningSource } = require('../../learning/continuousLearningService');
const names = ['parents','children','goal_library','parent_decisions','ai_jobs','graph_sync_queue',
    'child_interests','activities','subcategories','learning_outcomes','bookings','interactions','recommendations'];
const mutable = ['parent_decisions','ai_jobs','graph_sync_queue','children','parents','goal_library'];
const counts = data => Object.fromEntries(names.map(n => [n,data[n].length]));
async function snapshot(db) {
    const data = {};
    for (const name of names) data[name] = await db.collection(name).find({}).sort({_id:1}).toArray();
    return data;
}
async function indexes(db) {
    const all = {};
    const existing = new Set((await db.listCollections({}, {nameOnly:true}).toArray()).map(c=>c.name));
    for (const name of names) all[name] = existing.has(name) ? await db.collection(name).listIndexes().toArray() : [];
    for (const [collection,name,key] of [['child_interests','uniq_child_interest',{childId:1,subcategoryId:1}],
        ['ai_jobs','uniq_learning_idempotency',{jobType:1,idempotencyKey:1}]]) {
        const index = all[collection].find(i=>i.name===name);
        assert(index?.unique, `Missing required unique index: ${name}`); assert.deepStrictEqual(index.key,key);
    }
    return all;
}
async function main() {
    if (process.argv.length !== 3 || process.argv[2] !== '--run-live-development') {
        console.log('D7G live verification skipped: --run-live-development is required; no database access.'); return;
    }
    // Load the repository config normally; its selected database must be heroz.
    const config = require('../../config/mongodb');
    const marker = `D7G_PARENT_DECISION_LIVE_${randomUUID()}`;
    const captured = Object.fromEntries(names.map(n=>[n,new Map()]));
    const report = {marker,scenarios:{}};
    let db,client,baseline,beforeIndexes,failure,child,parent,goalA,goalB,existingCollections;
    let injectRollback = false, rollbackInjected = false;
    const remember = (name,id) => {
        captured[name].set(String(id),id);
        console.log(JSON.stringify({capture:name,id:String(id),marker}));
    };
    // Guard every production mutation to this run's IDs. The only fault injection
    // is after a real transactional queue insert; persistence must abort all writes.
    const testDb = {collection(name) {
        assert(names.includes(name));
        const collection = db.collection(name);
        return new Proxy(collection,{get(target,key) {
            if (key === 'updateOne') return async (filter,update,options) => {
                assert.strictEqual(name,'children'); assert(captured.children.has(String(filter._id)));
                assert(options?.session?.inTransaction());
                return target.updateOne({...filter,testDataset:marker},update,options);
            };
            if (key === 'insertOne') return async (document,options) => {
                assert(['ai_jobs','graph_sync_queue'].includes(name)); assert(options?.session?.inTransaction());
                if (name === 'ai_jobs') assert(captured.parent_decisions.has(String(document._id)));
                else { assert.strictEqual(document.entityType,'Child'); assert(captured.children.has(String(document.entityId))); }
                remember(name,document._id);
                const result = await target.insertOne(document,options);
                if (name === 'graph_sync_queue' && injectRollback) {rollbackInjected = true; throw Error('D7G test-only rollback after writes');}
                return result;
            };
            if (['deleteOne','deleteMany','updateMany','bulkWrite','replaceOne','findOneAndUpdate','createIndex','createIndexes','drop'].includes(key)) {
                return () => {throw Error('Unexpected production mutation');};
            }
            const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
        }});
    }};
    async function insert(name,fields) {
        assert(mutable.includes(name));
        const doc = {_id:new ObjectId(),...fields,testDataset:marker}; remember(name,doc._id);
        await db.collection(name).insertOne(doc); return doc;
    }
    const time = n => new Date(Date.UTC(2026,8,19) + n*3600000);
    const decision = (type,n,data,owner=parent._id) => insert('parent_decisions',{
        parentId:owner,childId:child._id,decisionType:type,decisionData:data,occurredAt:time(n)});
    async function state() {
        return {child:await db.collection('children').findOne({_id:child._id}),
            jobs:await db.collection('ai_jobs').find({'audit.childId':child._id}).sort({_id:1}).toArray(),
            queue:await db.collection('graph_sync_queue').find({entityId:child._id}).sort({_id:1}).toArray()};
    }
    function verifyAudit(job,doc,previous,next) {
        const pref = doc.decisionType === 'PreferenceUpdated', component = pref ? 'preference' : 'goals';
        assert(job._id instanceof ObjectId); assert(job._id.equals(doc._id));
        assert.strictEqual(job.jobType,'ContinuousLearning'); assert.strictEqual(job.idempotencyKey,`parentDecision:${doc._id}:${doc.decisionType}`);
        assert.strictEqual(job.status,'COMPLETED'); assert.strictEqual(job.resultStatus,'APPLIED'); assert.strictEqual(job.outcome,'APPLIED');
        assert.deepStrictEqual(Object.keys(job.components),[component]); assert.strictEqual(job.components[component].status,'APPLIED');
        assert(job.components[component].completedAt instanceof Date);
        const a = job.audit;
        assert.strictEqual(a.source,'ParentDecision'); assert.strictEqual(a.decisionType,doc.decisionType);
        for (const [key,value] of [['decisionId',doc._id],['parentId',parent._id],['childId',child._id]]) {
            assert(a[key] instanceof ObjectId); assert(a[key].equals(value));
        }
        assert.deepStrictEqual(a.target,pref ? {type:'preference',key:doc.decisionData.dimension} : {type:'goal',key:String(doc.decisionData.goalId)});
        assert.deepStrictEqual(a.previousState,previous); assert.deepStrictEqual(a.nextState,next);
        assert.deepStrictEqual(a.occurredAt,doc.occurredAt); assert(a.persistedAt instanceof Date); assert(Number.isFinite(+a.persistedAt));
        assert.deepStrictEqual(a.sourceSnapshot,{decisionId:doc._id,parentId:doc.parentId,childId:doc.childId,
            decisionType:doc.decisionType,decisionData:doc.decisionData,occurredAt:doc.occurredAt});
    }
    async function call(label,doc,status,reason,expectedNext=null,gateStop=false) {
        const before = await state();
        const response = await processContinuousLearningSource('ParentDecision',doc,{client,db:testDb});
        assert.strictEqual(response.status,'COMPLETED'); assert.strictEqual(response.results.length,1);
        const r = response.results[0];
        assert.strictEqual(r.status,status,`${label}: ${r.status}/${r.reasonCode}`);
        assert.strictEqual(r.reasonCode,reason,`${label}: reason`);
        const after = await state();
        if (status === 'APPLIED') {
            assert.strictEqual(r.preflight.status,'ELIGIBLE'); assert.strictEqual(r.transition.status,'APPLIED'); assert.strictEqual(r.persistence.status,'APPLIED');
            const pref = doc.decisionType === 'PreferenceUpdated';
            const previous = pref ? before.child.preferences?.[doc.decisionData.dimension] ?? null :
                before.child.parentGoals.find(g=>g.goalId.equals(doc.decisionData.goalId)) ?? null;
            const next = pref ? after.child.preferences[doc.decisionData.dimension] :
                after.child.parentGoals.find(g=>g.goalId.equals(doc.decisionData.goalId)) ?? null;
            assert.deepStrictEqual(next,expectedNext);
            const expectedChild = {...before.child};
            if (pref) expectedChild.preferences = {...before.child.preferences,[doc.decisionData.dimension]:expectedNext};
            else expectedChild.parentGoals = expectedNext ? [...before.child.parentGoals.filter(g=>!g.goalId.equals(doc.decisionData.goalId)),expectedNext] :
                before.child.parentGoals.filter(g=>!g.goalId.equals(doc.decisionData.goalId));
            assert.deepStrictEqual(after.child,expectedChild);
            assert.strictEqual(after.jobs.length,before.jobs.length+1);
            verifyAudit(after.jobs.find(j=>j._id.equals(doc._id)),doc,previous,expectedNext);
            assert.strictEqual(after.queue.length,before.queue.length+(pref ? 0 : 1));
            assert.strictEqual(r.queueIntentCreated,!pref);
        } else {
            assert.deepStrictEqual(after,before,`${label}: non-applied decision mutated data`);
            if (gateStop) {assert.strictEqual(r.transition,null); assert.strictEqual(r.persistence,null);}
        }
        assert(after.child._id instanceof ObjectId); assert(after.child.parentId instanceof ObjectId);
        for (const p of Object.values(after.child.preferences)) assert(p.updatedAt instanceof Date);
        for (const g of after.child.parentGoals) {assert(g.goalId instanceof ObjectId); assert(g.selectedAt instanceof Date);}
        for (const q of after.queue) {
            assert(q._id instanceof ObjectId); assert(q.entityId instanceof ObjectId); assert(q.entityId.equals(child._id));
            assert.strictEqual(q.entityType,'Child'); assert.strictEqual(q.operation,'UPDATE'); assert.strictEqual(q.status,'PENDING'); assert(q.createdAt instanceof Date);
        }
        report.scenarios[label] = {status:r.status,reasonCode:r.reasonCode,queueCount:after.queue.length,jobCount:after.jobs.length};
        console.log(JSON.stringify({scenario:label,...report.scenarios[label]}));
        return r;
    }
    const preference = n => ({value:'Outdoor',confidenceScore:1,source:'Parent',updatedAt:time(n)});
    const goal = (id,n,priority=1) => ({goalId:id,priority,status:'Active',selectedBy:'Parent',selectedAt:time(n),targetDate:null});
    try {
        await config.connectMongoDB(); db = config.getDatabase(); client = db.client;
        report.database = db.databaseName; console.log(JSON.stringify({configuredDatabase:db.databaseName,expectedDevelopmentDatabase:'heroz'}));
        assert.strictEqual(db.databaseName,'heroz','STOP: unexpected configured database');
        baseline = await snapshot(db); beforeIndexes = await indexes(db);
        report.baselineCounts = counts(baseline); console.log(JSON.stringify({baselineCounts:report.baselineCounts}));
        // parent_decisions may not exist until its first authorized source insert.
        existingCollections = new Set((await db.listCollections({}, {nameOnly:true}).toArray()).map(x=>x.name));
        for (const name of mutable.filter(n=>n!=='parent_decisions')) assert(existingCollections.has(name),`STOP: ${name} does not exist`);
        parent = await insert('parents',{name:marker,status:'Active',metadata:{systemTest:marker,createdAt:new Date(),updatedAt:new Date()}});
        const otherParent = await insert('parents',{name:`${marker}_other`,status:'Active',metadata:{systemTest:marker}});
        child = await insert('children',{parentId:parent._id,identity:{firstName:marker,dateOfBirth:new Date('2018-01-01'),gender:'Female'},
            status:'Active',preferences:{environment:{value:'Indoor',confidenceScore:0.5,source:'Onboarding',updatedAt:time(0)},
                socialStyle:{value:'Team',confidenceScore:0.5,source:'Onboarding',updatedAt:time(0)}},parentGoals:[],metadata:{systemTest:marker}});
        goalA = await insert('goal_library',{name:`${marker}_A`,isActive:true,relatedOutcomes:[],metadata:{systemTest:marker}});
        goalB = await insert('goal_library',{name:`${marker}_B`,isActive:true,relatedOutcomes:[],metadata:{systemTest:marker}});
        const prefData = {dimension:'environment',value:'Outdoor'};
        await call('A',await decision('PreferenceUpdated',1,prefData),'APPLIED','PARENT_DECISION_PERSISTED',preference(1));
        const reaffirm = await decision('PreferenceUpdated',2,prefData);
        await call('B',reaffirm,'APPLIED','PARENT_DECISION_PERSISTED',preference(2));
        await call('C',reaffirm,'IGNORED','DUPLICATE_EVENT',null,true);
        await call('D',await decision('PreferenceUpdated',1.5,{dimension:'environment',value:'Mixed'}),'NOT_APPLIED','OUT_OF_ORDER_PARENT_DECISION',null,true);
        await call('E',await decision('GoalSelected',3,{goalId:goalA._id,priority:1}),'APPLIED','PARENT_DECISION_PERSISTED',goal(goalA._id,3));
        await call('F',await decision('GoalUpdated',4,{goalId:goalA._id,priority:2}),'APPLIED','PARENT_DECISION_PERSISTED',goal(goalA._id,3,2));
        const removeA = await decision('GoalRemoved',5,{goalId:goalA._id});
        await call('G',removeA,'APPLIED','PARENT_DECISION_PERSISTED');
        for (const type of ['GoalSelected','GoalUpdated','GoalRemoved']) await call(`H_${type}`,
            await decision(type,4.5,{goalId:goalA._id,...(type==='GoalRemoved'?{}:{priority:1})}),'NOT_APPLIED','OUT_OF_ORDER_PARENT_DECISION',null,true);
        await call('I',removeA,'IGNORED','DUPLICATE_EVENT',null,true);
        await call('J_select',await decision('GoalSelected',6,{goalId:goalB._id,priority:1}),'APPLIED','PARENT_DECISION_PERSISTED',goal(goalB._id,6));
        await call('J_duplicate',await decision('GoalSelected',7,{goalId:goalB._id,priority:1}),'IGNORED','DUPLICATE_GOAL_SELECTION');
        await call('J_same_priority',await decision('GoalUpdated',8,{goalId:goalB._id,priority:1}),'IGNORED','NO_GOAL_CHANGE');
        await call('J_remove',await decision('GoalRemoved',9,{goalId:goalB._id}),'APPLIED','PARENT_DECISION_PERSISTED');
        await call('J_absent_remove',await decision('GoalRemoved',10,{goalId:goalB._id}),'IGNORED','GOAL_NOT_SELECTED');
        await call('K',await decision('PreferenceUpdated',11,prefData,otherParent._id),'REJECTED','INVALID_PARENT_AUTHORITY',null,true);
        const conflictSource = await decision('PreferenceUpdated',11,prefData);
        await call('L',{...conflictSource,decisionData:{dimension:'environment',value:'Indoor'}},'NOT_APPLIED','PARENT_DECISION_SOURCE_CONFLICT',null,true);
        const rollback = await decision('GoalSelected',11,{goalId:goalA._id,priority:1});
        injectRollback = true;
        try {await call('M',rollback,'FAILED','DATABASE_ERROR');} finally {injectRollback=false;}
        assert(rollbackInjected,'Rollback injection was not reached'); report.rollbackInjectedAfterQueueWrite = true;
        const missing = {_id:new ObjectId(),parentId:parent._id,childId:child._id,decisionType:'PreferenceUpdated',decisionData:prefData,occurredAt:time(12)};
        await call('N',missing,'NOT_APPLIED','PARENT_DECISION_SOURCE_MISSING',null,true);
        const final = await state(); assert.strictEqual(final.jobs.length,7); assert.strictEqual(final.queue.length,5);
        for (const [type,key,expected] of [['preference','environment',2],['goal',String(goalA._id),5],['goal',String(goalB._id),9]]) {
            const latest = await db.collection('ai_jobs').findOne({jobType:'ContinuousLearning',status:'COMPLETED',resultStatus:'APPLIED',outcome:'APPLIED',
                'audit.source':'ParentDecision','audit.childId':child._id,'audit.target.type':type,'audit.target.key':key},{sort:{'audit.occurredAt':-1,_id:-1}});
            assert.deepStrictEqual(latest.audit.occurredAt,time(expected));
        }
        assert(!Object.keys(require.cache).some(p=>/\/(queueWorker|graphBuilderService)\.js$|\/config\/neo4j\.js$/.test(p)));
        report.bsonTypes = 'ObjectId identities and BSON Date timestamps verified';
        report.checkpoints = 'environment T2; Goal A T5; Goal B T9; ignored removal T10 creates no tombstone';
    } catch (error) {
        failure = error;
        report.failure = {name:error.name,message:error instanceof assert.AssertionError ? error.message : 'Database/verification operation failed (details suppressed)'};
    } finally {
        if (db && baseline) {
            report.cleanup = {};
            for (const name of mutable) {
                try {
                    const ids = [...captured[name].values()];
                    report.cleanup[name] = ids.length ? (await db.collection(name).deleteMany({_id:{$in:ids}})).deletedCount : 0;
                } catch (_) {failure ||= Error('Cleanup failed'); report.cleanup[name]='FAILED';}
            }
            try {
                // Restore absence as well as contents. Never drop a pre-existing collection,
                // or one containing any document after our exact-ID cleanup.
                if (existingCollections && !existingCollections.has('parent_decisions') && captured.parent_decisions.size) {
                    assert.strictEqual(await db.collection('parent_decisions').countDocuments({}),0);
                    await db.collection('parent_decisions').drop();
                    report.temporarySourceCollectionRemoved = true;
                }
                const restored = await snapshot(db); report.restoredCounts = counts(restored);
                for (const name of names) {
                    assert.deepStrictEqual(restored[name],baseline[name],`${name}: original documents changed`);
                    assert.strictEqual(await db.collection(name).countDocuments({$or:[{testDataset:marker},{'metadata.systemTest':marker}]}),0);
                    const ids = [...captured[name].values()];
                    if (ids.length) assert.strictEqual(await db.collection(name).countDocuments({_id:{$in:ids}}),0);
                }
                assert.deepStrictEqual(await indexes(db),beforeIndexes);
                report.cleanupVerified=true; report.zeroMarkersAndIds=true; report.existingDocumentsUnchanged=true;
                report.indexesUnchanged=true; report.indexDefinitions=beforeIndexes;
            } catch (_) {failure ||= Error('Restoration verification failed'); report.cleanupVerified=false;}
            console.log(JSON.stringify({cleanup:report.cleanup,restoredCounts:report.restoredCounts,cleanupVerified:report.cleanupVerified}));
        }
        if (client) await client.close();
    }
    console.log(JSON.stringify(report,null,2));
    if (failure) {process.exitCode=1; console.log('D7G parent decision live verification: FAILED'); return;}
    console.log('D7G parent decision live verification: PASSED (scenarios A-N; cleanup, BSON types and indexes verified)');
}
main().catch(()=>{console.error('D7G verification failed before completion; inspect captured IDs and cleanup report.');process.exitCode=1;});
