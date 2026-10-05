// Lectura y escritura de la configuración de Quinta de Argos en Beds24.
// Toda la lógica de qué se cambia y cómo vive acá, nunca en el panel.
const { beds24Request } = require("./beds24Client");
const { invalidateCalendarCache } = require("./bookingSync");
const { addDays, todayMadrid, nightsBetween, isISODate } = require("../utils/dates");
const { REGLAS_FIELDS, PROPIEDAD_FIELDS, OVERRIDE_OPTIONS, CALENDAR_LIMITS } = require("./configFields");
const { diffFields, parseNumber } = require("./configValidation");

const PROPERTY_ID = Number(process.env.BEDS24_PROPERTY_ID);
const ROOM_ID = Number(process.env.BEDS24_ROOM_ID);
const TEXT_KEYS = ["propertyDescription", "houseRules", "cancellationPolicy", "generalPolicy"];
const BOOKING_RULE_KEYS = ["bookingType", "bookingCutOffHour"];
const RANGES_PER_REQUEST = 100;

class ConfigError extends Error {
    constructor(code, detail, status = 400, extra = {}) {
        super(detail);
        this.code = code;
        this.status = status;
        this.extra = extra;
    }
}

// Beds24 responde un array con un resultado por elemento enviado
function assertBeds24Ok(data) {
    const items = Array.isArray(data) ? data : [data];
    const failed = items.filter((item) => item && item.success === false);
    if (failed.length) {
        const err = new Error("Beds24 rechazó el cambio");
        err.details = failed.map((f) => f.errors || f.warnings || f);
        throw err;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Propiedad y habitación
// ═══════════════════════════════════════════════════════════════════════════════
async function fetchPropertyRaw() {
    const data = await beds24Request("/properties", {
        query: { id: PROPERTY_ID, includeAllRooms: true, includeTexts: true },
    });
    const property = (data?.data || []).find((p) => Number(p.id) === PROPERTY_ID);
    if (!property) throw new Error("Beds24 no devolvió la propiedad");
    return property;
}

const num = (v) => (typeof v === "number" ? v : v === null || v === undefined || v === "" ? null : Number(v));
const str = (v) => (typeof v === "string" ? v : "");

function pickTexts(property) {
    const texts = Array.isArray(property.texts) ? property.texts : [];
    return texts.find((t) => t.language === "es") || texts[0] || { language: "es" };
}

function toConfig(property) {
    const room = (property.roomTypes || []).find((r) => Number(r.id) === ROOM_ID) || {};
    const texts = pickTexts(property);
    const rules = property.bookingRules || {};

    return {
        reglas: {
            minStay: num(room.minStay),
            maxStay: num(room.maxStay),
            restrictionStrategy: room.restrictionStrategy ?? null,
            blockAfterCheckOutDays: num(room.blockAfterCheckOutDays),
            maxPeople: num(room.maxPeople),
            minPrice: num(room.minPrice),
            cleaningFee: num(room.cleaningFee),
            securityDeposit: num(room.securityDeposit),
            taxPercentage: num(room.taxPercentage),
        },
        propiedad: {
            checkInStart: str(property.checkInStart),
            checkInEnd: str(property.checkInEnd),
            checkOutEnd: str(property.checkOutEnd),
            phone: str(property.phone),
            email: str(property.email),
            permit: str(property.permit),
            bookingType: rules.bookingType ?? null,
            bookingCutOffHour: num(rules.bookingCutOffHour),
            allowGuestCancellation: rules.allowGuestCancellation?.type ?? null,
            propertyDescription: str(texts.propertyDescription),
            houseRules: str(texts.houseRules),
            cancellationPolicy: str(texts.cancellationPolicy),
            generalPolicy: str(texts.generalPolicy),
        },
        textLanguage: texts.language || "es",
    };
}

async function getConfig() {
    const config = toConfig(await fetchPropertyRaw());
    return {
        reglas: { values: config.reglas, fields: REGLAS_FIELDS },
        propiedad: { values: config.propiedad, fields: PROPIEDAD_FIELDS },
        calendario: { overrides: OVERRIDE_OPTIONS, limits: CALENDAR_LIMITS, today: todayMadrid() },
    };
}

// ---------- Reglas de la casa ----------
async function planReglas(incoming) {
    const config = toConfig(await fetchPropertyRaw());
    const { errors, changes } = diffFields(REGLAS_FIELDS, config.reglas, incoming);

    // Mínima nunca mayor que máxima (con los valores que van a quedar)
    const final = { ...config.reglas };
    changes.forEach((c) => { final[c.key] = c.after; });
    if (!errors.minStay && !errors.maxStay && final.minStay !== null && final.maxStay !== null && final.minStay > final.maxStay) {
        errors.minStay = "No puede ser mayor que la estancia máxima.";
    }
    return { errors, changes };
}

async function applyReglas(incoming) {
    const { errors, changes } = await planReglas(incoming);
    if (Object.keys(errors).length) throw new ConfigError("DATOS_INVALIDOS", "Revisá los campos marcados.", 400, { errors });
    if (!changes.length) throw new ConfigError("SIN_CAMBIOS", "No hay cambios para aplicar.");

    const room = { id: ROOM_ID };
    changes.forEach((c) => { room[c.key] = c.after; });

    assertBeds24Ok(await beds24Request("/properties", {
        method: "POST",
        body: [{ id: PROPERTY_ID, roomTypes: [room] }],
    }));
    invalidateCalendarCache();
    invalidateViewCache();
    return changes;
}

// ---------- Datos y políticas ----------
async function planPropiedad(incoming) {
    const config = toConfig(await fetchPropertyRaw());
    const { errors, changes } = diffFields(PROPIEDAD_FIELDS, config.propiedad, incoming);
    return { errors, changes, textLanguage: config.textLanguage };
}

async function applyPropiedad(incoming) {
    const { errors, changes, textLanguage } = await planPropiedad(incoming);
    if (Object.keys(errors).length) throw new ConfigError("DATOS_INVALIDOS", "Revisá los campos marcados.", 400, { errors });
    if (!changes.length) throw new ConfigError("SIN_CAMBIOS", "No hay cambios para aplicar.");

    const payload = { id: PROPERTY_ID };
    const bookingRules = {};
    const texts = {};

    for (const c of changes) {
        if (TEXT_KEYS.includes(c.key)) texts[c.key] = c.after;
        else if (BOOKING_RULE_KEYS.includes(c.key)) bookingRules[c.key] = c.after;
        else if (c.key === "allowGuestCancellation") bookingRules.allowGuestCancellation = { type: c.after };
        else payload[c.key] = c.after;
    }
    if (Object.keys(bookingRules).length) payload.bookingRules = bookingRules;
    if (Object.keys(texts).length) payload.texts = [{ language: textLanguage, ...texts }];

    assertBeds24Ok(await beds24Request("/properties", { method: "POST", body: [payload] }));
    return changes;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Calendario
// ═══════════════════════════════════════════════════════════════════════════════
const isoWeekday = (date) => {
    const d = new Date(`${date}T00:00:00Z`).getUTCDay();
    return d === 0 ? 7 : d;          // 1 = lunes … 7 = domingo
};

async function fetchCalendarDays(from, to) {
    const data = await beds24Request("/inventory/rooms/calendar", {
        query: {
            roomId: ROOM_ID,
            startDate: from,
            endDate: to,
            includePrices: true,
            includeMinStay: true,
            includeMaxStay: true,
            includeOverride: true,
        },
    });
    const room = (data?.data || []).find((r) => Number(r.roomId) === ROOM_ID);
    const days = new Map();
    for (const range of room?.calendar || []) {
        for (let date = range.from; date <= range.to; date = addDays(date, 1)) {
            if (date < from || date > to) continue;
            days.set(date, {
                price: typeof range.price1 === "number" ? range.price1 : null,
                minStay: num(range.minStay),
                maxStay: num(range.maxStay),
                override: range.override || "none",
            });
        }
    }
    return days;
}

// ---------- Vista mensual (solo lectura) ----------
// Cada mes gasta 1 crédito de Beds24: se guarda 2 minutos y se borra
// cuando se aplica un cambio desde el panel.
const VIEW_TTL = 2 * 60 * 1000;
const viewCache = new Map();

function invalidateViewCache() {
    viewCache.clear();
}

async function getCalendarView(from, to) {
    const key = `${from}|${to}`;
    const hit = viewCache.get(key);
    if (hit && hit.expires > Date.now()) return hit.days;

    const map = await fetchCalendarDays(from, to);
    const days = [];
    for (let date = from; date <= to; date = addDays(date, 1)) {
        const d = map.get(date);
        days.push({
            date,
            price: d?.price ?? null,
            minStay: d?.minStay ?? null,
            maxStay: d?.maxStay ?? null,
            override: d?.override ?? "none",
        });
    }
    viewCache.set(key, { days, expires: Date.now() + VIEW_TTL });
    if (viewCache.size > 24) viewCache.delete(viewCache.keys().next().value);
    return days;
}

// Normaliza y valida el pedido. Devuelve { request } o lanza ConfigError.
function parseCalendarRequest(body, today) {
    const errors = {};
    const { from, to } = body || {};
    const L = CALENDAR_LIMITS;

    if (!isISODate(from)) errors.from = "Fecha no válida.";
    else if (from < today) errors.from = "No se pueden cambiar fechas pasadas.";
    if (!isISODate(to)) errors.to = "Fecha no válida.";
    else if (isISODate(from) && to < from) errors.to = "Tiene que ser igual o posterior a la fecha de inicio.";
    if (!errors.from && !errors.to && nightsBetween(from, to) + 1 > L.maxDays) {
        errors.to = `El rango máximo es de ${L.maxDays} días.`;
    }

    let weekdays = [1, 2, 3, 4, 5, 6, 7];
    if (body?.weekdays !== undefined) {
        const list = Array.isArray(body.weekdays) ? body.weekdays.map(Number) : [];
        const valid = [...new Set(list)].filter((d) => Number.isInteger(d) && d >= 1 && d <= 7);
        if (!valid.length || valid.length !== list.length) errors.weekdays = "Elegí al menos un día de la semana.";
        else weekdays = valid.sort();
    }

    const request = { from, to, weekdays, price: null, minStay: null, maxStay: null, override: null };

    if (body?.price) {
        const { mode } = body.price;
        const value = parseNumber(body.price.value);
        if (mode === "fixed") {
            if (!Number.isFinite(value) || value < L.price.min || value > L.price.max) {
                errors.price = `El precio tiene que estar entre ${L.price.min} y ${L.price.max} €.`;
            } else request.price = { mode, value: Math.round(value) };
        } else if (mode === "percent") {
            if (!Number.isFinite(value) || value === 0 || value < L.percent.min || value > L.percent.max) {
                errors.price = `El ajuste tiene que estar entre ${L.percent.min}% y +${L.percent.max}%, distinto de 0.`;
            } else request.price = { mode, value };
        } else {
            errors.price = "Tipo de cambio de precio no válido.";
        }
    }

    for (const key of ["minStay", "maxStay"]) {
        const raw = body?.[key];
        if (raw === undefined || raw === null || raw === "") continue;
        const n = parseNumber(raw);
        const lim = L[key];
        if (!Number.isInteger(n) || n < lim.min || n > lim.max) errors[key] = `Tiene que estar entre ${lim.min} y ${lim.max}.`;
        else request[key] = n;
    }
    if (request.minStay !== null && request.maxStay !== null && request.minStay > request.maxStay) {
        errors.minStay = "No puede ser mayor que la estancia máxima.";
    }

    if (body?.override !== undefined && body.override !== null && body.override !== "") {
        if (!OVERRIDE_OPTIONS.some((o) => o.value === body.override)) errors.override = "Opción no válida.";
        else request.override = body.override;
    }

    if (!Object.keys(errors).length && !request.price && request.minStay === null && request.maxStay === null && !request.override) {
        errors._ = "Elegí al menos una cosa para cambiar.";
    }
    if (Object.keys(errors).length) throw new ConfigError("DATOS_INVALIDOS", "Revisá los campos marcados.", 400, { errors });
    return request;
}

const FIELD_TO_BEDS24 = { price: "price1", minStay: "minStay", maxStay: "maxStay", override: "override" };
const formatDate = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

async function planCalendar(body) {
    const today = todayMadrid();
    const request = parseCalendarRequest(body, today);
    const [days, property] = await Promise.all([
        fetchCalendarDays(request.from, request.to),
        fetchPropertyRaw(),
    ]);
    const { reglas } = toConfig(property);
    const priceFloor = Math.max(CALENDAR_LIMITS.price.min, reglas.minPrice || 0);

    const changes = [];
    const skipped = [];
    const outOfRange = [];
    const conflicts = [];

    for (let date = request.from; date <= request.to; date = addDays(date, 1)) {
        const weekday = isoWeekday(date);
        if (!request.weekdays.includes(weekday)) continue;

        const before = days.get(date) || { price: null, minStay: null, maxStay: null, override: "none" };
        const after = { ...before };

        if (request.price?.mode === "fixed") after.price = request.price.value;
        if (request.price?.mode === "percent") {
            if (before.price === null) skipped.push({ date, reason: "No tiene precio cargado: el ajuste no se aplica." });
            else after.price = Math.round(before.price * (1 + request.price.value / 100));
        }
        if (request.minStay !== null) after.minStay = request.minStay;
        if (request.maxStay !== null) after.maxStay = request.maxStay;
        if (request.override) after.override = request.override;

        if (after.price !== null && after.price !== before.price && (after.price < priceFloor || after.price > CALENDAR_LIMITS.price.max)) {
            outOfRange.push(date);
        }
        const effMin = after.minStay ?? reglas.minStay;
        const effMax = after.maxStay ?? reglas.maxStay;
        if (effMin !== null && effMax !== null && effMin > effMax) conflicts.push(date);

        const fields = Object.keys(FIELD_TO_BEDS24).filter((k) => after[k] !== before[k]);
        if (fields.length) changes.push({ date, weekday, before, after, fields });
    }

    if (outOfRange.length) {
        throw new ConfigError("PRECIO_FUERA_DE_RANGO",
            `El precio resultante queda fuera de ${priceFloor}–${CALENDAR_LIMITS.price.max} € en ${outOfRange.length} día(s), por ejemplo el ${formatDate(outOfRange[0])}.`,
            400, { dates: outOfRange.slice(0, 20) });
    }
    if (conflicts.length) {
        throw new ConfigError("MINIMA_MAYOR_QUE_MAXIMA",
            `La estancia mínima quedaría mayor que la máxima en ${conflicts.length} día(s), por ejemplo el ${formatDate(conflicts[0])}.`,
            400, { dates: conflicts.slice(0, 20) });
    }

    // Agrupa días seguidos con exactamente el mismo cambio en un solo rango
    const ranges = [];
    for (const change of changes) {
        const payload = {};
        change.fields.forEach((k) => { payload[FIELD_TO_BEDS24[k]] = change.after[k]; });
        const key = JSON.stringify(payload);
        const last = ranges[ranges.length - 1];
        if (last && last._key === key && addDays(last.to, 1) === change.date) {
            last.to = change.date;
        } else {
            ranges.push({ _key: key, from: change.date, to: change.date, ...payload });
        }
    }

    return {
        request,
        changes,
        skipped,
        ranges: ranges.map(({ _key, ...r }) => r),
    };
}

async function applyCalendar(body) {
    const plan = await planCalendar(body);
    if (!plan.changes.length) throw new ConfigError("SIN_CAMBIOS", "Las fechas elegidas ya tienen esos valores.");

    for (let i = 0; i < plan.ranges.length; i += RANGES_PER_REQUEST) {
        const chunk = plan.ranges.slice(i, i + RANGES_PER_REQUEST);
        assertBeds24Ok(await beds24Request("/inventory/rooms/calendar", {
            method: "POST",
            body: [{ roomId: ROOM_ID, calendar: chunk }],
        }));
    }
    invalidateCalendarCache();
    invalidateViewCache();
    return plan;
}

module.exports = {
    ConfigError,
    getConfig,
    planReglas, applyReglas,
    planPropiedad, applyPropiedad,
    planCalendar, applyCalendar,
    getCalendarView,
};