// Authorized isolated development verification; never run the unfiltered worker.
// node src/tests/systemTestV1/phaseD7K_closedLoop.js --run-live-development
const assert = require('assert');
const { randomUUID } = require('crypto');
const { ObjectId } = require('mongodb');
const names = ['parents','children','subcategories','activities','child_interests','goal_library','learning_outcomes',
    'ai_jobs','graph_sync_queue','interactions','bookings','parent_decisions','recommendations','vendors','sessions','cities','categories'];
const normalize = value => {
    if (value && typeof value.toNumber === 'function') return value.toNumber();
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,normalize(v)]));
    return value;
};
async function main() {
    if (process.argv.length !== 3 || process.argv[2] !== '--run-live-development') {
        console.log('D7K live verification skipped: --run-live-development is required; no database access.'); return;
    }
    const config = require('../../config/mongodb');
    assert.strictEqual(new URL(process.env.NEO4J_URI).hostname,'8e0def04.databases.neo4j.io');
    const driver = require('../../config/neo4j');
    const { processQueue } = require('../../workers/queueWorker');
    const { processContinuousLearningSource } = require('../../learning/continuousLearningService');
    const marker = `D7K_GRAPH_CLOSED_LOOP_${randomUUID()}`;
    const owned = Object.fromEntries(names.map(n=>[n,new Map()]));
    const graphOwned = [];
    const report = {marker,neo4jTarget:'8e0def04.databases.neo4j.io (configured account default database)',workerCalls:[],scenarios:{}};
    let db,baseline,graphBaseline,indexBaseline,schemaBaseline,existing,failure,writes=false;
    let parent,child,sub,activity,category,sessionDoc,control;
    let stage = 'baseline';
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
    async function checkLikes() {
        const i=await db.collection('child_interests').findOne({childId:child._id,subcategoryId:sub._id});
        assert.deepStrictEqual(await likes(),[{childId:String(child._id),subcategoryId:String(sub._id),properties:{score:i.interestScore.currentScore,
            confidence:i.confidence.currentScore,evidenceCount:i.confidence.evidenceCount,lastUpdated:i.metadata.updatedAt.toISOString()}}]);
    }
    const close=(actual,expected)=>assert(Math.abs(actual-expected)<1e-12,`${actual} != ${expected}`);
    const json=value=>JSON.parse(JSON.stringify(value));
    async function currentInterest() {return db.collection('child_interests').findOne({childId:child._id,subcategoryId:sub._id});}
    async function rating(timestamp) {
        return insert('interactions',{actor:{childId:child._id,actorType:'Child'},targetEntity:{entityType:'Activity',entityId:activity._id},
            interactionDetails:{interactionType:'Rate',ratingValue:5},timestamp,metadata:{version:1}});
    }
    // The normal engine persists snapshots and then attaches real D6 explanations.
    // Observers delegate unchanged inputs to production services, capturing owned
    // records and proving D6 does not change any D5 result field.
    async function makeEngine() {
        const {createRecommendationEngine}=require('../../recommendation/recommendationEngineService');
        const {persistRecommendationSnapshot}=require('../../recommendation/recommendationPersistenceService');
        const {attachRecommendationExplanations}=require('../../explanation/explanationOrchestrator');
        const {buildExplanationEvidence}=require('../../explanation/explanationEvidenceBuilder');
        const {buildExplanationPlan}=require('../../explanation/explanationPlanBuilder');
        const {generateExplanation}=require('../../explanation/languageGenerator');
        const {finalizeExplanation}=require('../../explanation/explanationFinalizer');
        return createRecommendationEngine({
            languageProvider:null, // Existing local deterministic realization, no external API.
            persistRecommendationSnapshot:async input=>{
                assert.strictEqual(String(input.childId),String(child._id));assert.strictEqual(String(input.parentId),String(parent._id));
                try {return await persistRecommendationSnapshot(input);}
                finally {
                    for(const doc of await db.collection('recommendations').find({childId:child._id}).toArray())remember('recommendations',doc._id);
                }
            },
            attachRecommendationExplanations:async input=>{
                const originals=json(input.recommendationResults);
                assert(owned.recommendations.has(String(input.recommendationId)));
                const result=await attachRecommendationExplanations(input);
                assert.deepStrictEqual(input.recommendationResults,originals,'D6 mutated D5 input');
                const plans=[];
                for(let i=0;i<originals.length;i++) {
                    const {explanation,...preserved}=result.recommendations[i];assert.deepStrictEqual(preserved,originals[i]);
                    const evidence=await buildExplanationEvidence(originals[i]);const plan=buildExplanationPlan(evidence);
                    assert(explanation.text.length>0);assert.deepStrictEqual(explanation.reasonTypes,plan.reasonTypes);
                    const generated=await generateExplanation(plan,{parent});
                    const finalized=finalizeExplanation({explanationPlan:plan,generatedExplanation:generated,language:explanation.language});
                    const {validation,...expected}=finalized;assert.deepStrictEqual(explanation,expected);
                    plans.push({plan,grounding:validation});
                }
                report[stage+'D6']={plans,unchangedD5:true};return result;
            }
        });
    }
    async function recommendation(engine) {
        const {buildRecommendationContext}=require('../../recommendation/recommendationContextService');
        const {evaluateRecommendationEligibility}=require('../../recommendation/recommendationEligibilityService');
        const context=await buildRecommendationContext(String(child._id));const checked=evaluateRecommendationEligibility(context);
        assert(checked.requestEligibility.eligible);assert.strictEqual(checked.eligibleCandidates.length,1,JSON.stringify(checked));
        assert.deepStrictEqual(checked.eligibleCandidates[0].missingInformation,[]);
        assert.strictEqual(checked.eligibleCandidates[0].eligibleSessions.length,1);
        const response=await engine.generateRecommendations(String(child._id),1);
        assert.strictEqual(response.recommendations.length,1);const r=response.recommendations[0];
        assert.strictEqual(r.activityId,String(activity._id));assert.strictEqual(r.rank,1);assert.deepStrictEqual(r.eligibleSessionIds,[String(sessionDoc._id)]);
        const state=await currentInterest();close(r.factors.interest.score,state.interestScore.currentScore);
        assert.deepStrictEqual(r.evidence.factors.interest,[{type:'exact_subcategory_interest',subcategoryId:String(sub._id),score:state.interestScore.currentScore,confidence:state.confidence.currentScore}]);
        const discovered=r.evidence.discovery.interests;assert.strictEqual(discovered.length,1);
        close(discovered[0].score,state.interestScore.currentScore);close(discovered[0].confidence,state.confidence.currentScore);
        assert.strictEqual(Number(discovered[0].evidenceCount),state.confidence.evidenceCount);
        const weights={interest:0.33,preference:0.16,goal:0.16,exploration:0.13,behavior:0.13,session:0.09};
        const available=Object.entries(r.factors).filter(([,f])=>f.available);const weight=available.reduce((n,[k])=>n+weights[k],0);
        close(r.score,available.reduce((n,[k,f])=>n+weights[k]*f.score,0)/weight);close(r.scoring.availableWeight,weight);
        const persisted=await db.collection('recommendations').findOne({_id:new ObjectId(response.recommendationId)});
        assert(persisted.childId.equals(child._id));assert.strictEqual(persisted.recommendedItems.length,1);
        const item=persisted.recommendedItems[0];assert(item.activityId.equals(activity._id));close(item.score,r.score);assert.strictEqual(item.rank,r.rank);
        for(const field of ['factors','scoring','evidence','explanation'])assert.deepStrictEqual(item[field],r[field]);
        report[stage]={response,interest:state,likes:await likes(),persistedRecommendationId:response.recommendationId};return r;
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
        stage='fixtures';
        parent=await insert('parents',{account:{firstName:marker,status:'Active',preferredLanguage:'en'}});
        category=await insert('categories',{name:marker,isActive:true});
        sub=await insert('subcategories',{name:marker,categoryId:category._id,isActive:true});
        child=await insert('children',{parentId:parent._id,identity:{firstName:marker,dateOfBirth:new Date('2018-01-01'),gender:'Female'},status:'Active',parentGoals:[],preferences:{},developmentProfile:[]});
        activity=await insert('activities',{basicInformation:{nameEn:marker,status:'Active'},classification:{categoryId:category._id,subcategoryId:sub._id},
            eligibility:{minimumAge:0,maximumAge:100,allowedGenders:['Female']},learningOutcomes:[]});
        const now=Date.now();
        sessionDoc=await insert('sessions',{activityId:activity._id,availability:{status:'Available',registrationOpen:true},capacity:{remainingCapacity:10},
            schedule:{bookingDeadline:new Date(now+7*86400000),startDateTime:new Date(now+8*86400000),timezone:'Asia/Riyadh'}});
        control=await queue('Child',new ObjectId());
        for(const [type,key,doc] of [['Parent','parentId',parent],['Subcategory','subcategoryId',sub],['Child','childId',child],['Activity','activityId',activity]])await project(type,key,doc);
        assert.deepStrictEqual(await likes(),[]);assert.strictEqual(await currentInterest(),null);
        stage='seed';const seed=await rating(new Date(now-60000));
        const seedIds=await learn('seed_Rate5','Interaction',seed,'ChildInterest','CREATE');
        assert.deepStrictEqual(await likes(),[]);await worker(seedIds,'seed interest CREATE');await checkLikes();
        const initial=await currentInterest();close(initial.interestScore.currentScore,0.6);close(initial.confidence.currentScore,0.25);assert.strictEqual(initial.confidence.evidenceCount,1);
        const fixedActivity=await db.collection('activities').findOne({_id:activity._id});const fixedSession=await db.collection('sessions').findOne({_id:sessionDoc._id});
        const engine=await makeEngine();stage='before';const before=await recommendation(engine);
        stage='learning';const source=await rating(new Date());report.source=source;
        const beforeGraph=await likes();const preJobs=owned.ai_jobs.size;const preQueue=owned.graph_sync_queue.size;
        const ids=await learn('recommended_activity_Rate5','Interaction',source,'ChildInterest','UPDATE');
        assert.strictEqual(owned.ai_jobs.size,preJobs+1);assert.strictEqual(owned.graph_sync_queue.size,preQueue+1);
        const learned=await currentInterest();close(learned.interestScore.previousScore,0.6);close(learned.interestScore.currentScore,0.7);
        close(learned.confidence.currentScore,0.3);assert.strictEqual(learned.confidence.evidenceCount,2);
        assert.strictEqual(learned.scoreHistory.length,2);assert.deepStrictEqual(learned.scoreHistory[0],initial.scoreHistory[0]);
        const history=learned.scoreHistory[1];assert.strictEqual(history.eventId,String(source._id));assert.strictEqual(history.eventType,'Rate');
        close(history.previousScore,0.6);close(history.newScore,0.7);close(history.interestDelta,0.1);
        close(history.previousConfidence,0.25);close(history.newConfidence,0.3);close(history.confidenceDelta,0.05);
        assert.deepStrictEqual(history.timestamp,source.timestamp);assert.deepStrictEqual(learned.metadata.updatedAt,source.timestamp);
        assert.deepStrictEqual(learned.evidenceSummary.interactionBreakdown,[{interactionType:'Rate',count:2}]);
        const jobs=await db.collection('ai_jobs').find({'source.documentId':String(source._id)}).toArray();assert.strictEqual(jobs.length,1);
        assert.strictEqual(jobs[0].status,'COMPLETED');assert.strictEqual(jobs[0].outcome,'APPLIED');assert.strictEqual(jobs[0].idempotencyKey,`interaction:${source._id}:Rate`);
        assert.deepStrictEqual(await likes(),beforeGraph);report.asyncBoundary={preWorkerGraph:beforeGraph,mongo:learned,queueId:String(ids[0]),status:'PENDING'};
        await worker(ids,'closed-loop learned interest UPDATE');await checkLikes();report.asyncBoundary.postWorkerGraph=await likes();
        stage='after';const after=await recommendation(engine);
        assert.deepStrictEqual(await db.collection('activities').findOne({_id:activity._id}),fixedActivity);
        assert.deepStrictEqual(await db.collection('sessions').findOne({_id:sessionDoc._id}),fixedSession);
        close(after.factors.interest.score-before.factors.interest.score,0.1);
        for(const factor of ['preference','goal','behavior','session'])assert.deepStrictEqual(after.factors[factor],before.factors[factor]);
        // Normal D5 persistence creates an initially absent recommendations
        // collection. Its history source then becomes available to exploration;
        // this legitimate effect must not be misattributed to interest learning.
        assert.strictEqual(after.factors.exploration.available,true);close(after.factors.exploration.score,1);
        assert.strictEqual(before.factors.exploration.available,existing.has('recommendations'));
        if(before.factors.exploration.available)close(before.factors.exploration.score,1);
        const interestContributionDelta=0.33/after.scoring.availableWeight*0.1;
        const historyAvailabilityEffect=(0.33*before.factors.interest.score+0.13+0.13)/after.scoring.availableWeight-before.score;
        close(after.score-before.score,interestContributionDelta+historyAvailabilityEffect);assert(after.score>before.score);
        report.learningEffect={interestDelta:after.factors.interest.score-before.factors.interest.score,finalScoreDelta:after.score-before.score,
            interestContributionAtAfterWeights:interestContributionDelta,historyAvailabilityEffect,
            explanation:'Exploration becomes available if normal initial recommendation persistence creates its previously absent collection; all other non-interest factor scores remain unchanged.'};
        stage='duplicate';const mongoBefore=await snapshot();const graphBefore=await graphSnapshot();
        const replay=await processContinuousLearningSource('Interaction',source,{client:db.client,db:guardedDb});
        assert.strictEqual(replay.results.length,1);assert.strictEqual(replay.results[0].status,'IGNORED');assert.strictEqual(replay.results[0].reasonCode,'DUPLICATE_EVENT');
        assert.deepStrictEqual(await snapshot(),mongoBefore);assert.deepStrictEqual(await graphSnapshot(),graphBefore);report.duplicate=replay;
        report.queueIsolation=true;report.controlQueueId=String(control._id);report.classification='PASS';
    } catch(error) {
        failure=error;report.classification=stage==='baseline'||stage==='fixtures'?'BLOCKED':'FAILED';report.failure={stage,name:error.name,message:error.message};
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
    if(failure){if(report.classification==='PASS')report.classification='FAILED';process.exitCode=1;}
    console.log(JSON.stringify(report,null,2));console.log(`D7K full closed-loop verification: ${report.classification}`);
}
main().catch(error=>{console.error('D7K verification failed:',error.name,error.message);process.exitCode=1;});
