const express = require("express");
const mongoose = require("mongoose");
const adminMiddleware = require("../middleware/adminMiddleware");
const Reserva = require("../models/Reserva");

const adminReservasWebRouter = express.Router();

// Límite de seguridad: una casa rural no debería acercarse nunca a esta cifra.
const MAX_RESERVAS_LISTADO = 5000;

async function cargarReserva(req, res) {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
        res.status(400).json({ mensaje: "Identificador de reserva no válido." });
        return null;
    }
    const reserva = await Reserva.findById(id);
    if (!reserva) {
        res.status(404).json({ mensaje: "La reserva no existe." });
        return null;
    }
    return reserva;
}

// ---------- Listado ----------
adminReservasWebRouter.get("/api/admin/reservas-web", adminMiddleware, async (req, res) => {
    try {
        const reservas = await Reserva.find({}, { __v: 0 })
            .sort({ createdAt: -1 })
            .limit(MAX_RESERVAS_LISTADO)
            .lean();
        res.set("Cache-Control", "no-store");
        res.json({ reservas });
    } catch (error) {
        console.error("Error listando reservas web 🔴", error);
        res.status(500).json({ mensaje: "No se han podido cargar las reservas." });
    }
});

// ---------- Detalle ----------
adminReservasWebRouter.get("/api/admin/reservas-web/:id", adminMiddleware, async (req, res) => {
    try {
        const reserva = await cargarReserva(req, res);
        if (reserva) res.json({ reserva: reserva.toObject({ versionKey: false }) });
    } catch (error) {
        console.error("Error leyendo reserva web 🔴", error);
        res.status(500).json({ mensaje: "No se ha podido cargar la reserva." });
    }
});

// ---------- Factura y mensaje al huésped ----------
// Viven en contactRouter (con clave de firma y la plantilla de correo):
//   POST /api/admin/reservas-web/:id/factura-adjunta  (adminMiddleware + requireFreshAdmin + requireSignature)
//   POST /api/admin/reservas-web/:id/mensaje
// Aquí había una copia que llamaba a funciones no importadas: asignaba número de
// factura y luego fallaba siempre. Se eliminó para que no quede una ruta a medias.

module.exports = adminReservasWebRouter;