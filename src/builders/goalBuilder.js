const driver = require("../config/neo4j");
const { toGraphId } = require("../utils/idUtils");

async function buildGoalNode(goal) {

    const session = driver.session();

    try {

        const name =
            goal.basicInformation?.nameEn ??
            goal.basicInformation?.nameAr ??
            null;

        const description =
            goal.basicInformation?.descriptionEn ??
            goal.basicInformation?.descriptionAr ??
            null;

        const query = `
            MERGE (g:Goal {goalId: $goalId})

            SET
                g.name = $name,
                g.description = $description,
                g.isActive = $isActive
        `;

        await session.run(query, {

            goalId: toGraphId(goal._id),
            name,
            description,
            isActive: goal.isActive ?? null

        });

        console.log(`✅ Goal node created: ${name}`);

    }

    finally {

        await session.close();

    }

}

module.exports = {
    buildGoalNode
};
