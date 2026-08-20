const driver = require("../config/neo4j");
const { toGraphId } = require("../utils/idUtils");

async function buildParentNode(parent) {

    const session = driver.session();

    try {

        const firstName = parent.account?.firstName ?? null;

        const query = `
            MERGE (p:Parent {parentId: $parentId})

            SET
                p.firstName = $firstName,
                p.lastName = $lastName,
                p.status = $status
        `;

        await session.run(query, {

            parentId: toGraphId(parent._id),
            firstName,
            lastName: parent.account?.lastName ?? null,
            status: parent.account?.status ?? null

        });

        console.log(`✅ Parent node created: ${firstName}`);

    }

    finally {

        await session.close();

    }

}

module.exports = {
    buildParentNode
};
