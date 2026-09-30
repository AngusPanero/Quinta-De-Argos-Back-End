// Sincronización Beds24 → Mongo, webhook y caché del calendario.
const Beds24Booking = require("../models/Beds24Booking");
const { fetchBookings, fetchBookingById, fetchCalendar, ROOM_ID } = require("./beds24Service");
const { todayMadrid, nightsBetween } = require("../utils/dates");

// Referer que va a usar la web cuando cree reservas (fase 3)
const WEB_REFERER = "quintadeargos.com";

// Campos personales: el webhook "no personal data" no los trae,
// así que solo se escriben si vienen en la respuesta
const PERSONAL_FIELDS = ["firstName", "lastName", "email", "phone", "mobile", "country2", "lang", "comments"];

function detectSource(b) {
    if (b.status === "black") return "owner";
    if (b.channel === "airbnb") return "airbnb";
    if (b.channel === "booking") return "booking";
    if (b.referer === WEB_REFERER) return "web";
    return "direct";
}

const toDate = (value) => (value ? new Date(value) : null);
const toNumber = (value) => (typeof value === "number" ? value : null);

function mapBooking(b) {
    const doc = {
        beds24Id: b.id,
        propertyId: b.propertyId,
        roomId: b.roomId,
        status: b.status,
        source: detectSource(b),
        channel: b.channel || null,
        apiSource: b.apiSource || null,
        apiReference: b.apiReference || null,
        referer: b.referer || null,
        arrival: b.arrival,
        departure: b.departure,
        nights: nightsBetween(b.arrival, b.departure),
        numAdult: b.numAdult ?? 0,
        numChild: b.numChild ?? 0,
        price: toNumber(b.price),
        commission: toNumber(b.commission),
        flagText: b.flagText || null,
        flagColor: b.flagColor || null,
        bookingTime: toDate(b.bookingTime),
        modifiedTime: toDate(b.modifiedTime),
        cancelTime: toDate(b.cancelTime),
        deletedInBeds24: false,
        lastSyncedAt: new Date(),
    };
    for (const field of PERSONAL_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(b, field)) doc[field] = b[field] || null;
    }
    return doc;
}

// Guarda la reserva solo si es igual o más nueva que la que ya tenemos.
// Así un aviso que llega tarde o repetido no pisa datos más recientes.
async function upsertBooking(b) {
    if (!b || Number(b.roomId) !== ROOM_ID) return { skipped: true };

    const doc = mapBooking(b);
    const filter = { beds24Id: doc.beds24Id };
    if (doc.modifiedTime) {
        filter.$or = [{ modifiedTime: { $lte: doc.modifiedTime } }, { modifiedTime: null }];
    }
    try {
        await Beds24Booking.updateOne(filter, { $set: doc }, { upsert: true });
        return { saved: true };
    } catch (err) {
        // Duplicado = ya existe una versión más nueva: se ignora
        if (err?.code === 11000) return { stale: true };
        throw err;
    }
}

// ---------- Caché del calendario ----------
// Cada llamada a Beds24 gasta créditos: el calendario se guarda 10 minutos
// y se invalida cuando entra un webhook o termina una sincronización.
const CALENDAR_TTL = 10 * 60 * 1000;
const calendarCache = new Map();

function invalidateCalendarCache() {
    calendarCache.clear();
}

async function getCalendar(from, to) {
    const key = `${from}|${to}`;
    const hit = calendarCache.get(key);
    if (hit && hit.expires > Date.now()) return hit.days;

    const days = await fetchCalendar(from, to);
    calendarCache.set(key, { days, expires: Date.now() + CALENDAR_TTL });
    if (calendarCache.size > 50) calendarCache.delete(calendarCache.keys().next().value);
    return days;
}

// ---------- Webhook ----------
async function handleWebhookBooking(incoming) {
    if (!incoming?.id || Number(incoming.roomId) !== ROOM_ID) return { skipped: true };

    // El webhook no trae datos personales: se pide la reserva completa
    let full;
    try {
        full = await fetchBookingById(incoming.id);
    } catch (err) {
        console.warn(`Webhook Beds24: no se pudo leer la reserva ${incoming.id}, se usa el aviso 🟠`);
        full = undefined;
    }

    if (full === null) {
        // Ya no existe en Beds24 (se borró)
        await Beds24Booking.updateOne(
            { beds24Id: incoming.id },
            { $set: { deletedInBeds24: true, lastSyncedAt: new Date() } }
        );
        invalidateCalendarCache();
        return { deleted: true };
    }

    const result = await upsertBooking(full || incoming);
    invalidateCalendarCache();
    return result;
}

// ---------- Sincronización completa (cron + botón del panel) ----------
let lastSync = { at: null, ok: null, error: null, fetched: 0, markedDeleted: 0 };
let running = null;

function getLastSync() {
    return lastSync;
}

async function syncUpcoming() {
    if (running) return running;   // si ya hay una en curso, se reutiliza

    running = (async () => {
        const today = todayMadrid();
        try {
            const bookings = await fetchBookings({ departureFrom: today });
            const seen = [];
            for (const b of bookings) {
                if (Number(b.roomId) !== ROOM_ID) continue;
                seen.push(b.id);
                await upsertBooking(b);
            }

            // Reservas futuras que están en Mongo pero Beds24 ya no devuelve = borradas.
            // Protección: si Beds24 devolvió 0 y localmente hay varias, no se marca nada.
            let markedDeleted = 0;
            const localUpcoming = await Beds24Booking.countDocuments({ departure: { $gte: today }, deletedInBeds24: false });
            if (seen.length > 0 || localUpcoming <= 2) {
                const result = await Beds24Booking.updateMany(
                    { departure: { $gte: today }, deletedInBeds24: false, beds24Id: { $nin: seen } },
                    { $set: { deletedInBeds24: true, lastSyncedAt: new Date() } }
                );
                markedDeleted = result.modifiedCount || 0;
            } else {
                console.warn("Sync Beds24: respuesta vacía con reservas locales, no se marca ninguna como borrada 🟠");
            }

            invalidateCalendarCache();
            lastSync = { at: new Date().toISOString(), ok: true, error: null, fetched: seen.length, markedDeleted };
            return lastSync;
        } catch (err) {
            lastSync = { ...lastSync, at: new Date().toISOString(), ok: false, error: err.message };
            throw err;
        } finally {
            running = null;
        }
    })();

    return running;
}

module.exports = {
    syncUpcoming,
    getLastSync,
    handleWebhookBooking,
    getCalendar,
    invalidateCalendarCache,
};