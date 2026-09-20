const { processContinuousLearningSource } = require("./continuousLearningService");

/** Compatibility entry point; all orchestration belongs to continuousLearningService. */
function processInterestLearningSource(sourceType, document, options = {}) {
    return processContinuousLearningSource(sourceType, document, options);
}

module.exports = { processInterestLearningSource };
