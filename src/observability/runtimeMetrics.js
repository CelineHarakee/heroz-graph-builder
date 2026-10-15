const { currentObservation } = require("./traceContext");

// Fixed operational boundaries only; never derive dimensions from requests.
const OPERATIONS = Object.freeze({
    ProductAPI: Object.freeze(["handleChildIntelligence", "handleRecommendations", "handleNextQuestion",
        "handleQuestionAnswer", "handleInteraction", "handleHealth"]),
    ContinuousLearning: Object.freeze(["processSource"]),
    GraphSync: Object.freeze(["processJob"]),
    Health: Object.freeze(["mongodb", "neo4j"])
});
const OUTCOMES = Object.freeze(["SUCCESS", "FAILURE", "DEGRADED"]);
const allowed = (component, operation) => Object.hasOwn(OPERATIONS, component) && OPERATIONS[component].includes(operation);
const validDuration = value => typeof value === "number" && Number.isFinite(value) && value >= 0;

function createMetricsCollector() {
    const rows = new Map();
    return Object.freeze({
        record({ component, operation, outcome, durationMs }) {
            if (!allowed(component, operation) || !OUTCOMES.includes(outcome)) return;
            const key = `${component}.${operation}`;
            let row = rows.get(key);
            if (!row) {
                row = { component, operation, total: 0, outcomes: { SUCCESS: 0, FAILURE: 0, DEGRADED: 0 },
                    durationMs: { count: 0, total: 0, min: null, max: null } };
                rows.set(key, row);
            }
            row.total++;
            row.outcomes[outcome]++;
            if (validDuration(durationMs)) {
                const duration = row.durationMs;
                duration.count++;
                duration.total += durationMs;
                duration.min = duration.min === null ? durationMs : Math.min(duration.min, durationMs);
                duration.max = duration.max === null ? durationMs : Math.max(duration.max, durationMs);
            }
        },
        snapshot() {
            return [...rows.values()].map(row => ({ ...row, outcomes: { ...row.outcomes }, durationMs: { ...row.durationMs } }));
        }
    });
}

const defaultMetrics = createMetricsCollector();
const monotonicNow = () => Number(process.hrtime.bigint()) / 1e6;

// A completion callback owned by the existing D2 lifecycle. No log dependency,
// business imports, asynchronous waits, retries, or metric-failure recursion.
function startMetric(component, operation) {
    try {
        if (!allowed(component, operation)) return () => {};
        const observation = currentObservation();
        const collector = observation?.metrics === undefined ? defaultMetrics : observation.metrics;
        const now = observation?.metricNow ?? monotonicNow;
        let start;
        try { start = now(); } catch (_) { /* count remains available */ }
        let completed = false;
        return outcome => {
            if (completed) return;
            completed = true;
            try {
                if (!OUTCOMES.includes(outcome)) return;
                const record = { component, operation, outcome };
                try {
                    const end = now();
                    if (validDuration(start) && validDuration(end) && validDuration(end - start)) record.durationMs = end - start;
                } catch (_) { /* broken timing cannot change an outcome */ }
                Promise.resolve(collector?.record(record)).catch(() => {});
            } catch (_) { /* metrics never affect business execution */ }
        };
    } catch (_) { return () => {}; }
}

module.exports = { createMetricsCollector, defaultMetrics, startMetric };
