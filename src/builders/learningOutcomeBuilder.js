const driver = require("../config/neo4j");
const { toGraphId } = require("../utils/idUtils");

async function buildLearningOutcomeNode(outcome) {

    const session = driver.session();

    try {

        const name = outcome.name ?? null;

        const description = outcome.description ?? null;

        const outcomeType = outcome.outcomeType ?? null;

        const query = `
            MERGE (o:LearningOutcome {outcomeId: $outcomeId})

            SET
                o.name = $name,
                o.description = $description,
                o.outcomeType = $outcomeType,
                o.isActive = $isActive
        `;

        await session.run(query, {

            outcomeId: toGraphId(outcome._id),
            name,
            description,
            outcomeType,
            isActive: outcome.isActive ?? null

        });

        console.log(`✅ LearningOutcome node created: ${name}`);

    }

    finally {

        await session.close();

    }

}

module.exports = {
    buildLearningOutcomeNode
};
