// services/beds24AvailabilityService.js — Quinta de Argos
// Lee de Beds24 qué noches están libres u ocupadas.
//
// Usa la API v2 de Beds24:
//   GET /authentication/token                 (header refreshToken) -> { token, expiresIn }
//   GET /inventory/rooms/availability         (header token)
//       ?roomId=&startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
//       -> { data: [ { roomId, availability: { "YYYY-MM-DD": true|false, ... } } ] }
//
// Si ya tienes un helper que obtiene el token de Beds24 (por ejemplo en
// beds24ConfigService), cambia getToken() para que use ese y borra el de aquí.
//
// Variables de entorno:
//   BEDS24_REFRESH_TOKEN  refresh token de la API v2
//   BEDS24_ROOM_ID        id de la habitación/unidad de Quinta de Argos en Beds24

const API = "https://api.beds24.com/v2";

// Caché corta para el calendario público: evita llamar a Beds24 cada vez
// que alguien abre la página. El pago SIEMPRE consulta en fresco.
const CACHE_MS = 60 * 1000;

class Beds24Error extends Error {
    constructor(message, details) {
        super(message);
        this.name = "Beds24Error";
        this.details = details;
    }
}

// ---------- Token ----------
let tokenCache = { token: null, expiresAt: 0 };

async function getToken() {
    if (tokenCache.token && Date.now() < tokenCache.expiresAt) return tokenCache.token;

    const refreshToken = process.env.BEDS24_REFRESH_TOKEN;
    if (!refreshToken) throw new Beds24Error("Falta BEDS24_REFRESH_TOKEN");

    const res = await fetch(`${API}/authentication/token`, { headers: { refreshToken } });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body?.token) throw new Beds24Error("No se pudo obtener el token de Beds24", body);

    // Renovamos 5 minutos antes de que caduque.
    const ttlMs = Math.max(60, (body.expiresIn ?? 3600) - 300) * 1000;
    tokenCache = { token: body.token, expiresAt: Date.now() + ttlMs };
    return body.token;
}

// ---------- Disponibilidad ----------
let availabilityCache = { key: null, value: null, at: 0 };

/**
 * Devuelve un Set con las noches OCUPADAS ("YYYY-MM-DD") entre desde y hasta (incluidos).
 * Una noche cuenta como ocupada si Beds24 dice false o si no viene en la respuesta
 * (ante la duda, no se vende).
 *
 * @param {string} desde  YYYY-MM-DD
 * @param {string} hasta  YYYY-MM-DD
 * @param {{ fresco?: boolean }} opciones  fresco: true ignora la caché (usar al cobrar)
 */
async function getNochesOcupadas(desde, hasta, { fresco = false } = {}) {
    const key = `${desde}_${hasta}`;
    if (!fresco && availabilityCache.key === key && Date.now() - availabilityCache.at < CACHE_MS) {
        return availabilityCache.value;
    }

    const roomId = process.env.BEDS24_ROOM_ID;
    if (!roomId) throw new Beds24Error("Falta BEDS24_ROOM_ID");

    const token = await getToken();
    const url = new URL(`${API}/inventory/rooms/availability`);
    url.searchParams.set("roomId", roomId);
    url.searchParams.set("startDate", desde);
    url.searchParams.set("endDate", hasta);

    const res = await fetch(url, { headers: { token } });
    const body = await res.json().catch(() => null);

    if (res.status === 401) tokenCache = { token: null, expiresAt: 0 };
    if (!res.ok || body?.success === false) {
        throw new Beds24Error(`Beds24 respondió ${res.status} al pedir disponibilidad`, body);
    }

    const room = (body?.data ?? []).find((r) => String(r.roomId) === String(roomId));
    if (!room?.availability) throw new Beds24Error("Beds24 no devolvió disponibilidad para la habitación", body);

    const ocupadas = new Set();
    for (const fecha of rangoFechas(desde, hasta)) {
        if (room.availability[fecha] !== true) ocupadas.add(fecha);
    }

    availabilityCache = { key, value: ocupadas, at: Date.now() };
    return ocupadas;
}

// Para forzar que el próximo calendario se lea en fresco (por ejemplo,
// justo después de crear una reserva desde el webhook).
function invalidarCacheDisponibilidad() {
    availabilityCache = { key: null, value: null, at: 0 };
}

function rangoFechas(desde, hasta) {
    const fechas = [];
    const d = new Date(`${desde}T00:00:00Z`);
    const fin = new Date(`${hasta}T00:00:00Z`);
    while (d <= fin) {
        fechas.push(d.toISOString().slice(0, 10));
        d.setUTCDate(d.getUTCDate() + 1);
    }
    return fechas;
}

module.exports = { getNochesOcupadas, invalidarCacheDisponibilidad, Beds24Error };