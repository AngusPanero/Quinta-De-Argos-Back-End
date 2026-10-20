// services/reservaWebBeds24Service.js — Quinta de Argos
// Reservas pagadas en la web:
//   sincronizarReservaWeb  -> crea la reserva en Beds24 (la llama el webhook de Stripe)
//   cancelarReservaWeb     -> la cancela en Beds24 y devuelve el dinero (total, parcial o nada)
//   devolverFianza         -> devuelve la fianza (toda o una parte) al terminar la estancia
//   reembolsarStripe       -> devuelve un importe repartiéndolo entre los pagos de la reserva
//                             (el original y los de ampliaciones con link de Stripe)
//
// Todo es idempotente: si el webhook de Stripe llega dos veces o se reintenta
// una cancelación a medias, no se duplica nada.
//
// sincronizarReservaWeb además toma un bloqueo atómico en Mongo: si el mismo pago
// llega a la vez a dos procesos (por ejemplo, el back local con `stripe listen` y
// el de Render con el endpoint del Dashboard), solo uno crea la reserva en Beds24.
// Sin esto, el segundo veía las noches ocupadas por la reserva que acababa de crear
// el primero, lo tomaba por un conflicto y reembolsaba al huésped.
//
// IMPORTES:
//   importes.totalCentimos   valor ACTUAL de la estancia con la fianza (cambia con las modificaciones)
//   cobrado por Stripe       pago.importeCentimos (pago original) + pagosExtra de Stripe
//   devuelto por Stripe      cancelación + fianza devuelta + reembolsos de modificaciones
//   Lo que se puede devolver por Stripe = cobrado - devuelto. Lo pagado por transferencia
//   lo gestiona el propietario aparte.
//
// FIANZA: a Beds24 se manda solo el precio de la estancia (sin fianza), para que
// Booking/Airbnb y los informes de Beds24 no vean un importe inflado.

const { stripe } = require("../config/stripe");
const { getNochesOcupadas, invalidarCacheDisponibilidad } = require("./beds24AvailabilityService");
const {
    crearReservaBeds24,
    cancelarReservaBeds24,
    liberarSiSigueActiva,
    estadoReservaBeds24,
    ESTADOS_QUE_OCUPAN,
    buscarPorReferencia,
    invalidarCachesPanel,
} = require("./beds24BookingsService");
const { sumarDias } = require("./reservasService");

// Beds24 guarda las reservas por API con referer "API": el panel las reconoce
// como "Web" cruzando beds24Id con reserva.beds24.bookingId (services/bookingSync.js).
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

// ---------- Fianza y estancia ----------
const fianzaCentimosDe = (reserva) => reserva.importes?.fianza?.totalCentimos || 0;
const fianzaDevueltaDe = (reserva) => reserva.devolucionFianza?.centimos || 0;
const estanciaCentimosDe = (reserva) => (reserva.importes?.totalCentimos || 0) - fianzaCentimosDe(reserva);

// ---------- Dinero cobrado y devuelto por Stripe ----------

/** Lo cobrado en el pago original (en reservas antiguas, el total de la reserva). */
const pagoOriginalDe = (reserva) =>
    typeof reserva.pago?.importeCentimos === "number" ? reserva.pago.importeCentimos : reserva.importes?.totalCentimos || 0;

const pagosExtraStripe = (reserva) =>
    (reserva.pagosExtra || []).filter((p) => p.metodo === "stripe" && p.paymentIntentId);

function cobradoStripeDe(reserva) {
    return pagoOriginalDe(reserva) + pagosExtraStripe(reserva).reduce((s, p) => s + (p.centimos || 0), 0);
}

function devueltoStripeDe(reserva) {
    const porModificaciones = (reserva.modificaciones || []).reduce((s, m) => s + (m.reembolsoCentimos || 0), 0);
    return (reserva.cancelacion?.reembolsoCentimos || 0) + fianzaDevueltaDe(reserva) + porModificaciones;
}

/** Lo que todavía se puede devolver por Stripe. */
const maximoStripeDe = (reserva) => Math.max(cobradoStripeDe(reserva) - devueltoStripeDe(reserva), 0);

/** Pagos de Stripe de la reserva, el original primero. */
function paymentIntentsDe(reserva) {
    return [reserva.pago?.paymentIntentId, ...pagosExtraStripe(reserva).map((p) => p.paymentIntentId)].filter(Boolean);
}

