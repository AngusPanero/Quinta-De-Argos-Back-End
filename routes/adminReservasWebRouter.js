const express = require("express");
const mongoose = require("mongoose");
const adminMiddleware = require("../middleware/adminMiddleware");
const Reserva = require("../models/Reserva");
const { asignarNumeroFactura, construirDatosFactura } = require("../services/facturaService");
const { enviarEmailFactura, enviarEmailMensaje } = require("../services/emailReservaService");

const adminReservasWebRouter = express.Router();

// Límite de seguridad: una casa rural no debería acercarse nunca a esta cifra.
const MAX_RESERVAS_LISTADO = 5000;

// Evita dobles clics: una sola operación a la vez por reserva.
const enCurso = new Set();

function quienEs(req) {
    return req.user?.email || req.admin?.email || req.firebaseUser?.email || "admin";
}

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

function sinBloqueo(handler) {
    return async (req, res) => {
        const id = req.params.id;
        if (enCurso.has(id)) {
            return res.status(409).json({ mensaje: "Ya se está procesando esta reserva. Espera unos segundos." });
        }
        enCurso.add(id);
        try {
            await handler(req, res);
        } finally {
            enCurso.delete(id);
        }
    };
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

// ---------- Factura ----------
adminReservasWebRouter.post(
    "/api/admin/reservas-web/:id/factura",
    adminMiddleware,
    sinBloqueo(async (req, res) => {
        try {
            const reserva = await cargarReserva(req, res);
            if (!reserva) return;

            if (reserva.estado !== "pagada") {
                return res.status(409).json({ mensaje: "Solo se puede facturar una reserva pagada." });
            }

            // El número se asigna una sola vez; si ya existe, se reenvía la misma factura.
            await asignarNumeroFactura(reserva);
            await reserva.save();

            const factura = construirDatosFactura(reserva);

            let envio;
            try {
                envio = await enviarEmailFactura(factura);
            } catch (error) {
                envio = { enviado: false, error: error?.message || "Error desconocido" };
            }

            reserva.comunicaciones.push({
                tipo: "factura",
                destinatario: factura.destinatario.email,
                asunto: `Factura ${factura.numero}`,
                estado: envio.enviado ? "enviado" : envio.error ? "error" : "pendiente_envio",
                error: envio.error || "",
                creadoPor: quienEs(req),
            });
            if (envio.enviado) reserva.factura.ultimoEnvio = new Date();
            await reserva.save();

            res.json({ reserva: reserva.toObject({ versionKey: false }), factura, envio });
        } catch (error) {
            console.error("Error preparando la factura 🔴", error);
            res.status(500).json({ mensaje: "No se ha podido preparar la factura." });
        }
    })
);

// ---------- Mensaje al huésped ----------
adminReservasWebRouter.post(
    "/api/admin/reservas-web/:id/mensaje",
    adminMiddleware,
    sinBloqueo(async (req, res) => {
        try {
            const asunto = typeof req.body?.asunto === "string" ? req.body.asunto.trim().slice(0, 200) : "";
            const mensaje = typeof req.body?.mensaje === "string" ? req.body.mensaje.trim().slice(0, 5000) : "";
            if (asunto.length < 2) return res.status(400).json({ mensaje: "Escribe un asunto." });
            if (mensaje.length < 2) return res.status(400).json({ mensaje: "Escribe el mensaje." });

            const reserva = await cargarReserva(req, res);
            if (!reserva) return;

            // Objeto completo que recibirá la plantilla del email.
            const datosEmail = {
                destinatario: { email: reserva.contacto.email, nombre: reserva.contacto.nombre },
                asunto,
                mensaje,
                reserva: {
                    codigo: reserva.codigo,
                    checkIn: reserva.estancia.checkIn,
                    checkOut: reserva.estancia.checkOut,
                    noches: reserva.estancia.noches,
                    huespedes: reserva.estancia.huespedes,
                },
            };

            let envio;
            try {
                envio = await enviarEmailMensaje(datosEmail);
            } catch (error) {
                envio = { enviado: false, error: error?.message || "Error desconocido" };
            }

            reserva.comunicaciones.push({
                tipo: "mensaje",
                destinatario: datosEmail.destinatario.email,
                asunto,
                mensaje,
                estado: envio.enviado ? "enviado" : envio.error ? "error" : "pendiente_envio",
                error: envio.error || "",
                creadoPor: quienEs(req),
            });
            await reserva.save();

            res.json({ reserva: reserva.toObject({ versionKey: false }), envio });
        } catch (error) {
            console.error("Error preparando el mensaje 🔴", error);
            res.status(500).json({ mensaje: "No se ha podido preparar el mensaje." });
        }
    })
);

module.exports = adminReservasWebRouter;