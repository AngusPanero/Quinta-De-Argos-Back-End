// routes/modificacionesRouter.js — Quinta de Argos
// Cambio de fechas de una reserva web desde el panel (Configuración → Calendario).
//
//   POST /api/admin/reservas-web/:id/modificar/preview   { checkIn, checkOut }
//        -> noches que se quitan / agregan, disponibilidad, precios y reembolso sugerido.
//           No cambia nada.
//   POST /api/admin/reservas-web/:id/modificar   (con firma)
//        {
//          checkIn, checkOut,
//          reembolso: "sugerido" | "otro" | "ninguno",
//          importeReembolso?: "90,50",        // solo con reembolso "otro"
//          fianzaAdicional?: "60",            // opcional
//          metodoCobro?: "stripe" | "transferencia",
//          nota?, pin
//        }
//        -> cambia la reserva en Beds24 (llega a Airbnb/Booking) y en la web,
//           devuelve dinero y/o cobra la diferencia (link de Stripe o transferencia).
//   POST /api/admin/reservas-web/:id/modificar/liberar   (con firma)  { checkIn, checkOut, pin }
//        -> libera las noches nuevas ocupadas por algo colgado (reserva web cancelada,
//           sin pagar o duplicada que sigue en Beds24, o un cierre manual) y vuelve a calcular.
//
// IMPORTANTE: en index.js, montar DESPUÉS de app.use(express.json()):
//   app.use(require("./routes/modificacionesRouter"));

const express = require("express");
const mongoose = require("mongoose");
const Reserva = require("../models/Reserva");
const adminMiddleware = require("../middleware/adminMiddleware");
const requireFreshAdmin = require("../middleware/requireFreshAdmin");
const { requireSignature, audit } = require("../middleware/requireSignature");
const { calcularModificacion, aplicarModificacion, liberarBloqueos, ModificacionError } = require("../services/modificacionReservaService");
const { CancelacionError } = require("../services/reservaWebBeds24Service");
const { Beds24WriteError } = require("../services/beds24BookingsService");

const esProduccion = process.env.NODE_ENV === "production";
const modificacionesRouter = express.Router();
const SECCION_FIRMA = "calendario";

const quien = (req) => req.freshAdmin?.email || req.user?.email || "admin";

function errorRespuesta(res, status, codigo, mensaje, extra = {}) {
    return res.status(status).json({ message: codigo, code: codigo, mensaje, detail: mensaje, ...extra });
}

// "180", "90,50", "90.5" -> céntimos; "" -> undefined; inválido -> null
function aCentimos(valor) {
    if (valor === undefined || valor === null || valor === "") return undefined;
    const limpio = String(valor).trim().replace(/\s|€/g, "").replace(",", ".");
    if (!/^\d+(\.\d{1,2})?$/.test(limpio)) return null;
    return Math.round(Number(limpio) * 100);
}

const fecha = (v) => (typeof v === "string" ? v.trim().slice(0, 10) : "");

function manejarError(res, error, contexto) {
    if (error instanceof ModificacionError || error instanceof CancelacionError) {
        const extra = {};
        if (error.extra?.errors) extra.errors = error.extra.errors;
        if (error.extra?.calculo) extra.calculo = error.extra.calculo;
        return errorRespuesta(res, error.status || 400, error.codigo, error.message, extra);
    }
    if (error instanceof Beds24WriteError) {
        console.error("Beds24 rechazó el cambio de fechas 🔴", error.message);
        return errorRespuesta(res, 502, "BEDS24_ERROR", `Beds24 no ha aceptado el cambio: ${error.message}. No se ha tocado nada.`);
    }
    if (error?.name === "Beds24Error") {
        return errorRespuesta(res, 503, "BEDS24_NO_DISPONIBLE", "No se ha podido consultar Beds24. Prueba en unos minutos.");
    }
    if (error?.type?.startsWith?.("Stripe")) {
        console.error("Stripe rechazó la operación 🔴", error.message);
        return errorRespuesta(res, 502, "STRIPE_ERROR", `Stripe ha dado un error: ${error.message}`);
    }
    console.error(esProduccion ? `Error ${contexto} 🔴` : `Error ${contexto} 🔴 ${error?.stack || error}`);
    return errorRespuesta(res, 500, "ERROR_INTERNO", "No se ha podido completar la operación.");
}

