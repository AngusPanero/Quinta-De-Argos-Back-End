// routes/reservasRouter.js — Quinta de Argos
// Rutas PÚBLICAS de la web de reservas (sin login):
//   GET  /api/reservas/disponibilidad  -> calendario: estado y precio de cada noche
//   POST /api/reservas/presupuesto     -> precio exacto de una reserva, calculado en el servidor
//
// Se monta en index.js DESPUÉS de express.json() (usa el parser global).

const express = require("express");
const { getNochesOcupadas, Beds24Error } = require("../services/beds24AvailabilityService");
const { construirCalendario, cotizarReserva, limitesReserva, ReservaError } = require("../services/reservasService");
const {
    MIN_HORAS_ANTELACION,
    MAX_NOCHES,
    MAX_HUESPEDES,
    ADICIONALES,
} = require("../config/reservasConfig");

const reservasRouter = express.Router();

// ─── Límite por IP ────────────────────────────────────────────────────────────
// Cada pedido consulta a Beds24, que tiene un cupo de uso de su API. Sin límite,
// un script podría pedir el calendario sin parar, agotar ese cupo y dejar la web
// (y la sincronización con Booking/Airbnb) sin disponibilidad.
// Una persona usando el calendario no se acerca a 40 pedidos por minuto.
const VENTANA_MS = 60 * 1000;
const MAX_POR_VENTANA = 40;
const pedidosPorIp = new Map();

function limitePublico(req, res, next) {
    const ip = req.headers["cf-connecting-ip"] || req.ip || "desconocida";
    const ahora = Date.now();
    const registro = pedidosPorIp.get(ip);

    if (!registro || ahora - registro.inicio > VENTANA_MS) {
        pedidosPorIp.set(ip, { inicio: ahora, cantidad: 1 });
    } else if (++registro.cantidad > MAX_POR_VENTANA) {
        res.set("Retry-After", String(Math.ceil((VENTANA_MS - (ahora - registro.inicio)) / 1000)));
        return res.status(429).json({
            codigo: "DEMASIADOS_PEDIDOS",
            mensaje: "Has hecho demasiadas consultas seguidas. Espera un minuto y vuelve a intentarlo.",
        });
    }

    // Limpieza ocasional para que el mapa no crezca sin fin
    if (pedidosPorIp.size > 5000) {
        for (const [clave, r] of pedidosPorIp) if (ahora - r.inicio > VENTANA_MS) pedidosPorIp.delete(clave);
    }
    next();
}

function enviarError(res, error, etiqueta) {
    if (error instanceof ReservaError) {
        return res.status(error.status).json({ codigo: error.codigo, mensaje: error.message, ...error.extra });
    }
    if (error instanceof Beds24Error) {
        console.error(`${etiqueta} (Beds24) 🔴`, error.message, error.details ? JSON.stringify(error.details) : "");
    } else {
        console.error(`${etiqueta} 🔴`, error);
    }
    return res.status(503).json({
        codigo: "DISPONIBILIDAD_NO_DISPONIBLE",
        mensaje: "No hemos podido consultar la disponibilidad. Inténtalo de nuevo en unos minutos.",
    });
}

reservasRouter.get("/api/reservas/disponibilidad", limitePublico, async (req, res) => {
    try {
        const { hoy, ultimaNoche } = limitesReserva();
        const ocupadas = await getNochesOcupadas(hoy, ultimaNoche);
        const calendario = construirCalendario(ocupadas);

        res.set("Cache-Control", "no-store");
        res.json({
            ...calendario,
            reglas: {
                minHorasAntelacion: MIN_HORAS_ANTELACION,
                maxNoches: MAX_NOCHES,
                maxHuespedes: MAX_HUESPEDES,
            },
            adicionales: ADICIONALES,
        });
    } catch (error) {
        enviarError(res, error, "Error leyendo disponibilidad");
    }
});

reservasRouter.post("/api/reservas/presupuesto", limitePublico, async (req, res) => {
    try {
        const { hoy, ultimaNoche } = limitesReserva();
        const ocupadas = await getNochesOcupadas(hoy, ultimaNoche);
        const { checkIn, checkOut, guests, adicionales } = req.body ?? {};
        res.json(cotizarReserva({ checkIn, checkOut, guests, adicionales }, ocupadas));
    } catch (error) {
        enviarError(res, error, "Error calculando presupuesto");
    }
});

module.exports = reservasRouter;