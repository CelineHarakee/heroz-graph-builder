require("dotenv").config();

const { connectMongoDB, getDatabase } = require("../../config/mongodb");
const driver = require("../../config/neo4j");
const { toGraphId } = require("../../utils/idUtils");

const DATASET = "SYSTEM_TEST_V1";

function asNumber(value) {
    if (
        value !== null &&
        value !== undefined &&
        typeof value.toNumber === "function"
    ) {
        return value.toNumber();
    }

    return value;
}

function asPlainValue(value) {
    if (value === undefined) {
        return null;
    }

    const numericValue = asNumber(value);

    if (
        numericValue !== null &&
        numericValue !== undefined &&
        numericValue !== value
    ) {
        return numericValue;
    }

    return value;
}

function assertEqual(label, actual, expected) {
    if (actual !== expected) {
        throw new Error(
            `${label}: expected ${expected}, found ${actual}`
        );
    }
}

function assertExactProperties(label, actualProperties, expectedProperties) {
    for (const [property, expected] of Object.entries(expectedProperties)) {
        const actual = asPlainValue(actualProperties[property]);

        if (actual !== expected) {
            throw new Error(
                `${label}.${property}: expected ${expected}, found ${actual}`
            );
        }
    }
}

function assertExactKeySet(label, actualKeys, expectedKeys) {
    const actual = new Set(actualKeys);
    const expected = new Set(expectedKeys);

    for (const key of expected) {
        if (!actual.has(key)) {
            throw new Error(`${label}: missing ${key}`);
        }
    }

    for (const key of actual) {
        if (!expected.has(key)) {
            throw new Error(`${label}: unexpected ${key}`);
        }
    }
}

function normalizeDate(value) {
    if (!value) {
        return null;
    }

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
        return null;
    }

    return date.toISOString();
}

function relationshipKey(...parts) {
    return parts.join(" -> ");
}

async function loadDatasetCollection(db, collectionName, expectedCount) {
    const documents = await db.collection(collectionName)
        .find({ "metadata.testDataset": DATASET })
        .toArray();

    if (documents.length !== expectedCount) {
        throw new Error(
            `Expected ${expectedCount} ${collectionName} documents, ` +
            `found ${documents.length}`
        );
    }

    return documents;
}

async function verifyNodeSet(session, config) {
    const result = await session.run(
        `
        MATCH (n:${config.label})
        WHERE n.${config.idProperty} IN $ids
        RETURN
            n.${config.idProperty} AS id,
            count(n) AS count,
            collect(properties(n)) AS propertySets
        ORDER BY id
        `,
        { ids: config.ids }
    );

    const actualIds = result.records.map((record) => record.get("id"));

    assertExactKeySet(`${config.label} nodes`, actualIds, config.ids);

    for (const record of result.records) {
        const id = record.get("id");
        const count = asNumber(record.get("count"));
        const propertySets = record.get("propertySets");

        if (count !== 1) {
            throw new Error(
                `${config.label} ${id}: expected exactly one node, ` +
                `found ${count}`
            );
        }

        assertExactProperties(
            `${config.label} ${id}`,
            propertySets[0],
            config.expectedPropertiesById.get(id)
        );
    }

    console.log(
        `${config.label.padEnd(18)} ${actualIds.length} / ${config.ids.length}`
    );

    return actualIds.length;
}

async function verifyRelationships(session, config) {
    const result = await session.run(config.query, config.params);
    const actualByKey = new Map();

    for (const record of result.records) {
        const key = config.keyFromRecord(record);
        const count = asNumber(record.get("count"));

        actualByKey.set(key, {
            count,
            propertySets: record.get("propertySets")
        });
    }

    assertExactKeySet(
        `${config.type} relationships`,
        Array.from(actualByKey.keys()),
        Array.from(config.expectedByKey.keys())
    );

    for (const [key, expectedProperties] of config.expectedByKey) {
        const actual = actualByKey.get(key);

        if (!actual) {
            throw new Error(`${config.type}: missing ${key}`);
        }

        if (actual.count !== 1) {
            throw new Error(
                `${config.type} ${key}: expected exactly one relationship, ` +
                `found ${actual.count}`
            );
        }

        assertExactProperties(
            `${config.type} ${key}`,
            actual.propertySets[0],
            expectedProperties
        );
    }

    console.log(
        `${config.type.padEnd(24)} ${actualByKey.size} / ` +
        `${config.expectedByKey.size}`
    );

    return actualByKey.size;
}

