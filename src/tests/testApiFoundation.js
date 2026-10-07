const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");

// Guard the complete API dependency tree throughout import and execution.
// Any database, recommendation, Question, learning, or other outside module
// import fails before it can execute, including lazy imports from helpers.
const apiRoot = path.resolve(__dirname, "../api") + path.sep;
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (parent && parent.filename.startsWith(apiRoot)) {
        const resolved = Module._resolveFilename(request, parent);
        assert.ok(resolved.startsWith(apiRoot), `API dependency escaped: ${request}`);
    }
    return originalLoad.call(this, request, parent, isMain);
};

let passed = 0;
function check(name, run) {
    run();
    passed++;
    console.log(`PASS ${name}`);
}

try {
    const { ApiError } = require("../api/apiError");
    const { successResponse, errorResponse } = require("../api/apiResponse");
    const { requireValue, requireType, requireIdentifier } = require("../api/requestValidation");
    const { API_VERSION, API_BASE_PATH } = require("../api/v1");
    const badRequest = (run) => assert.throws(run, error =>
        error instanceof ApiError && errorResponse(error).status === 400);

    for (const data of [{ childId: "child_001" }, [1, 2], null, [], { question: null }]) {
        check(`success ${JSON.stringify(data)}`, () => {
            assert.deepEqual(successResponse(data), { success: true, data });
            assert.deepEqual(JSON.parse(JSON.stringify(successResponse(data))), { success: true, data });
        });
    }
    for (const status of [400, 404, 409, 500]) {
        check(`controlled ${status} exposes only public fields`, () => {
            const error = new ApiError(status, "SAFE_CODE", "Safe public message.");
            error.cause = new Error("mongodb://user:secret@private");
            error.details = { neo4j: "bolt://private", credentials: "secret" };
            const result = errorResponse(error);
            assert.deepEqual(result, {
                status,
                body: { success: false, error: { code: "SAFE_CODE", message: "Safe public message." } }
            });
            assert.ok(!JSON.stringify(result).includes(error.stack));
        });
    }
    check("unexpected failures and service-shaped errors are sanitized", () => {
        for (const error of [
            new Error("mongodb://admin:secret@private/db bolt://neo4j:secret@private"),
            { status: 404, code: "DB_ERROR", message: "credentials", stack: "private stack" },
            new SyntaxError("Malformed JSON containing a secret"), null, undefined, "secret"
        ]) {
            assert.deepEqual(errorResponse(error), {
                status: 500,
                body: { success: false, error: {
                    code: "INTERNAL_ERROR", message: "An unexpected error occurred."
                } }
            });
        }
    });
    check("controlled error configuration rejects unsupported contracts", () => {
        for (const args of [[401, "CODE", "Message"], [400, {}, "Message"], [400, "CODE", new Error()], [400, "", "Message"]]) {
            assert.throws(() => new ApiError(...args), TypeError);
        }
    });
    check("required values reject missing input but preserve false and zero", () => {
        for (const value of [undefined, null]) badRequest(() => requireValue(value));
        for (const value of [false, 0, "", [], {}]) assert.equal(requireValue(value), value);
    });
    check("invalid primitive and body structures reject with 400", () => {
        for (const [value, type] of [[[], "object"], [null, "object"], ["{}", "object"],
            [new Date(), "object"], [{}, "array"], [12, "string"], ["12", "number"],
            [NaN, "number"], [Infinity, "number"], ["false", "boolean"]]) {
            badRequest(() => requireType(value, type));
        }
        assert.throws(() => requireType("x", "invented"), TypeError);
    });
    check("valid basic inputs pass without domain validation", () => {
        for (const [value, type] of [[{}, "object"], [[], "array"], [false, "boolean"],
            [0, "number"], ["Outdoor", "string"]]) assert.equal(requireType(value, type), value);
    });
    check("identifiers preserve existing string conventions", () => {
        for (const value of ["child_001", "activity_a", "507f1f77bcf86cd799439011"])
            assert.equal(requireIdentifier(value), value);
        for (const value of [undefined, null, "", " \t", 123, false, {}, []])
            badRequest(() => requireIdentifier(value));
    });
    check("V1 namespace", () => {
        assert.equal(API_VERSION, "v1");
        assert.equal(API_BASE_PATH, "/api/v1");
    });
    console.log(`${passed} API foundation checks passed; dependency isolation enforced throughout.`);
} finally {
    Module._load = originalLoad;
}
