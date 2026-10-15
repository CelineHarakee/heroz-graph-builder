# Phase 6 D4 — Runtime metrics

`runtimeMetrics.js` observes the existing D2 `observeOperation` lifecycle. It
does not parse log output or perform additional business/dependency operations.
One completed operation records one SUCCESS, FAILURE, or DEGRADED observation,
using D2's existing outcome interpretation. STARTED does not increment counters.
Thrown operations record FAILURE and rethrow the original failure unchanged.

Measured boundaries (fixed component/operation pairs):

| Component | Operations |
| --- | --- |
| ProductAPI | handleChildIntelligence, handleRecommendations, handleNextQuestion, handleQuestionAnswer, handleInteraction, handleHealth |
| Health | mongodb, neo4j |
| ContinuousLearning | processSource |
| GraphSync | processJob |

Health observations wrap the original D3 checks; they do not initiate checks.
The health API itself remains a successful operation when it intentionally
returns DEGRADED/UNHEALTHY. Dependency metrics record the individual failures.
Empty recommendations, No Question, and legitimate learning suppression retain
D2's existing SUCCESS interpretation. Mixed applied/failed learning uses D2's
DEGRADED interpretation. Graph jobs cover processing and the existing success
status update, preserving the accepted D2 boundary.

## Collector and injection

`defaultMetrics` is a process-local in-memory collector enabled at these
boundaries. Its `snapshot()` returns independent copies of accumulated rows:

```js
{
    component: "ProductAPI",
    operation: "handleRecommendations",
    total: 3,
    outcomes: { SUCCESS: 2, FAILURE: 1, DEGRADED: 0 },
    durationMs: { count: 3, total: 15, min: 2, max: 9 }
}
```

Total equals the sum of the three outcome counts. Duration summaries retain
count, sum, minimum, and maximum rather than raw observations. Storage is bounded
to ten rows; there are no IDs, profiles, request bodies, error details, tracing
fields, or dynamic dimensions. Unknown component/operation pairs and outcomes
are ignored. Counters are independent of duration availability.

Server-owned observability configuration can inject a collector and clock:

```js
const { createMetricsCollector } = require("./runtimeMetrics");
const metrics = createMetricsCollector();
await handleRecommendations(childId, 5, {
    db,
    observability: { metrics, metricNow: () => monotonicMilliseconds() }
});
const snapshot = metrics.snapshot();
```

An external sink needs only `record({ component, operation, outcome, durationMs })`.
`durationMs` is omitted when timing fails or produces an invalid/negative value.
The sink receives a fresh object containing only those approved fields.
`metrics: null` disables collection for a scope. Omitted metrics use the default
collector; `runBackground` inherits the originating scope's collector and clock
unless explicitly overridden. Independent background work can use the worker's
existing second observation argument or `runBackground(task, observation)`.
Standalone learning uses the default collector or the current observation scope.

Production timing uses `process.hrtime.bigint()` converted to milliseconds.
Injected `metricNow()` returns monotonic milliseconds for deterministic tests.
Timing adds no thresholds or timeouts. Zero and large finite durations do not
change outcomes. Collector calls are not awaited; synchronous throws and promise
rejections are swallowed without retry or recursive error telemetry. Clock or
metrics configuration failures cannot change business results or D2 trace setup.

Snapshots represent only this process since module initialization. Restarting
clears them; there is no persistent history, HTTP metrics route, scheduler,
exporter, external platform, alerting, or recovery behavior. Phase 5 evaluation
metrics remain separate. No dependencies are added.

Focused verification:
`node src/tests/systemTestV1/phase6D4RuntimeMetrics.js`.
