const recommendationService =
    require("./services/recommendationService");

async function test() {

    const childId = "child_001";

    try {

        const recommendations =
            await recommendationService.generateRecommendations(childId);

        console.log(
            JSON.stringify(recommendations, null, 2)
        );

    } catch (error) {

        console.error(
            "Recommendation test failed:",
            error
        );

    }

}

test();