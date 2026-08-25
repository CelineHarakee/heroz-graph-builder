const driver = require("../../config/neo4j");
const { toGraphId } = require("../../utils/idUtils");

async function build(activityId, outcomeId, properties = {}) {

    const session = driver.session();

    try {

        const query = `
            MATCH (a:Activity {activityId: $activityId})
            MATCH (o:LearningOutcome {outcomeId: $outcomeId})

            MERGE (a)-[r:SUPPORTS_OUTCOME]->(o)
            SET
                r.weight = $weight

            RETURN r
        `;

        const result = await session.run(query, {
            activityId: toGraphId(activityId),
            outcomeId: toGraphId(outcomeId),
            weight: properties.weight ?? null
        });

        if (result.records.length === 0) {
            throw new Error(
                "SUPPORTS_OUTCOME could not be created because the " +
                "required Activity or LearningOutcome Neo4j node was not found."
            );
        }

        console.log("🔗 SUPPORTS_OUTCOME relationship created");

    }

    finally {

        await session.close();

    }

}

async function removeStaleForActivity(activityId, currentOutcomeIds = []) {

    const session = driver.session();

    try {

        const normalizedActivityId = toGraphId(activityId);
        const normalizedOutcomeIds = currentOutcomeIds
            .map((outcomeId) => toGraphId(outcomeId))
            .filter((outcomeId) => outcomeId !== null);

        const query = `
            MATCH (a:Activity {activityId: $activityId})

            OPTIONAL MATCH
                (a)-[r:SUPPORTS_OUTCOME]->(:LearningOutcome)

            WITH a, [
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
            activityId: normalizedActivityId,
            currentOutcomeIds: normalizedOutcomeIds
        });

        if (result.records.length === 0) {
            throw new Error(
                "Cannot remove stale SUPPORTS_OUTCOME relationships " +
                `because Activity ${activityId} was not found in Neo4j.`
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
    removeStaleForActivity
};
