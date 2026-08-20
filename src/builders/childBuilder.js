const driver = require("../config/neo4j");
const { toGraphId } = require("../utils/idUtils");

async function buildChildNode(child) {
    const session = driver.session();

    try {
        const firstName = child.identity?.firstName ?? null;

        const query = `
            MERGE (c:Child {childId: $childId})
            SET
                c.firstName = $firstName,
                c.gender = $gender,
                c.ageGroup = $ageGroup,
                c.status = $status
        `;

        await session.run(query, {
            childId: toGraphId(child._id),
            firstName,
            gender: child.identity?.gender ?? null,
            ageGroup: child.identity?.ageGroup ?? null,
            status: child.status ?? null
        });

        console.log(`✅ Child node created: ${firstName}`);

    } finally {
        await session.close();
    }
}

module.exports = {
    buildChildNode
};
