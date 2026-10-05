// Intentos fallidos de la clave de firma, por admin.
// Vive en Mongo para que el bloqueo sobreviva a los reinicios de Render.
const mongoose = require("mongoose");

const AdminSignGuardSchema = new mongoose.Schema({
    adminUid: { type: String, required: true, unique: true },
    failedCount: { type: Number, default: 0 },
    lastFailedAt: Date,
    lockedUntil: { type: Date, default: null },
}, { timestamps: true });

module.exports = mongoose.model("AdminSignGuard", AdminSignGuardSchema);