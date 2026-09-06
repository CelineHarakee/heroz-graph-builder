const driver = require("../../config/neo4j");
const { toGraphId } = require("../../utils/idUtils");

async function findActivitiesByGoal(childId) {

    const session = driver.session();

    try {

        const query = `
            MATCH (c:Child {childId: $childId})

            -[hg:HAS_GOAL]->

            (g:Goal)

            -[:RELATES_TO_OUTCOME]->

            (o:LearningOutcome)

            <-[:SUPPORTS_OUTCOME]-

            (a:Activity)

            RETURN a, g, o, hg
        `;

        const result = await session.run(query, {

            childId: toGraphId(childId)

        });

        return result.records.map(record => {

            const activity = record.get("a");
            const goal = record.get("g");
            const learningOutcome = record.get("o");
            const hasGoal = record.get("hg");
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
                            name: goal.properties.name,
                            priority:
                                hasGoal.properties.priority ?? null,
                            status:
                                hasGoal.properties.status ?? null,
                            learningOutcome: {
                                outcomeId:
                                    learningOutcome.properties.outcomeId,
                                name:
                                    learningOutcome.properties.name
                            }
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
