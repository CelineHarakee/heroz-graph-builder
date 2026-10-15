# Phase 6 D5 — Resilience & Recovery

## Audit and operation policy

MongoDB remains authoritative. D5 introduces no automatic retry helper, timeout
wrapper, fallback engine, dependency, schema or business identity.

| Operation | Existing protection / D5 decision |
| --- | --- |
| Neo4j interest and goal discovery | Read-only MATCH, session closed in finally. Repeating a read cannot duplicate business state, but results may change with synchronization. No automatic retries added. |
| Mongo recommendation context/revalidation | Read-only current child, interests, parent, goals, activities, vendors, sessions and histories. Safe to read again; no new retries. |
| Whole recommendation generation | Includes snapshot/explanation persistence. Never restart automatically after an uncertain write. |
| Interaction submission | Creates a new canonical `_id` on each submission. Never retry submission automatically. Reprocess the stored Interaction through `processContinuousLearningSource` using its original `_id`. |
| Interaction/Attend learning | Existing normalization/idempotency key, source validation, component completion checks, transactional learning + ai_jobs + queue intent, unique indexes and compare-and-set guards. Existing orchestration retries only CONCURRENT_STATE_CHANGE, at most three persistence attempts, with refreshed checks/state. |
| ParentDecision learning | Existing canonical decision identity, source snapshot, source-wide and exact completion checks, ordering/authority guards and transactional persistence. At most three attempts for explicitly retryable CONCURRENT_STATE_CHANGE; preflight and current child state reread each time. |
| Question answer | Stable source ID derived from question history, decision type and target. Source equivalence must pass; D7 remains authoritative. Only supported learning success permits ANSWERED. No automatic submission/source-write retries. |
| Graph projection | Existing job identity and graph MERGE/SET plus stale-link deletion. Explicit FAILED-job replay is permitted through the existing worker; each selected job gets one attempt per invocation. Current Mongo document is reread. |
| Health | D3 bounded monitoring only; never a business-operation gate. |

D1 category, stateStatus or retryable metadata never independently authorizes
execution. Existing D7 DATABASE_ERROR/PROCESSING_ERROR results stop processing,
even when retryable metadata is true. Unknown commit results are not automatically
repeated. Existing uniqueness-collision handling checks authoritative ai_jobs
completion rather than interpreting a duplicate-key exception as success.
D5 adds no uncertain Mongo write repetition. If authoritative verification fails,
retain existing safe failure; no fabricated success or rollback of committed state.

## Graph recovery

Before D5, processQueue selected PENDING jobs only, including when given jobIds.
A failed job was retained as FAILED under its original `_id` but was not selectable
for recovery without an external status edit. D5 adds one explicit option:

```js
await processQueue({ jobIds: [existingJobId], retryFailed: true });
```

This selects FAILED jobs only, restricted to the exact validated ObjectIds.
jobIds is mandatory in recovery mode; empty jobIds selects none. Duplicates are
collapsed. Unknown options and malformed values fail before database access.
Default consumption and existing `{ jobIds }` behavior still select PENDING only.
PROCESSED jobs are excluded. No job is inserted or reset to PENDING by recovery.
No inner retry loop, scheduler, sleep or second queue exists.

Each job goes through existing graphBuilderService.process: read current Mongo
source, validate existing references, project stable node/relationship identities.
A partial graph write or a lost response can be replayed using MERGE/SET rather
than incrementing evidence or creating new learning. Failure retains FAILED;
success records PROCESSED on the same job. A failed Mongo status update is not
blindly repeated; the caller may receive an error and must inspect the queue
before choosing another invocation. Old error/failedAt fields remain historical
metadata after success; status and processedAt describe completion.

This uses the existing serial worker contract. It adds no claim/lease or guarantee
for competing workers. Run recovery with the same single-consumer discipline as
normal consumption; distributed execution is outside this change. Graph MERGE
replay assumes the existing graph identity integrity; this does not repair an
already duplicated graph. Missing references fail under existing builder rules.

Graph failure touches queue bookkeeping only, never rolls back Mongo learning,
and never creates another logical source event. A subsequent invocation rereads
Mongo, so recovery projects current truth rather than an obsolete event snapshot.

