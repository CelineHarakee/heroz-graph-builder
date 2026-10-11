// Default: deterministic only. Live checks are explicitly opt-in and delegated
// to the existing Phase 3 runner (including its scoped Phase 2 graph acceptance).
// node src/tests/systemTestV1/phase4FinalAcceptance.js --run-live-development
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname, '../../..');
const live = process.argv.includes('--run-live-development');
const results = new Map();
const areas = new Map();
const notes = new Set();
const focused = ['ApiFoundation', 'ChildIntelligenceApi', 'RecommendationApi', 'AdaptiveQuestionApi', 'QuestionAnswerApi', 'InteractionApi'];
const loopFile = 'src/tests/systemTestV1/phase4D7ProductClosedLoop.js';
const phase3File = 'src/tests/systemTestV1/phase3FinalAcceptance.js';
const allowedSkips = new Set(['A D1 Knowledge Gap Model', 'S Phase 2 Regression']);

// Cache both success and failure. A suite can support several areas without
// another invocation. Phase 3's internal scheduling remains its own responsibility.
function run(file, args = []) {
    const key = JSON.stringify([file, args]);
    if (!results.has(key)) {
        console.log(`Running ${file}${args.length ? ' ' + args.join(' ') : ''}`);
        const result = spawnSync(process.execPath, [file, ...args], {
            cwd: root, encoding: 'utf8', timeout: 600000, maxBuffer: 8 * 1024 * 1024
        });
        results.set(key, result);
    }
    const result = results.get(key);
    if (result.error || result.status !== 0) {
        throw new Error(`${file} failed (${result.error?.message ?? result.signal ?? result.status})\n${result.stdout ?? ''}${result.stderr ?? ''}`);
    }
    assert.ok(!/^.*: FAIL\s*$/m.test(result.stdout), `${file} reported FAIL`);
    return result.stdout;
}
function suite(name) { return run(`src/tests/test${name}.js`); }
function suites(names) { names.forEach(suite); }
function productLoop() {
    const output = run(loopFile);
    assert.match(output, /^D7B PRODUCT CLOSED LOOP: PASS$/m);
    return output;
}
function phase3() {
    const output = run(phase3File, live ? ['--run-live-development'] : []);
    assert.match(output, /^PHASE 3 FINAL ACCEPTANCE: PASS$/m);
    const rows = [...output.matchAll(/^([A-U] [^:\n]+): (PASS|FAIL|SKIPPED)$/gm)];
    assert.equal(rows.length, 21, 'Incomplete Phase 3 acceptance report');
    assert.equal(new Set(rows.map(row => row[1][0])).size, 21);
    for (const [, label, status] of rows) {
        if (status === 'SKIPPED') {
            assert.ok(!live && allowedSkips.has(label), `Unexpected Phase 3 skip: ${label}`);
            notes.add(`${label}: SKIPPED (--run-live-development not supplied)`);
        } else assert.equal(status, 'PASS', label);
    }
    return output;
}
function area(label, verify) {
    try { verify(); areas.set(label, 'PASS'); }
    catch (error) { areas.set(label, 'FAIL'); console.error(`${label}: ${error.message}`); }
}
function repositorySafety() {
    execFileSync('git', ['diff', '--check'], { cwd: root, stdio: 'pipe' });
    const allowed = new Set([loopFile, 'src/tests/systemTestV1/phase4FinalAcceptance.js']);
    const tracked = execFileSync('git', ['diff', 'HEAD', '--name-only', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
    const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
    for (const file of [...tracked, ...untracked]) assert.ok(allowed.has(file), `Unexpected repository change: ${file}`);
    // git diff --check does not inspect untracked additions.
    for (const file of untracked) {
        const checked = spawnSync('git', ['diff', '--no-index', '--check', '/dev/null', file], { cwd: root, encoding: 'utf8' });
        assert.ok(!checked.error && [0, 1].includes(checked.status) && !checked.stdout && !checked.stderr, `Whitespace failure: ${file}`);
    }
}
function main() {
    assert.ok(process.argv.slice(2).every(arg => arg === '--run-live-development'), 'Unsupported acceptance argument');
    console.log(`PHASE 4 FINAL ACCEPTANCE — ${live ? 'LIVE DEVELOPMENT OPT-IN' : 'DETERMINISTIC'}`);
    console.log('Suite results are reused across acceptance areas; each direct suite runs once.');
    const apiLabels = ['A. D1 API Foundation', 'B. D2 Child Intelligence API', 'C. D3 Recommendation API',
        'D. D4 Adaptive Question API', 'E. D5 Answer & Learning API', 'F. D6 Interaction & Feedback API'];
    apiLabels.forEach((label, index) => area(label, () => suite(focused[index])));
    area('G. Product Closed Loop', productLoop);
    area('H. Phase 3 Regression', phase3);
    area('I. Phase 2 / D7 Learning Integrity', () => {
        // Phase 3 already runs LearningRuleEngine and ParentDecision persistence/
        // continuous-learning suites. Reuse that result instead of repeating them.
        phase3();
        suites(['EventNormalizer', 'EventValidator', 'EventReferenceValidator', 'LearningEventProcessor',
            'EventIdempotencyService', 'RepeatLimitService', 'D7CLearningRuleBoundary', 'InterestStateTransition',
            'ContinuousLearningService', 'InterestLearningService', 'D7InterestLearningPipeline',
            'LearningPersistenceService', 'LearningPersistenceIndexes', 'D7HActivityAdmission']);
    });
    area('J. Recommendation Integrity', () => {
        // Phase 3 verifies exact V1 weights, FinalScore and PreferenceFactor.
        phase3(); productLoop();
        suites(['RecommendationEngine', 'RecommendationEligibility', 'InterestFactor', 'GoalFactor',
            'ExplorationFactor', 'BehaviorFactor', 'SessionFactor', 'FullRankingIntegration',
            'FullSelectionIntegration', 'RecommendationResultBuilder', 'RecommendationSnapshotBuilder', 'RecommendationPersistence']);
    });
    area('K. Question / Learning Integrity', () => { phase3(); suites(['AdaptiveQuestionApi', 'QuestionAnswerApi']); });
    area('L. Interaction / Learning Integrity', () => { suites(['InteractionApi', 'D7InterestLearningPipeline', 'D7CLearningRuleBoundary']); productLoop(); });
    area('M. Graph Queue Integrity', () => {
        suites(['LearningPersistenceService', 'QueueWorker']); phase3(); productLoop();
        if (!live) notes.add('Live MongoDB/Neo4j discovery, transactions and graph synchronization: SKIPPED (deterministic adapters only)');
    });
    area('N. Failure Safety', () => { suites(focused); suites(['ContinuousLearningService', 'LearningPersistenceService']); });
    area('O. Ownership / Architecture', () => { suites(focused); productLoop(); phase3(); });
    area('P. Replay / Idempotency', () => { suites(['QuestionAnswerApi', 'InteractionApi', 'EventIdempotencyService', 'LearningPersistenceService']); phase3(); });
    area('Q. No LLM / Agent Execution Dependency', () => {
        const output = productLoop();
        assert.match(output, /No live MongoDB\/Neo4j or LLM calls\./);
        suites(focused);
        notes.add('Phase 4 product intelligence correctness has no required LLM/agent execution dependency. The product loop disables language generation and uses real fallback explanations; Heroz still has optional LLM capability.');
    });
    area('R. Data / Graph Cleanup', () => {
        assert.match(productLoop(), /^K\. Cleanup \/ Infrastructure Boundary: PASS \(isolated store; hooks restored\)$/m);
        phase3(); suite('QueueWorker');
        notes.add(live ? 'Live cleanup is owned by the existing opt-in suites; Phase 4 performs no collection clearing or queue draining.' : 'Default tests use isolated fixtures; no external data/graph cleanup is needed.');
    });
    area('S. Repository Safety', repositorySafety);
    console.log('\nPHASE 4 FINAL ACCEPTANCE RESULTS');
    for (const [label, status] of areas) console.log(`${label}: ${status}`);
    for (const note of notes) console.log(note);
    const loop = results.get(JSON.stringify([loopFile, []]));
    for (const line of (loop?.stdout ?? '').split('\n')) {
        if (/^(BEFORE score\/rank:|AFTER score\/rank:|Score movement:)/.test(line)) console.log(line);
    }
    const passed = [...areas.values()].filter(status => status === 'PASS').length;
    const success = areas.size === 19 && passed === 19;
    console.log(`${passed}/19 REQUIRED ACCEPTANCE AREAS PASSED`);
    console.log(`PHASE 4 FINAL ACCEPTANCE: ${success ? 'PASS' : 'FAIL'}`);
    if (!success) { process.exitCode = 1; return; }
    console.log('PHASE 4 COMPLETE\n7/7 DELIVERABLES COMPLETED\nINTEGRATED\nTESTED\nVERIFIED\nACCEPTED');
}
try { main(); }
catch (error) {
    console.error(error);
    console.log('PHASE 4 FINAL ACCEPTANCE: FAIL');
    process.exitCode = 1;
}
