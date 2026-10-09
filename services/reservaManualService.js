// services/reservaManualService.js — Quinta de Argos
// Reservas que el propietario gestiona por su cuenta, creadas desde el panel:
//
//   particular  -> alquiler a un cliente propio (teléfono, WhatsApp, conocidos):
//                  reserva CONFIRMADA en Beds24 con nombre, huéspedes y precio.
//                  En el panel aparece como "Directa".
//   uso_propio  -> la casa la usa el propietario: reserva de BLOQUEO ("black")
//                  en Beds24. En el panel aparece como "Uso propio".
//
// En los dos casos Beds24 bloquea las fechas en Booking y Airbnb, igual que
// cualquier reserva, y al cancelarla se vuelven a abrir.
//
// Cerrar fechas desde Configuración (override "blackout") NO es una reserva:
// solo cierra. Si se crea una reserva sobre fechas cerradas a mano, se puede
// quitar ese cierre para que, si la reserva se cancela, las fechas se abran solas.

const crypto = require("crypto");
const { MAX_HUESPEDES } = require("../config/reservasConfig");
const { esFechaValida, sumarDias, hoyEnEspana } = require("./reservasService");
const { crearReservaBeds24, reservasQueSolapan, nochesConCierre, quitarCierres } = require("./beds24BookingsService");
const { separarNombre } = require("./reservaWebBeds24Service");

const TIPOS = ["particular", "uso_propio"];
const MAX_NOCHES_MANUAL = 365;
const MAX_PRECIO = 50000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TELEFONO_RE = /^\+?[\d\s().-]{7,20}$/;

// Así se ven en Beds24 (campo "referer") y en el panel.
const REFERER = { particular: "Particular", uso_propio: "Uso propio" };

const ETIQUETA_CANAL = { airbnb: "Airbnb", booking: "Booking" };

class GestionError extends Error {
    constructor(codigo, message, status = 400, extra = {}) {
        super(message);
        this.name = "GestionError";
        this.codigo = codigo;
        this.status = status;
        this.extra = extra;
    }
}

function texto(valor, max) {
    return typeof valor === "string" ? valor.trim().replace(/\s+/g, " ").slice(0, max) : "";
}

