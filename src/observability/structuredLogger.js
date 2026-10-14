const { FAILURE_CATEGORY, STATE_STATUS } = require("../reliability/reliabilityFailure");
const { currentObservation, currentTrace, runRequest, validId } = require("./traceContext");
const LEVEL = Object.freeze({ INFO:"INFO", WARN:"WARN", ERROR:"ERROR", DEBUG:"DEBUG" });
const EVENT = Object.freeze({ OPERATION_STARTED:"OPERATION_STARTED", OPERATION_COMPLETED:"OPERATION_COMPLETED", OPERATION_FAILED:"OPERATION_FAILED", OPERATION_DEGRADED:"OPERATION_DEGRADED" });
const OUTCOME = Object.freeze({ SUCCESS:"SUCCESS", FAILURE:"FAILURE", DEGRADED:"DEGRADED" });
const ID_FIELDS = new Set(["childId","parentId","activityId","interactionId","questionHistoryId","jobId","eventId","sourceId"]);
function safeContext(context) {
    const safe = {};
    if (!context || typeof context !== "object" || Array.isArray(context)) return safe;
    // Only own data properties: do not invoke getters or serialize nested objects.
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(context))) {
        if (!Object.hasOwn(descriptor,"value")) continue;
        const value = descriptor.value;
        if (ID_FIELDS.has(key) && validId(value)) safe[key] = value;
        if (["status","reasonCode"].includes(key) && typeof value === "string" && /^[A-Z][A-Z0-9_]{0,79}$/.test(value)) safe[key] = value;
        if (key === "resultCount" && Number.isSafeInteger(value) && value >= 0) safe[key] = value;
    }
    return safe;
}
function safeMessage(message) {
    return message.replace(/\b(?:mongodb(?:\+srv)?|neo4j(?:\+s)?|bolt(?:\+s)?):\/\/\S+/gi,"[REDACTED_CONNECTION]")
        .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s/]*@\S*/gi,"[REDACTED_CONNECTION]")
        .replace(/\bBearer\s+\S+/gi,"Bearer [REDACTED]")
        .replace(/\b(password|authorization|access[_-]?token|refresh[_-]?token|token|cookie|api[_-]?key|secret)\s*[:=]\s*\S+/gi,"$1=[REDACTED]");
}
function createRecord(input, { now = () => new Date() } = {}) {
    for (const [key, values] of [["level",LEVEL],["event",EVENT],["outcome",OUTCOME]])
        if (!Object.values(values).includes(input[key])) throw new TypeError(`Invalid log ${key}.`);
    for (const key of ["component","operation","message"])
        if (typeof input[key] !== "string" || !input[key].trim()) throw new TypeError(`Log ${key} required.`);
    for (const key of ["component","operation"])
        if (!/^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(input[key])) throw new TypeError(`Invalid log ${key}.`);
    const timestamp = now();
    if (!(timestamp instanceof Date) || !Number.isFinite(timestamp.getTime())) throw new TypeError("Invalid log clock.");
    const record = { timestamp:timestamp.toISOString(),level:input.level,event:input.event,component:input.component,
        operation:input.operation,outcome:input.outcome,message:safeMessage(input.message) };
    for (const key of ["requestId","correlationId"]) if (input[key] !== undefined) {
        if (!validId(input[key])) throw new TypeError(`Invalid log ${key}.`);
        record[key] = input[key];
    }
    // Explicit D1 metadata only. Never inspect names, messages or dependencies.
    for (const [field, source, values] of [["failureCategory","category",FAILURE_CATEGORY],["stateStatus","stateStatus",STATE_STATUS]]) {
        const value = input[field] ?? input.failure?.[source];
        if (value !== undefined) {
            if (!Object.values(values).includes(value)) throw new TypeError(`Invalid log ${field}.`);
            record[field] = value;
        }
    }
    if (input.context !== undefined) record.context = safeContext(input.context);
    return record;
}
function createLogger({ now, emit = record => console.log(JSON.stringify(record)) } = {}) {
    return Object.freeze({ log(input) {
        try {
            const record = createRecord(input, { now });
            // Swallow synchronous throws and asynchronous rejection; never retry.
            Promise.resolve(emit(record)).catch(() => {});
            return record;
        } catch (_) { return null; }
    } });
}
const defaultLogger = createLogger();
function emitSafely(input) {
    try {
        const logger = currentObservation()?.logger ?? defaultLogger;
        Promise.resolve(logger.log({ ...input, ...currentTrace() })).catch(() => {});
    } catch (_) { /* logging is never business execution */ }
}
async function observeOperation({ component, operation, context, outcomeOf = () => OUTCOME.SUCCESS }, task) {
    const base = { component, operation, context };
    emitSafely({ ...base,level:LEVEL.INFO,event:EVENT.OPERATION_STARTED,outcome:OUTCOME.SUCCESS,message:"Operation started." });
    let result;
    try { result = await task(); }
    catch (failure) {
        emitSafely({ ...base,level:LEVEL.ERROR,event:EVENT.OPERATION_FAILED,outcome:OUTCOME.FAILURE,message:"Operation failed.",failure });
        throw failure;
    }
    let outcome;
    try { outcome = outcomeOf(result); } catch (_) { return result; }
    const event = outcome === OUTCOME.FAILURE ? EVENT.OPERATION_FAILED : outcome === OUTCOME.DEGRADED ? EVENT.OPERATION_DEGRADED : EVENT.OPERATION_COMPLETED;
    emitSafely({ ...base,level:outcome === OUTCOME.FAILURE ? LEVEL.ERROR : outcome === OUTCOME.DEGRADED ? LEVEL.WARN : LEVEL.INFO,
        event,outcome,message:outcome === OUTCOME.FAILURE ? "Operation failed." : outcome === OUTCOME.DEGRADED ? "Operation degraded." : "Operation completed.",
        failure:outcome === OUTCOME.FAILURE ? currentObservation()?.failure : undefined });
    return result;
}
function instrumentApi(handler, operation, optionsIndex) {
    return function(...args) {
        let options;
        try { options = args[optionsIndex]?.observability; } catch (_) { /* optional metadata */ }
        return runRequest(() => observeOperation({ component:"ProductAPI",operation,
            outcomeOf:result => result.body.success === false ? OUTCOME.FAILURE : OUTCOME.SUCCESS }, () => handler(...args)), options);
    };
}
function learningOutcome(result) {
    const failed = result.results.some(r => ["FAILED","REJECTED"].includes(r.status));
    return failed ? result.results.some(r => r.status === "APPLIED") ? OUTCOME.DEGRADED : OUTCOME.FAILURE : OUTCOME.SUCCESS;
}
module.exports = { LEVEL, EVENT, OUTCOME, safeContext, createRecord, createLogger, observeOperation, instrumentApi, learningOutcome };
