// D3 measures the frozen baseline. D1 owns metrics, aggregation and engine setup.
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const executeFile = promisify(execFile);
const BASELINE_KS = Object.freeze([1, 3, 5]);

async function runBaseline() {
    // Production imports cache their infrastructure dependencies. A fresh process
    // keeps the controlled adapter out of both the caller and subsequent runs.
    const { stdout } = await executeFile(process.execPath, [__filename, '--worker'], {
        maxBuffer: 16 * 1024 * 1024, timeout: 60000
    });
    return JSON.parse(stdout);
}

async function evaluateInWorker() {
    const assert = require('node:assert/strict');
    const { isDeepStrictEqual } = require('node:util');
    const Module = require('node:module');
    const path = require('node:path');
    const { ObjectId } = require('mongodb');
    const { createEvaluationDatasetV1 } = require('./datasets/evaluationDatasetV1');
    const { SCORING_WEIGHTS } = require('../recommendation/scoringContract');
    const dataset = createEvaluationDatasetV1();
    const original = JSON.stringify(dataset), weights = { ...SCORING_WEIGHTS };
    const root = path.resolve(__dirname, '..');
    const savedLoad = Module._load, savedLog = console.log;
    let active;
    const audit = { caseIds: [], discoveryCalls: 0, databaseReads: 0, forbiddenOperations: [], engineCalls: 0 };
    function copy(value) {
        if (value instanceof ObjectId) return new ObjectId(value);
        if (value instanceof Date) return new Date(value.getTime());
        if (Array.isArray(value)) return value.map(copy);
        if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, copy(v)]));
        return value;
    }
    function valuesAt(value, parts) {
        if (!parts.length) return [value];
        if (Array.isArray(value)) return value.flatMap(item => valuesAt(item, parts));
        return valuesAt(value?.[parts[0]], parts.slice(1));
    }
    function matches(record, query) {
        return Object.entries(query).every(([key, expected]) => {
            const values = valuesAt(record, key.split('.'));
            if (expected && Object.hasOwn(expected, '$in')) return values.some(v => expected.$in.some(item => isDeepStrictEqual(item, v)));
            assert.ok(!expected || typeof expected !== 'object' || !Object.keys(expected).some(k => k.startsWith('$')), 'Unsupported fixture query');
            return values.some(v => isDeepStrictEqual(v, expected));
        });
    }
    function blocked(message) { audit.forbiddenOperations.push(message); throw new Error(message); }
    const db = {
        listCollections(filter = {}) {
            assert.ok(active);
            return { toArray: async () => Object.keys(active.fixture).filter(name => !filter.name || filter.name === name).map(name => ({ name })) };
        },
        collection(name) {
            assert.ok(active && Object.hasOwn(active.fixture, name), `Unknown collection ${name}`);
            const records = active.fixture[name];
            const methods = {
                async findOne(query) { audit.databaseReads++; return copy(records.find(record => matches(record, query)) ?? null); },
                find(query = {}) {
                    audit.databaseReads++;
                    return { project() { return this; }, async toArray() { return copy(records.filter(record => matches(record, query))); } };
                }
            };
            return new Proxy(methods, { get(target, key) { return Object.hasOwn(target, key) ? target[key] : blocked(`Forbidden DB operation ${name}.${String(key)}`); } });
        }
    };
    const engineWrappers = new WeakMap();
    try {
        // Reserve stdout for the JSON result, including when config emits logs.
        console.log = (...args) => console.error(...args);
        Module._load = function(request, parent, isMain) {
            const resolved = Module._resolveFilename(request, parent);
            if (resolved === path.join(root, 'config/mongodb.js')) return { getDatabase: () => db };
            if (resolved === path.join(root, 'traversal/traversalService.js')) return { async findCandidateActivities(childId) {
                assert.ok(active); assert.equal(String(childId), active.childId); audit.discoveryCalls++;
                return active.candidates.map(c => ({ activity: { activityId: c.activityId }, evidence: { interests: [], goals: [], summary: [] } }));
            } };
            if (['neo4j-driver', '@google/genai', 'http', 'https', 'net', 'tls'].includes(request.replace(/^node:/, ''))) return blocked(`Forbidden external dependency ${request}`);
            if (typeof resolved === 'string' && resolved.startsWith(root + path.sep) && /^(learning|questionLearning|questionEligibility|workers|builders)\//.test(path.relative(root, resolved))) return blocked(`Forbidden intelligence mutation dependency ${request}`);
            const loaded = savedLoad.call(this, request, parent, isMain);
            if (resolved === path.join(root, 'recommendation/recommendationEngineService.js')) {
                // Transparent call tracing, not a substituted engine/result.
                if (!engineWrappers.has(loaded)) engineWrappers.set(loaded, { ...loaded, createRecommendationEngine(...args) {
                    const engine = loaded.createRecommendationEngine(...args);
                    return { async generateRecommendations(...input) { audit.engineCalls++; return engine.generateRecommendations(...input); } };
                } });
                return engineWrappers.get(loaded);
            }
            return loaded;
        };
        const { evaluateCases } = require('./evaluationRunner');
        const { recommendationCoverage } = require('./evaluationMetrics');
        const result = await evaluateCases({ ...dataset, ks: BASELINE_KS,
            async withCaseEnvironment(c, execute) {
                assert.equal(active, undefined); active = copy(c); audit.caseIds.push(c.caseId);
                const before = JSON.stringify(active);
                try { await execute(); } finally { assert.equal(JSON.stringify(active), before, 'Fixture mutated'); active = undefined; }
            }
        });
        assert.equal(JSON.stringify(dataset), original, 'Dataset mutated');
        assert.deepEqual(SCORING_WEIGHTS, weights);
        assert.deepEqual(audit.forbiddenOperations, []);
        assert.equal(audit.engineCalls, 12); assert.equal(audit.discoveryCalls, 12);
        return { ...result, evaluatedAt: dataset.evaluatedAt.toISOString(),
            cases: result.cases.map(c => ({ ...c, recommendationCoverage: recommendationCoverage([c]) })),
            execution: { ...audit, fixtureStateUnchanged: true, configurationUnchanged: true,
                infrastructure: 'Read-only in-memory Mongo adapter; controlled discovery; D1 case-local outputs; external language provider disabled. No live MongoDB/Neo4j validation.' } };
    } finally { Module._load = savedLoad; console.log = savedLog; }
}

