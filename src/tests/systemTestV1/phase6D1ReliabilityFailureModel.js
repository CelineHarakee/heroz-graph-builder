const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { FAILURE_CATEGORY, STATE_STATUS, createReliabilityFailure } = require("../../reliability/reliabilityFailure");
const { errorResponse, successResponse } = require("../../api/apiResponse");
const { ApiError } = require("../../api/apiError");
const root = path.resolve(__dirname, "../../..");
let passed = 0;
function check(label, fn) { fn(); passed++; console.log(`${label}: PASS`); }
const input = { category: FAILURE_CATEGORY.DEPENDENCY_FAILURE, component: "Neo4j", operation: "candidateDiscovery",
    message: "Internal dependency failure", stateStatus: STATE_STATUS.UNCHANGED };
function regression(name) {
    const result = spawnSync(process.execPath, [`src/tests/${name}.js`], { cwd: root, encoding: "utf8", timeout: 60000 });
    assert.equal(result.status, 0, `${name}: ${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
}
check("A. Six categories", () => assert.deepEqual(Object.values(FAILURE_CATEGORY), ["INPUT_FAILURE","STATE_FAILURE","DEPENDENCY_FAILURE","TIMEOUT_FAILURE","INTERNAL_FAILURE","PARTIAL_FAILURE"]));
check("B. Four state statuses", () => assert.deepEqual(Object.values(STATE_STATUS), ["UNCHANGED","COMMITTED","PARTIAL","UNKNOWN"]));
check("C. Deterministic representation", () => {
    const a = createReliabilityFailure(input), b = createReliabilityFailure(input);
    assert.deepEqual(a,b); assert.equal(JSON.stringify(a),JSON.stringify(b));
    assert.ok(Object.isFrozen(a)); assert.ok(Object.isFrozen(FAILURE_CATEGORY)); assert.ok(Object.isFrozen(STATE_STATUS));
    assert.equal(a.stack,undefined); assert.equal(a.createdAt,undefined);
});
check("D. Invalid category rejected", () => [undefined,null,"DATABASE_FAILURE","",1].forEach(category => assert.throws(() => createReliabilityFailure({...input,category}),TypeError)));
check("E. Invalid or omitted state rejected", () => [undefined,null,"FAILED","",1].forEach(stateStatus => assert.throws(() => createReliabilityFailure({...input,stateStatus}),TypeError)));
check("F. Categories do not grant retryability", () => Object.values(FAILURE_CATEGORY).forEach(category => Object.values(STATE_STATUS).forEach(stateStatus => assert.equal(createReliabilityFailure({...input,category,stateStatus}).retryable,false))));
check("G. Explicit operation-owned retry flag", () => {
    assert.equal(createReliabilityFailure({...input,retryable:true}).retryable,true);
    assert.equal(createReliabilityFailure(input).retryable,false);
    for (const retryable of [null,1,"true"]) assert.throws(() => createReliabilityFailure({...input,retryable}),TypeError);
});
check("H. Partial completion representable", () => {
    const context = { sourceId:"original-interaction", completedSteps:["interactionPersisted"], pendingSteps:["learning"] };
    const before = JSON.stringify(context);
    const failure = createReliabilityFailure({...input,category:FAILURE_CATEGORY.PARTIAL_FAILURE,component:"ContinuousLearning",operation:"processInteraction",stateStatus:STATE_STATUS.PARTIAL,diagnosticContext:context});
    assert.equal(failure.stateStatus,"PARTIAL");assert.equal(failure.retryable,false);
    assert.equal(failure.diagnosticContext,context);assert.equal(JSON.stringify(context),before);
    assert.equal(createReliabilityFailure({...input,stateStatus:STATE_STATUS.COMMITTED}).stateStatus,"COMMITTED");
});
check("I. Timeout with unknown commit status", () => {
    const failure=createReliabilityFailure({...input,category:FAILURE_CATEGORY.TIMEOUT_FAILURE,stateStatus:STATE_STATUS.UNKNOWN});
    assert.equal(failure.stateStatus,"UNKNOWN");assert.equal(failure.retryable,false);
});
check("J. Component context", () => {assert.equal(createReliabilityFailure(input).component,"Neo4j");assert.throws(()=>createReliabilityFailure({...input,component:" "}),TypeError);});
check("K. Operation context", () => {assert.equal(createReliabilityFailure(input).operation,"candidateDiscovery");assert.throws(()=>createReliabilityFailure({...input,operation:null}),TypeError);assert.throws(()=>createReliabilityFailure({...input,message:""}),TypeError);});
const cause = new Error("mongodb credentials and neo4j internal query details");
const internal = createReliabilityFailure({...input,message:"Private implementation detail",cause,diagnosticContext:{sourceId:"private-id"}});
check("L. Internal diagnostics retained safely", () => {
    assert.equal(internal.cause,cause);assert.deepEqual(internal.diagnosticContext,{sourceId:"private-id"});
    assert.ok(!Object.keys(internal).includes("cause"));assert.ok(!Object.keys(internal).includes("diagnosticContext"));
    const external=errorResponse(internal);
    assert.deepEqual(external,{status:500,body:{success:false,error:{code:"INTERNAL_ERROR",message:"An unexpected error occurred."}}});
    assert.ok(!JSON.stringify(external).includes("Private"));assert.ok(!JSON.stringify(external).includes("credentials"));
});
// A fresh process denies all dependencies when loading/exercising the factory.
// Thus no DB, graph, learning, question or filesystem implementation is reachable.
const isolation = spawnSync(process.execPath,["-e",`
    const Module=require('node:module');
    const target=${JSON.stringify(require.resolve("../../reliability/reliabilityFailure"))};
    const load=Module._load;
    Module._load=function(request,...args){if(request!==target)throw new Error('Forbidden dependency '+request);return load.call(this,request,...args);};
    global.setTimeout=global.setInterval=global.fetch=()=>{throw new Error('Forbidden execution');};
    const model=require(target);
    for(const category of Object.values(model.FAILURE_CATEGORY))for(const stateStatus of Object.values(model.STATE_STATUS)) {
        const failure=model.createReliabilityFailure({category,stateStatus,component:'Test',operation:'describe',message:'Internal',diagnosticContext:{completedSteps:['source persisted']}});
        if(failure.retryable!==false)throw new Error('Unexpected replay');
    }
`],{cwd:root,encoding:"utf8",timeout:10000});
for(const [label,topic]of [["M","Mongo writes"],["N","Neo4j writes"],["O","Learning events"],["P","QuestionHistory changes"]]) check(`${label}. No ${topic}`,()=>assert.equal(isolation.status,0,isolation.stderr));
check("Q. Empty recommendations remain successful",()=>{assert.deepEqual(successResponse({recommendations:[]}),{success:true,data:{recommendations:[]}});regression("testRecommendationApi");});
check("R. No Question remains valid",()=>{assert.deepEqual(successResponse({question:null}),{success:true,data:{question:null}});regression("testAdaptiveQuestionApi");});
check("S. Existing learning suppression/replay contract",()=>{regression("testEventIdempotencyService");regression("testContinuousLearningService");});
check("T. Public envelope unchanged",()=>{for(const status of [400,404,409,500])assert.deepEqual(errorResponse(new ApiError(status,"SAFE_CODE","Safe message")),{status,body:{success:false,error:{code:"SAFE_CODE",message:"Safe message"}}});regression("testApiFoundation");});
check("U. Recommendation behavior unchanged",()=>{regression("testRecommendationEngine");regression("testFinalScore");});
check("V. Eligibility unchanged",()=>regression("testRecommendationEligibility"));
check("W. Continuous learning unchanged",()=>{regression("testD7InterestLearningPipeline");regression("testLearningPersistenceService");});
check("X. Adaptive questioning unchanged",()=>{regression("testQuestionSelectionService");regression("testQuestionEligibilityService");});
check("Y. Question-answer integration unchanged",()=>{regression("testQuestionLearningIntegrationService");regression("testQuestionAnswerApi");});
assert.equal(passed,25);
console.log("25/25 Phase 6 D1 validation groups passed.");
console.log("PHASE 6 D1 RELIABILITY & FAILURE MODEL: PASS");
