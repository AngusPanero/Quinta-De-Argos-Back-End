// Lecturas de Beds24 para la habitación de Quinta de Argos.
const { beds24Request, beds24GetAll } = require("./beds24Client");
const { addDays } = require("../utils/dates");

const ROOM_ID = Number(process.env.BEDS24_ROOM_ID);

// Sin filtro de estado, Beds24 no devuelve todas: se piden explícitamente
const ALL_STATUSES = ["confirmed", "new", "request", "black", "cancelled", "inquiry"];

async function fetchBookings({ departureFrom, arrivalFrom, arrivalTo } = {}) {
    return beds24GetAll("/bookings", {
        roomId: ROOM_ID,
        departureFrom,
        arrivalFrom,
        arrivalTo,
        status: ALL_STATUSES,
    });
}

// Devuelve la reserva completa (con datos personales) o null si ya no existe
async function fetchBookingById(id) {
    const data = await beds24Request("/bookings", { query: { id, status: ALL_STATUSES } });
    return data?.data?.[0] || null;
}

// Beds24 agrupa días iguales en rangos { from, to }. Acá se expanden a un día por fila.
function expandCalendar(ranges, startDate, endDate) {
    const days = [];
    for (const range of ranges) {
        for (let date = range.from; date <= range.to; date = addDays(date, 1)) {
            if (date < startDate || date > endDate) continue;
            days.push({
                date,
                available: (range.numAvail ?? 0) > 0,     // incluye los días de preparación
                minStay: range.minStay ?? null,
                price: typeof range.price1 === "number" ? range.price1 : null,
            });
        }
    }
    return days.sort((a, b) => (a.date < b.date ? -1 : 1));
}

async function fetchCalendar(startDate, endDate) {
    const data = await beds24Request("/inventory/rooms/calendar", {
        query: {
            roomId: ROOM_ID,
            startDate,
            endDate,
            includeNumAvail: true,
            includeMinStay: true,
            includePrices: true,
        },
    });
    const room = (data?.data || []).find((r) => Number(r.roomId) === ROOM_ID);
    return expandCalendar(room?.calendar || [], startDate, endDate);
}

module.exports = { fetchBookings, fetchBookingById, fetchCalendar, ROOM_ID };