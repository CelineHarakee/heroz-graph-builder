# Phase 6 D2 — Structured logging and request tracing

Records require timestamp (UTC ISO-8601), level, event, component, operation,
outcome and message. Optional fields are requestId, correlationId,
failureCategory, stateStatus and context. Closed values are INFO/WARN/ERROR/DEBUG,
OPERATION_STARTED/OPERATION_COMPLETED/OPERATION_FAILED/OPERATION_DEGRADED and
SUCCESS/FAILURE/DEGRADED. STARTED uses SUCCESS to describe starting the operation,
not a promise of successful completion.

`createRecord(input, { now })` validates records. `createLogger({ now, emit })`
provides fail-isolated logging, defaulting to JSON records on console.log. Clock,
validation, synchronous emission and asynchronous rejection failures cannot change
a business result. There is no logger-error recursion, retry or persistent store.
Operational messages must be developer-owned literal text, never request or error
messages. Instrumentation uses only fixed messages.

Context is an allowlist of scalar operational IDs (childId, parentId, activityId,
interactionId, questionHistoryId, jobId, eventId, sourceId), uppercase status and
reasonCode tokens, and a non-negative integer resultCount. Unknown keys, nested
objects, arrays and accessors are dropped. IDs exclude whitespace, URLs and email
syntax. Obvious secret fields are therefore excluded, including under DEBUG.
Common credential assignment/connection-string patterns in messages are also
redacted. This is a defensive boundary, not a general personal-data detector:
never place personal data or secrets inside an ID or free-text message. No request
bodies, headers, domain documents, exception messages, stacks or D1 diagnostics
are automatically serialized. D1 category/state are copied only when explicitly
provided and validated against D1 constants; classification is never guessed.

Each exported product handler creates its own requestId and correlationId with
Node randomUUID, independent of client fields/headers. Existing server-owned
options may supply `observability: { logger, idFactory }` for deterministic tests.
AsyncLocalStorage propagates these IDs and logger through synchronous downstream
work, including awaited service calls, without changing business signatures.
Each concurrent request has a separate scope. Business engines still work without
trace context. IDs never replace interaction, replay, decision or job identities.

The five API handlers log start and terminal events, interpreting their existing
success envelope only. Their public envelopes contain no tracing fields. The
continuous-learning boundary logs existing FAILED/REJECTED results as failures,
mixed APPLIED and failed results as degraded, and IGNORED/suppressed results as
successful completion. It adds no D1 classification or learning behavior.

`runBackground(task, { correlationId, logger, idFactory })` retains only the supplied
correlationId, or creates one for independent work. An old requestId is never
inherited, even on setup failure. `processQueue(options, observation)` accepts
optional server-owned observation settings as its second argument, preserving
its original strict first-argument contract. Each job uses an explicitly supplied
correlationId, an already-available job correlationId, or the current originating
scope's correlationId; otherwise it creates an independent correlationId.
D2 does not add queue persistence fields or change schemas. Durable propagation
across a separate process requires the dispatcher to supply existing correlation
metadata; it is not fabricated or reconstructed from business identities.

Graph jobs log processing plus their existing success-status update as a single
boundary. Existing FAILED updates and replay rules remain unchanged. Raw worker
console/error dumps are replaced, not copied into structured context. Other
legacy logging outside these selected boundaries is not broadly refactored.

No health checks, monitoring, metrics, dashboards, retries, recovery, tracing
spans, external platforms or production configuration changes are introduced.
