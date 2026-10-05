// Registro de cada intento de cambio firmado: quién, qué, cuándo y cómo terminó.
// Nunca guarda la clave de firma.
const mongoose = require("mongoose");

const ConfigAuditSchema = new mongoose.Schema({
    adminUid: { type: String, index: true },
    adminEmail: String,
    section: { type: String, index: true },   // calendario | reglas | propiedad
    result: {                                  // cómo terminó el intento
        type: String,
        enum: ["ok", "bad_pin", "locked", "rejected", "error"],
        index: true,
    },
    summary: mongoose.Schema.Types.Mixed,      // cambios aplicados o motivo del rechazo
    ip: String,
    userAgent: String,
}, { timestamps: true });

// Se borran solos al año
ConfigAuditSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 365 });

module.exports = mongoose.model("ConfigAudit", ConfigAuditSchema);