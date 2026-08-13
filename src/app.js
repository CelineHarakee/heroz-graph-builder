require("dotenv").config();

const { connectMongoDB } = require("./config/mongodb");
const driver = require("./config/neo4j");

const { processQueue } = require("./workers/queueWorker");
const traversalService = require("./traversal/traversalService");

async function start() {

    try {

        await connectMongoDB();

        await driver.verifyConnectivity();

        console.log("✅ Connected to Neo4j");

        console.log("🚀 Heroz Graph Builder Started");

        await processQueue();
        
        const candidates =
            await traversalService.findCandidateActivities("child_001");

        console.log(JSON.stringify(candidates, null, 2));

    }

    catch (error) {

        console.error(error);

    }

}

start();