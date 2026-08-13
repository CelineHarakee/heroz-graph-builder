const driver = require("../../config/neo4j");

async function findActivitiesByInterest(childId) {

    const session = driver.session();

    try {

        const query = `
            MATCH (c:Child {childId: $childId})
                  -[:LIKES]->
                  (s:Subcategory)
                  <-[:CLASSIFIED_AS]-
                  (a:Activity)

            RETURN a, s
        `;

        const result = await session.run(query, {
            childId
        });

        return result.records.map(record => {

            const activity = record.get("a");
            const subcategory = record.get("s");

            return {
                activity: {
                    activityId: activity.properties.activityId,
                    title: activity.properties.title,
                    categoryId: activity.properties.categoryId,
                    subcategoryId: activity.properties.subcategoryId
                },

                evidence: {
                    interests: [
                        {
                            subcategoryId: subcategory.properties.subcategoryId,
                            name: subcategory.properties.name
                        }
                    ],
                    goals: []
                }
            };

        });

    }

    finally {

        await session.close();

    }

}

module.exports = {
    findActivitiesByInterest
};