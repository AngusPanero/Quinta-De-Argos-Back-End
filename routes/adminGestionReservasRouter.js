// routes/adminGestionReservasRouter.js — Quinta de Argos
// Gestión de reservas desde el panel (Configuración → Calendario → Reservas particulares y uso propio).
//
//   GET  /api/admin/gestion-reservas                         -> próximas reservas que se pueden cancelar desde la web
//                                                               (web, particulares y uso propio) + pagos web sin pasar a Beds24
//   POST /api/admin/gestion-reservas/preview                 -> comprueba una reserva particular / uso propio (no escribe)
//   POST /api/admin/gestion-reservas                         -> la crea en Beds24                   [firma]
//   POST /api/admin/gestion-reservas/:beds24Id/cancelar      -> cancela (y reembolsa si es web)     [firma]
//   POST /api/admin/reservas-web/:id/cancelar                -> igual, desde el listado de reservas web [firma]
//   POST /api/admin/reservas-web/:id/beds24                  -> reintenta pasar a Beds24 un pago web
//
// Las reservas de Airbnb y Booking NO se cancelan desde aquí: se cancelan en cada plataforma.
//
// Se monta en index.js DESPUÉS de express.json() y cookieParser().

const express = require("express");
const mongoose = require("mongoose");
const adminMiddleware = require("../middleware/adminMiddleware");
const requireFreshAdmin = require("../middleware/requireFreshAdmin");
const { requireSignature, audit } = require("../middleware/requireSignature");
const Reserva = require("../models/Reserva");
const Beds24Booking = require("../models/Beds24Booking");
const { MAX_HUESPEDES } = require("../config/reservasConfig");
const { hoyEnEspana } = require("../services/reservasService");
const { invalidarCacheDisponibilidad } = require("../services/beds24AvailabilityService");
const { cancelarReservaBeds24, invalidarCachesPanel } = require("../services/beds24BookingsService");
const { sincronizarReservaWeb, cancelarReservaWeb, CancelacionError } = require("../services/reservaWebBeds24Service");
const { planificarReservaManual, crearReservaManual, GestionError, leerEuros, MAX_NOCHES_MANUAL } = require("../services/reservaManualService");

const router = express.Router();

// La firma reutiliza la sección "calendario" (mismo bloqueo y auditoría que el resto del calendario).
const SECCION_FIRMA = "calendario";

// Una sola escritura a la vez: evita dobles clics y dos cambios simultáneos en Beds24.
let ocupado = false;
function deUnoEnUno(handler) {
    return async (req, res) => {
        if (ocupado) return res.status(409).json({ message: "EN_CURSO", detail: "Ya se está aplicando otro cambio. Espera unos segundos." });
        ocupado = true;
        try {
            await handler(req, res);
        } finally {
            ocupado = false;
        }
    };
}

const quienEs = (req) => req.freshAdmin?.email || req.user?.email || "admin";

function enviarError(res, error, etiqueta) {
    if (error instanceof GestionError || error instanceof CancelacionError) {
        return res.status(error.status).json({ message: error.codigo, detail: error.message, ...error.extra });
    }
    console.error(`${etiqueta} 🔴`, error?.message || error, error?.details ? JSON.stringify(error.details) : "");
    if (error?.type?.startsWith?.("Stripe")) {
        return res.status(502).json({
            message: "STRIPE_ERROR",
            detail: `Stripe no pudo hacer el reembolso: ${error.message}. Puedes volver a intentarlo: no se duplicará.`,
        });
    }
    return res.status(502).json({
        message: "BEDS24_ERROR",
        detail: "Beds24 no respondió o rechazó el cambio. Inténtalo de nuevo en unos minutos.",
    });
}

function centimosDeBody(body) {
    if (body?.reembolso !== "parcial") return undefined;
    const valor = leerEuros(body.importe);
    return Number.isFinite(valor) ? Math.round(valor * 100) : NaN;
}

