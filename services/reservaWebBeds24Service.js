// services/reservaWebBeds24Service.js — Quinta de Argos
// Reservas pagadas en la web:
//   sincronizarReservaWeb  -> crea la reserva en Beds24 (la llama el webhook de Stripe)
//   cancelarReservaWeb     -> la cancela en Beds24 y devuelve el dinero (total, parcial o nada)
//
// Todo es idempotente: si el webhook de Stripe llega dos veces o se reintenta
// una cancelación a medias, no se duplica nada.

const { stripe } = require("../config/stripe");
const { getNochesOcupadas, invalidarCacheDisponibilidad } = require("./beds24AvailabilityService");
const {
    crearReservaBeds24,
    cancelarReservaBeds24,
    buscarPorReferencia,
    invalidarCachesPanel,
} = require("./beds24BookingsService");
const { sumarDias } = require("./reservasService");

// Tiene que coincidir con WEB_REFERER de services/bookingSync.js:
// así el panel muestra estas reservas como "Web".
const WEB_REFERER = "quintadeargos.com";

class CancelacionError extends Error {
    constructor(codigo, message, status = 400, extra = {}) {
        super(message);
        this.name = "CancelacionError";
        this.codigo = codigo;
        this.status = status;
        this.extra = extra;
    }
}

function separarNombre(nombreCompleto = "") {
    const partes = nombreCompleto.trim().split(/\s+/).filter(Boolean);
    return { firstName: partes[0] || "", lastName: partes.slice(1).join(" ") };
}

function nochesDe(checkIn, checkOut) {
    const noches = [];
    for (let f = checkIn; f < checkOut; f = sumarDias(f, 1)) noches.push(f);
    return noches;
}

const euros = (centimos) => (centimos / 100).toLocaleString("es-ES", { minimumFractionDigits: 0, maximumFractionDigits: 2 });

function datosParaBeds24(reserva, { prueba }) {
    const { firstName, lastName } = separarNombre(reserva.contacto.nombre);
    const adicionales = reserva.importes.adicionales.map((a) => `${a.nombre} (${a.precio} €)`).join(", ");
    const notas = [
        prueba ? "[PRUEBA] Pago en modo test de Stripe: cancela esta reserva cuando termines de probar." : null,
        `Reserva web ${reserva.codigo}. Pagada con Stripe: ${reserva.importes.total} € (${reserva.pago.paymentIntentId}).`,
        adicionales ? `Adicionales: ${adicionales}.` : null,
    ]
        .filter(Boolean)
        .join("\n");

    return {
        status: "confirmed",
        arrival: reserva.estancia.checkIn,
        departure: reserva.estancia.checkOut,
        numAdult: reserva.estancia.huespedes,
        numChild: 0,
        firstName: prueba ? `[PRUEBA] ${firstName}` : firstName,
        lastName,
        email: reserva.contacto.email,
        phone: reserva.contacto.telefono,
        price: reserva.importes.total,
        referer: WEB_REFERER,
        apiReference: reserva.codigo,
        notes: notas.slice(0, 1500),
    };
}

// Alguien reservó esas noches (Booking, Airbnb...) mientras este huésped pagaba:
// no se puede alojar a los dos, así que se le devuelve todo automáticamente.
async function reembolsarPorConflicto(reserva, nochesOcupadas) {
    const yaDevuelto = reserva.cancelacion?.reembolsoCentimos || 0;
    const importe = reserva.importes.totalCentimos - yaDevuelto;
    let refundId = null;

    if (importe > 0) {
        const refund = await stripe.refunds.create(
            {
                payment_intent: reserva.pago.paymentIntentId,
                amount: importe,
                reason: "requested_by_customer",
                metadata: { reservaId: String(reserva._id), codigo: reserva.codigo, motivo: "fechas_ocupadas" },
            },
            { idempotencyKey: `conflicto-${reserva._id}` }
        );
        refundId = refund.id;
    }

    const motivo = `Fechas ocupadas por otra reserva mientras se pagaba (${nochesOcupadas.join(", ")}): reembolso automático`;
    reserva.cancelacion = {
        fecha: new Date(),
        motivo,
        por: "sistema",
        reembolsoCentimos: yaDevuelto + importe,
        refundIds: [...(reserva.cancelacion?.refundIds || []), ...(refundId ? [refundId] : [])],
        beds24Cancelada: true, // nunca llegó a existir en Beds24
    };
    reserva.beds24.error = motivo.slice(0, 300);
    reserva.cambiarEstado("reembolsada", motivo.slice(0, 300));
    await reserva.save();

    // TODO (emails con Brevo): avisar al huésped y al propietario.
    console.error(`🔴 CONFLICTO: reserva ${reserva.codigo} reembolsada (${euros(importe)} €). Noches ocupadas: ${nochesOcupadas.join(", ")}`);
}

/**
 * Crea en Beds24 una reserva web ya pagada.
 * Lanza error si Beds24 o Stripe fallan: el webhook responde 500 y Stripe lo reintenta.
 * @returns {Promise<{ estado: "creada"|"ya_existia"|"ya_sincronizada"|"conflicto"|"no_aplica", bookingId?: string }>}
 */
