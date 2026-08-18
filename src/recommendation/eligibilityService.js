function checkActivityEligibility(child, activity) {

    const reasons = [];

    // Child must be active
    if (child.isActive !== true) {

        reasons.push("Child is inactive");

    }

    // Activity must be active
    if (activity.isActive !== true) {

        reasons.push("Activity is inactive");

    }

    // Age must satisfy activity requirements
    if (
        child.age < activity.minimumAge ||
        child.age > activity.maximumAge
    ) {

        reasons.push(
            `Child age ${child.age} is outside activity age range ` +
            `${activity.minimumAge}-${activity.maximumAge}`
        );

    }

    return {
        eligible: reasons.length === 0,
        reasons
    };
}

module.exports = {
    checkActivityEligibility
};