/**
 * Devuelve `importe` céntimos repartiéndolo entre los pagos de Stripe de la reserva
 * (primero el original, después las ampliaciones). Comprueba antes que haya saldo
 * suficiente en Stripe, para no dejar un reembolso a medias.
 * @returns {Promise<string[]>} ids de los reembolsos creados (re_...)
 */
async function reembolsarStripe(reserva, importe, { motivo = "", clave }) {
    if (!Number.isInteger(importe) || importe <= 0) return [];

    // 1) Cuánto queda por devolver en cada pago, según Stripe
    const disponibles = [];
    for (const pi of paymentIntentsDe(reserva)) {
        const intent = await stripe.paymentIntents.retrieve(pi, { expand: ["latest_charge"] });
        const charge = intent.latest_charge && typeof intent.latest_charge === "object" ? intent.latest_charge : null;
        const disponible = charge ? charge.amount - (charge.amount_refunded || 0) : 0;
        if (disponible > 0) disponibles.push({ pi, disponible });
    }
    const totalDisponible = disponibles.reduce((s, d) => s + d.disponible, 0);
    if (totalDisponible < importe) {
        throw new CancelacionError(
            "STRIPE_SIN_SALDO",
            `En Stripe solo quedan ${euros(totalDisponible)} € por devolver de esta reserva. Lo pagado por transferencia se devuelve por transferencia.`,
            409
        );
    }

    // 2) Reembolsos
    const ids = [];
    let restante = importe;
    for (const { pi, disponible } of disponibles) {
        if (restante <= 0) break;
        const parte = Math.min(disponible, restante);
        const refund = await stripe.refunds.create(
            {
                payment_intent: pi,
                amount: parte,
                reason: "requested_by_customer",
                metadata: { reservaId: String(reserva._id), codigo: reserva.codigo, motivo },
            },
            // misma petición repetida = mismo reembolso, nunca dos
            { idempotencyKey: `${clave}-${pi}-${parte}` }
        );
        ids.push(refund.id);
        restante -= parte;
    }
    return ids;
}

function datosParaBeds24(reserva, { prueba }) {
    const { firstName, lastName } = separarNombre(reserva.contacto.nombre);
    const e = reserva.estancia;
    const adultos = typeof e.adultos === "number" && e.adultos > 0 ? e.adultos : e.huespedes;
    const menores = typeof e.adultos === "number" && e.adultos > 0 ? e.menores || 0 : 0;
    const fianza = fianzaCentimosDe(reserva);
    const precioEstancia = estanciaCentimosDe(reserva) / 100;

    const adicionales = reserva.importes.adicionales.map((a) => `${a.nombre} (${a.precio} €)`).join(", ");
    const notas = [
        prueba ? "[PRUEBA] Pago en modo test de Stripe: cancela esta reserva cuando termines de probar." : null,
        `Reserva web ${reserva.codigo}. Pagado con Stripe: ${reserva.importes.total} € (${reserva.pago.paymentIntentId}).`,
        fianza ? `Incluye fianza reembolsable de ${euros(fianza)} €: devolver desde el panel de la web al terminar la estancia si no hay daños.` : null,
        `Huéspedes: ${adultos} ${adultos === 1 ? "adulto" : "adultos"}${menores ? `, ${menores} ${menores === 1 ? "menor" : "menores"}` : ""}.`,
        e.cuna ? "Necesitan CUNA para bebé (gratuita)." : null,
        adicionales ? `Adicionales: ${adicionales}.` : null,
    ]
        .filter(Boolean)
        .join("\n");

    return {
        status: "confirmed",
        arrival: e.checkIn,
        departure: e.checkOut,
        numAdult: adultos,
        numChild: menores,
        firstName: prueba ? `[PRUEBA] ${firstName}` : firstName,
        lastName,
        email: reserva.contacto.email,
        phone: reserva.contacto.telefono,
        price: precioEstancia, // sin fianza
        referer: WEB_REFERER,
        apiReference: reserva.codigo,
        notes: notas.slice(0, 1500),
    };
}

const BLOQUEO_MS = 2 * 60 * 1000; // si un proceso muere con el bloqueo puesto, caduca solo

