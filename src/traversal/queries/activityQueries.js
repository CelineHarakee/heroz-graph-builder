const driver = require("../../config/neo4j");
const { toGraphId } = require("../../utils/idUtils");

async function findActivitiesByInterest(childId) {

    const session = driver.session();

    try {

        const query = `
            MATCH (c:Child {childId: $childId})
                  -[l:LIKES]->
                  (s:Subcategory)
                  <-[:CLASSIFIED_AS]-
                  (a:Activity)

            RETURN a, s, l
        `;

        const result = await session.run(query, {
            childId: toGraphId(childId)
        });

        return result.records.map(record => {

            const activity = record.get("a");
            const subcategory = record.get("s");
            const likes = record.get("l");

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
                            name: subcategory.properties.name,
                            score:
                                likes.properties.score ?? null,
                            confidence:
                                likes.properties.confidence ?? null,
                            evidenceCount:
                                likes.properties.evidenceCount ?? null,
                            lastUpdated:
                                likes.properties.lastUpdated ?? null
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
