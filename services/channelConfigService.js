// Multiplicador de precios de Airbnb (Beds24 → Channel Manager → Airbnb).
// Solo Airbnb: Booking no está disponible en /channels/settings de la API.
// Se suma a lo existente sin tocar el resto de la configuración.
const { beds24Request } = require("./beds24Client");
const { addDays, todayMadrid } = require("../utils/dates");
const { ConfigError } = require("./beds24ConfigService");

const PROPERTY_ID = Number(process.env.BEDS24_PROPERTY_ID);
const ROOM_ID = Number(process.env.BEDS24_ROOM_ID);

// Cómo espera Beds24 el multiplicador al escribirlo:
//   "number"   → 1.1
//   "asterisk" → "*1.1"  (como se escribe en el panel)
// Confirmar con la prueba en el Swagger y cambiar solo esta línea si hace falta.
const MULTIPLIER_FORMAT = "asterisk";   // confirmado: Beds24 solo aplica "*1.1"

const PERCENT_LIMITS = { min: -50, max: 100 };
const MAX_EXAMPLES = 6;

function assertBeds24Ok(data) {
    const items = Array.isArray(data) ? data : [data];
    const failed = items.filter((item) => item && item.success === false);
    if (failed.length) {
        const err = new Error("Beds24 rechazó el cambio");
        err.details = failed.map((f) => f.errors || f.warnings || f);
        throw err;
    }
}

// Acepta 1.1, "1.1", "*1.1" o "*1.1*" y devuelve el factor (o null si no hay)
function parseMultiplier(raw) {
    if (raw === null || raw === undefined || raw === "") return null;
    const n = Number(String(raw).trim().replace(/^\*/, "").replace(/\*$/, ""));
    return Number.isFinite(n) && n > 0 ? n : null;
}

const round2 = (n) => Math.round(n * 100) / 100;
const factorToPercent = (f) => (f === null ? 0 : round2((f - 1) * 100));
const percentToFactor = (p) => Math.round((1 + p / 100) * 10000) / 10000;

async function fetchAirbnbProperty() {
    // Igual que el Swagger: /channels/settings?propertyId=357162&channel=airbnb
    const data = await beds24Request("/channels/settings", { query: { propertyId: PROPERTY_ID, channel: "airbnb" } });
    const channel = (data?.data || []).find((c) => c.channel === "airbnb");
    const property = channel?.properties?.find((p) => Number(p.id) === PROPERTY_ID);
    if (!property) {
        throw new ConfigError("AIRBNB_NO_CONECTADO", "La propiedad no aparece conectada a Airbnb en Beds24.", 404);
    }
    return property;
}

// Precios distintos cargados en el próximo año, para mostrar ejemplos reales
async function fetchSamplePrices() {
    const from = todayMadrid();
    const data = await beds24Request("/inventory/rooms/calendar", {
        query: { roomId: ROOM_ID, startDate: from, endDate: addDays(from, 365), includePrices: true },
    });
    const room = (data?.data || []).find((r) => Number(r.roomId) === ROOM_ID);
    const prices = new Set();
    for (const range of room?.calendar || []) {
        if (typeof range.price1 === "number") prices.add(range.price1);
    }
    const sorted = [...prices].sort((a, b) => a - b);
    if (sorted.length <= MAX_EXAMPLES) return sorted;
    // Mínimo, máximo y algunos intermedios
    const step = (sorted.length - 1) / (MAX_EXAMPLES - 1);
    return [...new Set(Array.from({ length: MAX_EXAMPLES }, (_, i) => sorted[Math.round(i * step)]))];
}

async function fetchMinPrice() {
    const data = await beds24Request("/properties", { query: { id: PROPERTY_ID, includeAllRooms: true } });
    const property = (data?.data || []).find((p) => Number(p.id) === PROPERTY_ID);
    const room = (property?.roomTypes || []).find((r) => Number(r.id) === ROOM_ID);
    return Number(room?.minPrice) || 0;
}

async function getAirbnbConfig() {
    const property = await fetchAirbnbProperty();
    const room = (property.roomTypes || []).find((r) => Number(r.id) === ROOM_ID) || {};
    const factor = parseMultiplier(property.multiplier);
    return {
        multiplier: { factor, percent: factorToPercent(factor), limits: PERCENT_LIMITS },
        listing: { connected: room.enabled === true, airbnbListingId: room.airbnbListingId || null },
        // Solo lectura: se aplican en Airbnb además del multiplicador
        discounts: {
            lastMinuteDays: room.lastMinuteDaysToCheckin ?? null,
            lastMinutePercent: room.lastMinuteDiscountPercent ?? null,
            weekPercent: room["7DayDiscountPercent"] ?? null,
            monthPercent: room["28DayDiscountPercent"] ?? null,
        },
    };
}

async function planAirbnbMultiplier(body) {
    const raw = body?.percent;
    const percent = typeof raw === "number" ? raw : Number(String(raw ?? "").trim().replace(",", "."));
    if (raw === undefined || raw === null || String(raw).trim() === "" || !Number.isFinite(percent)) {
        throw new ConfigError("DATOS_INVALIDOS", "Revisá los campos marcados.", 400, { errors: { percent: "Tiene que ser un número." } });
    }
    if (percent < PERCENT_LIMITS.min || percent > PERCENT_LIMITS.max) {
        throw new ConfigError("DATOS_INVALIDOS", "Revisá los campos marcados.", 400,
            { errors: { percent: `Tiene que estar entre ${PERCENT_LIMITS.min}% y +${PERCENT_LIMITS.max}%.` } });
    }

    const [property, samples, minPrice] = await Promise.all([fetchAirbnbProperty(), fetchSamplePrices(), fetchMinPrice()]);
    const currentFactor = parseMultiplier(property.multiplier);
    const newPercent = round2(percent);
    const newFactor = newPercent === 0 ? null : percentToFactor(newPercent);

    if ((currentFactor ?? 1) === (newFactor ?? 1)) {
        throw new ConfigError("SIN_CAMBIOS", "Airbnb ya tiene ese ajuste.");
    }

    const examples = samples.map((price) => ({ price, airbnb: round2(price * (newFactor ?? 1)) }));
    const below = examples.filter((e) => minPrice > 0 && e.airbnb < minPrice);
    if (below.length) {
        throw new ConfigError("PRECIO_FUERA_DE_RANGO",
            `Con ese ajuste, ${below[0].price} € se enviaría a Airbnb como ${below[0].airbnb} €, por debajo del precio mínimo de seguridad (${minPrice} €).`);
    }

    return {
        before: { factor: currentFactor, percent: factorToPercent(currentFactor) },
        after: { factor: newFactor, percent: newPercent },
        examples,
    };
}

async function applyAirbnbMultiplier(body) {
    const plan = await planAirbnbMultiplier(body);
    const value = plan.after.factor === null ? null
        : MULTIPLIER_FORMAT === "asterisk" ? `*${plan.after.factor}` : plan.after.factor;

    assertBeds24Ok(await beds24Request("/channels/settings", {
        method: "POST",
        body: [{ channel: "airbnb", properties: [{ id: PROPERTY_ID, multiplier: value }] }],
    }));
    return { plan, config: await getAirbnbConfig() };
}

module.exports = { getAirbnbConfig, planAirbnbMultiplier, applyAirbnbMultiplier };