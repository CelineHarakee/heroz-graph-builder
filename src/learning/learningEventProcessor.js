const { normalizeInteraction, normalizeBooking, normalizeParentDecision } = require("./eventNormalizer");
const { validateEvent } = require("./eventValidator");
const { validateEventReferences } = require("./eventReferenceValidator");
const { checkEventIdempotency } = require("./eventIdempotencyService");
const { evaluateRepeatLimit } = require("./repeatLimitService");

function processingError(event, error) {
    return { status: "FAILED", reasonCode: "PROCESSING_ERROR", retryable: true, event, error };
}

async function processEvent(event, options) {
    let currentEvent = event;
    try {
        let result = validateEvent(currentEvent);
        if (result.status !== "VALID") return result;
        currentEvent = result.event;

        result = await validateEventReferences(currentEvent, options);
        if (result.status !== "VALID") return result;
        currentEvent = result.event;

        // Step 3 stops at the explicit-decision boundary. Persistent replay/source
        // integrity and ordering are deferred; never use activity repeat limits.
        if (currentEvent.source === "ParentDecision") return result;

        result = await checkEventIdempotency(currentEvent, options);
        if (result.status !== "VALID") return result;
        currentEvent = result.event;

        return await evaluateRepeatLimit(currentEvent, options);
    } catch (error) {
        return processingError(currentEvent || null, error);
    }
}

/** Read-only D7C gate; returns one result per event, without applying learning. */
async function processLearningSource(sourceType, document, options = {}) {
    let events;
    try {
        if (sourceType === "Interaction") {
            const event = normalizeInteraction(document);
            events = event ? [event] : [];
        } else if (sourceType === "ParentDecision") {
            events = [normalizeParentDecision(document)];
        } else if (sourceType === "Booking") {
            events = normalizeBooking(document);
        } else {
            return [{ status: "REJECTED", reasonCode: "UNSUPPORTED_SOURCE", retryable: false, event: null, error: null }];
        }
    } catch (error) {
        return [processingError(null, error)];
    }

    if (events.length === 0) {
        return [{ status: "IGNORED", reasonCode: "NON_LEARNING_EVENT", retryable: false, event: null, error: null }];
    }

    const results = [];
    for (const event of events) {
        results.push(await processEvent(event, options));
    }
    return results;
}

module.exports = { processLearningSource };
