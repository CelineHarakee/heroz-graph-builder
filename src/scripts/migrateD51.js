require("dotenv").config();

const { MongoClient } = require("mongodb");

const client = new MongoClient(process.env.MONGO_URI);

const NOW = new Date();

function preference(value, confidenceScore = 0.65) {
    return {
        value: value ?? null,
        confidenceScore,
        source: "Onboarding",
        updatedAt: NOW
    };
}

function ageGroup(age) {
    if (age <= 6) return "4-6";
    if (age <= 9) return "7-9";
    if (age <= 12) return "10-12";
    return "13-18";
}

function convertChild(child) {

    const oldPreferences = child.preferences || {};

    return {
        _id: child._id,
        parentId: child.parentId,

        identity: {
            firstName: child.firstName,
            dateOfBirth: child.dateOfBirth,
            gender: child.gender,
            ageGroup: ageGroup(child.age)
        },

        preferences: {
            environment: preference(
                oldPreferences.indoorOutdoor
            ),

            socialStyle: preference(
                oldPreferences.activityStyle
            ),

            difficulty: preference(
                oldPreferences.difficultyPreference
            ),

            experienceStyle: preference(
                "Structured"
            ),

            commitmentPreference: preference(
                oldPreferences.experiencePreference === "Weekly Program"
                    ? "Weekly"
                    : oldPreferences.experiencePreference
            )
        },

        parentGoals: (child.parentGoals || []).map(goal => ({
            goalId: goal.goalId,

            priority:
                goal.priority === "High"
                    ? 1
                    : goal.priority === "Medium"
                        ? 2
                        : 3,

            status: "Active",
            selectedBy: "Parent",
            selectedAt: NOW,
            targetDate: null
        })),

        developmentProfile:
            (child.developmentProfile || []).map(profile => ({
                outcomeId: profile.outcomeId,
                score: profile.score,
                confidenceScore: profile.confidence,
                evidenceCount: 1,
                trend: "Improving",
                lastEvidenceAt: NOW,
                lastUpdated: NOW,
                history: []
            })),

        profileState: {
            completenessScore: 0.80,
            overallConfidenceScore: 0.75,
            maturityStage: "Learning",
            lastInteractionAt: null,
            lastUpdated: NOW
        },

        status: child.isActive
            ? "Active"
            : "Inactive",

        metadata: {
            version: 1,
            createdBy:
                child.metadata?.createdBy || "System",
            createdAt: NOW,
            updatedAt: NOW,
            lastSyncedToGraph: null
        }
    };
}

function convertParent(parent) {

    return {
        _id: parent._id,

        identity: {
            firstName: parent.firstName,
            lastName: parent.lastName,
            email: parent.email,
            phone: parent.phone
        },

        selectedGoals:
            parent.selectedGoals || [],

        status: parent.isActive
            ? "Active"
            : "Inactive",

        metadata: {
            version: 1,
            createdBy:
                parent.metadata?.createdBy || "System",
            createdAt: NOW,
            updatedAt: NOW
        }
    };
}

function convertActivity(activity) {

    const oldPreferences =
        activity.preferences || {};

    return {
        _id: activity._id,

        vendorId: activity.vendorId,

        basicInformation: {
            nameAr: activity.title,
            nameEn: activity.title,
            status: activity.isActive
                ? "Published"
                : "Inactive",
            tags: []
        },

        classification: {
            categoryId: activity.categoryId,
            subcategoryId: activity.subcategoryId
        },

        eligibility: {
            minimumAge: activity.minimumAge,
            maximumAge: activity.maximumAge,
            allowedGenders: [
                "Male",
                "Female"
            ],
            requiredExperienceLevel:
                oldPreferences.difficulty || null,
            additionalRequirements: []
        },

        experience: {
            environment:
                oldPreferences.indoorOutdoor || null,

            socialStyle:
                oldPreferences.activityStyle || null,

            difficulty:
                oldPreferences.difficulty || null,

            experienceStyles:
                oldPreferences.experienceType
                    ? ["Structured"]
                    : [],

            commitmentType:
                oldPreferences.experienceType ===
                "Weekly Program"
                    ? "Weekly"
                    : oldPreferences.experienceType || null,

            intensityLevel: "Low",

            durationMinutes: 90
        },

        learningOutcomes:
            (activity.supportedGoals || []).map(
                goalId => ({
                    outcomeId:
                        goalId.replace("goal_", ""),
                    weight: 1,
                    evidenceGuidance: []
                })
            ),

        activityConstraints: {
            equipmentProvided: true,
            requiredItems: [],
            accessibilityFeatures: [],
            safetyRequirements: [],
            medicalRestrictions: []
        },

        metadata: {
            version: 1,
            createdBy:
                activity.metadata?.createdBy || "System",
            createdAt: NOW,
            updatedAt: NOW,
            lastSyncedToGraph: null
        }
    };
}