function expectedPropertiesById(documents, idProperty, propertyGetter) {
    return new Map(
        documents.map((document) => [
            toGraphId(document._id),
            {
                [idProperty]: toGraphId(document._id),
                ...propertyGetter(document)
            }
        ])
    );
}

function buildExpectedRelationships(items, keyGetter, propertyGetter) {
    return new Map(
        items.map((item) => [
            keyGetter(item),
            propertyGetter(item)
        ])
    );
}

async function main() {
    await connectMongoDB();

    const db = getDatabase();
    const session = driver.session();

    try {
        console.log("🚀 Starting Step 9 — Phase C");
        console.log("🔍 Inspecting Neo4j graph");

        // ==================================================
        // 1. Load exact SYSTEM_TEST_V1 Mongo documents
        // ==================================================

        const parents = await loadDatasetCollection(db, "parents", 2);
        const children = await loadDatasetCollection(db, "children", 3);
        const subcategories =
            await loadDatasetCollection(db, "subcategories", 4);
        const outcomes =
            await loadDatasetCollection(db, "learning_outcomes", 3);
        const goals = await loadDatasetCollection(db, "goal_library", 3);
        const activities = await loadDatasetCollection(db, "activities", 5);
        const childInterests =
            await loadDatasetCollection(db, "child_interests", 3);

        const parentIds = parents.map((document) => toGraphId(document._id));
        const childIds = children.map((document) => toGraphId(document._id));
        const subcategoryIds =
            subcategories.map((document) => toGraphId(document._id));
        const outcomeIds = outcomes.map((document) => toGraphId(document._id));
        const goalIds = goals.map((document) => toGraphId(document._id));
        const activityIds =
            activities.map((document) => toGraphId(document._id));

        const nodeConfigs = [
            {
                label: "Parent",
                idProperty: "parentId",
                ids: parentIds,
                expectedPropertiesById: expectedPropertiesById(
                    parents,
                    "parentId",
                    (parent) => ({
                        firstName: parent.account?.firstName ?? null,
                        lastName: parent.account?.lastName ?? null,
                        status: parent.account?.status ?? null
                    })
                )
            },
            {
                label: "Child",
                idProperty: "childId",
                ids: childIds,
                expectedPropertiesById: expectedPropertiesById(
                    children,
                    "childId",
                    (child) => ({
                        firstName: child.identity?.firstName ?? null,
                        gender: child.identity?.gender ?? null,
                        ageGroup: child.identity?.ageGroup ?? null,
                        status: child.status ?? null
                    })
                )
            },
            {
                label: "Subcategory",
                idProperty: "subcategoryId",
                ids: subcategoryIds,
                expectedPropertiesById: expectedPropertiesById(
                    subcategories,
                    "subcategoryId",
                    (subcategory) => ({
                        name: subcategory.name ?? null,
                        categoryId: toGraphId(subcategory.categoryId),
                        description: subcategory.description ?? null,
                        isActive: subcategory.isActive ?? null
                    })
                )
            },
            {
                label: "LearningOutcome",
                idProperty: "outcomeId",
                ids: outcomeIds,
                expectedPropertiesById: expectedPropertiesById(
                    outcomes,
                    "outcomeId",
                    (outcome) => ({
                        name: outcome.name ?? null,
                        description: outcome.description ?? null,
                        outcomeType: outcome.outcomeType ?? null,
                        isActive: outcome.isActive ?? null
                    })
                )
            },
            {
                label: "Goal",
                idProperty: "goalId",
                ids: goalIds,
                expectedPropertiesById: expectedPropertiesById(
                    goals,
                    "goalId",
                    (goal) => ({
                        name: goal.name ?? null,
                        description: goal.description ?? null,
                        isActive: goal.isActive ?? null
                    })
                )
            },
            {
                label: "Activity",
                idProperty: "activityId",
                ids: activityIds,
                expectedPropertiesById: expectedPropertiesById(
                    activities,
                    "activityId",
                    (activity) => ({
                        title:
                            activity.basicInformation?.nameEn ??
                            activity.basicInformation?.nameAr ??
                            null,
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
                    })
                )
            }
        ];

        console.log("\n========================================");
        console.log("PHASE C1 — SCOPED NODE INSPECTION");
        console.log("========================================");

        let controlledNodeTotal = 0;

        for (const config of nodeConfigs) {
            controlledNodeTotal += await verifyNodeSet(session, config);
        }

        assertEqual(
            "Controlled Neo4j node total",
            controlledNodeTotal,
            20
        );

        console.log("\n✅ Scoped node validation PASSED");

        // ==================================================
        // 2. Build expected relationships from Mongo
        // ==================================================

        const expectedHasChild = buildExpectedRelationships(
            children,
            (child) => relationshipKey(
                toGraphId(child.parentId),
                toGraphId(child._id)
            ),
            () => ({})
        );

        const expectedHasGoal = buildExpectedRelationships(
            children.flatMap((child) => (
                Array.isArray(child.parentGoals)
                    ? child.parentGoals.map((parentGoal) => ({
                        child,
                        parentGoal
                    }))
                    : []
            )),
            ({ child, parentGoal }) => relationshipKey(
                toGraphId(child._id),
                toGraphId(parentGoal.goalId)
            ),
            ({ parentGoal }) => ({
                priority: parentGoal.priority ?? null,
                status: parentGoal.status ?? null
            })
        );

        const expectedLikes = buildExpectedRelationships(
            childInterests,
            (interest) => relationshipKey(
                toGraphId(interest.childId),
                toGraphId(interest.subcategoryId)
            ),
            (interest) => ({
                score: interest.interestScore?.currentScore ?? null,
                confidence: interest.confidence?.currentScore ?? null,
                evidenceCount:
                    interest.confidence?.evidenceCount ?? null,
                lastUpdated:
                    normalizeDate(interest.metadata?.updatedAt ?? null)
            })
        );

        const expectedRelatesToOutcome = buildExpectedRelationships(
            goals.flatMap((goal) => (
                Array.isArray(goal.relatedOutcomes)
                    ? goal.relatedOutcomes.map((relatedOutcome) => ({
                        goal,
                        relatedOutcome
                    }))
                    : []
            )),
            ({ goal, relatedOutcome }) => relationshipKey(
                toGraphId(goal._id),
                toGraphId(relatedOutcome.outcomeId)
            ),
            ({ relatedOutcome }) => ({
                weight: relatedOutcome.weight ?? null
            })
        );

        const expectedSupportsOutcome = buildExpectedRelationships(
            activities.flatMap((activity) => (
                Array.isArray(activity.learningOutcomes)
                    ? activity.learningOutcomes.map((learningOutcome) => ({
                        activity,
                        learningOutcome
                    }))
                    : []
            )),
            ({ activity, learningOutcome }) => relationshipKey(
                toGraphId(activity._id),
                toGraphId(learningOutcome.outcomeId)
            ),
            ({ learningOutcome }) => ({
                weight: learningOutcome.weight ?? null
            })
        );

        const expectedClassifiedAs = buildExpectedRelationships(
            activities,
            (activity) => relationshipKey(
                toGraphId(activity._id),
                toGraphId(activity.classification?.subcategoryId)
            ),
            () => ({})
        );

        assertEqual("Expected HAS_CHILD count", expectedHasChild.size, 3);
        assertEqual("Expected HAS_GOAL count", expectedHasGoal.size, 4);
        assertEqual("Expected LIKES count", expectedLikes.size, 3);
        assertEqual(
            "Expected RELATES_TO_OUTCOME count",
            expectedRelatesToOutcome.size,
            3
        );
        assertEqual(
            "Expected SUPPORTS_OUTCOME count",
            expectedSupportsOutcome.size,
            8
        );
        assertEqual(
            "Expected CLASSIFIED_AS count",
            expectedClassifiedAs.size,
            5
        );

        const relationshipConfigs = [
            {
                type: "HAS_CHILD",
                expectedByKey: expectedHasChild,
                query: `
                    MATCH (p:Parent)-[r:HAS_CHILD]->(c:Child)
                    WHERE p.parentId IN $parentIds
                    AND c.childId IN $childIds
                    RETURN
                        p.parentId AS fromId,
                        c.childId AS toId,
                        count(r) AS count,
                        collect(properties(r)) AS propertySets
                    ORDER BY fromId, toId
                `,
                params: { parentIds, childIds },
                keyFromRecord: (record) => relationshipKey(
                    record.get("fromId"),
                    record.get("toId")
                )
            },
            {
                type: "HAS_GOAL",
                expectedByKey: expectedHasGoal,
                query: `
                    MATCH (c:Child)-[r:HAS_GOAL]->(g:Goal)
                    WHERE c.childId IN $childIds
                    AND g.goalId IN $goalIds
                    RETURN
                        c.childId AS fromId,
                        g.goalId AS toId,
                        count(r) AS count,
                        collect(properties(r)) AS propertySets
                    ORDER BY fromId, toId
                `,
                params: { childIds, goalIds },
                keyFromRecord: (record) => relationshipKey(
                    record.get("fromId"),
                    record.get("toId")
                )
            },
            {
                type: "LIKES",
                expectedByKey: expectedLikes,
                query: `
                    MATCH (c:Child)-[r:LIKES]->(s:Subcategory)
                    WHERE c.childId IN $childIds
                    AND s.subcategoryId IN $subcategoryIds
                    RETURN
                        c.childId AS fromId,
                        s.subcategoryId AS toId,
                        count(r) AS count,
                        collect(properties(r)) AS propertySets
                    ORDER BY fromId, toId
                `,
                params: { childIds, subcategoryIds },
                keyFromRecord: (record) => relationshipKey(
                    record.get("fromId"),
                    record.get("toId")
                )
            },
            {
                type: "RELATES_TO_OUTCOME",
                expectedByKey: expectedRelatesToOutcome,
                query: `
                    MATCH (g:Goal)-[r:RELATES_TO_OUTCOME]->
                        (o:LearningOutcome)
                    WHERE g.goalId IN $goalIds
                    AND o.outcomeId IN $outcomeIds
                    RETURN
                        g.goalId AS fromId,
                        o.outcomeId AS toId,
                        count(r) AS count,
                        collect(properties(r)) AS propertySets
                    ORDER BY fromId, toId
                `,
                params: { goalIds, outcomeIds },
                keyFromRecord: (record) => relationshipKey(
                    record.get("fromId"),
                    record.get("toId")
                )
            },
            {
                type: "SUPPORTS_OUTCOME",
                expectedByKey: expectedSupportsOutcome,
                query: `
                    MATCH (a:Activity)-[r:SUPPORTS_OUTCOME]->
                        (o:LearningOutcome)
                    WHERE a.activityId IN $activityIds
                    AND o.outcomeId IN $outcomeIds
                    RETURN
                        a.activityId AS fromId,
                        o.outcomeId AS toId,
                        count(r) AS count,
                        collect(properties(r)) AS propertySets
                    ORDER BY fromId, toId
                `,
                params: { activityIds, outcomeIds },
                keyFromRecord: (record) => relationshipKey(
                    record.get("fromId"),
                    record.get("toId")
                )
            },
            {
                type: "CLASSIFIED_AS",
                expectedByKey: expectedClassifiedAs,
                query: `
                    MATCH (a:Activity)-[r:CLASSIFIED_AS]->(s:Subcategory)
                    WHERE a.activityId IN $activityIds
                    AND s.subcategoryId IN $subcategoryIds
                    RETURN
                        a.activityId AS fromId,
                        s.subcategoryId AS toId,
                        count(r) AS count,
                        collect(properties(r)) AS propertySets
                    ORDER BY fromId, toId
                `,
                params: { activityIds, subcategoryIds },
                keyFromRecord: (record) => relationshipKey(
                    record.get("fromId"),
                    record.get("toId")
                )
            }
        ];

        console.log("\n========================================");
        console.log("PHASE C2 — SCOPED RELATIONSHIP INSPECTION");
        console.log("========================================");

        let controlledRelationshipTotal = 0;

        for (const config of relationshipConfigs) {
            controlledRelationshipTotal +=
                await verifyRelationships(session, config);
        }

        assertEqual(
            "Controlled Neo4j relationship total",
            controlledRelationshipTotal,
            26
        );

        // ==================================================
        // SUCCESS
        // ==================================================

        console.log("\n========================================");
        console.log("✅ PHASE C PASSED");
        console.log("========================================");
        console.log("Controlled nodes:         20");
        console.log("Controlled relationships: 26");
        console.log("Mongo dataset counts:     VALID");
        console.log("Node IDs:                 VALID");
        console.log("Node properties:          VALID");
        console.log("Relationship endpoints:   VALID");
        console.log("Relationship properties:  VALID");
        console.log("Relationship duplicates:  VALID");
        console.log("Neo4j graph inspection:   PASSED");
        console.log("========================================");

    } finally {
        await session.close();
        await driver.close();
    }
}

main()
    .then(() => {
        process.exit(0);
    })
    .catch(error => {
        console.error("\n❌ PHASE C FAILED");
        console.error(error);
        process.exit(1);
    });
