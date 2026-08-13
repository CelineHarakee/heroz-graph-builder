const driver = require("../../config/neo4j");

async function findActivitiesByGoal(childId) {

    const session = driver.session();

    try {

        const query = `
            MATCH (c:Child {childId: $childId})

            <-[:HAS_CHILD]-

            (p:Parent)

            -[:HAS_GOAL]->

            (g:Goal)

            <-[:SUPPORTS]-

            (a:Activity)

            RETURN a, g
        `;

        const result = await session.run(query, {

            childId

        });

        return result.records.map(record => {

            const activity = record.get("a");
            const goal = record.get("g");

            return {
                activity: {
                    activityId: activity.properties.activityId,
                    title: activity.properties.title,
                    categoryId: activity.properties.categoryId,
                    subcategoryId: activity.properties.subcategoryId
                },

                evidence: {
                    interests: [],
                    goals: [
                        {
                            goalId: goal.properties.goalId,
                            name: goal.properties.name
                        }
                    ]
                }
            };

        });

    }

    finally {

        await session.close();

    }

}

module.exports = {

    findActivitiesByGoal

};