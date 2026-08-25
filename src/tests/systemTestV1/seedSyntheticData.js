require("dotenv").config();

const { MongoClient, ObjectId } = require("mongodb");

const client = new MongoClient(process.env.MONGO_URI);

function id() {
    return new ObjectId();
}

function assert(condition, message) {
    if (!condition) {
        throw new Error(`❌ ASSERTION FAILED: ${message}`);
    }
}

function preference(value, confidenceScore) {
    return {
        value,
        confidenceScore,
        source: "SYSTEM_TEST_V1",
        updatedAt: new Date()
    };
}

async function main() {
    try {
        await client.connect();

        const db = client.db("heroz");

        console.log("🚀 Starting Step 9 — System Test V1");
        console.log("📦 Phase A: Building synthetic MongoDB dataset\n");

        // --------------------------------------------------
        // CLEAN ONLY THE SYNTHETIC TEST DATA
        // --------------------------------------------------

        const testTag = "SYSTEM_TEST_V1";

        const collections = [
            "parents",
            "children",
            "categories",
            "subcategories",
            "learning_outcomes",
            "goal_library",
            "activities",
            "vendors",
            "cities",
            "child_interests"
        ];

        for (const collection of collections) {
            await db.collection(collection).deleteMany({
                "metadata.testDataset": testTag
            });
        }

        // --------------------------------------------------
        // IDS
        // --------------------------------------------------

        const parent1Id = id();
        const parent2Id = id();

        const cityId = id();
        const stemCategoryId = id();
        const artsCategoryId = id();
        const sportsCategoryId = id();
        const gamesLogicCategoryId = id();
        const vendor1Id = id();
        const vendor2Id = id();

        const saraId = id();
        const omarId = id();
        const linaId = id();

        const roboticsId = id();
        const paintingId = id();
        const footballId = id();
        const strategyGamesId = id();

        const problemSolvingId = id();
        const teamworkId = id();
        const creativityId = id();

        const problemSolvingGoalId = id();
        const teamworkGoalId = id();
        const creativityGoalId = id();

        const roboticsActivityId = id();
        const paintingActivityId = id();
        const footballActivityId = id();
        const strategyActivityId = id();
        const creativeRoboticsActivityId = id();

        // --------------------------------------------------
        // CITIES, CATEGORIES, AND VENDORS
        // --------------------------------------------------

        const cities = [
            {
                _id: cityId,
                nameEn: "Riyadh",
                nameAr: "الرياض",
                isActive: true,
                metadata: {
                    version: 1,
                    createdBy: testTag,
                    testDataset: testTag,
                    createdAt: new Date(),
                    updatedAt: new Date()
                }
            }
        ];

        const categories = [
            { _id: stemCategoryId, name: "STEM", description: "STEM activities", isActive: true, metadata: { version: 1, createdBy: testTag, testDataset: testTag } },
            { _id: artsCategoryId, name: "Arts", description: "Arts activities", isActive: true, metadata: { version: 1, createdBy: testTag, testDataset: testTag } },
            { _id: sportsCategoryId, name: "Sports", description: "Sports activities", isActive: true, metadata: { version: 1, createdBy: testTag, testDataset: testTag } },
            { _id: gamesLogicCategoryId, name: "Games & Logic", description: "Games and logic activities", isActive: true, metadata: { version: 1, createdBy: testTag, testDataset: testTag } }
        ];

        const vendors = [
            { _id: vendor1Id, name: "System Test Learning Hub", location: { cityId, districtId: null }, isActive: true, metadata: { version: 1, createdBy: testTag, testDataset: testTag } },
            { _id: vendor2Id, name: "System Test Activity Centre", location: { cityId, districtId: null }, isActive: true, metadata: { version: 1, createdBy: testTag, testDataset: testTag } }
        ];

        // --------------------------------------------------
        // PARENTS
        // --------------------------------------------------

        const parents = [
            {
                _id: parent1Id,

                account: {
                    firstName: "Noor",
                    lastName: "Parent",
                    phoneNumber: "+966500000001",
                    email: "noor.systemtest@example.com",
                    preferredLanguage: "en",
                    status: "Active"
                },

                location: {
                    cityId,
                    districtId: null
                },

                children: [
                    {
                        childId: saraId,
                        relationship: "Guardian",
                        isPrimaryGuardian: true
                    },
                    {
                        childId: omarId,
                        relationship: "Guardian",
                        isPrimaryGuardian: true
                    }
                ],

                recommendationPreferences: {
                    budget: {
                        preferredMaximumAmount: null,
                        currency: "SAR"
                    },
                    preferredDays: [],
                    preferredTravelDistanceKm: null,
                    excludedActivityIds: [],
                    excludedVendorIds: []
                },

                hardRequirements: {
                    requiredInstructorGender: "NoRequirement",
                    accessibilityRequirements: [],
                    medicalRequirements: [],
                    safetyRequirements: [],
                    allergyRestrictions: [],
                    transportationRequired: false
                },

                metadata: {
                    version: 1,
                    createdBy: testTag,
                    testDataset: testTag,
                    createdAt: new Date(),
                    updatedAt: new Date()
                }
            },

            {
                _id: parent2Id,

                account: {
                    firstName: "Maha",
                    lastName: "Parent",
                    phoneNumber: "+966500000002",
                    email: "maha.systemtest@example.com",
                    preferredLanguage: "en",
                    status: "Active"
                },

                location: {
                    cityId,
                    districtId: null
                },

                children: [
                    {
                        childId: linaId,
                        relationship: "Guardian",
                        isPrimaryGuardian: true
                    }
                ],

                recommendationPreferences: {
                    budget: {
                        preferredMaximumAmount: null,
                        currency: "SAR"
                    },
                    preferredDays: [],
                    preferredTravelDistanceKm: null,
                    excludedActivityIds: [],
                    excludedVendorIds: []
                },

                hardRequirements: {
                    requiredInstructorGender: "NoRequirement",
                    accessibilityRequirements: [],
                    medicalRequirements: [],
                    safetyRequirements: [],
                    allergyRestrictions: [],
                    transportationRequired: false
                },

                metadata: {
                    version: 1,
                    createdBy: testTag,
                    testDataset: testTag,
                    createdAt: new Date(),
                    updatedAt: new Date()
                }
            }
        ];

        // --------------------------------------------------
        // SUBCATEGORIES
        // --------------------------------------------------

        const subcategories = [
            {
                _id: roboticsId,
                name: "Robotics",
                categoryId: stemCategoryId,
                description: "Robotics activities",
                isActive: true,
                metadata: {
                    version: 1,
                    createdBy: testTag,
                    testDataset: testTag
                }
            },

            {
                _id: paintingId,
                name: "Painting",
                categoryId: artsCategoryId,
                description: "Painting activities",
                isActive: true,
                metadata: {
                    version: 1,
                    createdBy: testTag,
                    testDataset: testTag
                }
            },

            {
                _id: footballId,
                name: "Football",
                categoryId: sportsCategoryId,
                description: "Football activities",
                isActive: true,
                metadata: {
                    version: 1,
                    createdBy: testTag,
                    testDataset: testTag
                }
            },

            {
                _id: strategyGamesId,
                name: "Strategy Games",
                categoryId: gamesLogicCategoryId,
                description: "Strategy and logic activities",
                isActive: true,
                metadata: {
                    version: 1,
                    createdBy: testTag,
                    testDataset: testTag
                }
            }
        ];

        // --------------------------------------------------
        // LEARNING OUTCOMES
        // --------------------------------------------------

        const learningOutcomes = [
            {
                _id: problemSolvingId,
                name: "Problem Solving",
                description: "Ability to analyze problems and develop solutions.",
                outcomeType: "Cognitive",
                isActive: true,
                metadata: {
                    version: 1,
                    createdBy: testTag,
                    testDataset: testTag
                }
            },

            {
                _id: teamworkId,
                name: "Teamwork",
                description: "Ability to collaborate effectively with others.",
                outcomeType: "Social",
                isActive: true,
                metadata: {
                    version: 1,
                    createdBy: testTag,
                    testDataset: testTag
                }
            },

            {
                _id: creativityId,
                name: "Creativity",
                description: "Ability to generate original ideas and approaches.",
                outcomeType: "Cognitive",
                isActive: true,
                metadata: {
                    version: 1,
                    createdBy: testTag,
                    testDataset: testTag
                }
            }
        ];

        // --------------------------------------------------
        // GOALS
        // --------------------------------------------------

        const goals = [
            {
                _id: problemSolvingGoalId,
                name: "Improve Problem Solving",
                description: "Develop problem-solving ability.",
                isActive: true,

                relatedOutcomes: [
                    {
                        outcomeId: problemSolvingId,
                        weight: 0.90
                    }
                ],

                metadata: {
                    version: 1,
                    createdBy: testTag,
                    testDataset: testTag
                }
            },

            {
                _id: teamworkGoalId,
                name: "Build Teamwork",
                description: "Develop teamwork and collaboration.",
                isActive: true,

                relatedOutcomes: [
                    {
                        outcomeId: teamworkId,
                        weight: 0.85
                    }
                ],

                metadata: {
                    version: 1,
                    createdBy: testTag,
                    testDataset: testTag
                }
            },

            {
                _id: creativityGoalId,
                name: "Grow Creativity",
                description: "Develop creative thinking.",
                isActive: true,

                relatedOutcomes: [
                    {
                        outcomeId: creativityId,
                        weight: 0.95
                    }
                ],

                metadata: {
                    version: 1,
                    createdBy: testTag,
                    testDataset: testTag
                }
            }
        ];

        // --------------------------------------------------
        // CHILDREN
        // --------------------------------------------------

        const children = [
            {
                _id: saraId,
                parentId: parent1Id,

                identity: {
                    firstName: "Sara",
                    dateOfBirth: new Date("2017-05-10"),
                    gender: "Female",
                    ageGroup: "7-9"
                },

                preferences: {
                    environment: preference(null, 0.65),
                    socialStyle: preference(null, 0.65),
                    difficulty: preference(null, 0.65),
                    experienceStyle: preference("Structured", 0.65),
                    commitmentPreference: preference(null, 0.65)
                },

                parentGoals: [
                    {
                        goalId: problemSolvingGoalId,
                        priority: 1,
                        status: "Active",
                        selectedBy: "Parent",
                        selectedAt: new Date(),
                        targetDate: null
                    },
                    {
                        goalId: teamworkGoalId,
                        priority: 2,
                        status: "Active",
                        selectedBy: "Parent",
                        selectedAt: new Date(),
                        targetDate: null
                    }
                ],

                developmentProfile: [],

                profileState: {
                    completenessScore: 0.80,
                    overallConfidenceScore: 0.75,
                    maturityStage: "Learning",
                    lastInteractionAt: null,
                    lastUpdated: new Date()
                },

                status: "Active",

                metadata: {
                    version: 1,
                    createdBy: testTag,
                    testDataset: testTag,
                    createdAt: new Date(),
                    updatedAt: new Date()
                }
            },

            {
                _id: omarId,
                parentId: parent1Id,

                identity: {
                    firstName: "Omar",
                    dateOfBirth: new Date("2015-06-15"),
                    gender: "Male",
                    ageGroup: "10-12"
                },

                preferences: {
                    environment: preference(null, 0.65),
                    socialStyle: preference(null, 0.65),
                    difficulty: preference(null, 0.65),
                    experienceStyle: preference("Structured", 0.65),
                    commitmentPreference: preference(null, 0.65)
                },

                parentGoals: [
                    {
                        goalId: teamworkGoalId,
                        priority: 1,
                        status: "Active",
                        selectedBy: "Parent",
                        selectedAt: new Date(),
                        targetDate: null
                    }
                ],

                developmentProfile: [],

                profileState: {
                    completenessScore: 0.70,
                    overallConfidenceScore: 0.70,
                    maturityStage: "Learning",
                    lastInteractionAt: null,
                    lastUpdated: new Date()
                },

                status: "Active",

                metadata: {
                    version: 1,
                    createdBy: testTag,
                    testDataset: testTag,
                    createdAt: new Date(),
                    updatedAt: new Date()
                }
            },

            {
                _id: linaId,
                parentId: parent2Id,

                identity: {
                    firstName: "Lina",
                    dateOfBirth: new Date("2018-03-20"),
                    gender: "Female",
                    ageGroup: "7-9"
                },

                preferences: {
                    environment: preference(null, 0.65),
                    socialStyle: preference(null, 0.65),
                    difficulty: preference(null, 0.65),
                    experienceStyle: preference("Structured", 0.65),
                    commitmentPreference: preference(null, 0.65)
                },

                parentGoals: [
                    {
                        goalId: creativityGoalId,
                        priority: 1,
                        status: "Active",
                        selectedBy: "Parent",
                        selectedAt: new Date(),
                        targetDate: null
                    }
                ],

                developmentProfile: [],

                profileState: {
                    completenessScore: 0.50,
                    overallConfidenceScore: 0.50,
                    maturityStage: "Learning",
                    lastInteractionAt: null,
                    lastUpdated: new Date()
                },

                status: "Active",

                metadata: {
                    version: 1,
                    createdBy: testTag,
                    testDataset: testTag,
                    createdAt: new Date(),
                    updatedAt: new Date()
                }
            }
        ];

        // --------------------------------------------------
        // ACTIVITIES
        // --------------------------------------------------

        const activities = [
            {
                _id: roboticsActivityId,
                vendorId: vendor1Id,

                basicInformation: {
                    nameAr: "مختبر الروبوتات",
                    nameEn: "Robotics Lab",
                    status: "Published",
                    tags: []
                },

                classification: {
                    categoryId: stemCategoryId,
                    subcategoryId: roboticsId
                },

                eligibility: {
                    minimumAge: 7,
                    maximumAge: 12,
                    allowedGenders: ["Male", "Female"],
                    requiredExperienceLevel: null,
                    additionalRequirements: []
                },

                experience: {
                    environment: null,
                    socialStyle: null,
                    difficulty: null,
                    experienceStyles: [],
                    commitmentType: null,
                    intensityLevel: "Low",
                    durationMinutes: 90
                },

                learningOutcomes: [
                    {
                        outcomeId: problemSolvingId,
                        weight: 0.90,
                        evidenceGuidance: []
                    },
                    {
                        outcomeId: teamworkId,
                        weight: 0.50,
                        evidenceGuidance: []
                    }
                ],

                activityConstraints: {
                    equipmentProvided: true,
                    requiredItems: [],
                    accessibilityFeatures: [],
                    safetyRequirements: [],
                    medicalRestrictions: []
                },

                metadata: {
                    version: 1,
                    createdBy: testTag,
                    testDataset: testTag
                }
            },

            {
                _id: paintingActivityId,
                vendorId: vendor1Id,

                basicInformation: {
                    nameAr: "استوديو الرسم",
                    nameEn: "Painting Studio",
                    status: "Published",
                    tags: []
                },

                classification: {
                    categoryId: artsCategoryId,
                    subcategoryId: paintingId
                },

                eligibility: {
                    minimumAge: 7,
                    maximumAge: 12,
                    allowedGenders: ["Male", "Female"],
                    requiredExperienceLevel: null,
                    additionalRequirements: []
                },

                experience: {
                    environment: null,
                    socialStyle: null,
                    difficulty: null,
                    experienceStyles: [],
                    commitmentType: null,
                    intensityLevel: "Low",
                    durationMinutes: 90
                },

                learningOutcomes: [
                    {
                        outcomeId: creativityId,
                        weight: 0.90,
                        evidenceGuidance: []
                    }
                ],

                activityConstraints: {
                    equipmentProvided: true,
                    requiredItems: [],
                    accessibilityFeatures: [],
                    safetyRequirements: [],
                    medicalRestrictions: []
                },

                metadata: {
                    version: 1,
                    createdBy: testTag,
                    testDataset: testTag
                }
            },

            {
                _id: footballActivityId,
                vendorId: vendor2Id,

                basicInformation: {
                    nameAr: "معسكر كرة القدم",
                    nameEn: "Football Team Camp",
                    status: "Published",
                    tags: []
                },

                classification: {
                    categoryId: sportsCategoryId,
                    subcategoryId: footballId
                },

                eligibility: {
                    minimumAge: 7,
                    maximumAge: 12,
                    allowedGenders: ["Male", "Female"],
                    requiredExperienceLevel: null,
                    additionalRequirements: []
                },

                experience: {
                    environment: null,
                    socialStyle: null,
                    difficulty: null,
                    experienceStyles: [],
                    commitmentType: null,
                    intensityLevel: "Medium",
                    durationMinutes: 90
                },

                learningOutcomes: [
                    {
                        outcomeId: teamworkId,
                        weight: 0.95,
                        evidenceGuidance: []
                    }
                ],

                activityConstraints: {
                    equipmentProvided: true,
                    requiredItems: [],
                    accessibilityFeatures: [],
                    safetyRequirements: [],
                    medicalRestrictions: []
                },

                metadata: {
                    version: 1,
                    createdBy: testTag,
                    testDataset: testTag
                }
            },

            {
                _id: strategyActivityId,
                vendorId: vendor2Id,

                basicInformation: {
                    nameAr: "تحدي الهروب الاستراتيجي",
                    nameEn: "Strategy Escape Challenge",
                    status: "Published",
                    tags: []
                },

                classification: {
                    categoryId: gamesLogicCategoryId,
                    subcategoryId: strategyGamesId
                },

                eligibility: {
                    minimumAge: 7,
                    maximumAge: 12,
                    allowedGenders: ["Male", "Female"],
                    requiredExperienceLevel: null,
                    additionalRequirements: []
                },

                experience: {
                    environment: null,
                    socialStyle: null,
                    difficulty: null,
                    experienceStyles: [],
                    commitmentType: null,
                    intensityLevel: "Medium",
                    durationMinutes: 90
                },

                learningOutcomes: [
                    {
                        outcomeId: problemSolvingId,
                        weight: 0.85,
                        evidenceGuidance: []
                    },
                    {
                        outcomeId: teamworkId,
                        weight: 0.70,
                        evidenceGuidance: []
                    }
                ],

                activityConstraints: {
                    equipmentProvided: true,
                    requiredItems: [],
                    accessibilityFeatures: [],
                    safetyRequirements: [],
                    medicalRestrictions: []
                },

                metadata: {
                    version: 1,
                    createdBy: testTag,
                    testDataset: testTag
                }
            },

            {
                _id: creativeRoboticsActivityId,
                vendorId: vendor1Id,

                basicInformation: {
                    nameAr: "الروبوتات الإبداعية",
                    nameEn: "Creative Robotics",
                    status: "Published",
                    tags: []
                },

                classification: {
                    categoryId: stemCategoryId,
                    subcategoryId: roboticsId
                },

                eligibility: {
                    minimumAge: 7,
                    maximumAge: 12,
                    allowedGenders: ["Male", "Female"],
                    requiredExperienceLevel: null,
                    additionalRequirements: []
                },

                experience: {
                    environment: null,
                    socialStyle: null,
                    difficulty: null,
                    experienceStyles: [],
                    commitmentType: null,
                    intensityLevel: "Low",
                    durationMinutes: 90
                },

                learningOutcomes: [
                    {
                        outcomeId: problemSolvingId,
                        weight: 0.80,
                        evidenceGuidance: []
                    },
                    {
                        outcomeId: creativityId,
                        weight: 0.60,
                        evidenceGuidance: []
                    }
                ],

                activityConstraints: {
                    equipmentProvided: true,
                    requiredItems: [],
                    accessibilityFeatures: [],
                    safetyRequirements: [],
                    medicalRestrictions: []
                },

                metadata: {
                    version: 1,
                    createdBy: testTag,
                    testDataset: testTag
                }
            }
        ];

        // --------------------------------------------------
        // CHILD INTERESTS
        // --------------------------------------------------

        const childInterests = [
            {
                _id: id(),
                childId: saraId,
                subcategoryId: roboticsId,

                interestScore: {
                    currentScore: 0.88,
                    previousScore: 0.82,
                    lastCalculatedAt: new Date(),
                    lastDecayAt: new Date()
                },

                confidence: {
                    currentScore: 0.82,
                    evidenceCount: 12,
                    lastCalculatedAt: new Date()
                },

                evidenceSummary: {
                    interactionBreakdown: []
                },

                scoreHistory: [],

                metadata: {
                    version: 1,
                    createdBy: testTag,
                    testDataset: testTag,
                    createdAt: new Date(),
                    updatedAt: new Date()
                }
            },

            {
                _id: id(),
                childId: saraId,
                subcategoryId: paintingId,

                interestScore: {
                    currentScore: 0.56,
                    previousScore: 0.50,
                    lastCalculatedAt: new Date(),
                    lastDecayAt: new Date()
                },

                confidence: {
                    currentScore: 0.64,
                    evidenceCount: 5,
                    lastCalculatedAt: new Date()
                },

                evidenceSummary: {
                    interactionBreakdown: []
                },

                scoreHistory: [],

                metadata: {
                    version: 1,
                    createdBy: testTag,
                    testDataset: testTag,
                    createdAt: new Date(),
                    updatedAt: new Date()
                }
            },

            {
                _id: id(),
                childId: omarId,
                subcategoryId: footballId,

                interestScore: {
                    currentScore: 0.91,
                    previousScore: 0.87,
                    lastCalculatedAt: new Date(),
                    lastDecayAt: new Date()
                },

                confidence: {
                    currentScore: 0.87,
                    evidenceCount: 14,
                    lastCalculatedAt: new Date()
                },

                evidenceSummary: {
                    interactionBreakdown: []
                },

                scoreHistory: [],

                metadata: {
                    version: 1,
                    createdBy: testTag,
                    testDataset: testTag,
                    createdAt: new Date(),
                    updatedAt: new Date()
                }
            }
        ];

        // --------------------------------------------------
        // INSERT
        // --------------------------------------------------

        await db.collection("cities").insertMany(cities);
        await db.collection("categories").insertMany(categories);
        await db.collection("vendors").insertMany(vendors);
        await db.collection("parents").insertMany(parents);
        await db.collection("children").insertMany(children);
        await db.collection("subcategories").insertMany(subcategories);
        await db.collection("learning_outcomes").insertMany(learningOutcomes);
        await db.collection("goal_library").insertMany(goals);
        await db.collection("activities").insertMany(activities);
        await db.collection("child_interests").insertMany(childInterests);

        console.log("✅ Synthetic documents inserted\n");

        // --------------------------------------------------
        // VALIDATION
        // --------------------------------------------------

        const counts = {};

        for (const collection of collections) {
            counts[collection] = await db.collection(collection).countDocuments({
                "metadata.testDataset": testTag
            });
        }

        assert(counts.parents === 2, "Expected 2 parents");
        assert(counts.children === 3, "Expected 3 children");
        assert(counts.categories === 4, "Expected 4 categories");
        assert(counts.subcategories === 4, "Expected 4 subcategories");
        assert(
            counts.learning_outcomes === 3,
            "Expected 3 learning outcomes"
        );
        assert(counts.goal_library === 3, "Expected 3 goals");
        assert(counts.activities === 5, "Expected 5 activities");
        assert(counts.vendors === 2, "Expected 2 vendors");
        assert(counts.cities === 1, "Expected 1 city");
        assert(
            counts.child_interests === 3,
            "Expected 3 child interests"
        );

        // --------------------------------------------------
        // REFERENCE VALIDATION
        // --------------------------------------------------

        const childDocs = await db.collection("children")
            .find({ "metadata.testDataset": testTag })
            .toArray();

        const parentDocs = await db.collection("parents")
            .find({ "metadata.testDataset": testTag })
            .toArray();

        for (const parent of parentDocs) {
            for (const childReference of parent.children) {
                const child = childDocs.find((document) =>
                    document._id.equals(childReference.childId)
                );

                assert(
                    child,
                    `Parent ${parent._id} references missing child`
                );

                assert(
                    child.parentId.equals(parent._id),
                    `Parent-child back-reference mismatch for child ${child._id}`
                );
            }
        }

        for (const child of childDocs) {

            const parent = await db.collection("parents").findOne({
                _id: child.parentId,
                "metadata.testDataset": testTag
            });

            assert(
                parent,
                `Child ${child._id} references missing parent`
            );

            assert(
                child.identity.dateOfBirth instanceof Date,
                `Child ${child._id} dateOfBirth must be a Date`
            );

            for (const dimension of Object.values(child.preferences)) {
                assert(
                    typeof dimension.source === "string" && dimension.source.length > 0,
                    `Child ${child._id} preference source is required`
                );
                assert(
                    dimension.updatedAt instanceof Date,
                    `Child ${child._id} preference updatedAt must be a Date`
                );
            }

            for (const goal of child.parentGoals) {

                const goalDoc = await db.collection("goal_library").findOne({
                    _id: goal.goalId,
                    "metadata.testDataset": testTag
                });

                assert(
                    goalDoc,
                    `Child ${child._id} references missing goal`
                );

                assert(
                    typeof goal.priority === "number",
                    `Child ${child._id} goal priority must be numeric`
                );
            }
        }

        const goalDocs = await db.collection("goal_library")
            .find({ "metadata.testDataset": testTag })
            .toArray();

        for (const goal of goalDocs) {

            for (const relatedOutcome of goal.relatedOutcomes) {

                const outcome = await db.collection("learning_outcomes")
                    .findOne({
                        _id: relatedOutcome.outcomeId,
                        "metadata.testDataset": testTag
                    });

                assert(
                    outcome,
                    `Goal ${goal._id} references missing outcome`
                );

                assert(
                    typeof relatedOutcome.weight === "number",
                    `Goal ${goal._id} outcome weight must be numeric`
                );
            }
        }

        const activityDocs = await db.collection("activities")
            .find({ "metadata.testDataset": testTag })
            .toArray();

        for (const activity of activityDocs) {

            const subcategory = await db.collection("subcategories")
                .findOne({
                    _id: activity.classification.subcategoryId,
                    "metadata.testDataset": testTag
                });

            assert(
                subcategory,
                `Activity ${activity._id} references missing subcategory`
            );

            const category = await db.collection("categories").findOne({
                _id: activity.classification.categoryId,
                "metadata.testDataset": testTag
            });

            const vendor = await db.collection("vendors").findOne({
                _id: activity.vendorId,
                "metadata.testDataset": testTag
            });

            assert(category, `Activity ${activity._id} references missing category`);
            assert(vendor, `Activity ${activity._id} references missing vendor`);
            assert(
                activity.classification.categoryId.equals(subcategory.categoryId),
                `Activity ${activity._id} category does not match its subcategory category`
            );

            for (const outcome of activity.learningOutcomes) {

                const outcomeDoc = await db.collection("learning_outcomes")
                    .findOne({
                        _id: outcome.outcomeId,
                        "metadata.testDataset": testTag
                    });

                assert(
                    outcomeDoc,
                    `Activity ${activity._id} references missing outcome`
                );
            }
        }

        const categoryDocs = await db.collection("categories")
            .find({ "metadata.testDataset": testTag })
            .toArray();

        for (const subcategory of await db.collection("subcategories")
            .find({ "metadata.testDataset": testTag })
            .toArray()) {
            assert(
                categoryDocs.some((category) => category._id.equals(subcategory.categoryId)),
                `Subcategory ${subcategory._id} references missing category`
            );
        }

        const cityDocs = await db.collection("cities")
            .find({ "metadata.testDataset": testTag })
            .toArray();

        for (const parent of await db.collection("parents")
            .find({ "metadata.testDataset": testTag })
            .toArray()) {
            assert(cityDocs.some((city) => city._id.equals(parent.location.cityId)), `Parent ${parent._id} references missing city`);
        }

        for (const vendor of await db.collection("vendors")
            .find({ "metadata.testDataset": testTag })
            .toArray()) {
            assert(cityDocs.some((city) => city._id.equals(vendor.location.cityId)), `Vendor ${vendor._id} references missing city`);
        }

        const interestDocs = await db.collection("child_interests")
            .find({ "metadata.testDataset": testTag })
            .toArray();

        for (const interest of interestDocs) {

            const child = await db.collection("children").findOne({
                _id: interest.childId,
                "metadata.testDataset": testTag
            });

            const subcategory = await db.collection("subcategories").findOne({
                _id: interest.subcategoryId,
                "metadata.testDataset": testTag
            });

            assert(
                child,
                `Interest ${interest._id} references missing child`
            );

            assert(
                subcategory,
                `Interest ${interest._id} references missing subcategory`
            );
        }

        // --------------------------------------------------
        // EXACT SEMANTIC TEST DATA ASSERTIONS
        // --------------------------------------------------

        const sara = await db.collection("children").findOne({
            _id: saraId
        });

        const omar = await db.collection("children").findOne({
            _id: omarId
        });

        const lina = await db.collection("children").findOne({
            _id: linaId
        });

        assert(
            sara.parentGoals.length === 2,
            "Sara should have 2 goals"
        );

        assert(
            omar.parentGoals.length === 1,
            "Omar should have 1 goal"
        );

        assert(
            lina.parentGoals.length === 1,
            "Lina should have 1 goal"
        );

        const saraInterests = await db.collection("child_interests")
            .countDocuments({
                childId: saraId,
                "metadata.testDataset": testTag
            });

        const omarInterests = await db.collection("child_interests")
            .countDocuments({
                childId: omarId,
                "metadata.testDataset": testTag
            });

        const linaInterests = await db.collection("child_interests")
            .countDocuments({
                childId: linaId,
                "metadata.testDataset": testTag
            });

        assert(
            saraInterests === 2,
            "Sara should have 2 learned interests"
        );

        assert(
            omarInterests === 1,
            "Omar should have 1 learned interest"
        );

        assert(
            linaInterests === 0,
            "Lina should have no learned interests"
        );

        console.log("========================================");
        console.log("✅ PHASE A PASSED");
        console.log("========================================");
        console.log("Parents:            2");
        console.log("Children:           3");
        console.log("Categories:         4");
        console.log("Subcategories:      4");
        console.log("Learning Outcomes:  3");
        console.log("Goals:              3");
        console.log("Activities:         5");
        console.log("Vendors:            2");
        console.log("Cities:             1");
        console.log("Child Interests:    3");
        console.log("----------------------------------------");
        console.log("Parent-child refs VALID");
        console.log("Goal refs VALID");
        console.log("Outcome refs VALID");
        console.log("Subcategory refs VALID");
        console.log("Category refs VALID");
        console.log("Vendor refs VALID");
        console.log("City refs VALID");
        console.log("Activity category/subcategory consistency VALID");
        console.log("Child interest refs VALID");
        console.log("Neo4j NOT TOUCHED");
        console.log("========================================");

    } catch (error) {

        console.error("\n❌ PHASE A FAILED");
        console.error(error);

        process.exitCode = 1;

    } finally {
        await client.close();
    }
}

main();
