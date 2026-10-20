// routes/fianzasRouter.js — Quinta de Argos
// Fianzas y política de cancelación de las reservas web (panel → Configuración → Calendario).
//
//   GET  /api/admin/fianzas
//        -> fianzas pendientes de devolver (también de estancias ya terminadas)
//        -> datos de cada reserva web pagada por id de Beds24: fianza, estancia y
//           el reembolso que corresponde HOY según la política de cancelación
//   POST /api/admin/fianzas/:id/devolver   { importe?: "180" | "90,50", nota?, pin }
//        -> devuelve la fianza (toda o una parte) con un reembolso parcial en Stripe.
//           La reserva NO se cancela: sigue pagada y ocupando sus fechas.
//           El correo al huésped y a la finca sale con el webhook charge.refunded.
//
// Política de cancelación (sobre la estancia, sin la fianza):
//   15 días o más hasta el check-in  -> se devuelve el 100 %
//   14 días o menos                  -> se devuelve el 50 %
//   La fianza se devuelve siempre completa al cancelar.
//
// IMPORTANTE: en index.js, montar DESPUÉS de app.use(express.json()):
//   app.use(require("./routes/fianzasRouter"));

const express = require("express");
const mongoose = require("mongoose");
const Reserva = require("../models/Reserva");
const adminMiddleware = require("../middleware/adminMiddleware");
const requireFreshAdmin = require("../middleware/requireFreshAdmin");
const { requireSignature, audit } = require("../middleware/requireSignature");
const { hoyEnEspana } = require("../services/reservasService");
const { devolverFianza, maximoStripeDe, CancelacionError } = require("../services/reservaWebBeds24Service");

const esProduccion = process.env.NODE_ENV === "production";
const fianzasRouter = express.Router();

// Misma sección de firma que el resto del calendario (bloqueo y auditoría compartidos).
const SECCION_FIRMA = "calendario";

const POLITICA = {
    diasReembolsoTotal: 15, // 15 días o más: 100 %
    porcentajeTardio: 50, // 14 días o menos: 50 %
};

