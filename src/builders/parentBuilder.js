const driver = require("../config/neo4j");

async function buildParentNode(parent) {

    const session = driver.session();

    try {

        const query = `
            MERGE (p:Parent {parentId: $parentId})

            SET
                p.firstName = $firstName,
                p.lastName = $lastName,
                p.email = $email,
                p.phone = $phone,
                p.isActive = $isActive
        `;

        await session.run(query, {

            parentId: parent._id,
            firstName: parent.firstName,
            lastName: parent.lastName,
            email: parent.email,
            phone: parent.phone,
            isActive: parent.isActive

        });

        console.log(`✅ Parent node created: ${parent.firstName}`);

    }

    finally {

        await session.close();

    }

}

module.exports = {
    buildParentNode
};