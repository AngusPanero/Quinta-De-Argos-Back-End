// services/modificacionReservaService.js — Quinta de Argos
// Cambio de fechas de una reserva web desde el panel (acortar, alargar o mover la estancia).
//
//   calcularModificacion   -> qué noches se quitan y cuáles se agregan, disponibilidad y precios
//   aplicarModificacion    -> cambia la MISMA reserva en Beds24 (llega a Airbnb y Booking),
//                             actualiza Mongo, devuelve dinero y cobra la diferencia
//   completarPagoAmpliacion / vencerPagoAmpliacion -> los llama el webhook de Stripe
//
// Reglas:
//   - Disponibilidad en fresco en Beds24, sin contar las noches de la propia reserva y
//     SIN la antelación mínima de la web (la reserva ya existe).
//   - Si la estancia ya empezó, la llegada no se puede cambiar (solo la salida).
//   - Noches quitadas: se sugiere devolver lo que se PAGÓ por ellas (desglose de la reserva);
//     el panel puede poner otro importe o ninguno.
//   - Noches nuevas: al precio web del calendario de hoy. La fianza no cambia (es por persona),
//     salvo que el panel indique una fianza adicional.
//   - Cobro de la diferencia:
//       transferencia -> se aplica ya; el cobro lo gestiona el propietario
//       stripe        -> se aplica ya (las noches quedan bloqueadas) y se crea un link de pago
//                        que vence en 23 h. Si no se paga, la reserva vuelve a sus fechas.
//                        El reembolso de noches quitadas (si lo hay) se hace al pagar.
//   - Orden: primero Beds24; solo si Beds24 acepta el cambio se toca el dinero.

const mongoose = require("mongoose");
const { stripe } = require("../config/stripe");
const { getNochesOcupadas, invalidarCacheDisponibilidad } = require("./beds24AvailabilityService");
const { modificarReservaBeds24, invalidarCachesPanel } = require("./beds24BookingsService");
const { tarifaDe, sumarDias, esFechaValida, hoyEnEspana, cargarPreciosWeb } = require("./reservasService");
const { reembolsarStripe, maximoStripeDe, nochesDe } = require("./reservaWebBeds24Service");
const { notificarModificacion } = require("../routes/contactRouter");
const { MAX_NOCHES = 30, MONEDA = "eur" } = require("../config/reservasConfig");

const WEB_URL = (process.env.FRONT_END || "https://quintadeargos.com").replace(/\/+$/, "");
const VIGENCIA_LINK_MS = 23 * 60 * 60 * 1000; // Stripe Checkout admite como máximo 24 h

class ModificacionError extends Error {
    constructor(codigo, message, status = 400, extra = {}) {
        super(message);
        this.name = "ModificacionError";
        this.codigo = codigo;
        this.status = status;
        this.extra = extra;
    }
}