// Marca la reserva como "creándose en Beds24" de forma atómica.
// Devuelve true solo al proceso que consigue el bloqueo.
// (strict: false porque beds24.bloqueadoHasta no está en el schema: no hace falta tocar el modelo)
async function tomarBloqueo(reserva) {
    const Modelo = reserva.constructor;
    const ahora = new Date();
    const r = await Modelo.updateOne(
        {
            _id: reserva._id,
            estado: "pagada",
            "beds24.bookingId": null,
            $or: [{ "beds24.bloqueadoHasta": null }, { "beds24.bloqueadoHasta": { $lt: ahora } }],
        },
        { $set: { "beds24.bloqueadoHasta": new Date(ahora.getTime() + BLOQUEO_MS) } },
        { strict: false }
    );
    return r.modifiedCount === 1;
}

async function soltarBloqueo(reserva) {
    await reserva.constructor
        .updateOne({ _id: reserva._id }, { $unset: { "beds24.bloqueadoHasta": "" } }, { strict: false })
        .catch(() => {});
}

// Alguien reservó esas noches (Booking, Airbnb...) mientras este huésped pagaba:
// no se puede alojar a los dos, así que se le devuelve todo automáticamente (fianza incluida).
// Solo se llama si la reserva NO existe en Beds24 (comprobado justo antes).
async function reembolsarPorConflicto(reserva, nochesOcupadas) {
    const yaDevuelto = reserva.cancelacion?.reembolsoCentimos || 0;
    const importe = maximoStripeDe(reserva);
    const refundIds = importe > 0 ? await reembolsarStripe(reserva, importe, { motivo: "fechas_ocupadas", clave: `conflicto-${reserva._id}` }) : [];

    const motivo = `Fechas ocupadas por otra reserva mientras se pagaba (${nochesOcupadas.join(", ")}): reembolso automático`;
    reserva.cancelacion = {
        fecha: new Date(),
        motivo,
        por: "sistema",
        reembolsoCentimos: yaDevuelto + importe,
        refundIds: [...(reserva.cancelacion?.refundIds || []), ...refundIds],
        // true solo si de verdad no existe en Beds24; si tuviera id, se cancelaría desde el panel.
        beds24Cancelada: !reserva.beds24?.bookingId,
    };
    reserva.beds24.error = motivo.slice(0, 300);
    reserva.cambiarEstado("reembolsada", motivo.slice(0, 300));
    await reserva.save();

    console.error(`🔴 CONFLICTO: reserva ${reserva.codigo} reembolsada (${euros(importe)} €). Noches ocupadas: ${nochesOcupadas.join(", ")}`);
}

/**
 * Crea en Beds24 una reserva web ya pagada.
 * Lanza error si Beds24 o Stripe fallan: el webhook responde 500 y Stripe lo reintenta.
 * @returns {Promise<{ estado: "creada"|"ya_existia"|"ya_sincronizada"|"conflicto"|"no_aplica"|"en_curso", bookingId?: string }>}
 */
async function sincronizarReservaWeb(reserva, { prueba = false } = {}) {
    if (reserva.beds24?.bookingId) return { estado: "ya_sincronizada", bookingId: reserva.beds24.bookingId };
    if (reserva.estado !== "pagada") return { estado: "no_aplica" };

    // Solo un proceso a la vez por reserva.
    if (!(await tomarBloqueo(reserva))) {
        const actual = await reserva.constructor.findById(reserva._id).lean();
        if (actual?.beds24?.bookingId) return { estado: "ya_sincronizada", bookingId: actual.beds24.bookingId };
        // Otro proceso la está creando ahora mismo: él manda la confirmación.
        console.log(`⏳ Reserva ${reserva.codigo}: otro proceso la está pasando a Beds24, no se duplica`);
        return { estado: "en_curso" };
    }

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
            // Última comprobación: que la "otra reserva" no sea la nuestra.
            const nuestra = await buscarPorReferencia(reserva.codigo, checkIn);
            if (nuestra) {
                reserva.beds24.bookingId = String(nuestra.id);
                reserva.beds24.sincronizadoEn = new Date();
                reserva.beds24.error = "";
                await reserva.save();
                return { estado: "ya_existia", bookingId: reserva.beds24.bookingId };
            }
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
    } finally {
        await soltarBloqueo(reserva);
    }
}

/**
 * Cancela en Beds24 la reserva de este pago y COMPRUEBA que ya no ocupa fechas.
 * No se fía solo del número guardado en Mongo: también busca en Beds24 la reserva
 * con nuestra referencia (el código QA-…), por si el número guardado fuera de otra.
 * Si al final sigue activa, lanza error: quien llama NO debe devolver el dinero.
 * @returns {Promise<string[]>} números de Beds24 que se han cancelado ahora
 */