function formatBaseline(result) {
    const display = value => value === null ? 'N/A' : value.toFixed(3);
    const lines = ['HEROZ RECOMMENDATION BASELINE', `Dataset: ${result.datasetVersion}`, `Reference time: ${result.evaluatedAt}`, `K: ${result.requestedKs.join(', ')}`];
    function section(name, summary) {
        lines.push('', name, 'Metric                 @1       @3       @5');
        for (const [key, title] of [['relevance', 'Relevance'], ['ndcg', 'NDCG'], ['diversity', 'Diversity']])
            lines.push(`${title.padEnd(20)} ${result.requestedKs.map(k => display(summary.metricsByK[k][key].value).padStart(8)).join(' ')}`);
        lines.push(`Recommendation Coverage: ${display(summary.recommendationCoverage)}`, `Exploration Relevance Rate: ${display(summary.explorationRelevanceRate.value)}`);
    }
    section('Overall', result.overall);
    for (const [state, summary] of Object.entries(result.segments)) section(state, summary);
    lines.push('', 'Case   Relevance@3  NDCG@3  Diversity@3  Coverage  Exploration');
    for (const c of result.cases) lines.push(`${c.caseId.padEnd(5)} ${[c.metricsByK[3].relevance, c.metricsByK[3].ndcg, c.metricsByK[3].diversity, c.recommendationCoverage, c.explorationRelevanceRate].map(display).join('        ')}`);
    lines.push('', 'Exploration rate uses the returned Top-5 list; all metrics and aggregates are from D1. N/A is excluded from means. No quality thresholds or tuning.', result.execution.infrastructure);
    return lines.join('\n');
}
module.exports = { BASELINE_KS, runBaseline, formatBaseline };
if (require.main === module) {
    const mode = process.argv[2];
    const task = mode === '--worker' ? evaluateInWorker() : !mode || mode === '--json' ? runBaseline() : Promise.reject(new Error('Use no argument for summary or --json for full results'));
    task.then(result => process.stdout.write(mode === '--worker' || mode === '--json' ? JSON.stringify(result) + '\n' : formatBaseline(result) + '\n'))
        .catch(error => { console.error(error); process.exitCode = 1; });
}
