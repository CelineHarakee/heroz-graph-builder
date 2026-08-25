const driver = require("../../config/neo4j");
const { toGraphId } = require("../../utils/idUtils");

async function build(goalId, outcomeId, properties = {}) {

    const session = driver.session();

    try {

        const query = `
            MATCH (g:Goal {goalId: $goalId})
            MATCH (o:LearningOutcome {outcomeId: $outcomeId})

            MERGE (g)-[r:RELATES_TO_OUTCOME]->(o)
            SET
                r.weight = $weight

            RETURN r
        `;

        const result = await session.run(query, {
            goalId: toGraphId(goalId),
            outcomeId: toGraphId(outcomeId),
            weight: properties.weight ?? null
        });

        if (result.records.length === 0) {
            throw new Error(
                "RELATES_TO_OUTCOME could not be created because the " +
                "required Goal or LearningOutcome Neo4j node was not found."
            );
        }

        console.log("🔗 RELATES_TO_OUTCOME relationship created");

    }

    finally {

        await session.close();

    }

}

async function removeStaleForGoal(goalId, currentOutcomeIds = []) {

    const session = driver.session();

    try {

        const normalizedGoalId = toGraphId(goalId);
        const normalizedOutcomeIds = currentOutcomeIds
            .map((outcomeId) => toGraphId(outcomeId))
            .filter((outcomeId) => outcomeId !== null);

        const query = `
            MATCH (g:Goal {goalId: $goalId})

            OPTIONAL MATCH
                (g)-[r:RELATES_TO_OUTCOME]->(:LearningOutcome)

            WITH g, [
                rel IN collect(r)
                WHERE rel IS NOT NULL
                AND NOT endNode(rel).outcomeId IN $currentOutcomeIds
            ] AS staleRelationships

            FOREACH (
                rel IN staleRelationships |
                DELETE rel
            )

            RETURN size(staleRelationships) AS removedCount
        `;

        const result = await session.run(query, {
            goalId: normalizedGoalId,
            currentOutcomeIds: normalizedOutcomeIds
        });

        if (result.records.length === 0) {
            throw new Error(
                "Cannot remove stale RELATES_TO_OUTCOME relationships " +
                `because Goal ${goalId} was not found in Neo4j.`
            );
        }

        const removedCount = result.records[0].get("removedCount");

        if (
            removedCount !== null &&
            typeof removedCount.toNumber === "function"
        ) {
            return removedCount.toNumber();
        }

        return Number(removedCount);

    }

    finally {

        await session.close();

    }

}

module.exports = {
    build,
    removeStaleForGoal
};