async function liberarEnBeds24(reserva) {
    const { checkIn } = reserva.estancia;
    const guardado = reserva.beds24?.bookingId ? String(reserva.beds24.bookingId) : null;
    const canceladas = [];

    // a) La reserva activa con nuestra referencia: es seguro que es la de este pago.
    const propia = await buscarPorReferencia(reserva.codigo, checkIn);
    if (propia) {
        const id = String(propia.id);
        if (guardado && guardado !== id) {
            console.warn(`🟠 Reserva ${reserva.codigo}: el número guardado (#${guardado}) no coincide con el de Beds24 (#${id}). Se corrige.`);
        }
        reserva.beds24.bookingId = id;
        await cancelarReservaBeds24(id);
        canceladas.push(id);
    }

    // b) El número guardado, si es otro y sigue activo.
    if (guardado && guardado !== (propia && String(propia.id)) && (await liberarSiSigueActiva(guardado))) {
        canceladas.push(guardado);
    }

    // c) Comprobación final en Beds24 (no basta con que respondiera "OK").
    const siguePropia = await buscarPorReferencia(reserva.codigo, checkIn);
    const activas = siguePropia ? [String(siguePropia.id)] : [];
    for (const id of new Set([guardado, reserva.beds24?.bookingId].filter(Boolean).map(String))) {
        const estado = await estadoReservaBeds24(id);
        if (estado && ESTADOS_QUE_OCUPAN.has(estado) && !activas.includes(id)) activas.push(id);
    }
    if (activas.length) {
        throw new CancelacionError(
            "BEDS24_NO_CANCELA",
            `Beds24 no ha cancelado la reserva #${activas.join(", #")}. No se ha devuelto el dinero. Inténtalo de nuevo en unos minutos o cancélala en Beds24.`,
            502
        );
    }

    if (canceladas.length) {
        invalidarCacheDisponibilidad();
        invalidarCachesPanel();
        console.log(`📅 Reserva ${reserva.codigo}: cancelada en Beds24 (#${canceladas.join(", #")})`);
    }
    return canceladas;
}

// Si hay un link de pago de ampliación sin pagar, se anula (la reserva se va a cancelar).
async function anularLinksPendientes(reserva) {
    for (const m of reserva.modificaciones || []) {
        if (m.estado !== "pendiente_pago") continue;
        if (m.checkoutSessionId) {
            await stripe.checkout.sessions.expire(m.checkoutSessionId).catch(() => {});
        }
        m.estado = "vencida";
        m.reembolsoPendienteCentimos = 0;
        m.error = "Link anulado al cancelar la reserva";
    }
}

/**
 * Cancela una reserva web pagada: primero en Beds24 (libera las fechas) y luego
 * el reembolso en Stripe. Si se corta a mitad, se puede repetir sin duplicar nada.
 * "total" devuelve todo lo que queda por devolver por Stripe (estancia + fianza).
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
    const maximo = maximoStripeDe(reserva);
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
        // En Mongo ya está cancelada, pero puede seguir activa en Beds24 (por ejemplo,
        // un reembolso automático que no llegó a cancelarla allí). Se comprueba en Beds24
        // y, si sigue ocupando fechas, se cancela: así el panel repara estos casos.
        const liberadas = await liberarEnBeds24(reserva);
        if (liberadas.length) {
            if (!reserva.cancelacion) reserva.cancelacion = {};
            reserva.cancelacion.beds24Cancelada = true;
            reserva.beds24.error = "";
            await reserva.save();
            console.log(`🧹 Reserva ${reserva.codigo}: seguía activa en Beds24 y se ha cancelado`);
            return {
                reembolsoCentimos: 0,
                totalDevueltoCentimos: reserva.cancelacion.reembolsoCentimos || 0,
                beds24Liberada: true,
            };
        }
        throw new CancelacionError("YA_CANCELADA", "Esta reserva ya está cancelada.", 409);
    }

    const textoMotivo = String(motivo || "").trim().slice(0, 300);
    if (!reserva.cancelacion) reserva.cancelacion = {};
    if (!reserva.cancelacion.fecha) {
        reserva.cancelacion.fecha = new Date();
        reserva.cancelacion.motivo = textoMotivo;
        reserva.cancelacion.por = por;
    }

    // 0) Un link de ampliación sin pagar ya no tiene sentido.
    await anularLinksPendientes(reserva);

    // 1) Beds24: libera las fechas en todos los canales y COMPRUEBA que se liberaron.
    //    Si Beds24 no la cancela, liberarEnBeds24 lanza error y NO se devuelve el dinero.
    if (reserva.beds24?.bookingId || reserva.estado === "pagada") {
        await liberarEnBeds24(reserva);
        reserva.cancelacion.beds24Cancelada = true;
        await reserva.save();
    }

    // 2) Stripe: el reembolso (solo si Beds24 ya está liberado). Va a la misma tarjeta; tarda de 5 a 10 días en verse.
    if (importe > 0) {
        const refundIds = await reembolsarStripe(reserva, importe, {
            motivo: "cancelacion",
            clave: `cancelacion-${reserva._id}-${yaDevuelto}-${importe}`,
        });
        reserva.cancelacion.reembolsoCentimos = yaDevuelto + importe;
        reserva.cancelacion.refundIds = [...(reserva.cancelacion.refundIds || []), ...refundIds];
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

/**
 * Devuelve la fianza al terminar la estancia (desde el panel).
 * Sin importeCentimos devuelve toda la fianza pendiente; con importe, solo esa parte
 * (por ejemplo, si hubo algún daño). La reserva sigue "pagada": no se cancela nada en Beds24.
 *
 * @param {import('mongoose').Document} reserva
 * @param {{ importeCentimos?: number, nota?: string, por?: string }} [opciones]
 * @returns {Promise<{ devueltoCentimos: number, totalDevueltoCentimos: number, pendienteCentimos: number }>}
 */
