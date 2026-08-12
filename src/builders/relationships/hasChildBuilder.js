const driver = require("../../config/neo4j");

async function build(parentId, childId) {

    const session = driver.session();

    try {

        const query = `
            MATCH (p:Parent {parentId: $parentId})
            MATCH (c:Child {childId: $childId})

            MERGE (p)-[:HAS_CHILD]->(c)
        `;

        await session.run(query, {
            parentId,
            childId
        });

        console.log(`🔗 HAS_CHILD relationship created`);

    }

    finally {

        await session.close();

    }

}

module.exports = {
    build
};