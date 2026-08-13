const driver = require("../config/neo4j");

async function buildGoalNode(goal) {

    const session = driver.session();

    try {

        const query = `
            MERGE (g:Goal {goalId: $goalId})

            SET
                g.name = $name,
                g.description = $description,
                g.isActive = $isActive
        `;

        await session.run(query, {

            goalId: goal._id,
            name: goal.name,
            description: goal.description,
            isActive: goal.isActive

        });

        console.log(`✅ Goal node created: ${goal.name}`);

    }

    finally {

        await session.close();

    }

}

module.exports = {
    buildGoalNode
};