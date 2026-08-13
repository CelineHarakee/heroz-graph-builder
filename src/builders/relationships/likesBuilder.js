const driver = require("../../config/neo4j");

async function build(childId, subcategoryId) {

    const session = driver.session();

    try {

        const query = `
            MATCH (c:Child {childId: $childId})
            MATCH (s:Subcategory {subcategoryId: $subcategoryId})

            MERGE (c)-[:LIKES]->(s)
        `;

        await session.run(query, {
            childId,
            subcategoryId
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