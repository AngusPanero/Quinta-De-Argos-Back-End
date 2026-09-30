// Fechas siempre como string "YYYY-MM-DD" (igual que Beds24). Sin librerías externas.
const TZ = "Europe/Madrid";
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isISODate(value) {
    if (typeof value !== "string" || !ISO_DATE.test(value)) return false;
    const d = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function addDays(date, days) {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
}

// "Hoy" según la hora de España, no la del servidor de Render
function todayMadrid() {
    return new Intl.DateTimeFormat("en-CA", {
        timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date());
}

// Noches entre llegada y salida (la salida no cuenta como noche)
function nightsBetween(arrival, departure) {
    const ms = Date.parse(`${departure}T00:00:00Z`) - Date.parse(`${arrival}T00:00:00Z`);
    return Math.round(ms / 86400000);
}

module.exports = { isISODate, addDays, todayMadrid, nightsBetween };