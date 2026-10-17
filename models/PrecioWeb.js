// models/PrecioWeb.js — Quinta de Argos
// Precios SOLO de la web (no van a Beds24, Booking ni Airbnb).
//
//   PrecioWeb   -> precio fijado a mano para una noche concreta
//   AjustesWeb  -> un único documento con el descuento general de la web
//
// Prioridad del precio web de una noche:
//   precio fijado a mano > reglas (data/tarifas.js) con el descuento general

const mongoose = require("mongoose");

const precioWebSchema = new mongoose.Schema(
    {
        fecha: { type: String, required: true, unique: true, match: /^\d{4}-\d{2}-\d{2}$/ },
        precio: { type: Number, required: true, min: 1 },
        actualizadoPor: { type: String, default: "" },
    },
    { timestamps: true }
);

const ajustesWebSchema = new mongoose.Schema(
    {
        _id: { type: String, default: "web" },
        // 0.05 = 5 %. null = se usa DESCUENTO_WEB de config/reservasConfig.js
        descuento: { type: Number, default: null, min: 0, max: 0.9 },
        actualizadoPor: { type: String, default: "" },
    },
    { timestamps: true }
);

const PrecioWeb = mongoose.models.PrecioWeb || mongoose.model("PrecioWeb", precioWebSchema, "preciosweb");
const AjustesWeb = mongoose.models.AjustesWeb || mongoose.model("AjustesWeb", ajustesWebSchema, "ajustesweb");

module.exports = { PrecioWeb, AjustesWeb };