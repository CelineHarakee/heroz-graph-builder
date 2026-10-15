const { AsyncLocalStorage } = require("node:async_hooks");
const { randomUUID } = require("node:crypto");
const storage = new AsyncLocalStorage();
const validId = value => typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
function generatedId(factory) {
    const value = factory();
    if (!validId(value)) throw new TypeError("Invalid generated observability identity.");
    return value;
}
function createRequestTrace({ idFactory = randomUUID } = {}) {
    return Object.freeze({ requestId: generatedId(idFactory), correlationId: generatedId(idFactory) });
}
function createBackgroundTrace({ correlationId, idFactory = randomUUID } = {}) {
    if (correlationId !== undefined && !validId(correlationId)) throw new TypeError("Invalid correlation identity.");
    return Object.freeze({ correlationId: correlationId ?? generatedId(idFactory) });
}
function currentObservation() { return storage.getStore(); }
function currentTrace() { return currentObservation()?.trace; }
function runRequest(task, options = {}) {
    let observation;
    try { observation = { trace: createRequestTrace(options), logger: options.logger }; }
    catch (_) { observation = {}; } // Clear any parent request if setup fails.
    try { observation.metrics = options.metrics; observation.metricNow = options.metricNow; }
    catch (_) { /* optional metrics cannot affect tracing setup */ }
    return storage.run(observation, task);
}
function runBackground(task, options = {}) {
    let observation;
    try { observation = { trace: createBackgroundTrace(options), logger: options.logger ?? currentObservation()?.logger }; }
    catch (_) { observation = {}; }
    try {
        observation.metrics = options.metrics === undefined ? currentObservation()?.metrics : options.metrics;
        observation.metricNow = options.metricNow ?? currentObservation()?.metricNow;
    } catch (_) { /* optional metrics cannot affect tracing setup */ }
    return storage.run(observation, task); // Never inherit an active HTTP requestId.
}
function captureFailure(failure) {
    const observation = currentObservation();
    if (observation) observation.failure = failure;
}
module.exports = { createRequestTrace, createBackgroundTrace, currentTrace, currentObservation, runRequest, runBackground, captureFailure, validId };
