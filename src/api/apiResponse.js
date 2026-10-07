const { ApiError } = require("./apiError");

function successResponse(data) {
    return { success: true, data };
}

// Transport status is separate from the frozen JSON body contract.
function errorResponse(error) {
    const controlled = error instanceof ApiError;
    return {
        status: controlled ? error.status : 500,
        body: {
            success: false,
            error: {
                code: controlled ? error.code : "INTERNAL_ERROR",
                message: controlled ? error.message : "An unexpected error occurred."
            }
        }
    };
}

module.exports = { successResponse, errorResponse };