async function cargarReserva(req, res) {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
        errorRespuesta(res, 400, "DATOS_INVALIDOS", "Reserva no válida.");
        return null;
    }
    const reserva = await Reserva.findById(id);
    if (!reserva) {
        errorRespuesta(res, 404, "NO_EXISTE", "La reserva no existe.");
        return null;
    }
    return reserva;
}

// ---------- Vista previa (sin firma, no cambia nada) ----------
modificacionesRouter.post("/api/admin/reservas-web/:id/modificar/preview", adminMiddleware, async (req, res) => {
    try {
        const reserva = await cargarReserva(req, res);
        if (!reserva) return;
        const calculo = await calcularModificacion(reserva, {
            checkIn: fecha(req.body?.checkIn),
            checkOut: fecha(req.body?.checkOut),
        });
        res.json(calculo);
    } catch (error) {
        manejarError(res, error, "calculando el cambio de fechas");
    }
});

// ---------- Aplicar el cambio (con firma) ----------
const enCurso = new Set();

modificacionesRouter.post(
    "/api/admin/reservas-web/:id/modificar",
    adminMiddleware,
    requireFreshAdmin,
    requireSignature(SECCION_FIRMA),
    async (req, res) => {
        const { id } = req.params;
        const body = req.body || {};

        const importeReembolsoCentimos = aCentimos(body.importeReembolso);
        const fianzaAdicionalCentimos = aCentimos(body.fianzaAdicional);
        const errors = {};
        if (importeReembolsoCentimos === null) errors.importeReembolso = "Importe no válido.";
        if (fianzaAdicionalCentimos === null) errors.fianzaAdicional = "Importe no válido.";
        if (Object.keys(errors).length) {
            return errorRespuesta(res, 400, "DATOS_INVALIDOS", "Escribe importes válidos (por ejemplo 90 o 90,50).", { errors });
        }

        if (enCurso.has(id)) {
            return errorRespuesta(res, 409, "EN_CURSO", "Ya se está modificando esta reserva. Espera unos segundos.");
        }
        enCurso.add(id);
        try {
            const reserva = await cargarReserva(req, res);
            if (!reserva) return;

            const resultado = await aplicarModificacion(reserva, {
                checkIn: fecha(body.checkIn),
                checkOut: fecha(body.checkOut),
                reembolso: ["sugerido", "otro", "ninguno"].includes(body.reembolso) ? body.reembolso : "ninguno",
                importeReembolsoCentimos,
                fianzaAdicionalCentimos,
                metodoCobro: body.metodoCobro,
                nota: typeof body.nota === "string" ? body.nota.trim().slice(0, 300) : "",
                por: quien(req),
            });

            await audit(req, SECCION_FIRMA, "ok", {
                accion: "cambiar_fechas",
                codigo: reserva.codigo,
                antes: resultado.modificacion?.antes,
                despues: resultado.modificacion?.despues,
                cargoCentimos: resultado.modificacion?.cargoCentimos,
                reembolsoCentimos: resultado.modificacion?.reembolsoCentimos,
                metodoCobro: resultado.modificacion?.metodoCobro,
            });

            res.json(resultado);
        } catch (error) {
            manejarError(res, error, "modificando la reserva");
        } finally {
            enCurso.delete(id);
        }
    }
);

// ---------- Liberar noches colgadas (con firma) ----------
modificacionesRouter.post(
    "/api/admin/reservas-web/:id/modificar/liberar",
    adminMiddleware,
    requireFreshAdmin,
    requireSignature(SECCION_FIRMA),
    async (req, res) => {
        const { id } = req.params;
        if (enCurso.has(id)) {
            return errorRespuesta(res, 409, "EN_CURSO", "Ya se está modificando esta reserva. Espera unos segundos.");
        }
        enCurso.add(id);
        try {
            const reserva = await cargarReserva(req, res);
            if (!reserva) return;
            const resultado = await liberarBloqueos(reserva, {
                checkIn: fecha(req.body?.checkIn),
                checkOut: fecha(req.body?.checkOut),
                por: quien(req),
            });
            await audit(req, SECCION_FIRMA, "ok", {
                accion: "liberar_noches",
                codigo: reserva.codigo,
                reservasCanceladas: resultado.liberadas,
                cierresQuitados: resultado.cierresQuitados,
            });
            res.json(resultado);
        } catch (error) {
            manejarError(res, error, "liberando noches");
        } finally {
            enCurso.delete(id);
        }
    }
);

module.exports = modificacionesRouter;