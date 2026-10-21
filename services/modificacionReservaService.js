// services/modificacionReservaService.js — Quinta de Argos
// Cambio de fechas de una reserva web desde el panel (acortar, alargar o mover la estancia).
//
//   calcularModificacion   -> qué noches se quitan y cuáles se agregan, disponibilidad y precios
//   aplicarModificacion    -> cambia la MISMA reserva en Beds24 (llega a Airbnb y Booking),
//                             actualiza Mongo, devuelve dinero y cobra la diferencia
//   completarPagoAmpliacion / vencerPagoAmpliacion -> los llama el webhook de Stripe
//   liberarBloqueos        -> si una noche nueva está ocupada por algo que quedó colgado
//                             (reserva web ya cancelada, duplicada o sin pago; cierre manual),
//                             lo libera desde el panel sin entrar en Beds24
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
//       stripe        -> NO se toca nada: se crea un link de pago que vence en 23 h.
//                        Cuando el webhook confirma el pago, se vuelve a comprobar la
//                        disponibilidad y se aplica el cambio (Beds24 + web) con los precios
//                        del link. Si las noches ya no están libres, se devuelve el pago
//                        entero y la reserva sigue igual. Si no paga, no pasa nada.
//                        El reembolso de noches quitadas (si lo hay) se hace al pagar.
//   - Orden: primero Beds24; solo si Beds24 acepta el cambio se toca el dinero.

const mongoose = require("mongoose");
const { stripe } = require("../config/stripe");
const { getNochesOcupadas, invalidarCacheDisponibilidad } = require("./beds24AvailabilityService");
const {
    modificarReservaBeds24,
    invalidarCachesPanel,
    reservasQueSolapan,
    nochesConCierre,
    quitarCierres,
    cancelarReservaBeds24,
    estadoReservaBeds24,
    ESTADOS_QUE_OCUPAN,
} = require("./beds24BookingsService");
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

function validarEstado(reserva, { ignorarPendiente = false } = {}) {
    if (reserva.estado !== "pagada") {
        throw new ModificacionError("ESTADO_NO_VALIDO", "Solo se pueden cambiar las fechas de reservas pagadas y activas.", 409);
    }
    if (!reserva.beds24?.bookingId) {
        throw new ModificacionError("SIN_BEDS24", "Esta reserva todavía no está en Beds24. Usa «Reintentar» antes de cambiar las fechas.", 409);
    }
    if (!ignorarPendiente && (reserva.modificaciones || []).some((m) => m.estado === "pendiente_pago")) {
        throw new ModificacionError(
            "PAGO_PENDIENTE",
            "Hay un cambio de fechas esperando el pago del huésped. Espera a que pague o a que venza el link (23 h).",
            409
        );
    }
}

// ---------- Qué ocupa cada noche en conflicto ----------

const ESTADOS_WEB_LIBERABLES = new Set(["cancelada", "reembolsada", "pendiente_pago", "pago_fallido"]);

function origenDe(b, esWeb) {
    if (b.status === "black") return "uso_propio";
    if (b.channel === "airbnb") return "airbnb";
    if (b.channel === "booking") return "booking";
    if (esWeb) return "web";
    return "particular";
}

/**
 * Explica qué bloquea cada noche en conflicto, para que el panel lo diga con nombre
 * y deje liberar lo que quedó colgado. Nunca marca como liberable una reserva de
 * Airbnb, Booking, particular, uso propio ni una reserva web pagada y vigente.
 * @returns {Promise<Array<object>>}
 *   { tipo: "reserva", beds24Id, origen, nombre, checkIn, checkOut, noches, codigo, estadoWeb, liberable, motivo }
 *   { tipo: "cierre", noches, liberable: true }
 *   { tipo: "desconocido", noches, liberable: false }
 */
