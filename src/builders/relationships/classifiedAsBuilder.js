const driver = require("../../config/neo4j");
const { toGraphId } = require("../../utils/idUtils");

async function build(activityId, subcategoryId) {

    const session = driver.session();

    try {

        const query = `
            MATCH (a:Activity {activityId: $activityId})
            MATCH (s:Subcategory {subcategoryId: $subcategoryId})

            MERGE (a)-[:CLASSIFIED_AS]->(s)
        `;

        await session.run(query, {
            activityId: toGraphId(activityId),
            subcategoryId: toGraphId(subcategoryId)
        });

        console.log("🔗 CLASSIFIED_AS relationship created");

    }

    finally {

        await session.close();

    }

}

module.exports = {
    build
};
