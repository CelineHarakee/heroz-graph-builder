const driver = require("../config/neo4j");
const { toGraphId } = require("../utils/idUtils");

async function buildActivityNode(activity) {

    const session = driver.session();

    try {

        const title =
            activity.basicInformation?.nameEn ??
            activity.basicInformation?.nameAr ??
            null;

        const query = `
            MERGE (a:Activity {activityId: $activityId})

            SET
                a.title = $title,
                a.vendorId = $vendorId,
                a.categoryId = $categoryId,
                a.subcategoryId = $subcategoryId,
                a.minimumAge = $minimumAge,
                a.maximumAge = $maximumAge,
                a.status = $status
        `;

        await session.run(query, {

            activityId: toGraphId(activity._id),
            title,
            vendorId: toGraphId(activity.vendorId),
            categoryId: toGraphId(
                activity.classification?.categoryId
            ),
            subcategoryId: toGraphId(
                activity.classification?.subcategoryId
            ),
            minimumAge:
                activity.eligibility?.minimumAge ?? null,
            maximumAge:
                activity.eligibility?.maximumAge ?? null,
            status:
                activity.basicInformation?.status ?? null

        });

        console.log(`✅ Activity node created: ${title}`);

    }

    finally {

        await session.close();

    }

}

module.exports = {
    buildActivityNode
};
