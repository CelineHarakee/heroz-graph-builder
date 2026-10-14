const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { LEVEL, EVENT, OUTCOME, createRecord, createLogger, observeOperation } = require('../../observability/structuredLogger');
const { createRequestTrace, createBackgroundTrace, currentTrace, runRequest, runBackground } = require('../../observability/traceContext');
const { createReliabilityFailure } = require('../../reliability/reliabilityFailure');
const { handleRecommendations } = require('../../api/v1/recommendations');
const { handleNextQuestion } = require('../../api/v1/adaptiveQuestions');
const { handleChildIntelligence } = require('../../api/v1/childIntelligence');
const { handleQuestionAnswer } = require('../../api/v1/questionAnswers');
const { handleInteraction } = require('../../api/v1/interactions');
const { processContinuousLearningSource } = require('../../learning/continuousLearningService');
const { ObjectId } = require('mongodb');
const root=path.resolve(__dirname,'../../..');
const now=()=>new Date('2026-10-11T10:00:00.000Z');
const base={level:'INFO',event:'OPERATION_COMPLETED',component:'Test',operation:'execute',outcome:'SUCCESS',message:'Operation completed.'};
const records=[];
const logger=createLogger({now,emit:r=>records.push(r)});
let ids=0,passed=0;
const observation={logger,idFactory:()=>`opaque_${++ids}`};
function check(label,fn){fn();passed++;console.log(`${label}: PASS`);}
function regression(name){const r=spawnSync(process.execPath,[`src/tests/${name}.js`],{cwd:root,encoding:'utf8',timeout:60000});assert.equal(r.status,0,`${name}: ${r.error??''}\n${r.stdout}\n${r.stderr}`);}
async function main(){
    check('A. Four levels',()=>assert.deepEqual(Object.values(LEVEL),['INFO','WARN','ERROR','DEBUG']));
    check('B. Four events',()=>assert.deepEqual(Object.values(EVENT),['OPERATION_STARTED','OPERATION_COMPLETED','OPERATION_FAILED','OPERATION_DEGRADED']));
    check('C. Three outcomes',()=>assert.deepEqual(Object.values(OUTCOME),['SUCCESS','FAILURE','DEGRADED']));
    check('D. Required fields/closed values',()=>{for(const key of Object.keys(base)){const bad={...base};delete bad[key];assert.throws(()=>createRecord(bad,{now}),TypeError);}for(const key of ['level','event','outcome'])assert.throws(()=>createRecord({...base,[key]:'INVALID'},{now}),TypeError);assert.throws(()=>createRecord(base,{now:()=>null}),TypeError);});
    check('E. Optional fields absent',()=>assert.deepEqual(Object.keys(createRecord(base,{now})),['timestamp','level','event','component','operation','outcome','message']));
    check('F. UTC ISO timestamp',()=>assert.equal(createRecord(base,{now}).timestamp,'2026-10-11T10:00:00.000Z'));
    check('G. Deterministic clock',()=>assert.deepEqual(createRecord(base,{now}),createRecord(base,{now})));
    const seen=[];records.length=0;
    const childId='507f1f77bcf86cd799439011';
    const options={observability:observation,headers:{'x-request-id':'untrusted'},db:{collection:()=>({findOne:async()=>({_id:childId})})},
        generateRecommendations:async()=>observeOperation({component:'RecommendationEngine',operation:'generate'},async()=>{seen.push(currentTrace());await Promise.resolve();seen.push(currentTrace());return {childId,recommendations:[]};})};
    const response=await handleRecommendations(childId,3,options), apiRecords=[...records];
    check('H. One owned request ID',()=>{assert.equal(new Set(apiRecords.map(r=>r.requestId)).size,1);assert.notEqual(apiRecords[0].requestId,'untrusted');});
    check('I. One correlation ID',()=>assert.equal(new Set(apiRecords.map(r=>r.correlationId)).size,1));
    check('J. Request propagated',()=>seen.forEach(t=>assert.equal(t.requestId,apiRecords[0].requestId)));
    check('K. Correlation propagated',()=>seen.forEach(t=>assert.equal(t.correlationId,apiRecords[0].correlationId)));
    check('L. No nested generation; concurrent isolation',()=>assert.equal(ids,2));
    await Promise.all([handleRecommendations(childId,3,options),handleRecommendations(childId,3,options)]);
    assert.equal(new Set(records.filter(r=>r.component==='ProductAPI'&&r.event==='OPERATION_STARTED').map(r=>r.requestId)).size,3);
    let background,independent;
    await runRequest(()=>runBackground(()=>{background=currentTrace();},{correlationId:currentTrace().correlationId,logger}),observation);
    await runBackground(()=>{independent=currentTrace();},observation);
    check('M. Background correlation only',()=>{assert.deepEqual(Object.keys(background),['correlationId']);assert.equal(background.correlationId,'opaque_8');});
    check('N. Independent background identity',()=>{assert.deepEqual(Object.keys(independent),['correlationId']);assert.ok(independent.correlationId);});
    check('O. Opaque IDs without business data',()=>{const t=createRequestTrace({requestId:childId,correlationId:childId});for(const id of Object.values(t))assert.match(id,/^[a-f0-9-]{36}$/);assert.ok(!Object.values(t).includes(childId));assert.deepEqual(createBackgroundTrace({correlationId:'opaque'}),{correlationId:'opaque'});});
    const failure=createReliabilityFailure({category:'DEPENDENCY_FAILURE',stateStatus:'UNKNOWN',component:'Neo4j',operation:'discover',message:'secret database details',cause:new Error('password=abc'),diagnosticContext:{answer:'private'}});
    const failedRecord=createRecord({...base,level:'ERROR',event:'OPERATION_FAILED',outcome:'FAILURE',failure},{now});
    check('P. Explicit D1 category',()=>assert.equal(failedRecord.failureCategory,'DEPENDENCY_FAILURE'));
    check('Q. Explicit D1 state',()=>assert.equal(failedRecord.stateStatus,'UNKNOWN'));
    check('R. No classification guesses',()=>{const r=createRecord({...base,failure:new Error('Neo4j timeout')},{now});assert.ok(!Object.hasOwn(r,'failureCategory'));assert.ok(!Object.hasOwn(r,'stateStatus'));assert.ok(!JSON.stringify(failedRecord).includes('private'));assert.throws(()=>createRecord({...base,failureCategory:'NETWORK_FAILURE'},{now}),TypeError);});
    check('S. Successful lifecycle',()=>assert.ok(apiRecords.some(r=>r.event==='OPERATION_COMPLETED'&&r.outcome==='SUCCESS')));
    records.length=0;options.generateRecommendations=async()=>{throw failure;};
    const failedResponse=await handleRecommendations(childId,3,options);
    check('T. Failed lifecycle',()=>{assert.equal(records.at(-1).event,'OPERATION_FAILED');assert.equal(records.at(-1).outcome,'FAILURE');assert.equal(records.at(-1).failureCategory,'DEPENDENCY_FAILURE');});
    await runRequest(()=>observeOperation({component:'Test',operation:'partial',outcomeOf:()=>OUTCOME.DEGRADED},async()=>({completed:['source']})),observation);
    check('U. Degraded lifecycle',()=>{assert.equal(records.at(-1).event,'OPERATION_DEGRADED');assert.equal(records.at(-1).outcome,'DEGRADED');});
    check('V. Empty recommendations successful',()=>assert.deepEqual(response,{status:200,body:{success:true,data:{childId,recommendations:[]}}}));
    check('W. No Question stays successful',()=>regression('testAdaptiveQuestionApi'));
    records.length=0;
    const suppressed=await runRequest(()=>processContinuousLearningSource('Interaction',{_id:'original-source'},{dependencies:{processLearningSource:async()=>[{status:'IGNORED',reasonCode:'DUPLICATE_EVENT',event:null}]}}),observation);
    check('X. Suppression remains successful',()=>{assert.equal(suppressed.results[0].status,'IGNORED');assert.equal(records.at(-1).event,'OPERATION_COMPLETED');assert.equal(records.at(-1).outcome,'SUCCESS');});
    const context={interactionId:'canonical_id',activityId:'activity_1',status:'IGNORED',resultCount:0,password:'hidden',authorization:'hidden',accessToken:'hidden',refresh_token:'hidden',token:'hidden',cookie:'hidden',apiKey:'hidden',secret:'hidden',connectionString:'mongodb://user:pass@host/db',body:{answer:'private'},child:{name:'private'},preferences:['private']};
    const snapshot=JSON.stringify(context),safe=createRecord({...base,level:'DEBUG',context},{now});
    check('Y. Controlled context',()=>assert.deepEqual(safe.context,{interactionId:'canonical_id',activityId:'activity_1',status:'IGNORED',resultCount:0}));
    check('Z. Secrets excluded',()=>{assert.ok(!JSON.stringify(safe).includes('hidden'));assert.ok(!JSON.stringify(safe).includes('user:pass'));const r=createRecord({...base,message:'Failed mongodb://user:pass@host/db password=hidden Bearer abc'},{now});assert.ok(!JSON.stringify(r).includes('hidden'));assert.ok(!JSON.stringify(r).includes('user:pass'));assert.ok(!JSON.stringify(r).includes('Bearer abc'));});
    check('AA. Arbitrary documents/accessors dropped',()=>{const c={...context};Object.defineProperty(c,'jobId',{enumerable:true,get(){throw new Error('Do not invoke');}});assert.deepEqual(createRecord({...base,context:c},{now}).context,safe.context);assert.ok(!JSON.stringify(safe).includes('private'));});
    check('AB. Context not mutated',()=>{safe.context.activityId='changed';assert.equal(JSON.stringify(context),snapshot);});
    let calls=0;
    for(const emit of [()=>{throw Error('sink failure');},async()=>{throw Error('async sink failure');}]) {
        options.observability={...observation,logger:createLogger({now,emit})};options.generateRecommendations=async()=>{calls++;return {childId,recommendations:[]};};
        assert.deepEqual(await handleRecommendations(childId,3,options),response);
    }
    const sentinel=new Error('original failure');
    await assert.rejects(runRequest(()=>observeOperation({component:'Test',operation:'fail'},async()=>{throw sentinel;}),{logger:{log(){throw Error('logger failed');}}}),e=>e===sentinel);
    await new Promise(resolve=>setImmediate(resolve));
    check('AC. Emission failures isolated',()=>assert.equal(calls,2));
    check('AD. No operation replay',()=>assert.equal(calls,2));
    check('AE. Interaction identity unchanged',()=>regression('testInteractionApi'));
    check('AF. Answer replay identity unchanged',()=>regression('testQuestionAnswerApi'));
    check('AG. Graph job identity unchanged',()=>regression('testQueueWorker'));
    check('AH. Public envelope unchanged',()=>{assert.deepEqual(failedResponse,{status:500,body:{success:false,error:{code:'INTERNAL_ERROR',message:'An unexpected error occurred.'}}});regression('testApiFoundation');});
    check('AI. Recommendation unchanged',()=>{regression('testRecommendationApi');regression('testRecommendationEngine');});
    check('AJ. Eligibility unchanged',()=>regression('testRecommendationEligibility'));
    check('AK. Adaptive questions unchanged',()=>regression('testQuestionSelectionService'));
    check('AL. Learning unchanged',()=>{regression('testContinuousLearningService');regression('testEventIdempotencyService');});
    check('AM. Answer integration unchanged',()=>regression('testQuestionLearningIntegrationService'));
    const loaderScript=`const Module=require('node:module');const load=Module._load;Module._load=function(name,...args){if(/mongodb|neo4j|learning|question|config|workers|services/i.test(name))throw Error('Business dependency forbidden');return load.call(this,name,...args);};const logger=require(${JSON.stringify(require.resolve('../../observability/structuredLogger'))});const trace=require(${JSON.stringify(require.resolve('../../observability/traceContext'))});trace.runRequest(()=>logger.createLogger({emit:()=>{}}).log(${JSON.stringify(base)}));`;
    const isolated=spawnSync(process.execPath,['-e',loaderScript],{cwd:root,encoding:'utf8',timeout:10000});
    check('AN. Logger has no Mongo writes',()=>assert.equal(isolated.status,0,isolated.stderr));
    check('AO. Logger has no Neo4j writes',()=>assert.equal(isolated.status,0,isolated.stderr));
    // Every real product handler emits a lifecycle without exposing its input.
    for(const call of [()=>handleChildIntelligence('',{observability:observation}),()=>handleNextQuestion('',{}, {observability:observation}),()=>handleQuestionAnswer('',{}, {observability:observation}),()=>handleInteraction('',{}, {observability:observation})]) {
        records.length=0;const r=await call();assert.equal(r.body.success,false);assert.deepEqual(records.map(r=>r.event),['OPERATION_STARTED','OPERATION_FAILED']);
    }
    // Exercise the actual worker boundary with a controlled DB and builder.
    const mongoPath=require.resolve('../../config/mongodb'),builderPath=require.resolve('../../services/graphBuilderService'),workerPath=require.resolve('../../workers/queueWorker');
    const saved=[mongoPath,builderPath,workerPath].map(p=>[p,require.cache[p]]);
    const job={_id:new ObjectId('abcdef000000000000000001'),status:'PENDING',entityType:'Child',operation:'UPDATE'};
    const updates=[],workerTraces=[];let effects=0;
    try {
        require.cache[mongoPath]={exports:{getDatabase:()=>({collection:()=>({find:()=>({toArray:async()=>[job]}),updateOne:async(filter,update)=>{updates.push({filter,update});return {matchedCount:1};}})})}};
        require.cache[builderPath]={exports:{process:async()=>{effects++;workerTraces.push(currentTrace());}}};
        delete require.cache[workerPath];const {processQueue}=require(workerPath);
        records.length=0;
        await runRequest(()=>processQueue(),observation);
        assert.equal(records.length,2);assert.deepEqual(records.map(r=>r.event),['OPERATION_STARTED','OPERATION_COMPLETED']);
        assert.equal(records[0].requestId,undefined);assert.equal(records[0].correlationId,workerTraces[0].correlationId);
        assert.equal(records[0].context.jobId,String(job._id));assert.deepEqual(Object.keys(workerTraces[0]),['correlationId']);
        await processQueue({}, {correlationId:'continuation',logger:createLogger({emit:()=>{throw Error('sink');}})});
        assert.equal(workerTraces[1].correlationId,'continuation');assert.equal(workerTraces[1].requestId,undefined);
        assert.equal(effects,2);assert.equal(updates.length,2);updates.forEach(u=>{assert.deepEqual(u.filter,{_id:job._id});assert.equal(u.update.$set.status,'PROCESSED');});
        assert.equal(job.status,'PENDING');assert.equal(job.correlationId,undefined);
    } finally { for(const [p,value]of saved) {if(value)require.cache[p]=value;else delete require.cache[p];} }
    // Invalid observational setup must still call business code exactly once.
    let setupCalls=0;
    await runRequest(()=>{setupCalls++;assert.equal(currentTrace(),undefined);},{idFactory:()=>{throw Error('ID generation');}});
    await runBackground(()=>{setupCalls++;assert.equal(currentTrace(),undefined);},null);
    assert.equal(setupCalls,2);
    assert.equal(passed,41);console.log('41/41 D2 validation groups passed.');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
