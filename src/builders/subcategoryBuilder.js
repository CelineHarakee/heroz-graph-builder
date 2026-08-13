const driver = require("../config/neo4j");

async function buildSubcategoryNode(subcategory) {

    const session = driver.session();

    try {

        const query = `
            MERGE (s:Subcategory {subcategoryId: $subcategoryId})

            SET
                s.name = $name,
                s.categoryId = $categoryId,
                s.description = $description
        `;

        await session.run(query, {

            subcategoryId: subcategory._id,
            name: subcategory.name,
            categoryId: subcategory.categoryId,
            description: subcategory.description

        });

        console.log(`✅ Subcategory node created: ${subcategory.name}`);

    }

    finally {

        await session.close();

    }

}

module.exports = {
    buildSubcategoryNode
};