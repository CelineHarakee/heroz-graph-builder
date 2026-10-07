const { API_BASE_PATH } = require("./index");
const { requireIdentifier } = require("../requestValidation");
const { successResponse, errorResponse } = require("../apiResponse");
const { getChildIntelligence } = require("../../services/childIntelligenceService");

// Mounting contract only; this module does not create a server or router.
const METHOD = "GET";
const PATH = `${API_BASE_PATH}/children/{childId}/intelligence`;

async function handleChildIntelligence(childId, options = {}) {
    try {
        requireIdentifier(childId);
        const data = await getChildIntelligence(childId, options);
        return { status: 200, body: successResponse(data) };
    } catch (error) {
        return errorResponse(error);
    }
}

module.exports = { METHOD, PATH, handleChildIntelligence };