const euros = (centimos) => (centimos / 100).toLocaleString("es-ES", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const sumaCentimos = (noches) => noches.reduce((s, n) => s + Math.round(n.precio * 100), 0);
const esPrueba = () => String(process.env.STRIPE_SECRET_KEY || "").startsWith("sk_test");

function validarEstado(reserva) {
    if (reserva.estado !== "pagada") {
        throw new ModificacionError("ESTADO_NO_VALIDO", "Solo se pueden cambiar las fechas de reservas pagadas y activas.", 409);
    }
    if (!reserva.beds24?.bookingId) {
        throw new ModificacionError("SIN_BEDS24", "Esta reserva todavía no está en Beds24. Usa «Reintentar» antes de cambiar las fechas.", 409);
    }
    if ((reserva.modificaciones || []).some((m) => m.estado === "pendiente_pago")) {
        throw new ModificacionError(
            "PAGO_PENDIENTE",
            "Hay un cambio de fechas esperando el pago del huésped. Espera a que pague o a que venza el link (23 h).",
            409
        );
    }
}

/**
 * Calcula el cambio sin tocar nada.
 * @returns {Promise<object>} resumen para el panel
 */
async function calcularModificacion(reserva, { checkIn, checkOut }) {
    validarEstado(reserva);

    if (!esFechaValida(checkIn) || !esFechaValida(checkOut)) {
        throw new ModificacionError("FECHAS_INVALIDAS", "Las fechas no son válidas.", 400, { errors: { checkIn: "Fecha no válida." } });
    }
    if (checkOut <= checkIn) {
        throw new ModificacionError("FECHAS_INVALIDAS", "La salida tiene que ser posterior a la llegada.", 400, {
            errors: { checkOut: "Posterior a la llegada." },
        });
    }

    const actual = reserva.estancia;
    if (checkIn === actual.checkIn && checkOut === actual.checkOut) {
        throw new ModificacionError("SIN_CAMBIOS", "Las fechas son las mismas que ya tiene la reserva.");
    }

    const hoy = hoyEnEspana();
    const empezada = actual.checkIn <= hoy;
    if (empezada && checkIn !== actual.checkIn) {
        throw new ModificacionError("YA_EMPEZADA", "La estancia ya ha empezado: solo se puede cambiar la fecha de salida.", 400, {
            errors: { checkIn: "No se puede cambiar: la estancia ya ha empezado." },
        });
    }
    if (!empezada && checkIn < hoy) {
        throw new ModificacionError("FECHAS_INVALIDAS", "La llegada no puede ser anterior a hoy.", 400, {
            errors: { checkIn: "No puede ser anterior a hoy." },
        });
    }
    if (checkOut < hoy) {
        throw new ModificacionError("FECHAS_INVALIDAS", "La salida no puede ser anterior a hoy.", 400, {
            errors: { checkOut: "No puede ser anterior a hoy." },
        });
    }

    const nochesAntes = nochesDe(actual.checkIn, actual.checkOut);
    const nochesDespues = nochesDe(checkIn, checkOut);
    if (nochesDespues.length > MAX_NOCHES) {
        throw new ModificacionError("DEMASIADAS_NOCHES", `La estancia máxima es de ${MAX_NOCHES} noches.`);
    }

    // Noches que se quitan: con el precio que se pagó por cada una
    const pagado = new Map((reserva.importes.desglose || []).map((n) => [n.fecha, n.precio]));
    const nochesQuitadas = nochesAntes
        .filter((f) => !nochesDespues.includes(f))
        .map((f) => ({ fecha: f, precio: pagado.get(f) ?? 0 }));

    // Noches nuevas: disponibilidad (sin las propias) y precio web de hoy
    const fechasNuevas = nochesDespues.filter((f) => !nochesAntes.includes(f));
    const conflictos = [];
    const sinTarifa = [];
    const nochesNuevas = [];
    if (fechasNuevas.length) {
        await cargarPreciosWeb();
        const ocupadas = await getNochesOcupadas(fechasNuevas[0], fechasNuevas[fechasNuevas.length - 1], { fresco: true });
        for (const fecha of fechasNuevas) {
            if (ocupadas.has(fecha)) {
                conflictos.push(fecha);
                continue;
            }
            const tarifa = tarifaDe(fecha);
            if (!tarifa) {
                sinTarifa.push(fecha);
                continue;
            }
            nochesNuevas.push({ fecha, precio: tarifa.precio });
        }
    }

    const maximoReembolsoCentimos = maximoStripeDe(reserva);
    const valorQuitadasCentimos = sumaCentimos(nochesQuitadas);

    return {
        codigo: reserva.codigo,
        empezada,
        antes: { checkIn: actual.checkIn, checkOut: actual.checkOut, noches: nochesAntes.length },
        despues: { checkIn, checkOut, noches: nochesDespues.length },
        nochesQuitadas,
        nochesNuevas,
        conflictos,
        sinTarifa,
        disponible: conflictos.length === 0 && sinTarifa.length === 0,
        valorQuitadasCentimos,
        reembolsoSugeridoCentimos: Math.min(valorQuitadasCentimos, maximoReembolsoCentimos),
        maximoReembolsoCentimos,
        cargoNochesCentimos: sumaCentimos(nochesNuevas),
        fianzaActualCentimos: reserva.importes.fianza?.totalCentimos || 0,
    };
}

/** Importes de la reserva con las fechas nuevas. */
function importesNuevos(reserva, calculo, fianzaAdicionalCentimos) {
    const fechasDespues = new Set(nochesDe(calculo.despues.checkIn, calculo.despues.checkOut));
    const conservadas = (reserva.importes.desglose || [])
        .filter((n) => fechasDespues.has(n.fecha))
        .map((n) => ({ fecha: n.fecha, precio: n.precio }));
    const desglose = [...conservadas, ...calculo.nochesNuevas].sort((a, b) => a.fecha.localeCompare(b.fecha));

    const alojamientoCentimos = sumaCentimos(desglose);
    const adicionalesCentimos = Math.round((reserva.importes.totalAdicionales || 0) * 100);
    const fianzaAnterior = reserva.importes.fianza || {};
    const fianzaCentimos = (fianzaAnterior.totalCentimos || 0) + fianzaAdicionalCentimos;
    const totalCentimos = alojamientoCentimos + adicionalesCentimos + fianzaCentimos;

    return {
        desglose,
        alojamiento: alojamientoCentimos / 100,
        fianza: {
            porPersona: fianzaAnterior.porPersona || 0,
            personas: fianzaAnterior.personas || 0,
            total: fianzaCentimos / 100,
            totalCentimos: fianzaCentimos,
        },
        total: totalCentimos / 100,
        totalCentimos,
        precioBeds24: (alojamientoCentimos + adicionalesCentimos) / 100, // sin fianza
    };
}

/**
 * Aplica el cambio de fechas.
 * @param {import('mongoose').Document} reserva
 * @param {{
 *   checkIn: string, checkOut: string,
 *   reembolso: "sugerido" | "otro" | "ninguno", importeReembolsoCentimos?: number,
 *   fianzaAdicionalCentimos?: number,
 *   metodoCobro?: "stripe" | "transferencia",
 *   nota?: string, por?: string
 * }} opciones
 */
async function aplicarModificacion(reserva, opciones) {
    const calculo = await calcularModificacion(reserva, opciones);
    if (!calculo.disponible) {
        const fechas = [...calculo.conflictos, ...calculo.sinTarifa].join(", ");
        throw new ModificacionError("NO_DISPONIBLE", `Estas noches no están disponibles: ${fechas}.`, 409, { calculo });
    }

    const por = opciones.por || "admin";
    const nota = String(opciones.nota || "").trim().slice(0, 300);

    // ---------- Reembolso ----------
    let reembolso = 0;
    if (opciones.reembolso === "sugerido") reembolso = calculo.reembolsoSugeridoCentimos;
    else if (opciones.reembolso === "otro") {
        const importe = opciones.importeReembolsoCentimos;
        if (!Number.isInteger(importe) || importe < 0 || importe > calculo.maximoReembolsoCentimos) {
            throw new ModificacionError(
                "DATOS_INVALIDOS",
                `El reembolso tiene que estar entre 0 € y ${euros(calculo.maximoReembolsoCentimos)} €.`,
                400,
                { errors: { importeReembolso: `Entre 0 y ${euros(calculo.maximoReembolsoCentimos)} €.` } }
            );
        }
        reembolso = importe;
    } else if (opciones.reembolso !== "ninguno" && opciones.reembolso !== undefined) {
        throw new ModificacionError("DATOS_INVALIDOS", "Elige qué hacer con el reembolso.");
    }

    // ---------- Cobro ----------
    const fianzaAdicional = opciones.fianzaAdicionalCentimos ?? 0;
    if (!Number.isInteger(fianzaAdicional) || fianzaAdicional < 0) {
        throw new ModificacionError("DATOS_INVALIDOS", "La fianza adicional no es válida.", 400, {
            errors: { fianzaAdicional: "Importe no válido." },
        });
    }
    const cargo = calculo.cargoNochesCentimos + fianzaAdicional;
    let metodo = "sin_cargo";
    if (cargo > 0) {
        if (!["stripe", "transferencia"].includes(opciones.metodoCobro)) {
            throw new ModificacionError("DATOS_INVALIDOS", "Elige cómo va a pagar el huésped la diferencia.", 400, {
                errors: { metodoCobro: "Elige link de Stripe o transferencia." },
            });
        }
        metodo = opciones.metodoCobro;
    }

    // ---------- Importes nuevos ----------
    const importesAntes = JSON.parse(JSON.stringify(reserva.importes));
    const nuevos = importesNuevos(reserva, calculo, fianzaAdicional);

    // ---------- 1) Beds24: la misma reserva, con fechas y precio nuevos ----------
    await modificarReservaBeds24(reserva.beds24.bookingId, {
        arrival: calculo.despues.checkIn,
        departure: calculo.despues.checkOut,
        price: nuevos.precioBeds24,
    });
    invalidarCacheDisponibilidad();
    invalidarCachesPanel();

    // ---------- 2) Mongo ----------
    if (typeof reserva.pago.importeCentimos !== "number") reserva.pago.importeCentimos = importesAntes.totalCentimos;

    const modId = new mongoose.Types.ObjectId();
    const mod = {
        _id: modId,
        estado: metodo === "stripe" ? "pendiente_pago" : "aplicada",
        fecha: new Date(),
        por,
        nota,
        antes: calculo.antes,
        despues: calculo.despues,
        importesAntes,
        nochesQuitadas: calculo.nochesQuitadas,
        nochesNuevas: calculo.nochesNuevas,
        cargoCentimos: cargo,
        fianzaAdicionalCentimos: fianzaAdicional,
        metodoCobro: metodo,
        reembolsoCentimos: 0,
        reembolsoPendienteCentimos: metodo === "stripe" ? reembolso : 0,
        refundIds: [],
    };

    reserva.estancia.checkIn = calculo.despues.checkIn;
    reserva.estancia.checkOut = calculo.despues.checkOut;
    reserva.estancia.noches = calculo.despues.noches;
    reserva.importes.desglose = nuevos.desglose;
    reserva.importes.alojamiento = nuevos.alojamiento;
    reserva.importes.fianza = nuevos.fianza;
    reserva.importes.total = nuevos.total;
    reserva.importes.totalCentimos = nuevos.totalCentimos;
    reserva.markModified("importes");

    if (metodo === "transferencia") {
        reserva.pagosExtra.push({
            metodo: "transferencia",
            centimos: cargo,
            concepto: `Ampliación ${calculo.despues.checkIn} → ${calculo.despues.checkOut}`,
            modificacionId: String(modId),
        });
    }

    // ---------- 3) Link de pago de Stripe ----------
    let checkoutUrl = null;
    if (metodo === "stripe") {
        try {
            const descripcion = `Reserva ${reserva.codigo}: ${calculo.nochesNuevas.length} ${
                calculo.nochesNuevas.length === 1 ? "noche más" : "noches más"
            } (${calculo.despues.checkIn} → ${calculo.despues.checkOut})${fianzaAdicional ? ` + fianza ${euros(fianzaAdicional)} €` : ""}`;
            const session = await stripe.checkout.sessions.create(
                {
                    mode: "payment",
                    locale: "es",
                    customer_email: reserva.contacto.email,
                    line_items: [
                        {
                            quantity: 1,
                            price_data: {
                                currency: MONEDA,
                                unit_amount: cargo,
                                product_data: { name: `Ampliación de tu reserva ${reserva.codigo} — Quinta de Argos`, description: descripcion },
                            },
                        },
                    ],
                    expires_at: Math.floor((Date.now() + VIGENCIA_LINK_MS) / 1000),
                    success_url: `${WEB_URL}/?ampliacion=pagada`,
                    cancel_url: `${WEB_URL}/`,
                    metadata: { tipo: "ampliacion", reservaId: String(reserva._id), modificacionId: String(modId) },
                    payment_intent_data: {
                        description: descripcion,
                        receipt_email: reserva.contacto.email,
                        metadata: { tipo: "ampliacion", reservaId: String(reserva._id), modificacionId: String(modId), codigo: reserva.codigo },
                    },
                },
                { idempotencyKey: `ampliacion-${modId}` }
            );
            mod.checkoutSessionId = session.id;
            mod.checkoutUrl = session.url;
            mod.venceEn = new Date(session.expires_at * 1000);
            checkoutUrl = session.url;
        } catch (error) {
            // Sin link no se puede cobrar: Beds24 vuelve a las fechas de antes y no se guarda nada.
            await modificarReservaBeds24(reserva.beds24.bookingId, {
                arrival: calculo.antes.checkIn,
                departure: calculo.antes.checkOut,
                price: (importesAntes.totalCentimos - (importesAntes.fianza?.totalCentimos || 0)) / 100,
            }).catch((e) => console.error("🔴 No se pudo deshacer el cambio en Beds24:", e.message));
            invalidarCacheDisponibilidad();
            invalidarCachesPanel();
            throw new ModificacionError("STRIPE_ERROR", `Stripe no ha podido crear el link de pago: ${error.message}`, 502);
        }
    }

    reserva.modificaciones.push(mod);
    const modDoc = reserva.modificaciones[reserva.modificaciones.length - 1];

    // ---------- 4) Reembolso inmediato (sin link de Stripe) ----------
    let aviso = null;
    if (metodo !== "stripe" && reembolso > 0) {
        try {
            modDoc.refundIds = await reembolsarStripe(reserva, reembolso, { motivo: "modificacion", clave: `modificacion-${modId}` });
            modDoc.reembolsoCentimos = reembolso;
        } catch (error) {
            modDoc.error = String(error.message || error).slice(0, 300);
            aviso = `Las fechas ya están cambiadas, pero el reembolso de ${euros(reembolso)} € no se ha podido hacer: ${error.message}`;
        }
    }

    reserva.historialEstados.push({
        estado: reserva.estado,
        fecha: new Date(),
        motivo: `Fechas cambiadas por ${por}: ${calculo.antes.checkIn} → ${calculo.antes.checkOut} pasa a ${calculo.despues.checkIn} → ${calculo.despues.checkOut}`.slice(0, 300),
    });
    await reserva.save();

    console.log(`📅 Reserva ${reserva.codigo}: fechas cambiadas (${metodo}${checkoutUrl ? ", link de pago creado" : ""})`);
    await notificarModificacion(reserva, modDoc, metodo === "stripe" ? "pendiente_pago" : "aplicada", { prueba: esPrueba() }).catch((e) =>
        console.error("Error enviando el aviso del cambio de fechas 🔴", e?.message || e)
    );

    return { modificacion: modDoc.toObject(), checkoutUrl, aviso, calculo };
}

// ---------- Webhook: link de pago ----------

async function buscarModificacion(session) {
    const Reserva = mongoose.model("Reserva");
    const { reservaId, modificacionId } = session.metadata || {};
    if (!reservaId || !modificacionId || !mongoose.isValidObjectId(reservaId)) return {};
    const reserva = await Reserva.findById(reservaId);
    const mod = reserva?.modificaciones.id(modificacionId);
    return { reserva, mod };
}

/** checkout.session.completed (pagado): queda confirmada la ampliación. */
async function completarPagoAmpliacion(session) {
    const { reserva, mod } = await buscarModificacion(session);
    if (!reserva || !mod) {
        console.warn("⚠️ Pago de ampliación sin reserva asociada:", session.id);
        return;
    }
    if (mod.estado !== "pendiente_pago") return; // aviso repetido

    const paymentIntentId = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id;
    mod.estado = "pagada";
    mod.paymentIntentId = paymentIntentId || null;
    reserva.pagosExtra.push({
        metodo: "stripe",
        centimos: session.amount_total ?? mod.cargoCentimos,
        paymentIntentId: paymentIntentId || null,
        concepto: `Ampliación ${mod.despues.checkIn} → ${mod.despues.checkOut}`,
        modificacionId: String(mod._id),
    });

    // Reembolso de noches quitadas que quedó a la espera del pago
    if (mod.reembolsoPendienteCentimos > 0) {
        const importe = mod.reembolsoPendienteCentimos;
        try {
            mod.refundIds = await reembolsarStripe(reserva, importe, { motivo: "modificacion", clave: `modificacion-${mod._id}` });
            mod.reembolsoCentimos = importe;
            mod.reembolsoPendienteCentimos = 0;
        } catch (error) {
            mod.error = `Reembolso pendiente no realizado: ${String(error.message || error)}`.slice(0, 300);
        }
    }

    reserva.historialEstados.push({
        estado: reserva.estado,
        fecha: new Date(),
        motivo: `Ampliación pagada con Stripe: ${euros(session.amount_total ?? mod.cargoCentimos)} €`,
    });
    await reserva.save();
    console.log(`✅ Reserva ${reserva.codigo}: ampliación pagada (${session.id})`);

    await notificarModificacion(reserva, mod, "pagada", { prueba: session.livemode === false }).catch((e) =>
        console.error("Error enviando el aviso de ampliación pagada 🔴", e?.message || e)
    );
}

/** checkout.session.expired: el huésped no pagó; la reserva vuelve a sus fechas. */
async function vencerPagoAmpliacion(session) {
    const { reserva, mod } = await buscarModificacion(session);
    if (!reserva || !mod || mod.estado !== "pendiente_pago") return;

    mod.estado = "vencida";
    mod.reembolsoPendienteCentimos = 0;

    // Si la reserva se canceló mientras tanto, no hay fechas que devolver.
    if (reserva.estado === "pagada") {
        const antes = mod.importesAntes || {};
        // Si Beds24 falla, el webhook responde 500 y Stripe lo reintenta.
        await modificarReservaBeds24(reserva.beds24.bookingId, {
            arrival: mod.antes.checkIn,
            departure: mod.antes.checkOut,
            price: ((antes.totalCentimos || 0) - (antes.fianza?.totalCentimos || 0)) / 100,
        });
        invalidarCacheDisponibilidad();
        invalidarCachesPanel();

        reserva.estancia.checkIn = mod.antes.checkIn;
        reserva.estancia.checkOut = mod.antes.checkOut;
        reserva.estancia.noches = mod.antes.noches;
        if (mod.importesAntes) {
            reserva.importes = mod.importesAntes;
            reserva.markModified("importes");
        }
        reserva.historialEstados.push({
            estado: reserva.estado,
            fecha: new Date(),
            motivo: `El link de pago de la ampliación venció sin pagar: la reserva vuelve a ${mod.antes.checkIn} → ${mod.antes.checkOut}`,
        });
    }
    await reserva.save();
    console.log(`⌛ Reserva ${reserva.codigo}: link de ampliación vencido, fechas restauradas`);

    if (reserva.estado === "pagada") {
        await notificarModificacion(reserva, mod, "vencida", { prueba: session.livemode === false }).catch((e) =>
            console.error("Error enviando el aviso de link vencido 🔴", e?.message || e)
        );
    }
}

module.exports = {
    ModificacionError,
    calcularModificacion,
    aplicarModificacion,
    completarPagoAmpliacion,
    vencerPagoAmpliacion,
};