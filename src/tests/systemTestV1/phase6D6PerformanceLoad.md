# Phase 6 D6 — Performance & Load Testing

PHASE 6 D6 PERFORMANCE & LOAD TESTING: PASS

## Scope and infrastructure audit

D6 adds a focused benchmark and one test-only fixture. No existing production or
baseline test files are modified. No dependencies, retries, fallback, indexes,
caches, queue semantics, scoring or learning rules are added or changed.

The audit inspected Phase 4 callable API/product integration, recommendation
context/engine, interaction and continuous-learning/replay tests, adaptive
question/answer tests, queue/worker tests, and Phase 6 D4/D5. Existing conventions
provide dependency injection/module substitution, in-memory Mongo operations,
fixed business clocks, D4 metrics collectors, and background/request observation.
D4 already tests concurrent observation isolation. The existing product fixture
has one transaction session and cannot model overlapping writes safely as-is.
The D6 fixture adapts that fixture's data/query/update conventions with independent
snapshots and atomic per-document optimistic conflict validation. This is a
controlled dependency substitute, not a new application transaction system.

Real API handlers, context building and Mongo revalidation, eligibility, all six
factors, final score, ranking, selection, recommendation snapshot/explanation
persistence, learning normalization/validation/transitions/transactional guards,
question selection/history/integration, and the queue/service/LIKES builder run.
Only Mongo I/O, graph I/O and candidate discovery are substituted. Discovery
returns three known activities: two eligible with different scores and one failing
gender eligibility. Language generation is disabled through its existing seam.
The real existing fallback explanation code runs.

## Run and measurement method

```sh
node src/tests/systemTestV1/phase6D6PerformanceLoad.js
node src/tests/systemTestV1/phase6D6PerformanceLoad.js --report /tmp/heroz-d6-results.json
```

Each of eight scenarios runs with fresh state at concurrency 1, 4 and 8. Each
level launches exactly one cohort of N operations: 24 scenarios, 104 total
operations. No sustained arrival rate, uncontrolled stress, or breaking-point
search is performed. There are no sleeps. Dependency I/O yields through
setImmediate to create real overlapping asynchronous calls; transactions also
yield at commit. The business clock is fixed using the existing product-test
pattern and restored afterward. Timing uses the real monotonic performance clock,
independent of fixed business time. A serial recommendation reference and the
completed-answer replay seed are setup work excluded from timing and D4 counts.
No general warm-up or statistically sampled repeated performance analysis occurs.

Measurements: requested/completed/success/failure counts; maximum in-flight calls;
elapsed duration; per-operation minimum/mean/maximum latency; completed and
successful operations per second; transaction conflicts and overlap; duplicate
insert failures; existing D4 operation/outcome/duration metrics. Completed
throughput includes safe failures; successful throughput is separate in JSON.
Assertions use counts and correctness, never latency or throughput thresholds.

Business outcomes/counters matched in a second complete run (24/24 scenarios).
Elapsed times vary; the table is one local sample, not reproducible timing.
**Deterministic benchmark results describe the controlled test environment.
They are NOT production-capacity claims or a production SLA.** They exclude real
network delay, Mongo/Neo4j contention, driver behavior, CPU saturation, multiple
processes and production-scale datasets. The fixture models only operations used
by these cases, not every Mongo isolation/index/error behavior.

## Recorded sample

S/F means successful/failed operations. N is both operation count and concurrency.
Throughput below is completed operations per second, including safe failures.

| Path | N | S/F | Elapsed ms | Mean latency ms | Completed ops/s |
| --- | ---: | ---: | ---: | ---: | ---: |
| recommendations | 1 | 1/0 | 1.740 | 1.722 | 574.6 |
| interaction-submission | 1 | 1/0 | 2.351 | 2.349 | 425.3 |
| interaction-replay | 1 | 1/0 | 0.744 | 0.741 | 1343.5 |
| adaptive-question | 1 | 1/0 | 1.829 | 1.827 | 546.6 |
| question-answer-first | 1 | 1/0 | 2.951 | 2.948 | 338.9 |
| question-answer-replay | 1 | 1/0 | 0.079 | 0.075 | 12624.8 |
| graph-worker-disjoint | 1 | 1/0 | 0.849 | 0.846 | 1177.2 |
| graph-failed-job-recovery-overlap | 1 | 1/0 | 0.214 | 0.212 | 4676.5 |
| recommendations | 4 | 4/0 | 4.251 | 4.148 | 940.9 |
| interaction-submission | 4 | 3/1 | 4.731 | 3.630 | 845.4 |
| interaction-replay | 4 | 4/0 | 2.338 | 2.052 | 1710.9 |
| adaptive-question | 4 | 4/0 | 1.174 | 1.107 | 3407.9 |
| question-answer-first | 4 | 1/3 | 1.231 | 0.570 | 3249.2 |
| question-answer-replay | 4 | 4/0 | 0.102 | 0.065 | 39263.8 |
| graph-worker-disjoint | 4 | 4/0 | 0.408 | 0.376 | 9801.9 |
| graph-failed-job-recovery-overlap | 4 | 4/0 | 0.357 | 0.336 | 11200.6 |
| recommendations | 8 | 8/0 | 5.620 | 5.481 | 1423.4 |
| interaction-submission | 8 | 3/5 | 7.674 | 6.463 | 1042.4 |
| interaction-replay | 8 | 8/0 | 2.184 | 2.023 | 3662.4 |
| adaptive-question | 8 | 8/0 | 1.198 | 1.113 | 6675.2 |
| question-answer-first | 8 | 1/7 | 1.202 | 0.533 | 6654.6 |
| question-answer-replay | 8 | 8/0 | 0.102 | 0.063 | 78144.1 |
| graph-worker-disjoint | 8 | 8/0 | 0.825 | 0.776 | 9691.6 |
| graph-failed-job-recovery-overlap | 8 | 8/0 | 0.410 | 0.378 | 19508.2 |

