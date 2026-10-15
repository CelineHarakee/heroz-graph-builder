# Phase 6 D3 — Health checks

`src/api/v1/health.js` exports `METHOD = GET`, `PATH = /api/v1/health`, and
`handleHealth(options)`, following the existing framework-independent V1 mounting
contract. There is no HTTP server/router in this repository; a hosting adapter
must mount the handler, as for the existing product handlers.

Completed health checks return HTTP 200 with the existing success envelope:

```json
{"success":true,"data":{"status":"HEALTHY","dependencies":{"mongodb":{"status":"HEALTHY"},"neo4j":{"status":"HEALTHY"}}}}
```

MongoDB unhealthy always means overall UNHEALTHY. With healthy MongoDB,
unhealthy Neo4j means DEGRADED; both healthy means HEALTHY. Execution of the
handler is the application liveness evidence. Dependency unhealthiness is an
intentional result, not an unexpected API exception. Invalid server-owned
configuration uses the existing sanitized HTTP 500 error envelope.

MongoDB uses the existing `getDatabase()` and `db.command({ ping: 1 },
{ timeoutMS })`. Neo4j uses the existing driver's `verifyConnectivity()`.
Neither check invokes Heroz business operations. Checks start independently
and concurrently; failures never short-circuit the other check.

Server-owned options accept `db`, `driver`, and `timeoutMs` (default 2000,
positive integer up to 2147483647). `setTimer`/`clearTimer` may be injected for
deterministic tests. Each check races its operation against a timer; timers are
cleared on completion. MongoDB also receives its native operation timeout.
The response deadline does not cancel an in-flight Neo4j connectivity operation;
late rejection is handled. There are no health-level retries or reconnects.
Successful completion before the deadline is healthy without latency thresholds.

D2's `instrumentApi` supplies request tracing; `observeOperation` records each
dependency start and completion/failure. A successfully returned health payload
is a successful API operation even when dependencies are unhealthy; dependency
records capture failures. Only existing explicit D1 metadata is logged, with no
classification inferred from dependency names, error names, or messages. D1 and
D2 implementations remain unchanged. Logging failures cannot change results.

Public data contains only the three health statuses and dependency status
objects. Errors, driver results, secrets, trace IDs, and D1 diagnostics are not
projected. No business writes, intelligence execution, queue changes, fallback,
recovery, background polling, or persistent health history is introduced.

Deterministic verification: `node src/tests/systemTestV1/phase6D3HealthChecks.js`.
It guards imports and dependency operations to exclude business services and
writes, and covers aggregation, independence, timeouts, late failures, safe
projection, D1 metadata, D2 tracing, and logger/emitter failures. Live database
coverage is separate and not required by this acceptance path.