async function sincronizarReservaWeb(reserva, { prueba = false } = {}) {
    if (reserva.beds24?.bookingId) return { estado: "ya_sincronizada", bookingId: reserva.beds24.bookingId };
    if (reserva.estado !== "pagada") return { estado: "no_aplica" };

    const { checkIn, checkOut } = reserva.estancia;
    reserva.beds24.intentos = (reserva.beds24.intentos || 0) + 1;

    try {
        // 1) ¿La creamos en un intento anterior y no llegó a guardarse el id?
        const existente = await buscarPorReferencia(reserva.codigo, checkIn);
        if (existente) {
            reserva.beds24.bookingId = String(existente.id);
            reserva.beds24.sincronizadoEn = new Date();
            reserva.beds24.error = "";
            await reserva.save();
            return { estado: "ya_existia", bookingId: reserva.beds24.bookingId };
        }

        // 2) ¿Se ocuparon esas noches mientras pagaba? (en fresco, sin caché)
        const ocupadas = await getNochesOcupadas(checkIn, sumarDias(checkOut, -1), { fresco: true });
        const choque = nochesDe(checkIn, checkOut).filter((n) => ocupadas.has(n));
        if (choque.length) {
            await reembolsarPorConflicto(reserva, choque);
            return { estado: "conflicto" };
        }

        // 3) Crear la reserva: Beds24 la reparte a Booking y Airbnb.
        const bookingId = await crearReservaBeds24(datosParaBeds24(reserva, { prueba }));
        reserva.beds24.bookingId = bookingId;
        reserva.beds24.sincronizadoEn = new Date();
        reserva.beds24.error = "";
        await reserva.save();

        invalidarCacheDisponibilidad();
        invalidarCachesPanel();
        console.log(`📅 Reserva ${reserva.codigo} creada en Beds24 (#${bookingId})`);
        return { estado: "creada", bookingId };
    } catch (error) {
        reserva.beds24.error = String(error.message || error).slice(0, 300);
        await reserva.save().catch(() => {});
        throw error;
    }
}

/**
 * Cancela una reserva web pagada: primero en Beds24 (libera las fechas) y luego
 * el reembolso en Stripe. Si se corta a mitad, se puede repetir sin duplicar nada.
 *
 * @param {import('mongoose').Document} reserva
 * @param {{ reembolso: "total"|"parcial"|"ninguno", importeCentimos?: number, motivo?: string, por?: string }} opciones
 */
async function cancelarReservaWeb(reserva, { reembolso, importeCentimos, motivo = "", por = "admin" }) {
    const yaCancelada = reserva.estado === "cancelada" || reserva.estado === "reembolsada";
    if (!yaCancelada && reserva.estado !== "pagada") {
        throw new CancelacionError(
            "ESTADO_NO_VALIDO",
            "Solo se pueden cancelar reservas pagadas. Esta no llegó a cobrarse.",
            409
        );
    }
    if (!["total", "parcial", "ninguno"].includes(reembolso)) {
        throw new CancelacionError("DATOS_INVALIDOS", "Elige el tipo de reembolso.", 400, {
            errors: { reembolso: "Elige total, parcial o sin reembolso." },
        });
    }

    const yaDevuelto = reserva.cancelacion?.reembolsoCentimos || 0;
    const maximo = reserva.importes.totalCentimos - yaDevuelto;
    let importe = 0;
    if (reembolso === "total") importe = maximo;
    if (reembolso === "parcial") {
        if (!Number.isInteger(importeCentimos) || importeCentimos < 1 || importeCentimos > maximo) {
            throw new CancelacionError("DATOS_INVALIDOS", `El reembolso tiene que estar entre 0,01 € y ${euros(maximo)} €.`, 400, {
                errors: { importe: `Entre 0,01 € y ${euros(maximo)} €.` },
            });
        }
        importe = importeCentimos;
    }
    if (yaCancelada && importe === 0) {
        throw new CancelacionError("YA_CANCELADA", "Esta reserva ya está cancelada.", 409);
    }

    const textoMotivo = String(motivo || "").trim().slice(0, 300);
    if (!reserva.cancelacion) reserva.cancelacion = {};
    if (!reserva.cancelacion.fecha) {
        reserva.cancelacion.fecha = new Date();
        reserva.cancelacion.motivo = textoMotivo;
        reserva.cancelacion.por = por;
    }

    // 1) Beds24: libera las fechas en todos los canales.
    if (reserva.beds24?.bookingId && !reserva.cancelacion.beds24Cancelada) {
        await cancelarReservaBeds24(reserva.beds24.bookingId);
        reserva.cancelacion.beds24Cancelada = true;
        await reserva.save();
        invalidarCacheDisponibilidad();
        invalidarCachesPanel();
    }

    // 2) Stripe: el reembolso (va a la misma tarjeta; tarda de 5 a 10 días en verse).
    if (importe > 0) {
        const refund = await stripe.refunds.create(
            {
                payment_intent: reserva.pago.paymentIntentId,
                amount: importe,
                reason: "requested_by_customer",
                metadata: { reservaId: String(reserva._id), codigo: reserva.codigo },
            },
            // misma petición repetida = mismo reembolso, nunca dos
            { idempotencyKey: `cancelacion-${reserva._id}-${yaDevuelto}-${importe}` }
        );
        reserva.cancelacion.reembolsoCentimos = yaDevuelto + importe;
        reserva.cancelacion.refundIds = [...(reserva.cancelacion.refundIds || []), refund.id];
    }

    // 3) Estado final
    const totalDevuelto = reserva.cancelacion.reembolsoCentimos || 0;
    const detalle = [
        totalDevuelto > 0 ? `reembolso de ${euros(totalDevuelto)} €` : "sin reembolso",
        textoMotivo,
    ]
        .filter(Boolean)
        .join(" · ");
    reserva.cambiarEstado(totalDevuelto > 0 ? "reembolsada" : "cancelada", `Cancelada por ${por}: ${detalle}`.slice(0, 300));
    await reserva.save();

    return { reembolsoCentimos: importe, totalDevueltoCentimos: totalDevuelto };
}

module.exports = { sincronizarReservaWeb, cancelarReservaWeb, CancelacionError, WEB_REFERER, separarNombre };