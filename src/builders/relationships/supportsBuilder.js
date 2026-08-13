const driver = require("../../config/neo4j");

async function build(activityId, goalId) {

    const session = driver.session();

    try {

        const query = `
            MATCH (a:Activity {activityId: $activityId})
            MATCH (g:Goal {goalId: $goalId})

            MERGE (a)-[:SUPPORTS]->(g)
        `;

        await session.run(query, {
            activityId,
            goalId
        });

        console.log("🔗 SUPPORTS relationship created");

    }

    finally {

        await session.close();

    }

}

module.exports = {
    build
};