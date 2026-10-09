const { beds24Request } = require("./beds24Client");
const { fetchBookings, ROOM_ID } = require("./beds24Service");
const { sumarDias } = require("./reservasService");

// Estados de Beds24 que ocupan la casa. "new" es como llegan las de Airbnb.
const ESTADOS_QUE_OCUPAN = new Set(["confirmed", "new", "request", "black"]);

class Beds24WriteError extends Error {
    constructor(message, details) {
        super(message);
        this.name = "Beds24WriteError";
        this.details = details;
    }
}

// Las respuestas de POST son un array con un resultado por elemento enviado:
// [{ success, new: { id }, modified, errors, warnings, info }]
function primerResultado(data, accion) {
    const r = Array.isArray(data) ? data[0] : data;
    if (!r || r.success === false) {
        const errores = (r?.errors || [])
            .map((e) => [e.field, e.message].filter(Boolean).join(": ") || JSON.stringify(e))
            .join("; ");
        throw new Beds24WriteError(`Beds24 rechazó ${accion}${errores ? ` (${errores})` : ""}`, data);
    }
    if (r.warnings?.length) console.warn(`Beds24 avisó al ${accion} 🟠`, JSON.stringify(r.warnings));
    return r;
}

/**
 * Crea una reserva en la habitación de la Quinta y devuelve su id de Beds24 (texto).
 * @param {object} datos  campos de la reserva de Beds24 (status, arrival, departure, firstName...)
 */
async function crearReservaBeds24(datos) {
    const data = await beds24Request("/bookings", { method: "POST", body: [{ roomId: ROOM_ID, ...datos }] });
    const r = primerResultado(data, "crear la reserva");
    const id = r.new?.id ?? r.modified?.id ?? r.id;
    if (!id) throw new Beds24WriteError("Beds24 no devolvió el número de la reserva creada", data);
    return String(id);
}

/** Cancela una reserva: deja de ocupar las fechas en todos los canales. */
async function cancelarReservaBeds24(bookingId) {
    const data = await beds24Request("/bookings", {
        method: "POST",
        body: [{ id: Number(bookingId), status: "cancelled" }],
    });
    primerResultado(data, "cancelar la reserva");
}

/** Reservas activas que pisan alguna noche entre checkIn (incluida) y checkOut (excluida). */
async function reservasQueSolapan(checkIn, checkOut) {
    // Filtro amplio en Beds24 y el exacto aquí, para no depender de cómo
    // interpreta Beds24 los límites de cada parámetro.
    const lista = await fetchBookings({ arrivalTo: checkOut, departureFrom: checkIn });
    return lista.filter(
        (b) =>
            Number(b.roomId ?? ROOM_ID) === ROOM_ID &&
            ESTADOS_QUE_OCUPAN.has(b.status) &&
            b.arrival < checkOut &&
            b.departure > checkIn
    );
}

/** Busca una reserva ya creada con nuestra referencia (para no duplicarla al reintentar). */
async function buscarPorReferencia(apiReference, checkIn) {
    const lista = await fetchBookings({ arrivalFrom: checkIn, arrivalTo: checkIn });
    return lista.find((b) => b.apiReference === apiReference && b.status !== "cancelled") || null;
}

// ---------- Cierres manuales (override "blackout") ----------

/** Noches de la estancia que tienen un cierre manual en el calendario de Beds24. */
async function nochesConCierre(checkIn, checkOut) {
    const ultimaNoche = sumarDias(checkOut, -1);
    const data = await beds24Request("/inventory/rooms/calendar", {
        query: { roomId: ROOM_ID, startDate: checkIn, endDate: ultimaNoche, includeOverride: true },
    });
    const rangos = data?.data?.find((r) => Number(r.roomId) === ROOM_ID)?.calendar ?? data?.data?.[0]?.calendar ?? [];

    const noches = new Set();
    for (const rango of rangos) {
        if (rango.override !== "blackout" || !rango.from) continue;
        const hasta = rango.to || rango.from;
        for (let f = rango.from; f <= hasta; f = sumarDias(f, 1)) {
            if (f >= checkIn && f <= ultimaNoche) noches.add(f);
        }
    }
    return [...noches].sort();
}

function agruparEnRangos(fechas) {
    const rangos = [];
    for (const fecha of fechas) {
        const ultimo = rangos[rangos.length - 1];
        if (ultimo && sumarDias(ultimo.to, 1) === fecha) ultimo.to = fecha;
        else rangos.push({ from: fecha, to: fecha });
    }
    return rangos;
}

/** Quita el cierre manual de esas noches (solo se usa cuando ya hay una reserva encima). */
async function quitarCierres(noches) {
    if (!noches.length) return;
    const calendar = agruparEnRangos(noches).map((r) => ({ ...r, override: "none" }));
    const data = await beds24Request("/inventory/rooms/calendar", {
        method: "POST",
        body: [{ roomId: ROOM_ID, calendar }],
    });
    primerResultado(data, "quitar el cierre de las fechas");
}

// Después de escribir en Beds24: que el calendario del panel no muestre datos viejos.
function invalidarCachesPanel() {
    try {
        require("./bookingSync").invalidateCalendarCache?.();
    } catch {
        // si no existe, no pasa nada: la caché caduca sola
    }
}

module.exports = {
    Beds24WriteError,
    crearReservaBeds24,
    cancelarReservaBeds24,
    reservasQueSolapan,
    buscarPorReferencia,
    nochesConCierre,
    quitarCierres,
    agruparEnRangos,
    invalidarCachesPanel,
};