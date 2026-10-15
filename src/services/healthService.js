const { observeOperation } = require("../observability/structuredLogger");

const DEFAULT_TIMEOUT_MS = 2000;

// Bounds the observation only. No reconnect, retry, or business operation is run.
async function checkDependency(operation, task, { timeoutMs, setTimer, clearTimer }) {
    let timer;
    try {
        await observeOperation({ component: "Health", operation }, () => Promise.race([
            new Promise((_, reject) => {
                timer = setTimer(() => reject(new Error("Health check timed out.")), timeoutMs);
            }),
            Promise.resolve().then(task)
        ]));
        return { status: "HEALTHY" };
    } catch (_) {
        return { status: "UNHEALTHY" };
    } finally {
        if (timer !== undefined) clearTimer(timer);
    }
}

async function checkHealth(options = {}) {
    const {
        timeoutMs = DEFAULT_TIMEOUT_MS,
        setTimer = setTimeout,
        clearTimer = clearTimeout
    } = options;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) {
        throw new TypeError("Health timeout must be a positive timer-safe integer.");
    }
    const timing = { timeoutMs, setTimer, clearTimer };
    const [mongodb, neo4j] = await Promise.all([
        checkDependency("mongodb", () => {
            const db = options.db ?? require("../config/mongodb").getDatabase();
            return db.command({ ping: 1 }, { timeoutMS: timeoutMs });
        }, timing),
        checkDependency("neo4j", () => {
            const driver = options.driver ?? require("../config/neo4j");
            return driver.verifyConnectivity();
        }, timing)
    ]);
    const status = mongodb.status === "UNHEALTHY" ? "UNHEALTHY"
        : neo4j.status === "UNHEALTHY" ? "DEGRADED" : "HEALTHY";
    return { status, dependencies: { mongodb, neo4j } };
}

module.exports = { checkHealth, DEFAULT_TIMEOUT_MS };
