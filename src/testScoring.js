const {
    calculateInterestRelevance,
    calculatePreferenceMatch,
    calculateGoalRelevance,
    calculateExplorationNovelty,
    calculateBehavioralAffinity,
    calculateVendorReliability,
    calculateSessionSuitability,
    calculateFinalScore
} = require("./recommendation/scoringService");

function test() {

    const matchingEvidence = {
        interests: [
            {
                subcategoryId: "subcategory_robotics",
                name: "Robotics"
            }
        ]
    };

    const noMatchEvidence = {
        interests: []
    };


    console.log("Interest Match:");

    console.log(
        calculateInterestRelevance(
            matchingEvidence
        )
    );


    console.log("\nNo Interest Match:");

    console.log(
        calculateInterestRelevance(
            noMatchEvidence
        )
    );


    const child = {
        preferences: {
            indoorOutdoor: "Indoor",
            activityStyle: "Team",
            difficultyPreference: "Beginner",
            experiencePreference: "Weekly Program"
        }
    };


    const juniorRobotics = {
        preferences: {
            indoorOutdoor: "Indoor",
            activityStyle: "Team",
            difficulty: "Beginner",
            experienceType: "Weekly Program"
        }
    };


    const advancedRobotics = {
        preferences: {
            indoorOutdoor: "Indoor",
            activityStyle: "Team",
            difficulty: "Advanced",
            experienceType: "Weekly Program"
        }
    };


    console.log("\nJunior Robotics Preference Match:");

    console.log(
        calculatePreferenceMatch(
            child,
            juniorRobotics
        )
    );


    console.log("\nAdvanced Robotics Preference Match:");

    console.log(
        calculatePreferenceMatch(
            child,
            advancedRobotics
        )
    );

    const goalEvidence = {
    goals: [
        {
            goalId: "goal_problem_solving",
            name: "Problem Solving"
        }
    ]
};

    const noGoalEvidence = {
        goals: []
    };

    console.log("\nGoal Match:");

    console.log(
        calculateGoalRelevance(
            goalEvidence
        )
    );

    console.log("\nNo Goal Match:");

    console.log(
        calculateGoalRelevance(
            noGoalEvidence
        )
    );

    const newChild = {
    activityHistory: []
};

const experiencedChild = {
    activityHistory: [
        "activity_001"
    ]
};

console.log("\nNovel Activity:");

console.log(
    calculateExplorationNovelty(
        newChild,
        "activity_002"
    )
);

console.log("\nPreviously Experienced Activity:");

console.log(
    calculateExplorationNovelty(
        experiencedChild,
        "activity_001"
    )
);

const childWithBehavior = {
    behaviorHistory: [
        {
            activityId: "activity_001",
            liked: true,
            booked: true,
            attended: true,
            dismissed: false
        }
    ]
};

const childWithNoBehavior = {
    behaviorHistory: []
};

const childWithDismissal = {
    behaviorHistory: [
        {
            activityId: "activity_001",
            liked: false,
            booked: false,
            attended: false,
            dismissed: true
        }
    ]
};

console.log("\nPositive Behavioral Affinity:");

console.log(
    calculateBehavioralAffinity(
        childWithBehavior,
        "activity_001"
    )
);

console.log("\nNo Behavioral History:");

console.log(
    calculateBehavioralAffinity(
        childWithNoBehavior,
        "activity_001"
    )
);

console.log("\nDismissed Activity:");

console.log(
    calculateBehavioralAffinity(
        childWithDismissal,
        "activity_001"
    )
);

const vendorWithoutData = {
    _id: "vendor_001",
    reliability: {
        sessionCompletionRate: null,
        cancellationRate: null,
        noShowRate: null,
        capacityAccuracy: null
    }
};

const vendorWithData = {
    _id: "vendor_test",
    reliability: {
        sessionCompletionRate: 0.96,
        cancellationRate: 0.02,
        noShowRate: 0.01,
        capacityAccuracy: 0.95
    }
};

console.log("\nVendor Without Reliability Data:");

console.log(
    calculateVendorReliability(
        vendorWithoutData
    )
);

console.log("\nVendor With Reliability Data:");

console.log(
    calculateVendorReliability(
        vendorWithData
    )
);

const sessionWithoutData = {
    _id: "session_001",
    activityId: "activity_001",
    startDate: null,
    startTime: null,
    endDate: null,
    endTime: null,
    capacity: null,
    availableSpots: null,
    price: null,
    locationId: null,
    isActive: true
};

const sessionChild = {
    cityId: "city_jeddah",
    preferences: {
        indoorOutdoor: "Indoor",
        activityStyle: "Team",
        difficultyPreference: "Beginner",
        experiencePreference: "Weekly Program"
    }
};

console.log("\nSession Without Suitability Data:");

console.log(
    calculateSessionSuitability(
    sessionChild,
    sessionWithoutData
)
);

const factorsWithMissingData = {

    interest: {
        score: 1,
        available: true
    },

    preference: {
        score: 0.75,
        available: true
    },

    goal: {
        score: 1,
        available: true
    },

    exploration: {
        score: 1,
        available: true
    },

    behavior: {
        score: 0,
        available: false
    },

    vendor: {
        score: 0,
        available: false
    },

    session: {
        score: 0,
        available: false
    }
};

console.log("\nFinal Score With Missing Factors:");

console.log(
    calculateFinalScore(
        factorsWithMissingData
    )
);

const allFactorsAvailable = {

    interest: {
        score: 1,
        available: true
    },

    preference: {
        score: 0.8,
        available: true
    },

    goal: {
        score: 1,
        available: true
    },

    exploration: {
        score: 0.5,
        available: true
    },

    behavior: {
        score: 0.6,
        available: true
    },

    vendor: {
        score: 0.9,
        available: true
    },

    session: {
        score: 0.75,
        available: true
    }
};

console.log("\nFinal Score With All Factors:");

console.log(
    calculateFinalScore(
        allFactorsAvailable
    )
);
}




test();