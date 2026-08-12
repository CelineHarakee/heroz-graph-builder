const driver = require("../config/neo4j");

async function buildChildNode(child) {
    const session = driver.session();

    try {
        const query = `
            MERGE (c:Child {childId: $childId})
            SET
                c.firstName = $firstName,
                c.lastName = $lastName,
                c.age = $age,
                c.gender = $gender,
                c.cityId = $cityId,
                c.isActive = $isActive
        `;

        await session.run(query, {
            childId: child._id,
            firstName: child.firstName,
            lastName: child.lastName,
            age: child.age,
            gender: child.gender,
            cityId: child.cityId,
            isActive: child.isActive
        });

        console.log(`✅ Child node created: ${child.firstName}`);

    } finally {
        await session.close();
    }
}

module.exports = {
    buildChildNode
};