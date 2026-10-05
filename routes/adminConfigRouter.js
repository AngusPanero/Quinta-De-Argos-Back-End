// Configuración de Quinta de Argos (Beds24) desde el panel admin.
// - Lecturas y vistas previas: adminMiddleware.
// - Cambios: adminMiddleware + requireFreshAdmin + clave de firma.
// El panel solo manda lo que el usuario escribió: validar, comparar y
// armar lo que se envía a Beds24 se hace siempre acá.
const express = require("express");
const adminMiddleware = require("../middleware/adminMiddleware");
const requireFreshAdmin = require("../middleware/requireFreshAdmin");
const { requireSignature, audit } = require("../middleware/requireSignature");
const Beds24Booking = require("../models/Beds24Booking");
const { isISODate, nightsBetween } = require("../utils/dates");
const {
    ConfigError, getConfig,
    planReglas, applyReglas,
    planPropiedad, applyPropiedad,
    planCalendar, applyCalendar,
    getCalendarView,
} = require("../services/beds24ConfigService");

const esProduccion = (process.env.NODE_ENV === "production");
const adminConfigRouter = express.Router();

// Un cambio a la vez por sección: evita dos envíos simultáneos a Beds24
const busy = new Set();

function sendError(res, error, label) {
    if (error instanceof ConfigError) {
        return res.status(error.status).json({ message: error.code, detail: error.message, ...error.extra });
    }
    console.error(esProduccion ? `${label} 🔴` : `${label} 🔴 ${error} ${JSON.stringify(error.details || "")}`);
    return res.status(502).json({
        message: "BEDS24_ERROR",
        detail: "Beds24 no respondió o rechazó el cambio. Probá de nuevo en unos minutos.",
    });
}

// Resumen corto del calendario para la auditoría y la respuesta
function calendarSummary(plan) {
    return {
        from: plan.request.from,
        to: plan.request.to,
        weekdays: plan.request.weekdays,
        price: plan.request.price,
        minStay: plan.request.minStay,
        maxStay: plan.request.maxStay,
        override: plan.request.override,
        days: plan.changes.length,
        ranges: plan.ranges.length,
    };
}

// ---------- Leer la configuración actual ----------
adminConfigRouter.get("/api/admin/config", adminMiddleware, async (req, res) => {
    try {
        res.json(await getConfig());
    } catch (error) {
        sendError(res, error, "Error leyendo la configuración de Beds24");
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Calendario
// ═══════════════════════════════════════════════════════════════════════════════

// Vista mensual: precio, estancias y estado de cada día, más las reservas
// GET /api/admin/config/calendario?from=2026-09-28&to=2026-11-08
const MAX_VIEW_DAYS = 62;
adminConfigRouter.get("/api/admin/config/calendario", adminMiddleware, async (req, res) => {
    const { from, to } = req.query;
    if (!isISODate(from) || !isISODate(to) || to < from) {
        return res.status(400).json({ message: "FECHAS_INVALIDAS", detail: "Fechas no válidas (formato AAAA-MM-DD)." });
    }
    if (nightsBetween(from, to) + 1 > MAX_VIEW_DAYS) {
        return res.status(400).json({ message: "RANGO_DEMASIADO_LARGO", detail: `El rango máximo es de ${MAX_VIEW_DAYS} días.` });
    }
    try {
        const [days, bookings] = await Promise.all([
            getCalendarView(from, to),
            Beds24Booking.find({
                deletedInBeds24: false,
                status: { $ne: "cancelled" },
                arrival: { $lte: to },
                departure: { $gt: from },
            })
                .sort({ arrival: 1 })
                .select("beds24Id status source arrival departure nights numAdult numChild firstName lastName -_id")
                .lean(),
        ]);
        res.json({ days, bookings });
    } catch (error) {
        sendError(res, error, "Error leyendo el calendario");
    }
});

adminConfigRouter.post("/api/admin/config/calendario/preview", adminMiddleware, async (req, res) => {
    try {
        const plan = await planCalendar(req.body);
        res.json({
            summary: calendarSummary(plan),
            changes: plan.changes.map(({ date, weekday, before, after, fields }) => ({ date, weekday, before, after, fields })),
            skipped: plan.skipped,
        });
    } catch (error) {
        sendError(res, error, "Error en la vista previa del calendario");
    }
});

adminConfigRouter.post(
    "/api/admin/config/calendario",
    adminMiddleware, requireFreshAdmin, requireSignature("calendario"),
    async (req, res) => {
        if (busy.has("calendario")) return res.status(409).json({ message: "EN_CURSO", detail: "Ya se está aplicando un cambio. Esperá unos segundos." });
        busy.add("calendario");
        try {
            const plan = await applyCalendar(req.body);
            const summary = calendarSummary(plan);
            await audit(req, "calendario", "ok", summary);
            res.json({ applied: summary, skipped: plan.skipped });
        } catch (error) {
            await audit(req, "calendario", error instanceof ConfigError ? "rejected" : "error",
                { code: error.code || "BEDS24_ERROR", body: { ...req.body } });
            sendError(res, error, "Error aplicando cambios de calendario");
        } finally {
            busy.delete("calendario");
        }
    }
);

// ═══════════════════════════════════════════════════════════════════════════════
//  Reglas de la casa y Datos y políticas (misma mecánica)
// ═══════════════════════════════════════════════════════════════════════════════
const SECTIONS = {
    reglas: { plan: planReglas, apply: applyReglas, label: "reglas de la casa" },
    propiedad: { plan: planPropiedad, apply: applyPropiedad, label: "datos de la propiedad" },
};

for (const [name, section] of Object.entries(SECTIONS)) {
    adminConfigRouter.post(`/api/admin/config/${name}/preview`, adminMiddleware, async (req, res) => {
        try {
            const { errors, changes } = await section.plan(req.body?.values);
            if (Object.keys(errors).length) {
                return res.status(400).json({ message: "DATOS_INVALIDOS", detail: "Revisá los campos marcados.", errors });
            }
            res.json({ changes });
        } catch (error) {
            sendError(res, error, `Error en la vista previa de ${section.label}`);
        }
    });

    adminConfigRouter.post(
        `/api/admin/config/${name}`,
        adminMiddleware, requireFreshAdmin, requireSignature(name),
        async (req, res) => {
            if (busy.has(name)) return res.status(409).json({ message: "EN_CURSO", detail: "Ya se está aplicando un cambio. Esperá unos segundos." });
            busy.add(name);
            try {
                const changes = await section.apply(req.body?.values);
                // En la auditoría los textos largos se recortan
                const summary = changes.map((c) => ({
                    key: c.key,
                    before: typeof c.before === "string" ? c.before.slice(0, 300) : c.before,
                    after: typeof c.after === "string" ? c.after.slice(0, 300) : c.after,
                }));
                await audit(req, name, "ok", summary);
                const config = await getConfig();
                res.json({ applied: changes.length, config });
            } catch (error) {
                await audit(req, name, error instanceof ConfigError ? "rejected" : "error", { code: error.code || "BEDS24_ERROR" });
                sendError(res, error, `Error aplicando ${section.label}`);
            } finally {
                busy.delete(name);
            }
        }
    );
}

module.exports = adminConfigRouter;