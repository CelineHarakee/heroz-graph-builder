const driver = require("../../config/neo4j");

async function build(parentId, goalId) {

    const session = driver.session();

    try {

        const query = `
            MATCH (p:Parent {parentId: $parentId})
            MATCH (g:Goal {goalId: $goalId})

            MERGE (p)-[:HAS_GOAL]->(g)
        `;

        await session.run(query, {
            parentId,
            goalId
        });

        console.log("🔗 HAS_GOAL relationship created");

    }

    finally {

        await session.close();

    }

}

module.exports = {
    build
};