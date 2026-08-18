const {
    connectMongoDB
} = require("../config/mongodb");

const recommendationService =
    require("../services/recommendationService");

async function test() {

    try {

        await connectMongoDB();

        const childId = "child_001";

        const result =
            await recommendationService.generateRecommendations(
                childId,3
            );

        console.log(
            JSON.stringify(result, null, 2)
        );

    } catch (error) {

        console.error(
            "Recommendation test failed:",
            error
        );

    }

}

test();