Baseline: 8/8 successful. Small load: 28/32 successful, 4 safe failures.
Higher load: 52/64 successful, 12 safe failures. Overall: 88 successful operations
and 16 explicitly verified safe failures, with no duplicate authoritative learning.

## Correctness, degradation and frozen boundaries

- Recommendations: every response equals its serial reference, including scores,
  factors, evidence and ranks. The hard-ineligible candidate is absent; both
  eligible results survive with the expected score order. Each request creates
  its own original recommendation snapshot; other collections remain unchanged.
- Interaction submissions: each request retains a distinct canonical stored source
  `_id`. Under same-child contention, 1/1, 3/4 and 3/8 apply. Remaining requests
  fail with the existing CONCURRENT_RETRY_EXHAUSTED result and safe HTTP 500.
  All sources remain stored. No extra recovery or retries are added. Committed
  score history, evidence count, confidence and interest score are checked against
  the existing transition rules for the actual committed source sequence. Each
  committed event has one ai_job and one graph queue intent. Failed sources need
  explicit identity-preserving recovery; resubmission is a new logical interaction.
- Interaction replay: concurrent processing of one original source applies exactly
  once at every level. Others use existing duplicate-event suppression. No new
  interaction source is created. Existing D7 retry checks handle modeled conflicts.
- Adaptive questions: calls return valid preference questions/history IDs and do
  not write learning state. Under simultaneous eligibility checks there are N
  PRESENTED records for one child/session, matching the documented check/insert
  race. This is an availability/product boundary, not a uniqueness guarantee.
- First question answers: 1/1, 1/4 and 1/8 succeed. Losing attempts fail safely
  at the same stable source ID's duplicate insertion. Exactly one ParentDecision
  and one completed learning job survive, one preference update is applied, and
  QuestionHistory becomes ANSWERED after the winning required learning succeeds.
  D4 confirms only one ContinuousLearning call. No preference graph job is added.
- Completed-answer replay: all calls succeed, and the complete store is unchanged.
  The fixed clock does not test D5's known fresh-occurredAt source-conflict limit
  for retries after partial question-answer persistence. D5 regressions retain
  the existing failed-learning/ANSWERED safeguards; no semantics are changed here.
- Graph worker: disjoint exact job IDs process normally; overlapping explicit
  recovery of the same FAILED job retains one original job and one logical LIKES
  edge, with unchanged Mongo learning and evidence count. Worker attempts can
  repeat N times because the worker has no claim/lease. This is redundant work,
  not exactly-once processing. Completed jobs are excluded on later recovery.
  No new queue or retry loop is introduced. Live graph identity integrity remains
  outside this in-memory MERGE model.
- D4: API/learning/graph counts, outcome totals and duration counts match actual
  boundaries at every load level. No new collector, logger, labels or traces are
  introduced; benchmark reports are test results. D1 through D5 remain frozen.

The observed degradation is same-child conflict exhaustion, first-answer source
insertion contention, repeated question presentation and redundant worker effort.
No production bottleneck or capacity limit can be inferred from these fixtures.
These weaknesses are reported rather than optimized or hidden. D6 PASS means
bounded measurable execution with verified original semantics and authoritative
state integrity, including the explicit safe-failure cases; it does not mean all
concurrent requests succeed or that the existing races have been fixed.

## Verification and regression results

Focused D6: PASS, 24 scenarios. Repeated outcomes/counters: identical.
100 existing deterministic suites: PASS (94 src/tests unit/integration suites,
Phase 6 D1–D5, and the Phase 4 product closed loop). These cover recommendation,
eligibility/scoring/ranking, interaction/continuous learning, replay/idempotency,
adaptive questioning/answers, queue/worker, and all six Phase 4 callable APIs.

Live-only recommendation and Gemini smoke tests were skipped. No live MongoDB,
Neo4j transaction/driver/uniqueness, HTTP-server, or production capacity tests ran.
The old Phase 4 final repository allowlist is not a D6 acceptance gate; its known
frozen file allowlist excludes later-deliverable files. That aggregate was not
rerun; its behavioral coverage is supplied by the existing suites above.

`git diff --check`, whitespace checks on new files, and JavaScript syntax checks:
PASS. Dependencies added: NONE. Production files modified: NONE. Existing files
modified: NONE. No frozen business-design mismatch introduced; the concurrency
limits above are preserved and disclosed. D7 was not begun. Nothing was pushed.