const diasEntre = (desde, hasta) => Math.round((Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${desde}T00:00:00Z`)) / 86_400_000);

/** "1.250,50" / "1250.5" / 1250.5 -> 1250.5 (o NaN) */
function leerEuros(valor) {
    if (typeof valor === "number") return valor;
    if (typeof valor !== "string" || !valor.trim()) return NaN;
    let v = valor.trim().replace(/\s|€/g, "");
    if (v.includes(",")) v = v.replace(/\./g, "").replace(",", ".");
    return /^\d+(\.\d{1,2})?$/.test(v) ? Number(v) : NaN;
}

/** Valida lo que manda el panel. Devuelve los datos limpios o lanza GestionError con un error por campo. */
function validarReservaManual(body = {}, hoy = hoyEnEspana()) {
    const errors = {};
    const tipo = TIPOS.includes(body.tipo) ? body.tipo : null;
    if (!tipo) errors.tipo = "Elige si es una reserva particular o uso propio.";

    const checkIn = body.checkIn;
    const checkOut = body.checkOut;
    if (!esFechaValida(checkIn)) errors.checkIn = "Fecha de llegada no válida.";
    else if (checkIn < hoy) errors.checkIn = "La llegada no puede ser anterior a hoy.";
    if (!esFechaValida(checkOut)) errors.checkOut = "Fecha de salida no válida.";
    else if (esFechaValida(checkIn) && checkOut <= checkIn) errors.checkOut = "La salida tiene que ser posterior a la llegada.";

    const noches = !errors.checkIn && !errors.checkOut ? diasEntre(checkIn, checkOut) : 0;
    if (noches > MAX_NOCHES_MANUAL) errors.checkOut = `Como máximo ${MAX_NOCHES_MANUAL} noches de una vez.`;

    const datos = { tipo, checkIn, checkOut, noches, notas: texto(body.notas, 500), quitarCierre: body.quitarCierre !== false };

    if (tipo === "particular") {
        datos.nombre = texto(body.nombre, 120);
        datos.email = texto(body.email, 200).toLowerCase();
        datos.telefono = texto(body.telefono, 40);
        datos.huespedes = Number(body.huespedes);
        datos.precio = leerEuros(body.precio);

        if (datos.nombre.length < 2) errors.nombre = "Indica el nombre del cliente.";
        if (datos.email && !EMAIL_RE.test(datos.email)) errors.email = "Correo electrónico no válido.";
        if (datos.telefono && !TELEFONO_RE.test(datos.telefono)) errors.telefono = "Teléfono no válido.";
        if (!Number.isInteger(datos.huespedes) || datos.huespedes < 1 || datos.huespedes > MAX_HUESPEDES) {
            errors.huespedes = `Entre 1 y ${MAX_HUESPEDES} huéspedes.`;
        }
        if (!Number.isFinite(datos.precio) || datos.precio < 0 || datos.precio > MAX_PRECIO) {
            errors.precio = `Indica el precio total de la estancia (de 0 a ${MAX_PRECIO.toLocaleString("es-ES")} €).`;
        }
    } else if (tipo === "uso_propio") {
        datos.nombre = texto(body.nombre, 120) || "Uso propio";
        datos.huespedes = 1;
        datos.precio = 0;
    }

    if (Object.keys(errors).length) {
        throw new GestionError("DATOS_INVALIDOS", "Revisa los campos marcados.", 400, { errors });
    }
    return datos;
}

function datosParaBeds24(d) {
    const referencia = `QA-M-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
    const notas = [`Creada desde el panel web (${REFERER[d.tipo].toLowerCase()}).`, d.notas].filter(Boolean).join("\n");

    if (d.tipo === "uso_propio") {
        return {
            status: "black",
            arrival: d.checkIn,
            departure: d.checkOut,
            numAdult: 1,
            firstName: d.nombre,
            lastName: "",
            price: 0,
            referer: REFERER.uso_propio,
            apiReference: referencia,
            notes: notas,
        };
    }

    const { firstName, lastName } = separarNombre(d.nombre);
    return {
        status: "confirmed",
        arrival: d.checkIn,
        departure: d.checkOut,
        numAdult: d.huespedes,
        numChild: 0,
        firstName,
        lastName,
        email: d.email || undefined,
        phone: d.telefono || undefined,
        price: d.precio,
        referer: REFERER.particular,
        apiReference: referencia,
        notes: notas,
    };
}

function describirConflicto(b) {
    const quien = [b.firstName, b.lastName].filter(Boolean).join(" ");
    const origen = b.status === "black" ? "Uso propio" : ETIQUETA_CANAL[b.channel] || b.referer || "Reserva";
    return {
        beds24Id: b.id,
        origen,
        nombre: quien || null,
        checkIn: b.arrival,
        checkOut: b.departure,
    };
}

/**
 * Valida y comprueba en Beds24 (sin escribir nada) si se puede crear.
 * @returns {Promise<{ datos, conflictos, cierres }>}
 */
async function planificarReservaManual(body) {
    const datos = validarReservaManual(body);
    const [solapes, cierres] = await Promise.all([
        reservasQueSolapan(datos.checkIn, datos.checkOut),
        nochesConCierre(datos.checkIn, datos.checkOut),
    ]);
    return { datos, conflictos: solapes.map(describirConflicto), cierres };
}

/**
 * Crea la reserva en Beds24. Vuelve a comprobar todo desde cero (no se fía de la vista previa).
 * Si las fechas tenían un cierre manual y quitarCierre es true, lo quita DESPUÉS de crear
 * la reserva, para que las fechas nunca queden abiertas sin reserva.
 */
async function crearReservaManual(body) {
    const { datos, conflictos, cierres } = await planificarReservaManual(body);
    if (conflictos.length) {
        throw new GestionError("FECHAS_OCUPADAS", "Esas fechas ya tienen otra reserva. Revisa el calendario.", 409, {
            conflictos,
        });
    }

    const bookingId = await crearReservaBeds24(datosParaBeds24(datos));

    let aviso = null;
    let cierresQuitados = [];
    if (datos.quitarCierre && cierres.length) {
        try {
            await quitarCierres(cierres);
            cierresQuitados = cierres;
        } catch (error) {
            console.error("La reserva se creó pero no se pudo quitar el cierre de las fechas 🟠", error.message);
            aviso = "La reserva se creó, pero esas fechas siguen con el cierre manual. Si la cancelas, ábrelas desde «Precios y disponibilidad».";
        }
    }

    return { bookingId, datos, cierresQuitados, aviso };
}

module.exports = {
    GestionError,
    validarReservaManual,
    planificarReservaManual,
    crearReservaManual,
    leerEuros,
    REFERER,
    MAX_NOCHES_MANUAL,
};