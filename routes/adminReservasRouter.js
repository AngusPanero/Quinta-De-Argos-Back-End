// Rutas del panel admin de reservas. Todas protegidas con adminMiddleware.
const express = require("express");
const adminMiddleware = require("../middleware/adminMiddleware");
const Beds24Booking = require("../models/Beds24Booking");
const { syncUpcoming, getLastSync, getCalendar } = require("../services/bookingSync");
const { isISODate, todayMadrid, nightsBetween } = require("../utils/dates");

const esProduccion = (process.env.NODE_ENV === "production");
const adminReservasRouter = express.Router();

const SOURCES = ["web", "airbnb", "booking", "owner", "direct"];
const SCOPES = ["upcoming", "past", "cancelled"];
const MAX_CALENDAR_DAYS = 120;

const logError = (label, error) =>
    console.error(esProduccion ? `${label} 🔴` : `${label} 🔴 ${error}`);

// ---------- Listado de reservas ----------
// GET /api/admin/reservas?scope=upcoming|past|cancelled&source=airbnb,booking
adminReservasRouter.get("/api/admin/reservas", adminMiddleware, async (req, res) => {
    try {
        const today = todayMadrid();
        const scope = SCOPES.includes(req.query.scope) ? req.query.scope : "upcoming";

        const filter = { deletedInBeds24: false };
        let sort = { arrival: 1 };

        if (scope === "upcoming") {
            filter.departure = { $gte: today };
            filter.status = { $ne: "cancelled" };
        } else if (scope === "past") {
            filter.departure = { $lt: today };
            filter.status = { $ne: "cancelled" };
            sort = { arrival: -1 };
        } else {
            filter.status = "cancelled";
            sort = { cancelTime: -1 };
        }

        if (req.query.source) {
            const list = String(req.query.source).split(",").filter((s) => SOURCES.includes(s));
            if (list.length) filter.source = { $in: list };
        }

        const bookings = await Beds24Booking.find(filter).sort(sort).limit(300).select("-__v").lean();
        res.json({ bookings, today, lastSync: getLastSync() });
    } catch (error) {
        logError("Error listando reservas", error);
        res.status(500).json({ message: "No se pudieron cargar las reservas" });
    }
});

// ---------- Estado de la sincronización ----------
adminReservasRouter.get("/api/admin/reservas/estado", adminMiddleware, (req, res) => {
    res.json({ lastSync: getLastSync() });
});

// ---------- Sincronizar ahora ----------
adminReservasRouter.post("/api/admin/reservas/sync", adminMiddleware, async (req, res) => {
    const last = getLastSync();
    if (last.at && Date.now() - Date.parse(last.at) < 30 * 1000) {
        return res.status(429).json({ message: "Esperá unos segundos antes de volver a sincronizar", lastSync: last });
    }
    try {
        const lastSync = await syncUpcoming();
        res.json({ lastSync });
    } catch (error) {
        logError("Error sincronizando con Beds24", error);
        res.status(502).json({ message: "No se pudo sincronizar con Beds24", lastSync: getLastSync() });
    }
});

// ---------- Detalle de una reserva ----------
adminReservasRouter.get("/api/admin/reservas/:id", adminMiddleware, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: "ID inválido" });
    try {
        const booking = await Beds24Booking.findOne({ beds24Id: id }).select("-__v").lean();
        if (!booking) return res.status(404).json({ message: "Reserva no encontrada" });
        res.json({ booking });
    } catch (error) {
        logError("Error leyendo reserva", error);
        res.status(500).json({ message: "No se pudo cargar la reserva" });
    }
});

// ---------- Calendario (ocupación, precio y estancia mínima por día) ----------
// GET /api/admin/calendario?from=2026-10-01&to=2026-11-08
adminReservasRouter.get("/api/admin/calendario", adminMiddleware, async (req, res) => {
    const { from, to } = req.query;
    if (!isISODate(from) || !isISODate(to) || to < from) {
        return res.status(400).json({ message: "Fechas inválidas (formato YYYY-MM-DD)" });
    }
    if (nightsBetween(from, to) > MAX_CALENDAR_DAYS) {
        return res.status(400).json({ message: `El rango máximo es de ${MAX_CALENDAR_DAYS} días` });
    }
    try {
        const [days, bookings] = await Promise.all([
            getCalendar(from, to),
            Beds24Booking.find({
                deletedInBeds24: false,
                status: { $ne: "cancelled" },
                arrival: { $lte: to },
                departure: { $gt: from },
            })
                .sort({ arrival: 1 })
                .select("beds24Id status source arrival departure nights numAdult numChild firstName lastName price commission apiReference")
                .lean(),
        ]);
        res.json({ days, bookings, lastSync: getLastSync() });
    } catch (error) {
        logError("Error cargando calendario", error);
        res.status(502).json({ message: "No se pudo cargar el calendario desde Beds24" });
    }
});

module.exports = adminReservasRouter;