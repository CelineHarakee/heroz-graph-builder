const { instrumentApi } = require("../../observability/structuredLogger");
const { captureFailure } = require("../../observability/traceContext");
const { API_BASE_PATH } = require("./index");
const { successResponse, errorResponse } = require("../apiResponse");
const { checkHealth } = require("../../services/healthService");

const METHOD = "GET";
const PATH = `${API_BASE_PATH}/health`;

async function handleHealth(options = {}) {
    try {
        return { status: 200, body: successResponse(await checkHealth(options)) };
    } catch (error) {
        captureFailure(error);
        return errorResponse(error);
    }
}

module.exports = { METHOD, PATH, handleHealth: instrumentApi(handleHealth, "handleHealth", 0) };
