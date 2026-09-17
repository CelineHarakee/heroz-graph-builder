const { ObjectId } = require("mongodb");
const { toMongoId, toGraphId } = require("../utils/idUtils");
const { processLearningSource } = require("./learningEventProcessor");
const { getLearningInstruction } = require("./learningRuleEngine");
const { calculateNextInterestState } = require("./interestStateTransition");
const { persistAppliedInterestLearning } = require("./learningPersistenceService");

function outcome(event, status, reasonCode, retryable = false) {
    return { eventId: event?.eventId ?? null, eventType: event?.eventType ?? null,
        status, reasonCode, retryable, interestId: null, transition: null };
}

/**
 * Explicit entry point only; does not connect, initialize indexes or consume queues.
 * options: db, client (defaults to db.client), dependencies with any of the four
 * imported service functions overridden for tests. Each event has at most three
 * persistence attempts. COMPLETED means evaluation finished; inspect each result.
 */
async function processInterestLearningSource(sourceType, document, options = {}) {
    const dependencies = { processLearningSource, getLearningInstruction,
        calculateNextInterestState, persistAppliedInterestLearning, ...options.dependencies };
    let initial;
    try {
        initial = await dependencies.processLearningSource(sourceType, document, { db: options.db });
    } catch (_) {
        return { status: "COMPLETED", sourceType, results: [outcome(null, "FAILED", "PROCESSING_ERROR", true)] };
    }

    async function processOne(first) {
        let checked = first;
        let event = first.event;
        let stage = "processing";
        try {
            for (let attempt = 0; attempt < 3; attempt++) {
                if (attempt > 0) {
                    const refreshed = await dependencies.processLearningSource(sourceType, document, { db: options.db });
                    checked = refreshed.find((item) => item.event?.eventId === first.event.eventId &&
                        item.event?.eventType === first.event.eventType) ?? refreshed.find((item) => item.event == null);
                    if (!checked) return outcome(event, "IGNORED", "EVENT_NO_LONGER_ELIGIBLE");
                }
                event = checked.event ?? event;
                if (checked.status !== "VALID") {
                    return outcome(event, checked.status, checked.reasonCode, checked.retryable === true);
                }
                const instruction = dependencies.getLearningInstruction(event);
                if (instruction.status !== "APPLICABLE") return outcome(event, "IGNORED", instruction.reasonCode);

                stage = "database";
                const db = options.db || require("../config/mongodb").getDatabase();
                const client = options.client || db?.client;
                if (!db || !client) return outcome(event, "FAILED", "DATABASE_ERROR", true);
                const childId = toMongoId(event.childId), subcategoryId = toMongoId(event.subcategoryId);
                if (!(childId instanceof ObjectId) || !(subcategoryId instanceof ObjectId)) {
                    return outcome(event, "REJECTED", "INVALID_IDENTITY");
                }
                const currentState = await db.collection("child_interests").findOne({ childId, subcategoryId });
                stage = "processing";
                const calculated = dependencies.calculateNextInterestState(currentState, instruction, event);
                if (calculated.status !== "APPLIED") return outcome(event, "REJECTED", calculated.reasonCode);

                stage = "database";
                const persisted = await dependencies.persistAppliedInterestLearning({
                    client, db, event, instruction, currentState, nextState: calculated.state
                });
                stage = "processing";
                if (persisted.reasonCode === "CONCURRENT_STATE_CHANGE") {
                    if (attempt === 2) return outcome(event, "FAILED", "CONCURRENT_RETRY_EXHAUSTED", true);
                    continue;
                }
                if (persisted.reasonCode === "DUPLICATE_EVENT") return outcome(event, "IGNORED", "DUPLICATE_EVENT");
                if (persisted.status === "APPLIED") {
                    const state = persisted.state;
                    return { ...outcome(event, "APPLIED", persisted.reasonCode), interestId: toGraphId(state._id),
                        transition: {
                            previousScore: state.interestScore.previousScore,
                            currentScore: state.interestScore.currentScore,
                            previousConfidence: state.scoreHistory.at(-1).previousConfidence,
                            currentConfidence: state.confidence.currentScore,
                            evidenceCount: state.confidence.evidenceCount
                        } };
                }
                return outcome(event, persisted.status === "NOT_APPLIED" ? "REJECTED" : persisted.status,
                    persisted.reasonCode, persisted.retryable === true);
            }
        } catch (_) {
            return outcome(event, "FAILED", stage === "database" ? "DATABASE_ERROR" : "PROCESSING_ERROR", true);
        }
    }

    const results = [];
    for (const result of initial) results.push(await processOne(result));
    return { status: "COMPLETED", sourceType, results };
}

module.exports = { processInterestLearningSource };
