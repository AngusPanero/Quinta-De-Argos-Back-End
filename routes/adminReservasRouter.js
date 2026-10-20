// Rutas del panel admin de reservas. Todas protegidas con adminMiddleware.
const express = require("express");
const adminMiddleware = require("../middleware/adminMiddleware");
const Beds24Booking = require("../models/Beds24Booking");
const Reserva = require("../models/Reserva");
const { syncUpcoming, getLastSync, getCalendar } = require("../services/bookingSync");
const { isISODate, todayMadrid, nightsBetween } = require("../utils/dates");

const esProduccion = (process.env.NODE_ENV === "production");
const adminReservasRouter = express.Router();

const SOURCES = ["web", "airbnb", "booking", "owner", "direct"];
const SCOPES = ["upcoming", "past", "cancelled"];
const MAX_CALENDAR_DAYS = 120;

const logError = (label, error) =>
    console.error(esProduccion ? `${label} 🔴` : `${label} 🔴 ${error}`);

// ---------- Datos de la reserva web (huéspedes, cuna y fianza) ----------
// Beds24 no guarda la fianza ni la cuna: se buscan en nuestra colección de
// reservas web (Reserva) por el id de Beds24 y se adjuntan como `web`.
// Las reservas que no son de la web llevan `web: null`.
const CAMPOS_WEB = {
    codigo: 1,
    estado: 1,
    "beds24.bookingId": 1,
    "estancia.huespedes": 1,
    "estancia.adultos": 1,
    "estancia.menores": 1,
    "estancia.cuna": 1,
    "importes.total": 1,
    "importes.totalCentimos": 1,
    "importes.fianza": 1,
    "devolucionFianza.centimos": 1,
};

function resumenWeb(r) {
    const fianzaCentimos = r.importes?.fianza?.totalCentimos || 0;
    const totalCentimos = r.importes?.totalCentimos || Math.round((r.importes?.total || 0) * 100);
    return {
        codigo: r.codigo,
        estado: r.estado,
        huespedes: r.estancia?.huespedes ?? 0,
        adultos: typeof r.estancia?.adultos === "number" ? r.estancia.adultos : null, // null = reserva antigua
        menores: r.estancia?.menores ?? 0,
        cuna: Boolean(r.estancia?.cuna),
        reserva: (totalCentimos - fianzaCentimos) / 100, // estancia (alojamiento + adicionales)
        fianza: fianzaCentimos / 100,
        fianzaPorPersona: r.importes?.fianza?.porPersona ?? 0,
        fianzaPersonas: r.importes?.fianza?.personas ?? 0,
        fianzaDevuelta: (r.devolucionFianza?.centimos || 0) / 100,
        total: totalCentimos / 100, // lo cobrado: reserva + fianza
    };
}

async function adjuntarDatosWeb(bookings) {
    if (!bookings.length) return bookings;
    const ids = bookings.map((b) => String(b.beds24Id));
    const reservas = await Reserva.find({ "beds24.bookingId": { $in: ids } }, CAMPOS_WEB).lean();
    const porId = new Map(reservas.map((r) => [String(r.beds24.bookingId), r]));
    return bookings.map((b) => {
        const r = porId.get(String(b.beds24Id));
        return { ...b, web: r ? resumenWeb(r) : null };
    });
}

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

        const lista = await Beds24Booking.find(filter).sort(sort).limit(300).select("-__v").lean();
        const bookings = await adjuntarDatosWeb(lista);
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
        const [conWeb] = await adjuntarDatosWeb([booking]);
        res.json({ booking: conWeb });
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
        const [days, lista] = await Promise.all([
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
        // Mismos datos web que el listado (huéspedes, cuna, reserva, fianza y total).
        const bookings = await adjuntarDatosWeb(lista);
        res.json({ days, bookings, lastSync: getLastSync() });
    } catch (error) {
        logError("Error cargando calendario", error);
        res.status(502).json({ message: "No se pudo cargar el calendario desde Beds24" });
    }
});

module.exports = adminReservasRouter;