## Neo4j fallback audit

**NEO4J FALLBACK: NOT SAFE IN V1.**

Interest discovery follows Child-LIKES-Subcategory-CLASSIFIED_AS-Activity; goal
discovery follows Child-HAS_GOAL-Goal-RELATES_TO_OUTCOME-LearningOutcome-
SUPPORTS_OUTCOME-Activity. Returned evidence includes projected interest scores,
confidence/count/date, goal priority/status, and outcome names. Traversal merges
candidates and preserves its existing evidence behavior. Mongo stores source
classification, interests, parent goals, goal/outcome mappings and outcome
references, but projection can lag after failed jobs. Graph node availability,
projected values, path multiplicity/order and existing traversal deduplication
are not reproduced by an existing Mongo discovery implementation. Source data
availability alone does not prove equivalent candidate/evidence contracts.

No fallback is introduced. Traversal rejection propagates through recommendation
context/engine to the existing API safe error boundary, before ranking or snapshot
persistence. There are no all-activity, random, popular or default candidates.
Eligibility, six-factor scoring/weights, ranking, missing evidence behavior and
Mongo revalidation are unchanged.

## Existing boundaries and limitations

Question source comparison includes occurredAt. The HTTP answer service supplies
a fresh timestamp on each attempt. After a source was stored but before ANSWERED,
a later submission can return SOURCE_CONFLICT instead of recovering. D5 preserves
this fail-safe boundary: it neither changes question semantics nor silently
accepts different source content. Recovery with the original evidence/timestamp
retains the existing integration contract. Interaction HTTP resubmission is also
a new event, not an identity-preserving recovery endpoint. Stale PROCESSING or
FAILED ai_jobs may require existing orchestration/manual investigation; D5 does
not force them complete. These are availability limits, not reasons to duplicate
learning. No frozen-design requirement requires unsafe automatic recovery.

D1 factory/taxonomy are unchanged. D2 observes each graph processJob attempt using
its existing background trace (correlation may continue, HTTP requestId does not).
D4 records the existing GraphSync.processJob lifecycle with fixed labels. No new
logger, collector or metric dimension exists. Broken sinks cannot change recovery.
D3 health checks remain independent. No D6 work or GitHub push is included.

## Deterministic verification

Run `node src/tests/systemTestV1/phase6D5ResilienceRecovery.js`.
It exercises real worker/service/LIKES builder code with dependency I/O doubles:
exact FAILED filtering, validation, duplicate IDs, bounded single attempts,
uncertain graph response after a write, stable job/edge identities, current Mongo
reread, retained authoritative state, completed-job exclusion, D2/D4 outcomes,
background correlation, broken sinks and traversal rejection. It also executes
existing transactional/replay/learning/API fixtures, including three-attempt
conflict exhaustion and failed-learning history protection. No real sleeps.

Live Mongo transactions, real Neo4j uniqueness/driver behavior and live Gemini
are excluded from deterministic acceptance. No performance/load tests are run.

## Acceptance results

- Focused Phase 6 D5 verification: PASS, including its ten replay/API regressions.
- 98 individual deterministic regression suites: PASS (94 src/tests suites plus
  Phase 6 D1, D2, D3 and D4). Live recommendation and Gemini smoke tests excluded.
- Initial extra Phase 3/4 aggregate attempts hit a 55-second harness timeout.
  The longer Phase 4 rerun completed and reported Phase 3 regression PASS.
- Phase 4 aggregate: 18/19 areas PASS; its frozen Repository Safety allowlist
  rejects the intentional D5 change to src/workers/queueWorker.js. All behavioral,
  replay, queue, failure-safety and recommendation areas PASS. The frozen runner
  was not modified to accept new deliverable files.
- git diff --check and whitespace checks for both new files: PASS.
- Dependencies added: NONE. No live acceptance or D6 work performed; no push.

PHASE 6 D5 RESILIENCE & RECOVERY: PASS (focused and relevant deterministic
regressions; Phase 4 legacy repository allowlist mismatch disclosed above).
