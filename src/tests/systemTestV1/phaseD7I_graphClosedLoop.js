// Authorized isolated development verification; never run the unfiltered worker.
// node src/tests/systemTestV1/phaseD7I_graphClosedLoop.js --run-live-development
const assert = require('assert');
const { randomUUID } = require('crypto');
const { ObjectId } = require('mongodb');
const names = ['parents','children','subcategories','activities','child_interests','goal_library','learning_outcomes',
    'ai_jobs','graph_sync_queue','interactions','bookings','parent_decisions','recommendations','vendors','sessions'];
const normalize = value => {
    if (value && typeof value.toNumber === 'function') return value.toNumber();
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,normalize(v)]));
    return value;
};
async function main() {
    if (process.argv.length !== 3 || process.argv[2] !== '--run-live-development') {
        console.log('D7I live verification skipped: --run-live-development is required; no database access.'); return;
    }
    const config = require('../../config/mongodb');
    assert.strictEqual(new URL(process.env.NEO4J_URI).hostname,'8e0def04.databases.neo4j.io');
    const driver = require('../../config/neo4j');
    const { processQueue } = require('../../workers/queueWorker');
    const { processContinuousLearningSource } = require('../../learning/continuousLearningService');
    const marker = `D7I_GRAPH_CLOSED_LOOP_${randomUUID()}`;
    const owned = Object.fromEntries(names.map(n=>[n,new Map()]));
    const graphOwned = [];
    const report = {marker,neo4jTarget:'8e0def04.databases.neo4j.io (configured account default database)',workerCalls:[],scenarios:{}};
    let db,baseline,graphBaseline,indexBaseline,schemaBaseline,existing,failure,writes=false;
    let parent,child,sub,activity,outcome,goalA,goalB,control;
    async function graph(query,params={}) {
        const session=driver.session();try {return (await session.run(query,params)).records.map(r=>normalize(r.toObject()));} finally {await session.close();}
    }
    async function graphSnapshot() {
        return {nodes:await graph('MATCH (n) RETURN elementId(n) AS id, labels(n) AS labels, properties(n) AS properties ORDER BY id'),
            relationships:await graph('MATCH (a)-[r]->(b) RETURN elementId(r) AS id, elementId(a) AS source, elementId(b) AS target, type(r) AS type, properties(r) AS properties ORDER BY id')};
    }
    async function schema() {
        return {indexes:await graph('SHOW INDEXES YIELD name, type, entityType, labelsOrTypes, properties, owningConstraint RETURN name, type, entityType, labelsOrTypes, properties, owningConstraint ORDER BY name'),
            constraints:await graph('SHOW CONSTRAINTS YIELD name, type, entityType, labelsOrTypes, properties RETURN name, type, entityType, labelsOrTypes, properties ORDER BY name')};
    }
    async function snapshot() {const s={};for(const n of names)s[n]=await db.collection(n).find({}).sort({_id:1}).toArray();return s;}
    async function indexes() {
        const present=new Set((await db.listCollections({}, {nameOnly:true}).toArray()).map(c=>c.name));
        const s={};for(const n of names)s[n]=present.has(n)?await db.collection(n).listIndexes().toArray():[];return s;
    }
    function remember(name,id) {
        assert(id instanceof ObjectId);assert(!baseline[name].some(d=>String(d._id)===String(id)),'Temporary identity collides with baseline');
        owned[name].set(String(id),id);console.log(JSON.stringify({capture:name,id:String(id)}));
    }
    async function insert(name,fields) {
        const doc={_id:new ObjectId(),...fields,testDataset:marker};remember(name,doc._id);writes=true;
        await db.collection(name).insertOne(doc);return doc;
    }
    const guardedDb={collection(name) {
        assert(names.includes(name));const col=db.collection(name);
        return new Proxy(col,{get(target,key) {
            if(key==='insertOne')return async(doc,options)=>{
                assert(options?.session?.inTransaction());assert(['ai_jobs','graph_sync_queue','child_interests'].includes(name));
                if(name==='child_interests')assert(owned.children.has(String(doc.childId)));
                if(name==='ai_jobs')assert(owned.children.has(String(doc.event?.childId??doc.audit?.childId)));
                if(name==='graph_sync_queue')assert((doc.entityType==='Child'&&owned.children.has(String(doc.entityId)))||
                    (doc.entityType==='ChildInterest'&&owned.child_interests.has(String(doc.entityId))));
                remember(name,doc._id);return target.insertOne(doc,options);
            };
            if(key==='updateOne')return async(filter,update,options)=>{
                assert(['children','child_interests'].includes(name));assert(owned[name].has(String(filter._id)));assert(options?.session?.inTransaction());
                return target.updateOne(filter,update,options);
            };
            if(['deleteOne','deleteMany','updateMany','bulkWrite','replaceOne','findOneAndUpdate','createIndex','createIndexes','drop'].includes(key))return ()=>{throw Error('Unexpected production mutation');};
            const v=target[key];return typeof v==='function'?v.bind(target):v;
        }});
    }};
    async function worker(ids,label,expected='PROCESSED') {
        assert(ids.length);for(const id of ids)assert(owned.graph_sync_queue.has(String(id)));
        const allBefore=await db.collection('graph_sync_queue').find({}).sort({_id:1}).toArray();
        report.workerCalls.push({label,jobIds:ids.map(String)});console.log(JSON.stringify({worker:label,jobIds:ids.map(String)}));
        await processQueue({jobIds:ids});
        const allAfter=await db.collection('graph_sync_queue').find({}).sort({_id:1}).toArray();assert.strictEqual(allAfter.length,allBefore.length);
        for(const before of allBefore) {
            const after=allAfter.find(q=>String(q._id)===String(before._id));
            if(!ids.some(id=>String(id)===String(before._id))||before.status!=='PENDING')assert.deepStrictEqual(after,before,'Unselected/non-pending queue changed');
            else {
                assert.strictEqual(after.status,expected,`${label}: ${after.error??after.status}`);
                const field=expected==='PROCESSED'?'processedAt':'failedAt';assert(after[field] instanceof Date);
                const restored={...after,status:before.status};delete restored[field];
                if(expected==='FAILED'){assert.strictEqual(after.error,'Child not found.');delete restored.error;}
                assert.deepStrictEqual(restored,before,'Unexpected worker field change');
            }
        }
    }
    async function queue(type,id,operation='CREATE') {return insert('graph_sync_queue',{entityType:type,entityId:id,operation,status:'PENDING',createdAt:new Date()});}
    async function project(type,key,doc) {
        assert.deepStrictEqual(await graph(`MATCH (n:${type} {${key}:$id}) RETURN elementId(n) AS id`,{id:String(doc._id)}),[]);
        graphOwned.push({type,key,id:String(doc._id)});
        await worker([(await queue(type,doc._id))._id],`prerequisite ${type}`);
        assert.strictEqual((await graph(`MATCH (n:${type} {${key}:$id}) RETURN n`,{id:String(doc._id)})).length,1);
    }
    const time=n=>new Date(Date.UTC(2026,8,19)+n*3600000);
    async function learn(label,type,doc,entityType,operation) {
        const before=new Set(owned.graph_sync_queue.keys());
        const result=await processContinuousLearningSource(type,doc,{client:db.client,db:guardedDb});
        assert.strictEqual(result.results.length,1);assert.strictEqual(result.results[0].status,'APPLIED',`${label}: ${JSON.stringify(result)}`);
        const ids=[...owned.graph_sync_queue.entries()].filter(([id])=>!before.has(id)).map(([,id])=>id);
        assert.strictEqual(ids.length,entityType?1:0);
        if(entityType){const q=await db.collection('graph_sync_queue').findOne({_id:ids[0]});assert.strictEqual(q.entityType,entityType);assert.strictEqual(q.operation,operation);assert.strictEqual(q.status,'PENDING');}
        report.scenarios[label]={learning:'APPLIED',queueIds:ids.map(String)};return ids;
    }
    async function likes() {return graph('MATCH (c:Child {childId:$id})-[r:LIKES]->(s) RETURN c.childId AS childId, s.subcategoryId AS subcategoryId, properties(r) AS properties',{id:String(child._id)});}
    async function goals() {return graph('MATCH (c:Child {childId:$id})-[r:HAS_GOAL]->(g) RETURN c.childId AS childId, g.goalId AS goalId, properties(r) AS properties ORDER BY goalId',{id:String(child._id)});}
    async function checkLikes() {
        const i=await db.collection('child_interests').findOne({childId:child._id,subcategoryId:sub._id});
        assert.deepStrictEqual(await likes(),[{childId:String(child._id),subcategoryId:String(sub._id),properties:{score:i.interestScore.currentScore,
            confidence:i.confidence.currentScore,evidenceCount:i.confidence.evidenceCount,lastUpdated:i.metadata.updatedAt.toISOString()}}]);
    }
    async function checkGoals() {
        const c=await db.collection('children').findOne({_id:child._id});
        assert.deepStrictEqual(await goals(),c.parentGoals.map(g=>({childId:String(child._id),goalId:String(g.goalId),properties:{priority:g.priority,status:g.status}})).sort((a,b)=>a.goalId.localeCompare(b.goalId)));
    }
    async function decision(label,type,goal,n,priority) {
        const before=await goals();const doc=await insert('parent_decisions',{parentId:parent._id,childId:child._id,decisionType:type,
            decisionData:{goalId:goal._id,...(priority===undefined?{}:{priority})},occurredAt:time(n)});
        const ids=await learn(label,'ParentDecision',doc,'Child','UPDATE');assert.deepStrictEqual(await goals(),before);
        await worker(ids,label);await checkGoals();report.scenarios[label].staleBeforeWorker=true;
    }
    try {
        await config.connectMongoDB();db=config.getDatabase();assert.strictEqual(db.databaseName,'heroz');report.database=db.databaseName;
        existing=new Set((await db.listCollections({}, {nameOnly:true}).toArray()).map(c=>c.name));
        baseline=await snapshot();indexBaseline=await indexes();graphBaseline=await graphSnapshot();schemaBaseline=await schema();
        for(const [n,key] of [['child_interests',{childId:1,subcategoryId:1}],['ai_jobs',{jobType:1,idempotencyKey:1}]])assert(indexBaseline[n].some(i=>i.unique&&JSON.stringify(i.key)===JSON.stringify(key)),'Required unique Mongo index missing');
        report.baselineCounts=Object.fromEntries(names.map(n=>[n,baseline[n].length]));
        report.queueBaseline={total:baseline.graph_sync_queue.length,...Object.fromEntries(['PENDING','PROCESSED','FAILED'].map(s=>[s,baseline.graph_sync_queue.filter(q=>q.status===s).length]))};
        report.graphBaseline={nodes:graphBaseline.nodes.length,relationships:graphBaseline.relationships.length,indexes:schemaBaseline.indexes.length,constraints:schemaBaseline.constraints.length};
        console.log(JSON.stringify({baseline:report}));
        parent=await insert('parents',{account:{firstName:marker,status:'Active'}});
        sub=await insert('subcategories',{name:marker,isActive:true});outcome=await insert('learning_outcomes',{name:marker,isActive:true});
        goalA=await insert('goal_library',{name:`${marker}_A`,isActive:true,relatedOutcomes:[{outcomeId:outcome._id}]});
        goalB=await insert('goal_library',{name:`${marker}_B`,isActive:true,relatedOutcomes:[{outcomeId:outcome._id}]});
        child=await insert('children',{parentId:parent._id,identity:{firstName:marker,dateOfBirth:new Date('2018-01-01'),gender:'Female'},status:'Active',parentGoals:[],preferences:{},developmentProfile:[]});
        activity=await insert('activities',{basicInformation:{nameEn:marker,status:'Active'},classification:{subcategoryId:sub._id},learningOutcomes:[{outcomeId:outcome._id}]});
        if(!baseline.graph_sync_queue.some(q=>q.status==='PENDING'))control=await queue('Child',new ObjectId());
        for(const [type,key,doc] of [['Parent','parentId',parent],['Subcategory','subcategoryId',sub],['LearningOutcome','outcomeId',outcome],['Goal','goalId',goalA],['Goal','goalId',goalB],['Child','childId',child],['Activity','activityId',activity]])await project(type,key,doc);
        assert.deepStrictEqual(await likes(),[]);assert.deepStrictEqual(await goals(),[]);
        for(const [label,type,n,operation] of [['A_interest_create','Click',1,'CREATE'],['B_interest_update','Rate',2,'UPDATE']]) {
            const old=await likes();const doc=await insert('interactions',{actor:{childId:child._id,actorType:'Child'},targetEntity:{entityType:'Activity',entityId:activity._id},
                interactionDetails:{interactionType:type,...(type==='Rate'?{ratingValue:5}:{})},timestamp:time(n),metadata:{version:1}});
            const ids=await learn(label,'Interaction',doc,'ChildInterest',operation);assert.deepStrictEqual(await likes(),old);
            await worker(ids,label);await checkLikes();assert.notDeepStrictEqual(await likes(),old);report.scenarios[label].staleBeforeWorker=true;
        }
        await decision('C_goal_select','GoalSelected',goalA,3,1);
        await decision('D_goal_update','GoalUpdated',goalA,4,2);
        await decision('E_goal_remove','GoalRemoved',goalA,5);
        assert.deepStrictEqual(await goals(),[]);
        await decision('F_reselect_A','GoalSelected',goalA,6,1);await decision('F_select_B','GoalSelected',goalB,7,2);
        const bBefore=(await goals()).find(g=>g.goalId===String(goalB._id));
        await decision('F_remove_only_A','GoalRemoved',goalA,8);assert.deepStrictEqual(await goals(),[bBefore]);
        let beforeGraph=await graphSnapshot();
        const pref=await insert('parent_decisions',{parentId:parent._id,childId:child._id,decisionType:'PreferenceUpdated',decisionData:{dimension:'environment',value:'Outdoor'},occurredAt:time(9)});
        const oldPreferences=(await db.collection('children').findOne({_id:child._id})).preferences;
        await learn('preference_mongo_only','ParentDecision',pref);assert.deepStrictEqual(await graphSnapshot(),beforeGraph);
        assert.notDeepStrictEqual((await db.collection('children').findOne({_id:child._id})).preferences,oldPreferences);
        const booking=await insert('bookings',{bookingDetails:{childId:child._id,activityId:activity._id,status:'Completed',bookedAt:time(10)},attendance:{status:'Attended',checkedInAt:time(10)}});
        const attendIds=await learn('development_mongo_only','Booking',booking,'ChildInterest','UPDATE');assert.deepStrictEqual(await graphSnapshot(),beforeGraph);
        const profile=(await db.collection('children').findOne({_id:child._id})).developmentProfile;assert.strictEqual(profile.length,1);assert(profile[0].outcomeId.equals(outcome._id));assert.strictEqual(profile[0].score,0.1);
        await worker(attendIds,'Attend interest only');await checkLikes();
        assert.deepStrictEqual(await graph('MATCH (:Child {childId:$id})-[r]->(:LearningOutcome) RETURN type(r) AS type',{id:String(child._id)}),[]);
        const interest=await db.collection('child_interests').findOne({childId:child._id});beforeGraph=await graphSnapshot();
        await worker([(await queue('ChildInterest',interest._id,'UPDATE'))._id,(await queue('Child',child._id,'UPDATE'))._id],'idempotent current-state UPDATE');
        await checkLikes();await checkGoals();assert.deepStrictEqual(await graphSnapshot(),beforeGraph);report.idempotentProjection=true;
        const failed=await queue('Child',new ObjectId());await worker([failed._id],'controlled missing Child','FAILED');
        await worker([failed._id],'FAILED excluded on subsequent call');assert.deepStrictEqual(await graphSnapshot(),beforeGraph);report.failedJobsNotRetried=true;
        const {buildRecommendationContext}=require('../../recommendation/recommendationContextService');
        const {evaluateRecommendationEligibility}=require('../../recommendation/recommendationEligibilityService');
        const context=await buildRecommendationContext(String(child._id));
        assert(context.candidates.some(c=>c.activity.activityId===String(activity._id)));assert.strictEqual(context.interestContext.childInterests.length,1);
        const eligibility=evaluateRecommendationEligibility(context);
        report.d5={candidateCount:context.candidates.length,mongoInterestRevalidated:true,eligibility};
        // This minimal graph fixture has no vendor/session operational setup.
        // Report the real eligibility result, never manufacture a scored result.
        assert.strictEqual(eligibility.eligibleCandidates.length,0,'Fixture unexpectedly eligible; D6 continuation requires review');
        report.d5.eligibility={request:eligibility.requestEligibility,candidates:eligibility.candidateEvaluations.map(e=>({eligibility:e.eligibility,missingInformation:e.missingInformation,sessionEvaluations:e.sessionEvaluations}))};
        report.d6='Not reached: no real eligible D5 recommendation from minimal graph fixtures';report.classification='PARTIAL';
        report.queueIsolation=true;report.controlQueueId=control?String(control._id):null;
    } catch(error) {
        failure=error;report.classification='BLOCKED';report.failure={name:error.name,message:error.message};
    } finally {
        if(db&&writes) {
            report.cleanup={graph:false,mongo:false};
            // Exact recorded identities only; graph cleanup always precedes Mongo.
            try {
                for(const {type,key,id} of [...graphOwned].reverse())await graph(`MATCH (n:${type} {${key}:$id}) DETACH DELETE n`,{id});
                for(const {type,key,id} of graphOwned)assert.deepStrictEqual(await graph(`MATCH (n:${type} {${key}:$id}) RETURN n`,{id}),[]);
                assert.deepStrictEqual(await graphSnapshot(),graphBaseline);assert.deepStrictEqual(await schema(),schemaBaseline);report.cleanup.graph=true;
            } catch(error){failure ||= error;report.cleanup.graphError=error.message;}
            try {
                for(const n of names){const ids=[...owned[n].values()];if(ids.length)await db.collection(n).deleteMany({_id:{$in:ids}});}
                for(const n of names)if(!existing.has(n)&&owned[n].size&&(await db.listCollections({name:n},{nameOnly:true}).toArray()).length){assert.strictEqual(await db.collection(n).countDocuments({}),0);await db.collection(n).drop();}
                assert.deepStrictEqual(await snapshot(),baseline);assert.deepStrictEqual(await indexes(),indexBaseline);
                for(const n of names){assert.strictEqual(await db.collection(n).countDocuments({testDataset:marker}),0);assert.strictEqual(await db.collection(n).countDocuments({_id:{$in:[...owned[n].values()]}}),0);}
                report.cleanup.mongo=true;report.cleanup.preexistingQueueUnchanged=true;report.cleanup.allBaselineDocumentsUnchanged=true;report.cleanup.indexesAndSchemaUnchanged=report.cleanup.graph;
            } catch(error){failure ||= error;report.cleanup.mongoError=error.message;}
        }
        if(db)await db.client.close();await driver.close();
    }
    if(failure){report.classification='BLOCKED';process.exitCode=1;}
    console.log(JSON.stringify(report,null,2));console.log(`D7I graph closed-loop verification: ${report.classification}`);
}
main().catch(error=>{console.error('D7I verification failed:',error.name,error.message);process.exitCode=1;});
