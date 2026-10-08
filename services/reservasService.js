// services/reservasService.js — Quinta de Argos
// Toda la lógica de fechas, tarifas y precio de una reserva.
// El front solo propone fechas; aquí se decide si se pueden reservar y cuánto cuestan.
//
// Convención: las fechas viajan siempre como texto "YYYY-MM-DD" (fecha de calendario,
// sin hora ni zona). Una "noche" se identifica por el día en que empieza:
// llegada 10/11 y salida 13/11 = noches 10, 11 y 12.

const { VIGENCIA, TARIFAS } = require("../data/tarifas");
const {
    MIN_DIAS_ANTELACION,
    MIN_HORAS_ANTELACION,
    HORIZONTE_DIAS,
    MAX_NOCHES,
    MAX_HUESPEDES,
    ZONA_HORARIA,
    ADICIONALES,
} = require("../config/reservasConfig");

class ReservaError extends Error {
    constructor(codigo, message, status = 400, extra = {}) {
        super(message);
        this.name = "ReservaError";
        this.codigo = codigo;
        this.status = status;
        this.extra = extra;
    }
}

// ---------- Fechas ----------
const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;

function esFechaValida(str) {
    if (typeof str !== "string" || !FECHA_RE.test(str)) return false;
    const d = new Date(`${str}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === str;
}

function sumarDias(fecha, dias) {
    const d = new Date(`${fecha}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + dias);
    return d.toISOString().slice(0, 10);
}

