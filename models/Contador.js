// models/Contador.js — Quinta de Argos
// Contadores atómicos. Se usa para la numeración correlativa de facturas,
// que exige el Reglamento de facturación (RD 1619/2012): una serie por año,
// sin saltos ni duplicados.

const mongoose = require("mongoose");

const contadorSchema = new mongoose.Schema(
    {
        _id: { type: String, required: true }, // ej. "factura-QA-2026"
        valor: { type: Number, default: 0 },
    },
    { versionKey: false }
);

contadorSchema.statics.siguiente = async function (clave) {
    const doc = await this.findOneAndUpdate(
        { _id: clave },
        { $inc: { valor: 1 } },
        { new: true, upsert: true }
    );
    return doc.valor;
};

module.exports = mongoose.models.Contador || mongoose.model("Contador", contadorSchema);