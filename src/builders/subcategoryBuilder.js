const driver = require("../config/neo4j");
const { toGraphId } = require("../utils/idUtils");

async function buildSubcategoryNode(subcategory) {

    const session = driver.session();

    try {

        const name = subcategory.name ?? null;

        const description = subcategory.description ?? null;

        const query = `
            MERGE (s:Subcategory {subcategoryId: $subcategoryId})

            SET
                s.name = $name,
                s.categoryId = $categoryId,
                s.description = $description,
                s.isActive = $isActive
        `;

        await session.run(query, {

            subcategoryId: toGraphId(subcategory._id),
            name,
            categoryId: toGraphId(subcategory.categoryId),
            description,
            isActive: subcategory.isActive ?? null

        });

        console.log(`✅ Subcategory node created: ${name}`);

    }

    finally {

        await session.close();

    }

}

module.exports = {
    buildSubcategoryNode
};
