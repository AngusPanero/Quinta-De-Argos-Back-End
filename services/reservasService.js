// services/reservasService.js — Quinta de Argos
// Toda la lógica de fechas, tarifas y precio de una reserva.
// El front solo propone fechas; aquí se decide si se pueden reservar y cuánto cuestan.
//
// Convención: las fechas viajan siempre como texto "YYYY-MM-DD" (fecha de calendario,
// sin hora ni zona). Una "noche" se identifica por el día en que empieza:
// llegada 10/11 y salida 13/11 = noches 10, 11 y 12.

const { tarifaDe: tarifaSegunReglas } = require("../data/tarifas");
const {
    MIN_DIAS_ANTELACION,
    MIN_HORAS_ANTELACION,
    HORIZONTE_DIAS,
    MAX_NOCHES,
    MAX_HUESPEDES,
    ZONA_HORARIA,
    DESCUENTO_WEB,
    ADICIONALES,
    // Fianza por persona en €. Si no está en config/reservasConfig.js, se usan 60 €.
    FIANZA_POR_PERSONA = 60,
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

// ---------- Precios de la web ----------
// Las reglas (data/tarifas.js) dan el precio de Beds24, Booking y Airbnb.
// La web cobra:
//   1) el precio fijado a mano para esa noche (panel → Configuración → Precios de la web), o
//   2) el precio de las reglas con el descuento general, redondeado al euro.
// El relleno diario de Beds24 no pasa por aquí: sigue usando el precio completo.
//
// Los precios a mano y el descuento viven en Mongo (models/PrecioWeb.js) y se guardan
// en memoria para que tarifaDe() siga siendo síncrona. Se recargan cada minuto, al
// guardar desde el panel y justo antes de cobrar (paymentsRouter → cargarPreciosWeb).

const preciosWeb = {
    manuales: new Map(), // fecha -> precio
    descuento: DESCUENTO_WEB,
    cargadoEn: 0,
};

async function cargarPreciosWeb() {
    try {
        const { PrecioWeb, AjustesWeb } = require("../models/PrecioWeb");
        const [filas, ajustes] = await Promise.all([
            PrecioWeb.find({}, { fecha: 1, precio: 1, _id: 0 }).lean(),
            AjustesWeb.findById("web").lean(),
        ]);
        preciosWeb.manuales = new Map(filas.map((f) => [f.fecha, f.precio]));
        preciosWeb.descuento = typeof ajustes?.descuento === "number" ? ajustes.descuento : DESCUENTO_WEB;
        preciosWeb.cargadoEn = Date.now();
    } catch (error) {
        // Si Mongo falla se siguen usando los últimos precios cargados.
        console.error("Precios web: no se pudieron cargar 🟠", error?.message || error);
    }
    return preciosWeb;
}

const RECARGA_MS = 60 * 1000;
setTimeout(cargarPreciosWeb, 0).unref?.();
setInterval(cargarPreciosWeb, RECARGA_MS).unref?.();

const descuentoWeb = () => preciosWeb.descuento;

/** Precio web automático (reglas con el descuento general) a partir del precio de las reglas. */
const precioWebAutomatico = (precioReglas, descuento = preciosWeb.descuento) => Math.round(precioReglas * (1 - descuento));

function tarifaDe(fecha) {
    const tarifa = tarifaSegunReglas(fecha);
    if (!tarifa) return null;
    const manual = preciosWeb.manuales.get(fecha);
    return {
        precio: manual ?? precioWebAutomatico(tarifa.precio),
        precioSinDescuento: tarifa.precio,
        minNoches: tarifa.minNoches,
        manual: manual !== undefined,
    };
}

// ---------- Calendario público ----------
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
        dias[fecha] = {
            estado: "libre",
            precio: tarifa.precio,
            precioSinDescuento: tarifa.precioSinDescuento,
            minNoches: tarifa.minNoches,
        };
    }

    return { hoy, primeraLlegada, ultimaNoche, dias };
}

// ---------- Huéspedes ----------
// Acepta { adultos, menores, cuna } o, en llamadas antiguas, solo { guests }
// (en ese caso todos cuentan como adultos y no hay cuna).
function leerHuespedes(datos) {
    const conDesglose = datos?.adultos !== undefined || datos?.menores !== undefined;
    const adultos = conDesglose ? Number(datos.adultos) : Number(datos?.guests);
    const menores = conDesglose ? Number(datos.menores ?? 0) : 0;

    if (!Number.isInteger(adultos) || adultos < 1) {
        throw new ReservaError("HUESPEDES_INVALIDOS", "Tiene que haber al menos una persona adulta (18 años o más).");
    }
    if (!Number.isInteger(menores) || menores < 0) {
        throw new ReservaError("HUESPEDES_INVALIDOS", "El número de menores no es válido.");
    }
    const guests = adultos + menores;
    if (guests > MAX_HUESPEDES) {
        throw new ReservaError("HUESPEDES_INVALIDOS", `El número de huéspedes debe estar entre 1 y ${MAX_HUESPEDES}.`);
    }

    // La cuna solo tiene sentido si viaja algún menor. No cambia el precio.
    const cuna = menores > 0 && (datos?.cuna === true || datos?.cuna === "true");
    return { adultos, menores, guests, cuna };
}

// ---------- Presupuesto (fuente de verdad del precio) ----------
/**
 * Valida una reserva y calcula su precio. Lanza ReservaError si algo no cuadra.
 * El total incluye la fianza (60 € por persona), que se devuelve al terminar la estancia
 * si la casa no tiene daños.
 * @param {{checkIn:string, checkOut:string, guests?:number, adultos?:number, menores?:number, cuna?:boolean, adicionales?:string[]}} datos
 * @param {Set<string>} ocupadas  noches ocupadas según Beds24
 */
function cotizarReserva(datos, ocupadas, ahora = new Date()) {
    const { checkIn, checkOut } = datos ?? {};
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

    const { adultos, menores, guests, cuna } = leerHuespedes(datos);

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

    // Sumas en céntimos para que no aparezcan decimales raros (374.29999…).
    const alojamientoCentimos = desglose.reduce((s, n) => s + Math.round(n.precio * 100), 0);
    const alojamiento = alojamientoCentimos / 100;
    const totalAdicionales = adicionales.reduce((s, a) => s + a.precio, 0);
    const estanciaCentimos = alojamientoCentimos + Math.round(totalAdicionales * 100);

    // Fianza: por persona (adultos y menores), se devuelve si la casa no tiene daños.
    const fianzaCentimos = guests * Math.round(FIANZA_POR_PERSONA * 100);
    const fianza = {
        porPersona: FIANZA_POR_PERSONA,
        personas: guests,
        total: fianzaCentimos / 100,
        totalCentimos: fianzaCentimos,
    };

    const totalCentimos = estanciaCentimos + fianzaCentimos;

    return {
        checkIn,
        checkOut,
        noches,
        guests,
        adultos,
        menores,
        cuna,
        minNoches,
        desglose,
        alojamiento,
        adicionales,
        totalAdicionales,
        totalEstancia: estanciaCentimos / 100, // alojamiento + adicionales (sin fianza)
        fianza,
        total: totalCentimos / 100, // lo que se cobra: estancia + fianza
        totalCentimos,
    };
}

module.exports = {
    ReservaError,
    esFechaValida,
    sumarDias,
    hoyEnEspana,
    limitesReserva,
    tarifaDe,
    tarifaSegunReglas,
    cargarPreciosWeb,
    descuentoWeb,
    precioWebAutomatico,
    construirCalendario,
    cotizarReserva,
    FIANZA_POR_PERSONA,
};