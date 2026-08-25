const driver = require("../../config/neo4j");
const { toGraphId } = require("../../utils/idUtils");

async function build(parentId, childId) {

    const session = driver.session();

    try {

        const query = `
            MATCH (p:Parent {parentId: $parentId})
            MATCH (c:Child {childId: $childId})

            MERGE (p)-[r:HAS_CHILD]->(c)

            RETURN r
        `;

        const result = await session.run(query, {
            parentId: toGraphId(parentId),
            childId: toGraphId(childId)
        });

        if (result.records.length === 0) {
            throw new Error(
                "HAS_CHILD could not be created because the required " +
                "Parent or Child Neo4j node was not found."
            );
        }

        console.log("🔗 HAS_CHILD relationship created");

    }

    finally {

        await session.close();

    }

}

module.exports = {
    build
};