async function explicarConflictos(reserva, conflictos) {
    if (!conflictos.length) return [];
    const Reserva = mongoose.model("Reserva");
    const desde = conflictos[0];
    const hasta = sumarDias(conflictos[conflictos.length - 1], 1);
    const propia = String(reserva.beds24?.bookingId || "");

    const [solapes, cierres] = await Promise.all([
        reservasQueSolapan(desde, hasta),
        nochesConCierre(desde, hasta).catch(() => []),
    ]);

    const bloqueos = [];
    const explicadas = new Set();

    for (const b of solapes) {
        if (String(b.id) === propia) continue;
        const noches = conflictos.filter((f) => f >= b.arrival && f < b.departure);
        if (!noches.length) continue;
        noches.forEach((n) => explicadas.add(n));

        const ref = String(b.apiReference || "");
        const web = await Reserva.findOne(
            { $or: [{ "beds24.bookingId": String(b.id) }, ...(ref.startsWith("QA-") ? [{ codigo: ref }] : [])] },
            { codigo: 1, estado: 1, "beds24.bookingId": 1 }
        ).lean();
        const esWeb = !!web || ref.startsWith("QA-");
        const origen = origenDe(b, esWeb);

        // Reserva web colgada: en la web no existe, no está pagada, o la web apunta a otra reserva de Beds24.
        let motivo = null;
        if (origen === "web") {
            if (!web) motivo = "Reserva web que ya no existe en la web (quedó en Beds24).";
            else if (ESTADOS_WEB_LIBERABLES.has(web.estado)) motivo = `Reserva web ${web.codigo} en estado «${web.estado}» que sigue ocupando Beds24.`;
            else if (web.beds24?.bookingId && String(web.beds24.bookingId) !== String(b.id))
                motivo = `Copia duplicada de la reserva web ${web.codigo} (la buena es la #${web.beds24.bookingId}).`;
        }

        bloqueos.push({
            tipo: "reserva",
            beds24Id: Number(b.id),
            origen,
            nombre: [b.firstName, b.lastName].filter(Boolean).join(" ") || null,
            checkIn: b.arrival,
            checkOut: b.departure,
            noches,
            codigo: web?.codigo || (ref.startsWith("QA-") ? ref : null),
            estadoWeb: web?.estado || null,
            liberable: !!motivo,
            motivo,
        });
    }

    const conCierre = cierres.filter((n) => conflictos.includes(n) && !explicadas.has(n));
    if (conCierre.length) {
        conCierre.forEach((n) => explicadas.add(n));
        bloqueos.push({ tipo: "cierre", noches: conCierre, liberable: true });
    }

    const resto = conflictos.filter((n) => !explicadas.has(n));
    if (resto.length) bloqueos.push({ tipo: "desconocido", noches: resto, liberable: false });

    return bloqueos;
}

const MAX_MARGEN = 3; // noches de margen de limpieza que Beds24 puede dejar junto a una reserva

/**
 * De las noches ocupadas sin reserva ni cierre, las que están pegadas a la propia
 * reserva (justo antes de la llegada o justo después de la salida, sin huecos).
 */
function nochesDeMargenPropio(sinExplicar, actual) {
    const margen = [];
    // Antes de la llegada: 12, 11, 10… mientras sigan sin explicar
    for (let i = 1, f = sumarDias(actual.checkIn, -1); i <= MAX_MARGEN && sinExplicar.has(f); i++, f = sumarDias(f, -1)) margen.push(f);
    // Después de la salida: la noche del día de salida, la siguiente…
    for (let i = 1, f = actual.checkOut; i <= MAX_MARGEN && sinExplicar.has(f); i++, f = sumarDias(f, 1)) margen.push(f);
    return margen.sort();
}

/**
 * Calcula el cambio sin tocar nada.
 * @returns {Promise<object>} resumen para el panel
 */
