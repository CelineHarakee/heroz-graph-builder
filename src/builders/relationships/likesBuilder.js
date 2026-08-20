const driver = require("../../config/neo4j");
const { toGraphId } = require("../../utils/idUtils");

function normalizeDate(value) {
    if (!value) {
        return null;
    }

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
        return null;
    }

    return date.toISOString();
}

async function build(childId, subcategoryId, properties = {}) {

    const session = driver.session();

    try {

        const query = `
            MATCH (c:Child {childId: $childId})
            MATCH (s:Subcategory {subcategoryId: $subcategoryId})

            MERGE (c)-[r:LIKES]->(s)
            SET
                r.score = $score,
                r.confidence = $confidence,
                r.evidenceCount = $evidenceCount,
                r.lastUpdated = $lastUpdated
        `;

        await session.run(query, {
            childId: toGraphId(childId),
            subcategoryId: toGraphId(subcategoryId),
            score: properties.score ?? null,
            confidence: properties.confidence ?? null,
            evidenceCount: properties.evidenceCount ?? null,
            lastUpdated: normalizeDate(properties.lastUpdated)
        });

        console.log(`🔗 LIKES relationship created`);

    }

    finally {

        await session.close();

    }

}

module.exports = {
    build
};
