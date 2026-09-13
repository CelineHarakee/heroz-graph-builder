function isPlainObject(value) {
    return (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value)
    );
}

function resolveStoredLanguage({ parent } = {}) {
    if (!isPlainObject(parent)) {
        throw new Error("Parent context is required to resolve language");
    }

    const storedLanguage = parent.account?.preferredLanguage;

    if (storedLanguage === "en" || storedLanguage === "ar") {
        return storedLanguage;
    }

    throw new Error("Parent account preferredLanguage must be en or ar");
}

module.exports = {
    resolveStoredLanguage
};
