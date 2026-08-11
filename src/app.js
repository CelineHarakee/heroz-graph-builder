require("dotenv").config();

const { connectMongoDB } = require("./config/mongodb");
const driver = require("./config/neo4j");

const { processQueue } = require("./workers/queueWorker");

async function start() {

    try {

        await connectMongoDB();

        await driver.verifyConnectivity();

        console.log("✅ Connected to Neo4j");

        console.log("🚀 Heroz Graph Builder Started");

        await processQueue();

    }

    catch (error) {

        console.error(error);

    }

}

start();