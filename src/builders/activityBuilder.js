const driver = require("../config/neo4j");

async function buildActivityNode(activity) {

    const session = driver.session();

    try {

        const query = `
            MERGE (a:Activity {activityId: $activityId})

            SET
                a.title = $title,
                a.vendorId = $vendorId,
                a.categoryId = $categoryId,
                a.subcategoryId = $subcategoryId,
                a.minimumAge = $minimumAge,
                a.maximumAge = $maximumAge,
                a.isActive = $isActive
        `;

        await session.run(query, {

            activityId: activity._id,
            title: activity.title,
            vendorId: activity.vendorId,
            categoryId: activity.categoryId,
            subcategoryId: activity.subcategoryId,
            minimumAge: activity.minimumAge,
            maximumAge: activity.maximumAge,
            isActive: activity.isActive

        });

        console.log(`✅ Activity node created: ${activity.title}`);

    }

    finally {

        await session.close();

    }

}

module.exports = {
    buildActivityNode
};