function convertVendor(vendor) {

    return {
        _id: vendor._id,

        profile: {
            name: vendor.name
        },

        location: {
            cityId: null,
            districtId: null,
            address: null
        },

        verification: {
            status: "Unverified",
            verifiedAt: null
        },

        performance: {
            reliabilityScore: null
        },

        status: vendor.isActive
            ? "Active"
            : "Inactive",

        metadata: {
            version: 1,
            createdBy:
                vendor.metadata?.createdBy || "System",
            createdAt: NOW,
            updatedAt: NOW
        }
    };
}

function buildChildInterests(children) {

    const interests = [];

    for (const child of children) {

        const oldInterests =
            child.interestSubcategories || [];

        for (const subcategoryId of oldInterests) {

            interests.push({
                _id:
                    `interest_${child._id}_${subcategoryId}`,

                childId: child._id,

                subcategoryId,

                interestScore: {
                    currentScore: 0.75,
                    previousScore: 0.70,
                    lastCalculatedAt: NOW,
                    lastDecayAt: NOW
                },

                confidence: {
                    currentScore: 0.70,
                    evidenceCount: 1,
                    lastCalculatedAt: NOW
                },

                evidenceSummary: {
                    interactionBreakdown: []
                },

                scoreHistory: [],

                metadata: {
                    version: 1,
                    createdBy: "Migration",
                    createdAt: NOW,
                    updatedAt: NOW,
                    lastSyncedToGraph: null
                }
            });
        }
    }

    return interests;
}

async function main() {

    try {

        await client.connect();

        const db = client.db("heroz");

        console.log("🚀 Starting D5.1 migration");

        // --------------------------------------------------
        // 1. READ OLD DATA FIRST
        // --------------------------------------------------

        const oldChildren =
            await db.collection("children")
                .find({})
                .toArray();

        const oldParents =
            await db.collection("parents")
                .find({})
                .toArray();

        const oldActivities =
            await db.collection("activities")
                .find({})
                .toArray();

        const oldVendors =
            await db.collection("vendors")
                .find({})
                .toArray();

        console.log(
            `Children: ${oldChildren.length}`
        );

        console.log(
            `Parents: ${oldParents.length}`
        );

        console.log(
            `Activities: ${oldActivities.length}`
        );

        console.log(
            `Vendors: ${oldVendors.length}`
        );

        // --------------------------------------------------
        // 2. BUILD NEW DATA IN MEMORY
        // --------------------------------------------------

        const newChildren =
            oldChildren.map(convertChild);

        const newParents =
            oldParents.map(convertParent);

        const newActivities =
            oldActivities.map(convertActivity);

        const newVendors =
            oldVendors.map(convertVendor);

        const newChildInterests =
            buildChildInterests(oldChildren);

        console.log(
            `Child interests: ${newChildInterests.length}`
        );

        // --------------------------------------------------
        // 3. REPLACE CHILDREN
        // --------------------------------------------------

        for (const child of newChildren) {

            await db.collection("children")
                .replaceOne(
                    { _id: child._id },
                    child
                );

            console.log(
                `✅ Migrated child: ${child._id}`
            );
        }

        // --------------------------------------------------
        // 4. REPLACE PARENTS
        // --------------------------------------------------

        for (const parent of newParents) {

            await db.collection("parents")
                .replaceOne(
                    { _id: parent._id },
                    parent
                );

            console.log(
                `✅ Migrated parent: ${parent._id}`
            );
        }

        // --------------------------------------------------
        // 5. REPLACE ACTIVITIES
        // --------------------------------------------------

        for (const activity of newActivities) {

            await db.collection("activities")
                .replaceOne(
                    { _id: activity._id },
                    activity
                );

            console.log(
                `✅ Migrated activity: ${activity._id}`
            );
        }

        // --------------------------------------------------
        // 6. REPLACE VENDORS
        // --------------------------------------------------

        for (const vendor of newVendors) {

            await db.collection("vendors")
                .replaceOne(
                    { _id: vendor._id },
                    vendor
                );

            console.log(
                `✅ Migrated vendor: ${vendor._id}`
            );
        }

        // --------------------------------------------------
        // 7. CREATE CHILD INTERESTS
        // --------------------------------------------------

        await db.collection("child_interests")
            .deleteMany({});

        if (newChildInterests.length > 0) {

            await db.collection("child_interests")
                .insertMany(newChildInterests);
        }

        console.log(
            `✅ Created ${newChildInterests.length} child interests`
        );

        console.log("\n🎉 D5.1 migration completed");

    } catch (error) {

        console.error(
            "\n❌ D5.1 migration failed:"
        );

        console.error(error);

        process.exitCode = 1;

    } finally {

        await client.close();
    }
}

main();