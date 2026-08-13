const driver = require("../../config/neo4j");

async function findParent(childId) {

    const session = driver.session();

    try {

        const query = `

            MATCH (p:Parent)-[:HAS_CHILD]->(c:Child)

            WHERE c.childId = $childId

            RETURN p

        `;

        const result = await session.run(query, {

            childId

        });

        if (result.records.length === 0) {
        return null;
        }

        const parent = result.records[0].get("p");

    return {
        parentId: parent.properties.parentId,
        firstName: parent.properties.firstName,
        lastName: parent.properties.lastName,
        email: parent.properties.email,
        phone: parent.properties.phone,
        isActive: parent.properties.isActive
    };  

    }

    finally {

        await session.close();

    }

}

module.exports = {

    findParent

};