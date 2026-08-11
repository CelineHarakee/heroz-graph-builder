const { MongoClient } = require("mongodb");
require("dotenv").config();

const client = new MongoClient(process.env.MONGO_URI);

let db;

async function connectMongoDB() {
    try {
        await client.connect();

        db = client.db("heroz");

        console.log("✅ Connected to MongoDB");

    } catch (error) {

        console.error("❌ MongoDB Connection Failed");
        console.error(error);

        process.exit(1);

    }
}

function getDatabase() {
    return db;
}

module.exports = {
    connectMongoDB,
    getDatabase
};