async function devolverFianza(reserva, { importeCentimos, nota = "", por = "admin" } = {}) {
    if (reserva.estado !== "pagada") {
        throw new CancelacionError(
            "ESTADO_NO_VALIDO",
            "Solo se puede devolver la fianza de reservas pagadas y activas. Si la reserva se canceló, la fianza se devuelve con la cancelación.",
            409
        );
    }

    const fianza = fianzaCentimosDe(reserva);
    const yaDevuelta = fianzaDevueltaDe(reserva);
    const pendiente = Math.min(fianza - yaDevuelta, maximoStripeDe(reserva));
    if (pendiente <= 0) {
        throw new CancelacionError("FIANZA_DEVUELTA", "La fianza de esta reserva ya está devuelta.", 409);
    }

    const importe = importeCentimos === undefined ? pendiente : importeCentimos;
    if (!Number.isInteger(importe) || importe < 1 || importe > pendiente) {
        throw new CancelacionError("DATOS_INVALIDOS", `La devolución tiene que estar entre 0,01 € y ${euros(pendiente)} €.`, 400, {
            errors: { importe: `Entre 0,01 € y ${euros(pendiente)} €.` },
        });
    }

    const refundIds = await reembolsarStripe(reserva, importe, {
        motivo: "devolucion_fianza",
        clave: `fianza-${reserva._id}-${yaDevuelta}-${importe}`,
    });

    if (!reserva.devolucionFianza) reserva.devolucionFianza = {};
    reserva.devolucionFianza.centimos = yaDevuelta + importe;
    reserva.devolucionFianza.fecha = new Date();
    reserva.devolucionFianza.por = por;
    reserva.devolucionFianza.nota = String(nota || "").trim().slice(0, 300);
    reserva.devolucionFianza.refundIds = [...(reserva.devolucionFianza.refundIds || []), ...refundIds];
    reserva.historialEstados.push({
        estado: reserva.estado,
        fecha: new Date(),
        motivo: `Fianza devuelta por ${por}: ${euros(importe)} € de ${euros(fianza)} €`.slice(0, 300),
    });
    await reserva.save();

    console.log(`💶 Reserva ${reserva.codigo}: fianza devuelta ${euros(importe)} € (${refundIds.join(", ")})`);
    return {
        devueltoCentimos: importe,
        totalDevueltoCentimos: reserva.devolucionFianza.centimos,
        pendienteCentimos: fianza - reserva.devolucionFianza.centimos,
    };
}

module.exports = {
    sincronizarReservaWeb,
    cancelarReservaWeb,
    devolverFianza,
    reembolsarStripe,
    cobradoStripeDe,
    devueltoStripeDe,
    maximoStripeDe,
    estanciaCentimosDe,
    nochesDe,
    CancelacionError,
    WEB_REFERER,
    separarNombre,
};