// ---------- Listado ----------
router.get("/api/admin/gestion-reservas", adminMiddleware, async (req, res) => {
    try {
        const hoy = hoyEnEspana();
        const bookings = await Beds24Booking.find({
            deletedInBeds24: false,
            status: { $ne: "cancelled" },
            departure: { $gte: hoy },
            source: { $in: ["web", "direct", "owner"] },
        })
            .sort({ arrival: 1 })
            .limit(200)
            .lean();

        const ids = bookings.map((b) => String(b.beds24Id));
        const webs = await Reserva.find(
            { "beds24.bookingId": { $in: ids } },
            { codigo: 1, estado: 1, "importes.totalCentimos": 1, cancelacion: 1, "beds24.bookingId": 1 }
        ).lean();
        const webPorBooking = new Map(webs.map((r) => [r.beds24.bookingId, r]));

        const reservas = bookings.map((b) => {
            const web = webPorBooking.get(String(b.beds24Id));
            return {
                beds24Id: b.beds24Id,
                tipo: b.source, // web | direct | owner
                checkIn: b.arrival,
                checkOut: b.departure,
                noches: b.nights,
                nombre: [b.firstName, b.lastName].filter(Boolean).join(" ") || null,
                huespedes: b.numAdult ?? null,
                precio: typeof b.price === "number" ? b.price : null,
                web: web
                    ? {
                          id: String(web._id),
                          codigo: web.codigo,
                          estado: web.estado,
                          totalCentimos: web.importes.totalCentimos,
                          reembolsadoCentimos: web.cancelacion?.reembolsoCentimos || 0,
                      }
                    : null,
            };
        });

        // Pagos web que no llegaron a Beds24 (Beds24 caído, token sin permiso...).
        const pendientes = await Reserva.find(
            { estado: "pagada", "beds24.bookingId": null },
            { codigo: 1, estancia: 1, "contacto.nombre": 1, "importes.total": 1, "beds24.error": 1, "beds24.intentos": 1 }
        )
            .sort({ "estancia.checkIn": 1 })
            .limit(50)
            .lean();

        res.set("Cache-Control", "no-store");
        res.json({
            hoy,
            limites: { maxHuespedes: MAX_HUESPEDES, maxNoches: MAX_NOCHES_MANUAL },
            reservas,
            pendientes: pendientes.map((r) => ({
                id: String(r._id),
                codigo: r.codigo,
                checkIn: r.estancia.checkIn,
                checkOut: r.estancia.checkOut,
                nombre: r.contacto.nombre,
                total: r.importes.total,
                error: r.beds24?.error || "",
                intentos: r.beds24?.intentos || 0,
            })),
        });
    } catch (error) {
        console.error("Error listando la gestión de reservas 🔴", error);
        res.status(500).json({ message: "ERROR", detail: "No se han podido cargar las reservas." });
    }
});

// ---------- Reserva particular / uso propio ----------
router.post("/api/admin/gestion-reservas/preview", adminMiddleware, async (req, res) => {
    try {
        const { datos, conflictos, cierres } = await planificarReservaManual(req.body);
        res.json({ datos, conflictos, cierres });
    } catch (error) {
        enviarError(res, error, "Error en la vista previa de la reserva manual");
    }
});

router.post(
    "/api/admin/gestion-reservas",
    adminMiddleware,
    requireFreshAdmin,
    requireSignature(SECCION_FIRMA),
    deUnoEnUno(async (req, res) => {
        try {
            const resultado = await crearReservaManual(req.body);
            const { datos } = resultado;
            await audit(req, SECCION_FIRMA, "ok", {
                accion: "crear_reserva",
                tipo: datos.tipo,
                checkIn: datos.checkIn,
                checkOut: datos.checkOut,
                precio: datos.precio,
                beds24Id: resultado.bookingId,
            });

            invalidarCacheDisponibilidad();
            invalidarCachesPanel();
            // Trae la reserva nueva al panel sin esperar al webhook de Beds24.
            require("../services/bookingSync").syncUpcoming?.().catch(() => {});

            res.json({
                bookingId: resultado.bookingId,
                tipo: datos.tipo,
                cierresQuitados: resultado.cierresQuitados.length,
                aviso: resultado.aviso,
            });
        } catch (error) {
            await audit(req, SECCION_FIRMA, error instanceof GestionError ? "rejected" : "error", {
                accion: "crear_reserva",
                code: error.codigo || "BEDS24_ERROR",
            });
            enviarError(res, error, "Error creando la reserva manual");
        }
    })
);

// ---------- Cancelar ----------
async function cancelarPorReservaWeb(req, res, reserva) {
    const resultado = await cancelarReservaWeb(reserva, {
        reembolso: req.body?.reembolso,
        importeCentimos: centimosDeBody(req.body),
        motivo: req.body?.motivo,
        por: quienEs(req),
    });
    if (reserva.beds24?.bookingId) {
        await Beds24Booking.updateOne(
            { beds24Id: Number(reserva.beds24.bookingId) },
            { $set: { status: "cancelled", cancelTime: new Date() } }
        ).catch(() => {});
    }
    await audit(req, SECCION_FIRMA, "ok", {
        accion: "cancelar_reserva_web",
        codigo: reserva.codigo,
        beds24Id: reserva.beds24?.bookingId || null,
        reembolsoCentimos: resultado.reembolsoCentimos,
    });
    res.json({ cancelada: true, codigo: reserva.codigo, ...resultado });
}

