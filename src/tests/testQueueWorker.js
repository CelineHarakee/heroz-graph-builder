const assert = require('assert');
const { ObjectId } = require('mongodb');
const mongoPath = require.resolve('../config/mongodb');
const builderPath = require.resolve('../services/graphBuilderService');
const workerPath = require.resolve('../workers/queueWorker');
const copy = v => v instanceof ObjectId ? new ObjectId(v) : v instanceof Date ? new Date(v) :
    Array.isArray(v) ? v.map(copy) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k,x])=>[k,copy(x)])) : v;
const a = new ObjectId('abcdef000000000000000001'), b = new ObjectId('abcdef000000000000000002'), c = new ObjectId('abcdef000000000000000003');
function fixture() {
    const f = { rows: [a,b,c].map(_id=>({_id,entityType:'Child',operation:'UPDATE',status:'PENDING',retained:'unchanged'})), queries:[],processed:[],updates:[],accesses:0 };
    f.db = {collection(name) {
        assert.strictEqual(name,'graph_sync_queue');
        return {find(query) {
            f.queries.push(copy(query));
            return {toArray:async()=>f.rows.filter(row=>row.status===query.status&&(!query._id||query._id.$in.some(id=>id.equals(row._id)))).map(copy)};
        },async updateOne(filter,update) {
            f.updates.push(copy({filter,update}));
            assert.deepStrictEqual(Object.keys(filter),['_id']);
            const row=f.rows.find(r=>r._id.equals(filter._id));assert(row);
            Object.assign(row,copy(update.$set));return {matchedCount:1};
        }};
    }};
    return f;
}
async function main() {
    const saved = [mongoPath,builderPath,workerPath].map(path=>[path,require.cache[path]]);
    const log=console.log,error=console.error;let f;
    try {
        // Replace dependency modules BEFORE loading the worker: no configuration,
        // Mongo client or graph driver is loaded by these tests.
        require.cache[mongoPath]={exports:{getDatabase(){f.accesses++;return f.db;}}};
        require.cache[builderPath]={exports:{async process(job){f.processed.push(String(job._id));if(f.fail?.equals(job._id))throw Error('controlled builder failure');}}};
        delete require.cache[workerPath];const {processQueue}=require(workerPath);
        console.log=()=>{};console.error=()=>{};
        f=fixture();assert.strictEqual(await processQueue(),undefined);
        assert.deepStrictEqual(f.queries,[{status:'PENDING'}]);assert.deepStrictEqual(f.processed,[a,b,c].map(String));
        assert(f.rows.every(r=>r.status==='PROCESSED'&&r.processedAt instanceof Date));
        f=fixture();const untouched=copy(f.rows[1]);
        assert.strictEqual(await processQueue({jobIds:[a,String(c).toUpperCase()]}),undefined);
        assert.deepStrictEqual(f.queries,[{status:'PENDING',_id:{$in:[a,c]}}]);
        assert.deepStrictEqual(f.processed,[a,c].map(String));assert.deepStrictEqual(f.rows[1],untouched);
        assert(f.updates.every(u=>[String(a),String(c)].includes(String(u.filter._id))));
        for(const ids of [[],[new ObjectId()]]) {
            f=fixture();const before=copy(f.rows);await processQueue({jobIds:ids});
            assert.deepStrictEqual(f.rows,before);assert.strictEqual(f.processed.length,0);assert.strictEqual(f.updates.length,0);
            assert.deepStrictEqual(f.queries,[{status:'PENDING',_id:{$in:ids}}]);
        }
        f=fixture();f.rows[0].status='PROCESSED';f.rows[0].processedAt=new Date(0);f.rows[1].status='FAILED';f.rows[1].error='old';f.rows[1].failedAt=new Date(0);
        const before=copy(f.rows);await processQueue({jobIds:[a,b]});assert.deepStrictEqual(f.rows,before);assert.strictEqual(f.processed.length,0);
        f=fixture();const input={jobIds:[a,a,String(a),String(a).toUpperCase()]},inputBefore=copy(input);
        await processQueue(input);assert.deepStrictEqual(input,inputBefore);assert.deepStrictEqual(f.processed,[String(a)]);
        assert.deepStrictEqual(f.queries,[{status:'PENDING',_id:{$in:[a]}}]);assert.strictEqual(f.updates.length,1);
        for(const invalid of ['bad','',null,undefined,42,{},{$ne:null},'abcdefghijkl',new Array(1)]) {
            for(const ids of [[invalid],[a,invalid]]) {
                f=fixture();const before=copy(f.rows);await assert.rejects(processQueue({jobIds:ids}),TypeError);
                assert.strictEqual(f.accesses,0);assert.deepStrictEqual(f.rows,before);assert.deepStrictEqual(f.processed,[]);assert.deepStrictEqual(f.updates,[]);
            }
        }
        for(const options of [null,[],false,'all',{jobIds:null},{jobIds:undefined},{jobIds:'bad'},{filter:{status:'PENDING'}},{jobIds:[a],filter:{}},Object.create({jobIds:[a]})]) {
            f=fixture();await assert.rejects(processQueue(options),TypeError);assert.strictEqual(f.accesses,0);
        }
        f=fixture();f.fail=a;const others=copy(f.rows.slice(1));await processQueue({jobIds:[a]});
        assert.strictEqual(f.rows[0].status,'FAILED');assert.strictEqual(f.rows[0].error,'controlled builder failure');assert(f.rows[0].failedAt instanceof Date);
        assert(!Object.hasOwn(f.rows[0],'processedAt'));assert.deepStrictEqual(f.rows.slice(1),others);assert.strictEqual(f.updates.length,1);
        f=fixture();f.fail=a;await processQueue({jobIds:[a,c]});assert.strictEqual(f.rows[0].status,'FAILED');assert.strictEqual(f.rows[2].status,'PROCESSED');assert.strictEqual(f.rows[1].status,'PENDING');
        f=fixture();f.rows[1].status='FAILED';f.rows[2].status='PROCESSED';await processQueue({});assert.deepStrictEqual(f.processed,[String(a)]);
    } finally {
        console.log=log;console.error=error;
        for(const [path,original] of saved){if(original)require.cache[path]=original;else delete require.cache[path];}
    }
    console.log('Queue worker isolation unit tests: PASSED');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
