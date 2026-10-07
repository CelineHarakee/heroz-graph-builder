# API foundation (D1D)

Framework-independent CommonJS helpers; no server or product endpoints yet.
Future V1 endpoints belong under `src/api/v1`, mounted at `API_BASE_PATH`.

- On success, send `successResponse(data)` as JSON with HTTP 200. Empty arrays,
  null, and valid empty result objects remain successes.
- On failure, use `errorResponse(error)` and send its `body` with its `status`.
  Only explicitly constructed `ApiError` instances carry public status/code/text.
  Construct these with trusted public-safe messages, never raw service messages.
  Unknown failures always produce the generic INTERNAL_ERROR response.
- Use `requireValue`, `requireType`, and `requireIdentifier` for basic JSON input
  validation. They return the original value or throw a controlled 400 error.
  Identifiers are non-empty JSON strings, including existing prefixed identifiers
  and serialized MongoDB ObjectIds. Values are not converted or normalized.
  Required values reject null/undefined, while false, zero, and empty strings
  remain present; identifier validation additionally rejects blank strings.
- A future HTTP adapter owns JSON parsing; map malformed JSON to a controlled
  400 with fixed safe text. Engine-owned domain validation stays in the engine.
  Map known service failures explicitly; never trust arbitrary status/code/message
  fields on an exception. No service error taxonomy is inferred here.

These helpers do not access databases, services, logging, or environment settings.