const diasEntre = (desde, hasta) =>
    Math.round((Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${desde}T00:00:00Z`)) / 86_400_000);

const quien = (req) => req.freshAdmin?.email || req.user?.email || "admin";

function errorRespuesta(res, status, codigo, mensaje, errors) {
    return res.status(status).json({ message: codigo, code: codigo, mensaje, detail: mensaje, ...(errors ? { errors } : {}) });
}

// ---------- Importes de una reserva (todo en céntimos) ----------
function importesDe(r) {
    const total = r.importes?.totalCentimos || 0;
    const fianza = r.importes?.fianza?.totalCentimos || 0;
    const fianzaDevuelta = r.devolucionFianza?.centimos || 0;
    const reembolsado = r.cancelacion?.reembolsoCentimos || 0;
    const modificado = (r.modificaciones || []).reduce((t, m) => t + (m.reembolsoCentimos || 0), 0);
    return {
        total,
        estancia: total - fianza,
        fianza,
        fianzaDevuelta,
        fianzaPendiente: Math.max(fianza - fianzaDevuelta, 0),
        devueltoTotal: reembolsado + fianzaDevuelta + modificado,
        // Lo que todavía se puede devolver por Stripe (pagos con tarjeta − devoluciones hechas)
        maximoDevolvible: maximoStripeDe(r),
    };
}

/** Reembolso que corresponde si se cancela HOY, según la política. */
function politicaCancelacion(r, hoy) {
    const i = importesDe(r);
    const dias = diasEntre(hoy, r.estancia.checkIn);
    const porcentaje = dias >= POLITICA.diasReembolsoTotal ? 100 : POLITICA.porcentajeTardio;
    const estanciaCentimos = Math.round((i.estancia * porcentaje) / 100);
    const reembolsoCentimos = Math.min(estanciaCentimos + i.fianzaPendiente, i.maximoDevolvible);
    return {
        diasHastaLlegada: dias,
        porcentaje,
        estanciaCentimos: i.estancia,
        estanciaDevueltaCentimos: estanciaCentimos,
        fianzaCentimos: i.fianzaPendiente,
        reembolsoCentimos,
        maximoCentimos: i.maximoDevolvible,
    };
}

// "180", "90,50", "90.5" -> céntimos (entero) o null
function aCentimos(valor) {
    if (valor === undefined || valor === null || valor === "") return undefined;
    const limpio = String(valor).trim().replace(/\s|€/g, "").replace(",", ".");
    if (!/^\d+(\.\d{1,2})?$/.test(limpio)) return null;
    return Math.round(Number(limpio) * 100);
}

// ---------- GET: fianzas pendientes + política de cada reserva web ----------
fianzasRouter.get("/api/admin/fianzas", adminMiddleware, async (req, res) => {
    try {
        const hoy = hoyEnEspana();
        const reservas = await Reserva.find(
            { estado: "pagada" },
            {
                codigo: 1,
                estado: 1,
                estancia: 1,
                contacto: 1,
                importes: 1,
                cancelacion: 1,
                devolucionFianza: 1,
                pago: 1,
                pagosExtra: 1,
                modificaciones: 1,
                "beds24.bookingId": 1,
            }
        )
            .sort({ "estancia.checkIn": 1 })
            .lean();

        // Fianzas pendientes (las de estancias terminadas primero)
        const pendientes = reservas
            .map((r) => ({ r, i: importesDe(r) }))
            .filter(({ i }) => i.fianzaPendiente > 0 && i.maximoDevolvible > 0)
            .map(({ r, i }) => ({
                id: String(r._id),
                beds24Id: r.beds24?.bookingId ? Number(r.beds24.bookingId) : null,
                codigo: r.codigo,
                nombre: r.contacto?.nombre || "",
                email: r.contacto?.email || "",
                checkIn: r.estancia.checkIn,
                checkOut: r.estancia.checkOut,
                huespedes: r.estancia.huespedes,
                estanciaTerminada: r.estancia.checkOut <= hoy,
                fianzaCentimos: i.fianza,
                fianzaDevueltaCentimos: i.fianzaDevuelta,
                pendienteCentimos: Math.min(i.fianzaPendiente, i.maximoDevolvible),
            }))
            .sort((a, b) => Number(b.estanciaTerminada) - Number(a.estanciaTerminada) || a.checkOut.localeCompare(b.checkOut));

        // Política por id de Beds24 (para el panel de cancelación de las próximas)
        const politica = {};
        for (const r of reservas) {
            if (!r.beds24?.bookingId || r.estancia.checkOut <= hoy) continue;
            politica[String(r.beds24.bookingId)] = politicaCancelacion(r, hoy);
        }

        // Links de pago de ampliaciones que el huésped todavía no ha pagado
        const linksPendientes = {};
        for (const r of reservas) {
            if (!r.beds24?.bookingId || r.estancia.checkOut <= hoy) continue;
            const mod = [...(r.modificaciones || [])].reverse().find((m) => m.estado === "pendiente_pago" && m.checkoutUrl);
            if (!mod) continue;
            linksPendientes[String(r.beds24.bookingId)] = {
                url: mod.checkoutUrl,
                cargoCentimos: mod.cargoCentimos || 0,
                venceEn: mod.venceEn,
                antes: mod.antes,
                despues: mod.despues,
            };
        }

        res.json({ hoy, reglas: POLITICA, pendientes, politica, linksPendientes });
    } catch (error) {
        console.error(esProduccion ? "Error listando fianzas 🔴" : `Error listando fianzas 🔴 ${error}`);
        errorRespuesta(res, 500, "ERROR_INTERNO", "No se han podido cargar las fianzas.");
    }
});

// ---------- POST: devolver la fianza (con firma) ----------
const devolviendo = new Set();

fianzasRouter.post(
    "/api/admin/fianzas/:id/devolver",
    adminMiddleware,
    requireFreshAdmin,
    requireSignature(SECCION_FIRMA),
    async (req, res) => {
        const { id } = req.params;
        if (!mongoose.isValidObjectId(id)) return errorRespuesta(res, 400, "DATOS_INVALIDOS", "Reserva no válida.");

        const importeCentimos = aCentimos(req.body?.importe);
        if (importeCentimos === null) {
            return errorRespuesta(res, 400, "DATOS_INVALIDOS", "Escribe un importe válido (por ejemplo 90 o 90,50).", {
                importe: "Importe no válido.",
            });
        }
        const nota = typeof req.body?.nota === "string" ? req.body.nota.trim().slice(0, 300) : "";

        if (devolviendo.has(id)) {
            return errorRespuesta(res, 409, "EN_CURSO", "Ya se está devolviendo la fianza de esta reserva. Espera unos segundos.");
        }
        devolviendo.add(id);
        try {
            const reserva = await Reserva.findById(id);
            if (!reserva) return errorRespuesta(res, 404, "NO_EXISTE", "La reserva no existe.");

            const resultado = await devolverFianza(reserva, { importeCentimos, nota, por: quien(req) });

            await audit(req, SECCION_FIRMA, "ok", {
                accion: "devolver_fianza",
                codigo: reserva.codigo,
                importeCentimos: resultado.devueltoCentimos,
            });

            res.json(resultado);
        } catch (error) {
            if (error instanceof CancelacionError) {
                return errorRespuesta(res, error.status, error.codigo, error.message, error.extra?.errors);
            }
            if (error?.type?.startsWith?.("Stripe")) {
                console.error("Stripe rechazó la devolución de la fianza 🔴", error.message);
                return errorRespuesta(res, 502, "STRIPE_ERROR", `Stripe no ha podido hacer la devolución: ${error.message}`);
            }
            console.error(esProduccion ? "Error devolviendo fianza 🔴" : `Error devolviendo fianza 🔴 ${error}`);
            errorRespuesta(res, 500, "ERROR_INTERNO", "No se ha podido devolver la fianza.");
        } finally {
            devolviendo.delete(id);
        }
    }
);

module.exports = fianzasRouter;
module.exports.politicaCancelacion = politicaCancelacion;