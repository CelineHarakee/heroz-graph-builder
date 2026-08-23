const driver = require("../../config/neo4j");
const { toGraphId } = require("../../utils/idUtils");

async function build(childId, goalId, properties = {}) {

    const session = driver.session();

    try {

        const query = `
            MATCH (c:Child {childId: $childId})
            MATCH (g:Goal {goalId: $goalId})

            MERGE (c)-[r:HAS_GOAL]->(g)
            SET
                r.priority = $priority,
                r.status = $status

            RETURN r
        `;

        const result = await session.run(query, {
            childId: toGraphId(childId),
            goalId: toGraphId(goalId),
            priority: properties.priority ?? null,
            status: properties.status ?? null
        });

        if (result.records.length === 0) {
            throw new Error(
                "HAS_GOAL could not be created because the required Child " +
                "or Goal Neo4j node was not found."
            );
        }

        console.log("🔗 HAS_GOAL relationship created");

    }

    finally {

        await session.close();

    }

}

async function removeStaleForChild(childId, currentGoalIds = []) {

    const session = driver.session();

    try {

        const query = `
            MATCH (c:Child {childId: $childId})
            OPTIONAL MATCH (c)-[r:HAS_GOAL]->(g:Goal)
            WITH [
                rel IN collect(r)
                WHERE rel IS NOT NULL
                AND NOT endNode(rel).goalId IN $currentGoalIds
            ] AS staleRelationships
            FOREACH (rel IN staleRelationships | DELETE rel)
            RETURN size(staleRelationships) AS removedCount
        `;

        const result = await session.run(query, {
            childId: toGraphId(childId),
            currentGoalIds: currentGoalIds.map(toGraphId)
        });

        if (result.records.length === 0) {
            throw new Error(
                "Stale HAS_GOAL cleanup could not run because the " +
                "required Child Neo4j node was not found."
            );
        }

        const removedCount = result.records[0].get("removedCount");

        if (typeof removedCount.toNumber === "function") {
            return removedCount.toNumber();
        }

        return removedCount;

    }

    finally {

        await session.close();

    }

}

module.exports = {
    build,
    removeStaleForChild
};