function diferenciaDias(hasta, desde) {
    return Math.round((Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${desde}T00:00:00Z`)) / 86_400_000);
}

// "Hoy" en España, aunque el servidor esté en otra zona horaria.
function hoyEnEspana(ahora = new Date()) {
    return new Intl.DateTimeFormat("en-CA", {
        timeZone: ZONA_HORARIA,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).format(ahora);
}

function formatoFechaLarga(fecha) {
    return new Date(`${fecha}T00:00:00Z`).toLocaleDateString("es-ES", {
        timeZone: "UTC",
        day: "numeric",
        month: "long",
        year: "numeric",
    });
}

function limitesReserva(ahora = new Date()) {
    const hoy = hoyEnEspana(ahora);
    return {
        hoy,
        primeraLlegada: sumarDias(hoy, MIN_DIAS_ANTELACION),
        ultimaNoche: sumarDias(hoy, HORIZONTE_DIAS),
    };
}

// ---------- Tarifas ----------
// Devuelve { precio, minNoches } o null si ese día no se vende online.
function tarifaDe(fecha) {
    if (fecha < VIGENCIA.desde || fecha > VIGENCIA.hasta) return null;
    const t = TARIFAS[fecha.slice(5)];
    if (!t || typeof t.precio !== "number" || !(t.precio > 0)) return null;
    const minNoches = Number.isInteger(t.minNoches) && t.minNoches > 0 ? t.minNoches : 1;
    return { precio: t.precio, minNoches };
}

// ---------- Calendario público ----------
/**
 * Estado de cada noche entre hoy y el final del horizonte.
 *   libre       se puede reservar (incluye precio y estancia mínima)
 *   ocupado     ya reservado o bloqueado en Beds24
 *   sin_tarifa  no tiene precio cargado: no se vende online
 *   antelacion  dentro de las 72 h mínimas
 */
function construirCalendario(ocupadas, ahora = new Date()) {
    const { hoy, primeraLlegada, ultimaNoche } = limitesReserva(ahora);
    const dias = {};

    for (let fecha = hoy; fecha <= ultimaNoche; fecha = sumarDias(fecha, 1)) {
        if (fecha < primeraLlegada) {
            dias[fecha] = { estado: "antelacion" };
            continue;
        }
        if (ocupadas.has(fecha)) {
            dias[fecha] = { estado: "ocupado" };
            continue;
        }
        const tarifa = tarifaDe(fecha);
        if (!tarifa) {
            dias[fecha] = { estado: "sin_tarifa" };
            continue;
        }
        dias[fecha] = { estado: "libre", precio: tarifa.precio, minNoches: tarifa.minNoches };
    }

    return { hoy, primeraLlegada, ultimaNoche, dias };
}

// ---------- Presupuesto (fuente de verdad del precio) ----------
/**
 * Valida una reserva y calcula su precio. Lanza ReservaError si algo no cuadra.
 * @param {{checkIn:string, checkOut:string, guests:number, adicionales?:string[]}} datos
 * @param {Set<string>} ocupadas  noches ocupadas según Beds24
 */
function cotizarReserva(datos, ocupadas, ahora = new Date()) {
    const { checkIn, checkOut } = datos ?? {};
    const guests = Number(datos?.guests);
    const adicionalesPedidos = datos?.adicionales ?? [];

    if (!esFechaValida(checkIn) || !esFechaValida(checkOut)) {
        throw new ReservaError("FECHAS_INVALIDAS", "Las fechas no son válidas.");
    }
    if (checkOut <= checkIn) {
        throw new ReservaError("FECHAS_INVALIDAS", "La fecha de salida debe ser posterior a la de llegada.");
    }

    const { primeraLlegada, ultimaNoche } = limitesReserva(ahora);
    if (checkIn < primeraLlegada) {
        throw new ReservaError(
            "ANTELACION",
            `Las reservas requieren un mínimo de ${MIN_HORAS_ANTELACION} horas de antelación.`
        );
    }

    const noches = diferenciaDias(checkOut, checkIn);
    if (sumarDias(checkOut, -1) > ultimaNoche) {
        throw new ReservaError("FUERA_DE_RANGO", "Todavía no se puede reservar con tanta antelación.");
    }
    if (noches > MAX_NOCHES) {
        throw new ReservaError("DEMASIADAS_NOCHES", `La estancia máxima es de ${MAX_NOCHES} noches.`);
    }

    if (!Number.isInteger(guests) || guests < 1 || guests > MAX_HUESPEDES) {
        throw new ReservaError("HUESPEDES_INVALIDOS", `El número de huéspedes debe estar entre 1 y ${MAX_HUESPEDES}.`);
    }

    const desglose = [];
    for (let fecha = checkIn; fecha < checkOut; fecha = sumarDias(fecha, 1)) {
        if (ocupadas.has(fecha)) {
            throw new ReservaError(
                "NO_DISPONIBLE",
                `La noche del ${formatoFechaLarga(fecha)} ya no está disponible. Elige otras fechas.`,
                409
            );
        }
        const tarifa = tarifaDe(fecha);
        if (!tarifa) {
            throw new ReservaError(
                "SIN_TARIFA",
                `La noche del ${formatoFechaLarga(fecha)} no se puede reservar online. Escríbenos y te ayudamos.`,
                409
            );
        }
        desglose.push({ fecha, precio: tarifa.precio });
    }

    const minNoches = tarifaDe(checkIn).minNoches;
    if (noches < minNoches) {
        throw new ReservaError(
            "ESTANCIA_MINIMA",
            `Llegando el ${formatoFechaLarga(checkIn)}, la estancia mínima es de ${minNoches} noches.`,
            400,
            { minNoches }
        );
    }

    if (!Array.isArray(adicionalesPedidos) || adicionalesPedidos.some((id) => typeof id !== "string")) {
        throw new ReservaError("ADICIONAL_INVALIDO", "Los adicionales no son válidos.");
    }
    const adicionales = [...new Set(adicionalesPedidos)].map((id) => {
        const a = ADICIONALES.find((x) => x.id === id);
        if (!a) throw new ReservaError("ADICIONAL_INVALIDO", "Uno de los adicionales elegidos no existe.");
        return { id: a.id, nombre: a.nombre, precio: a.precio };
    });

    const alojamiento = desglose.reduce((s, n) => s + n.precio, 0);
    const totalAdicionales = adicionales.reduce((s, a) => s + a.precio, 0);
    const total = alojamiento + totalAdicionales;

    return {
        checkIn,
        checkOut,
        noches,
        guests,
        minNoches,
        desglose,
        alojamiento,
        adicionales,
        totalAdicionales,
        total,
        totalCentimos: Math.round(total * 100),
    };
}

module.exports = {
    ReservaError,
    esFechaValida,
    sumarDias,
    hoyEnEspana,
    limitesReserva,
    tarifaDe,
    construirCalendario,
    cotizarReserva,
};