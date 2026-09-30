require("dotenv").config()
const mongoose = require("mongoose")
const { startBeds24Reconcile } = require("../jobs/beds24Reconcile")

const esProduccion = (process.env.NODE_ENV === 'production');

const dbConnection = async () => {
    try{
        await mongoose.connect(process.env.MONGO_URI)
        console.log(`DB connected successfully! 🟢`);
        startBeds24Reconcile();
        
    } catch (error) {
        console.error(esProduccion ? `Error connecting DB! 🔴`: `Error connecting DB! 🔴 ${error}`);
        throw new Error(`Error connecting DB! 🔴`);
    }
}

module.exports = dbConnection