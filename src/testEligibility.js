const {
    checkActivityEligibility
} = require("./recommendation/eligibilityService");

function test() {

    const child = {
        _id: "child_001",
        age: 3,
        isActive: true
    };

    const activity = {
        _id: "activity_001",
        title: "Junior Robotics",
        minimumAge: 7,
        maximumAge: 10,
        isActive: true
    };

    const result =
        checkActivityEligibility(child, activity);

    console.log(
        JSON.stringify(result, null, 2)
    );
}

test();