router.post(
    "/api/admin/gestion-reservas/:beds24Id/cancelar",
    adminMiddleware,
    requireFreshAdmin,
    requireSignature(SECCION_FIRMA),
    deUnoEnUno(async (req, res) => {
        const beds24Id = Number(req.params.beds24Id);
        if (!Number.isInteger(beds24Id) || beds24Id <= 0) {
            return res.status(400).json({ message: "DATOS_INVALIDOS", detail: "Número de reserva no válido." });
        }
        try {
            // ¿Es una reserva pagada en la web? Entonces también hay que devolver el dinero.
            const reservaWeb = await Reserva.findOne({ "beds24.bookingId": String(beds24Id) });
            if (reservaWeb) return await cancelarPorReservaWeb(req, res, reservaWeb);

            const booking = await Beds24Booking.findOne({ beds24Id }).lean();
            if (!booking) return res.status(404).json({ message: "NO_EXISTE", detail: "La reserva no existe." });
            if (booking.source === "airbnb" || booking.source === "booking") {
                return res.status(400).json({
                    message: "OTRO_CANAL",
                    detail: `Las reservas de ${booking.source === "airbnb" ? "Airbnb" : "Booking"} se cancelan desde esa plataforma.`,
                });
            }
            if (booking.status === "cancelled") {
                return res.status(409).json({ message: "YA_CANCELADA", detail: "Esta reserva ya está cancelada." });
            }

            await cancelarReservaBeds24(beds24Id);
            await Beds24Booking.updateOne({ beds24Id }, { $set: { status: "cancelled", cancelTime: new Date() } });
            invalidarCacheDisponibilidad();
            invalidarCachesPanel();

            await audit(req, SECCION_FIRMA, "ok", {
                accion: "cancelar_reserva",
                tipo: booking.source,
                beds24Id,
                checkIn: booking.arrival,
                checkOut: booking.departure,
            });
            res.json({ cancelada: true, beds24Id });
        } catch (error) {
            await audit(req, SECCION_FIRMA, error instanceof CancelacionError ? "rejected" : "error", {
                accion: "cancelar_reserva",
                beds24Id,
                code: error.codigo || "ERROR",
            });
            enviarError(res, error, "Error cancelando la reserva");
        }
    })
);

router.post(
    "/api/admin/reservas-web/:id/cancelar",
    adminMiddleware,
    requireFreshAdmin,
    requireSignature(SECCION_FIRMA),
    deUnoEnUno(async (req, res) => {
        if (!mongoose.isValidObjectId(req.params.id)) {
            return res.status(400).json({ message: "DATOS_INVALIDOS", detail: "Identificador de reserva no válido." });
        }
        try {
            const reserva = await Reserva.findById(req.params.id);
            if (!reserva) return res.status(404).json({ message: "NO_EXISTE", detail: "La reserva no existe." });
            await cancelarPorReservaWeb(req, res, reserva);
        } catch (error) {
            await audit(req, SECCION_FIRMA, error instanceof CancelacionError ? "rejected" : "error", {
                accion: "cancelar_reserva_web",
                reservaId: req.params.id,
                code: error.codigo || "ERROR",
            });
            enviarError(res, error, "Error cancelando la reserva web");
        }
    })
);

// ---------- Reintentar el paso a Beds24 de un pago web ----------
router.post(
    "/api/admin/reservas-web/:id/beds24",
    adminMiddleware,
    requireFreshAdmin,
    deUnoEnUno(async (req, res) => {
        if (!mongoose.isValidObjectId(req.params.id)) {
            return res.status(400).json({ message: "DATOS_INVALIDOS", detail: "Identificador de reserva no válido." });
        }
        try {
            const reserva = await Reserva.findById(req.params.id);
            if (!reserva) return res.status(404).json({ message: "NO_EXISTE", detail: "La reserva no existe." });
            const resultado = await sincronizarReservaWeb(reserva);
            if (resultado.estado === "creada" || resultado.estado === "ya_existia") {
                require("../services/bookingSync").syncUpcoming?.().catch(() => {});
            }
            res.json(resultado);
        } catch (error) {
            enviarError(res, error, "Error reintentando la reserva web en Beds24");
        }
    })
);

module.exports = router;