async function calcularModificacion(reserva, { checkIn, checkOut, ignorarPendiente = false }) {
    validarEstado(reserva, { ignorarPendiente });

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
    let bloqueos = await explicarConflictos(reserva, conflictos);

    // Noches bloqueadas SOLO por el margen de limpieza de esta misma reserva
    // (Beds24 bloquea días antes/después de cada reserva). Al mover la reserva,
    // el margen se corre con ella, así que esas noches cuentan como libres.
    const sinExplicar = new Set(bloqueos.filter((b) => b.tipo === "desconocido").flatMap((b) => b.noches));
    const margenPropio = nochesDeMargenPropio(sinExplicar, actual);
    if (margenPropio.length) {
        for (const fecha of margenPropio) {
            conflictos.splice(conflictos.indexOf(fecha), 1);
            const tarifa = tarifaDe(fecha);
            if (tarifa) nochesNuevas.push({ fecha, precio: tarifa.precio });
            else sinTarifa.push(fecha);
        }
        nochesNuevas.sort((a, b) => a.fecha.localeCompare(b.fecha));
        sinTarifa.sort();
        bloqueos = bloqueos
            .map((b) => (b.tipo === "desconocido" ? { ...b, noches: b.noches.filter((n) => !margenPropio.includes(n)) } : b))
            .filter((b) => b.noches.length);
    }

    return {
        codigo: reserva.codigo,
        empezada,
        antes: { checkIn: actual.checkIn, checkOut: actual.checkOut, noches: nochesAntes.length },
        despues: { checkIn, checkOut, noches: nochesDespues.length },
        nochesQuitadas,
        nochesNuevas,
        conflictos,
        bloqueos,
        margenPropio,
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
 * Cambia la reserva de verdad: primero Beds24 (si falla, lanza y no se toca Mongo),
 * después las fechas e importes en el documento (sin guardar).
 */
async function aplicarCambio(reserva, despues, nuevos) {
    await modificarReservaBeds24(reserva.beds24.bookingId, {
        arrival: despues.checkIn,
        departure: despues.checkOut,
        price: nuevos.precioBeds24,
    });
    invalidarCacheDisponibilidad();
    invalidarCachesPanel();

    if (typeof reserva.pago.importeCentimos !== "number") reserva.pago.importeCentimos = reserva.importes.totalCentimos;
    reserva.estancia.checkIn = despues.checkIn;
    reserva.estancia.checkOut = despues.checkOut;
    reserva.estancia.noches = despues.noches;
    reserva.importes.desglose = nuevos.desglose;
    reserva.importes.alojamiento = nuevos.alojamiento;
    reserva.importes.fianza = nuevos.fianza;
    reserva.importes.total = nuevos.total;
    reserva.importes.totalCentimos = nuevos.totalCentimos;
    reserva.markModified("importes");
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

    // ---------- 1) Sin link de Stripe: se cambia ya (Beds24 primero) ----------
    if (metodo !== "stripe") await aplicarCambio(reserva, calculo.despues, nuevos);

    // ---------- 2) Mongo ----------
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
        importesDespues: nuevos,
        nochesQuitadas: calculo.nochesQuitadas,
        nochesNuevas: calculo.nochesNuevas,
        cargoCentimos: cargo,
        fianzaAdicionalCentimos: fianzaAdicional,
        metodoCobro: metodo,
        reembolsoCentimos: 0,
        reembolsoPendienteCentimos: metodo === "stripe" ? reembolso : 0,
        refundIds: [],
    };

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
            // Con Stripe todavía no se ha tocado nada: basta con no guardar.
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

    const cambio = `${calculo.antes.checkIn} → ${calculo.antes.checkOut} pasa a ${calculo.despues.checkIn} → ${calculo.despues.checkOut}`;
    reserva.historialEstados.push({
        estado: reserva.estado,
        fecha: new Date(),
        motivo: (metodo === "stripe"
            ? `Link de pago creado por ${por} para cambiar ${cambio} (se aplica al pagar)`
            : `Fechas cambiadas por ${por}: ${cambio}`
        ).slice(0, 300),
    });
    await reserva.save();

    console.log(
        metodo === "stripe"
            ? `🔗 Reserva ${reserva.codigo}: link de pago creado, el cambio se aplica al pagar`
            : `📅 Reserva ${reserva.codigo}: fechas cambiadas (${metodo})`
    );
    await notificarModificacion(reserva, modDoc, metodo === "stripe" ? "pendiente_pago" : "aplicada", { prueba: esPrueba() }).catch((e) =>
        console.error("Error enviando el aviso del cambio de fechas 🔴", e?.message || e)
    );

    return { modificacion: modDoc.toObject(), checkoutUrl, aviso, calculo };
}

// ---------- Liberar lo que quedó colgado ----------

/**
 * Libera las noches nuevas ocupadas por algo que quedó colgado: reservas web canceladas,
 * sin pagar o duplicadas que siguen en Beds24, y cierres manuales. No toca nada más.
 * @returns {Promise<{ liberadas: number[], cierresQuitados: string[], calculo: object }>}
 */
async function liberarBloqueos(reserva, { checkIn, checkOut, por = "admin" }) {
    const antes = await calcularModificacion(reserva, { checkIn, checkOut });
    const reservas = antes.bloqueos.filter((b) => b.tipo === "reserva" && b.liberable);
    const cierres = antes.bloqueos.filter((b) => b.tipo === "cierre").flatMap((b) => b.noches);

    if (!reservas.length && !cierres.length) {
        throw new ModificacionError(
            "NADA_QUE_LIBERAR",
            "No hay nada que se pueda liberar desde aquí: esas noches están ocupadas por una reserva vigente.",
            409,
            { calculo: antes }
        );
    }

    const liberadas = [];
    for (const b of reservas) {
        await cancelarReservaBeds24(b.beds24Id);
        const estado = await estadoReservaBeds24(b.beds24Id);
        if (estado && ESTADOS_QUE_OCUPAN.has(estado)) {
            throw new ModificacionError("BEDS24_NO_LIBERA", `Beds24 no ha cancelado la reserva #${b.beds24Id}. Prueba en unos minutos.`, 502);
        }
        liberadas.push(b.beds24Id);
        console.log(`🧹 Reserva colgada #${b.beds24Id} cancelada en Beds24 por ${por} (${b.motivo})`);
    }
    if (cierres.length) {
        await quitarCierres(cierres);
        console.log(`🧹 Cierre manual quitado por ${por}: ${cierres.join(", ")}`);
    }

    invalidarCacheDisponibilidad();
    invalidarCachesPanel();

    const calculo = await calcularModificacion(reserva, { checkIn, checkOut });
    return { liberadas, cierresQuitados: cierres, calculo };
}

// ---------- Respaldo del webhook ----------

let ultimaConciliacion = 0;

/**
 * Revisa en Stripe los links de pago pendientes y aplica lo que el webhook no aplicó
 * (pagados -> "pagada"; vencidos -> la reserva vuelve a sus fechas). Lo llama el panel
 * al cargar, como mucho una vez cada 30 s. Nunca lanza: si falla, el panel carga igual.
 * @returns {Promise<number>} links actualizados
 */
async function conciliarLinksPendientes() {
    if (Date.now() - ultimaConciliacion < 30_000) return 0;
    ultimaConciliacion = Date.now();
    const Reserva = mongoose.model("Reserva");
    let actualizados = 0;
    try {
        const reservas = await Reserva.find(
            { "modificaciones.estado": "pendiente_pago" },
            { "modificaciones.estado": 1, "modificaciones.checkoutSessionId": 1 }
        ).lean();
        for (const r of reservas) {
            for (const mod of r.modificaciones || []) {
                if (mod.estado !== "pendiente_pago" || !mod.checkoutSessionId) continue;
                try {
                    const session = await stripe.checkout.sessions.retrieve(mod.checkoutSessionId);
                    if (session.payment_status === "paid") {
                        await completarPagoAmpliacion(session);
                        actualizados++;
                    } else if (session.status === "expired") {
                        await vencerPagoAmpliacion(session);
                        actualizados++;
                    }
                } catch (error) {
                    console.error(`Error conciliando el link ${mod.checkoutSessionId} 🔴`, error?.message || error);
                }
            }
        }
    } catch (error) {
        console.error("Error conciliando links de pago 🔴", error?.message || error);
    }
    if (actualizados) console.log(`🔁 Links de pago conciliados con Stripe: ${actualizados}`);
    return actualizados;
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

/**
 * checkout.session.completed (pagado): se comprueba otra vez la disponibilidad y se
 * aplica el cambio con los precios del link. Si las noches ya no están libres, se
 * devuelve el pago entero y la reserva sigue igual.
 * Si Beds24 falla, lanza: el webhook responde 500 y Stripe lo reintenta.
 */
async function completarPagoAmpliacion(session) {
    const { reserva, mod } = await buscarModificacion(session);
    if (!reserva || !mod) {
        console.warn("⚠️ Pago de ampliación sin reserva asociada:", session.id);
        return;
    }
    if (mod.estado !== "pendiente_pago") return; // aviso repetido

    const paymentIntentId = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id;
    const pagado = session.amount_total ?? mod.cargoCentimos;
    const prueba = session.livemode === false;
    mod.paymentIntentId = paymentIntentId || null;

    // ---------- ¿Se puede aplicar todavía? ----------
    let motivoRechazo = null;
    if (reserva.estado !== "pagada") {
        motivoRechazo = "la reserva ya no está activa";
    } else {
        try {
            const calculo = await calcularModificacion(reserva, { ...mod.despues, ignorarPendiente: true });
            if (!calculo.disponible) motivoRechazo = `noches ya no disponibles: ${[...calculo.conflictos, ...calculo.sinTarifa].join(", ")}`;
        } catch (error) {
            if (!(error instanceof ModificacionError)) throw error; // Beds24 caído: que Stripe reintente
            motivoRechazo = error.message;
        }
    }

    if (motivoRechazo) {
        // Se devuelve el pago del link entero. No se apunta como pago de la reserva,
        // así que el aviso charge.refunded no manda el correo genérico de reembolso.
        if (paymentIntentId) {
            const refund = await stripe.refunds.create(
                {
                    payment_intent: paymentIntentId,
                    metadata: { reservaId: String(reserva._id), codigo: reserva.codigo, motivo: "ampliacion_rechazada" },
                },
                { idempotencyKey: `ampliacion-rechazada-${mod._id}` }
            );
            mod.refundIds = [refund.id];
        }
        mod.estado = "rechazada";
        mod.reembolsoPendienteCentimos = 0;
        mod.error = `Pago devuelto (${euros(pagado)} €): ${motivoRechazo}`.slice(0, 300);
        reserva.historialEstados.push({
            estado: reserva.estado,
            fecha: new Date(),
            motivo: `Link de ampliación pagado pero no aplicado (${motivoRechazo}). Pago devuelto.`.slice(0, 300),
        });
        await reserva.save();
        console.warn(`🟠 Reserva ${reserva.codigo}: ampliación pagada pero no aplicada (${motivoRechazo}). Pago devuelto.`);
        if (reserva.estado === "pagada") {
            await notificarModificacion(reserva, mod, "rechazada", { prueba }).catch((e) =>
                console.error("Error enviando el aviso de ampliación rechazada 🔴", e?.message || e)
            );
        }
        return;
    }

    // ---------- Aplicar: Beds24 primero ----------
    const nuevos = mod.importesDespues || importesNuevos(reserva, { despues: mod.despues, nochesNuevas: mod.nochesNuevas }, mod.fianzaAdicionalCentimos || 0);
    await aplicarCambio(reserva, mod.despues, nuevos);

    mod.estado = "pagada";
    reserva.pagosExtra.push({
        metodo: "stripe",
        centimos: pagado,
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
        motivo: `Ampliación pagada con Stripe (${euros(pagado)} €): ${mod.antes.checkIn} → ${mod.antes.checkOut} pasa a ${mod.despues.checkIn} → ${mod.despues.checkOut}`.slice(0, 300),
    });
    await reserva.save();
    console.log(`✅ Reserva ${reserva.codigo}: ampliación pagada y aplicada (${session.id})`);

    await notificarModificacion(reserva, mod, "pagada", { prueba }).catch((e) =>
        console.error("Error enviando el aviso de ampliación pagada 🔴", e?.message || e)
    );
}

/** checkout.session.expired: el huésped no pagó. La reserva no se había tocado: solo se anota. */
async function vencerPagoAmpliacion(session) {
    const { reserva, mod } = await buscarModificacion(session);
    if (!reserva || !mod || mod.estado !== "pendiente_pago") return;

    mod.estado = "vencida";
    mod.reembolsoPendienteCentimos = 0;
    reserva.historialEstados.push({
        estado: reserva.estado,
        fecha: new Date(),
        motivo: `El link de pago de la ampliación venció sin pagar: la reserva sigue en ${reserva.estancia.checkIn} → ${reserva.estancia.checkOut}`,
    });
    await reserva.save();
    console.log(`⌛ Reserva ${reserva.codigo}: link de ampliación vencido (no se cambió nada)`);

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
    liberarBloqueos,
    conciliarLinksPendientes,
    completarPagoAmpliacion,
    vencerPagoAmpliacion,
};