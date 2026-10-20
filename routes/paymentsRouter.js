// routes/paymentsRouter.js — Quinta de Argos
// Flujo de pago de reservas:
//   POST /intent        -> valida datos y consentimientos, calcula el precio EN EL SERVIDOR,
//                          guarda la reserva (pendiente_pago) y crea el PaymentIntent
//   GET  /status/:id    -> estado del pago (para la vuelta de métodos con redirección)
//   POST /webhook       -> eventos de Stripe (body crudo):
//        payment_intent.processing      pago pendiente           -> aviso al huésped y a la finca
//        payment_intent.succeeded       pago aprobado            -> pagada, Beds24, confirmación + aviso a la finca
//        payment_intent.payment_failed  pago rechazado           -> pago_fallido (+ aviso si estaba pendiente)
//        payment_intent.canceled        pago cancelado en Stripe -> cancelada (+ aviso si estaba pendiente)
//        charge.refunded                reembolso                -> aviso de cancelación/reembolso
//        checkout.session.completed     link de ampliación pagado -> confirma el cambio de fechas
//        checkout.session.expired       link de ampliación vencido -> la reserva vuelve a sus fechas
//
// Todos los correos los arma y envía notificarReserva() de contactRouter.
// Aquí solo se decide CUÁNDO avisar.
//
// IMPORTANTE: en index.js, app.use(paymentsRouter) va ANTES de app.use(express.json()),
// porque el webhook necesita el body sin parsear para verificar la firma.
// Por eso cada ruta declara su propio parser.
//
// Del front solo se aceptan: fechas, huéspedes (adultos, menores y cuna), ids de adicionales,
// contacto, facturación y las casillas de consentimiento. Ningún importe del front se usa jamás.
// El total que se cobra incluye la fianza (60 € por persona), calculada en reservasService.

const express = require("express");
const { stripe } = require("../config/stripe");
const Reserva = require("../models/Reserva");
const { getNochesOcupadas, invalidarCacheDisponibilidad, Beds24Error } = require("../services/beds24AvailabilityService");
const { cotizarReserva, limitesReserva, cargarPreciosWeb, ReservaError } = require("../services/reservasService");
const { validarDatosCliente } = require("../services/datosClienteService");
const { sincronizarReservaWeb } = require("../services/reservaWebBeds24Service");
const { notificarReserva } = require("./contactRouter");
const { completarPagoAmpliacion, vencerPagoAmpliacion } = require("../services/modificacionReservaService");

// Los pagos de ampliación (link de Stripe Checkout del panel) tienen su propio flujo:
// los PaymentIntent que generan no deben tratarse como reservas nuevas.
const esAmpliacion = (objeto) => objeto?.metadata?.tipo === "ampliacion";
const { MONEDA } = require("../config/reservasConfig");

const paymentsRouter = express.Router();

const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- Helpers ----------

async function crearReservaPendiente(datos) {
    // El código es aleatorio; si coincidiera con uno existente, reintentamos.
    for (let intento = 0; intento < 3; intento++) {
        try {
            const reserva = new Reserva({ ...datos, codigo: Reserva.generarCodigo() });
            reserva.cambiarEstado("pendiente_pago", "Reserva creada desde la web");
            return await reserva.save();
        } catch (error) {
            const codigoDuplicado = error?.code === 11000 && error?.keyPattern?.codigo;
            if (!codigoDuplicado) throw error;
        }
    }
    throw new Error("No se pudo generar un código de reserva único");
}

async function buscarReservaDelPago(paymentIntent) {
    const porPago = await Reserva.findOne({ "pago.paymentIntentId": paymentIntent.id });
    if (porPago) return porPago;
    const reservaId = paymentIntent.metadata?.reservaId;
    return reservaId ? Reserva.findById(reservaId).catch(() => null) : null;
}

// ---------- Pago aprobado ----------
async function confirmBooking(paymentIntent) {
    if (esAmpliacion(paymentIntent)) return; // lo gestiona checkout.session.completed
    const reserva = await buscarReservaDelPago(paymentIntent);
    if (!reserva) {
        // Por ejemplo, eventos de prueba lanzados con `stripe trigger`.
        console.warn("⚠️ Pago sin reserva asociada:", paymentIntent.id);
        return;
    }
    // Ya cancelada o reembolsada desde el panel: no se vuelve a crear.
    if (reserva.estado === "cancelada" || reserva.estado === "reembolsada") return;

    if (reserva.estado !== "pagada") {
        reserva.pago.paymentIntentId = paymentIntent.id;
        reserva.pago.estadoProveedor = paymentIntent.status;
        reserva.pago.pagadoEn = new Date();
        reserva.pago.errorMensaje = "";
        reserva.cambiarEstado("pagada", "Pago confirmado por Stripe");
        await reserva.save();
        invalidarCacheDisponibilidad();
        console.log("✅ Reserva pagada:", reserva.codigo, paymentIntent.id);
    }

    // Crea la reserva en Beds24 (no duplica si Stripe reenvía el evento).
    // Si Beds24 falla, esto lanza: el webhook responde 500 y Stripe lo reintenta.
    // Mientras tanto aparece en el panel como "pagada sin pasar a Beds24".
    const prueba = paymentIntent.livemode === false;
    const sincronizacion = await sincronizarReservaWeb(reserva, { prueba });

    // Solo se confirma si la reserva quedó creada en Beds24. Si las fechas se
    // ocuparon mientras pagaba, se le reembolsó: el aviso de cancelación y
    // reembolso llega por charge.refunded.
    if (["creada", "ya_existia", "ya_sincronizada"].includes(sincronizacion.estado)) {
        const actual = (await Reserva.findById(reserva._id)) || reserva;
        const avisos = await notificarReserva("confirmada", actual, { prueba });
        console.log("📨 Avisos de reserva confirmada:", reserva.codigo, avisos);
    }
}

// ---------- Pago pendiente (SEPA y otros métodos que tardan) ----------
async function handleProcessingPayment(paymentIntent) {
    if (esAmpliacion(paymentIntent)) return;
    const reserva = await buscarReservaDelPago(paymentIntent);
    if (!reserva) {
        console.warn("⚠️ Pago pendiente sin reserva asociada:", paymentIntent.id);
        return;
    }
    // Si ya está pagada o cerrada, este aviso llega tarde: no se toca.
    if (!["pendiente_pago", "pago_fallido"].includes(reserva.estado)) return;

    reserva.pago.paymentIntentId = paymentIntent.id;
    reserva.pago.estadoProveedor = paymentIntent.status;
    reserva.pago.errorMensaje = "";
    if (reserva.estado === "pago_fallido") reserva.cambiarEstado("pendiente_pago", "Nuevo intento de pago en proceso");
    await reserva.save();
    console.log("⏳ Pago pendiente:", reserva.codigo, paymentIntent.id);

    const avisos = await notificarReserva("pendiente", reserva, { prueba: paymentIntent.livemode === false });
    console.log("📨 Avisos de pago pendiente:", reserva.codigo, avisos);
}

// ---------- Pago rechazado ----------
async function handleFailedPayment(paymentIntent) {
    if (esAmpliacion(paymentIntent)) return;
    const reserva = await buscarReservaDelPago(paymentIntent);
    const mensaje = paymentIntent.last_payment_error?.message || "Pago rechazado";
    console.warn("❌ Pago fallido:", paymentIntent.id, mensaje);
    if (!reserva || reserva.estado !== "pendiente_pago") return;

    reserva.pago.estadoProveedor = paymentIntent.status;
    reserva.pago.errorMensaje = mensaje.slice(0, 300);
    reserva.cambiarEstado("pago_fallido", mensaje.slice(0, 300));
    await reserva.save();

    // Solo avisa si antes se avisó de que el pago estaba pendiente.
    const avisos = await notificarReserva("fallido", reserva, {
        prueba: paymentIntent.livemode === false,
        mensaje,
    });
    console.log("📨 Avisos de pago fallido:", reserva.codigo, avisos);
}

// ---------- Pago cancelado en Stripe ----------
async function handleCanceledPayment(paymentIntent) {
    if (esAmpliacion(paymentIntent)) return;
    const reserva = await buscarReservaDelPago(paymentIntent);
    if (!reserva || !["pendiente_pago", "pago_fallido"].includes(reserva.estado)) return;

    const motivo = `Pago cancelado en Stripe${paymentIntent.cancellation_reason ? ` (${paymentIntent.cancellation_reason})` : ""}`;
    reserva.pago.estadoProveedor = paymentIntent.status;
    reserva.cambiarEstado("cancelada", motivo);
    await reserva.save();
    console.warn("🚫", motivo, reserva.codigo);

    const avisos = await notificarReserva("fallido", reserva, {
        prueba: paymentIntent.livemode === false,
        mensaje: "El pago se ha cancelado",
    });
    console.log("📨 Avisos de pago cancelado:", reserva.codigo, avisos);
}

// ---------- Reembolsos (cancelaciones del panel, fechas ocupadas, fianza o desde Stripe) ----------
async function handleChargeRefunded(charge) {
    const paymentIntentId = typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id;
    if (!paymentIntentId) return;

    // El reembolso puede ser del pago original o del de una ampliación.
    let reserva = await Reserva.findOne({
        $or: [{ "pago.paymentIntentId": paymentIntentId }, { "pagosExtra.paymentIntentId": paymentIntentId }],
    });
    if (!reserva) {
        console.warn("⚠️ Reembolso sin reserva asociada:", paymentIntentId);
        return;
    }

    // Al cancelar desde el panel, el reembolso se pide a Stripe y justo después
    // la reserva se marca como cancelada. Si este aviso llega antes, esperamos un
    // momento para mandar el correo correcto (cancelación + reembolso).
    if (reserva.estado === "pagada") {
        await esperar(4000);
        reserva = (await Reserva.findById(reserva._id)) || reserva;
    }

    const { data } = await stripe.refunds.list({ payment_intent: paymentIntentId, limit: 100 });
    const reembolsos = data
        .filter((r) => r.status === "succeeded" || r.status === "pending")
        .sort((a, b) => a.created - b.created);
    const totalReembolsadoCentimos = reembolsos.reduce((suma, r) => suma + r.amount, 0);
    const prueba = charge.livemode === false;

    // Cada reembolso se avisa una sola vez (por su id), aunque Stripe repita el evento.
    for (const refund of reembolsos) {
        const actual = (await Reserva.findById(reserva._id)) || reserva;
        const avisos = await notificarReserva("reembolso", actual, { refund, totalReembolsadoCentimos, prueba });
        console.log("📨 Avisos de reembolso:", reserva.codigo, refund.id, avisos);
    }
}

// ---------- 1) Guardar reserva y crear PaymentIntent ----------
paymentsRouter.post("/intent", express.json({ limit: "20kb" }), async (req, res) => {
    let reserva = null;
    try {
        // a) Datos del cliente y consentimientos (antes de llamar a nadie).
        const { contacto, facturacion, consentimientos } = validarDatosCliente(req.body, req);

        // b) Disponibilidad en FRESCO (sin caché) y precio calculado aquí (incluye la fianza).
        const { checkIn, checkOut, guests, adultos, menores, cuna, adicionales } = req.body ?? {};
        const { hoy, ultimaNoche } = limitesReserva();
        const ocupadas = await getNochesOcupadas(hoy, ultimaNoche, { fresco: true });
        await cargarPreciosWeb(); // precios de la web en fresco (los edita el panel)
        const presupuesto = cotizarReserva({ checkIn, checkOut, guests, adultos, menores, cuna, adicionales }, ocupadas);

        // c) Guardamos la reserva ANTES de cobrar, con los consentimientos registrados.
        reserva = await crearReservaPendiente({
            estancia: {
                checkIn: presupuesto.checkIn,
                checkOut: presupuesto.checkOut,
                noches: presupuesto.noches,
                huespedes: presupuesto.guests,
                adultos: presupuesto.adultos,
                menores: presupuesto.menores,
                cuna: presupuesto.cuna,
            },
            importes: {
                moneda: MONEDA,
                desglose: presupuesto.desglose,
                alojamiento: presupuesto.alojamiento,
                adicionales: presupuesto.adicionales,
                totalAdicionales: presupuesto.totalAdicionales,
                fianza: presupuesto.fianza,
                total: presupuesto.total,
                totalCentimos: presupuesto.totalCentimos,
            },
            contacto,
            facturacion,
            consentimientos,
            // Lo cobrado en este pago: los importes pueden cambiar después si se modifican las fechas.
            pago: { importeCentimos: presupuesto.totalCentimos },
        });

        // d) PaymentIntent. En Stripe solo van los datos imprescindibles:
        //    el resto vive en nuestra base de datos.
        const paymentIntent = await stripe.paymentIntents.create(
            {
                amount: presupuesto.totalCentimos,
                currency: MONEDA,
                automatic_payment_methods: { enabled: true },
                receipt_email: contacto.email,
                description: `Reserva ${reserva.codigo} · Quinta de Argos ${presupuesto.checkIn} → ${presupuesto.checkOut} (incluye fianza reembolsable de ${presupuesto.fianza.total} €)`,
                metadata: {
                    reservaId: String(reserva._id),
                    codigo: reserva.codigo,
                    checkIn: presupuesto.checkIn,
                    checkOut: presupuesto.checkOut,
                    fianzaCentimos: String(presupuesto.fianza.totalCentimos),
                },
            },
            { idempotencyKey: `reserva-${reserva._id}` }
        );

        reserva.pago.paymentIntentId = paymentIntent.id;
        reserva.pago.estadoProveedor = paymentIntent.status;
        await reserva.save();

        res.json({ clientSecret: paymentIntent.client_secret, codigo: reserva.codigo, presupuesto });
    } catch (error) {
        // Si la reserva llegó a guardarse pero el pago no se creó, la cerramos.
        if (reserva && !reserva.pago.paymentIntentId) {
            reserva.cambiarEstado("cancelada", "No se pudo crear el pago en Stripe");
            await reserva.save().catch(() => {});
        }

        if (error instanceof ReservaError) {
            return res.status(error.status).json({ codigo: error.codigo, mensaje: error.message, ...error.extra });
        }
        if (error instanceof Beds24Error) {
            console.error("Beds24 no respondió al crear el pago 🔴", error.message);
            return res.status(503).json({
                codigo: "DISPONIBILIDAD_NO_DISPONIBLE",
                mensaje: "No hemos podido confirmar la disponibilidad. Inténtalo de nuevo en unos minutos.",
            });
        }
        console.error("Error creando la reserva o el PaymentIntent 🔴", error);
        res.status(500).json({ codigo: "ERROR_PAGO", mensaje: "No se ha podido iniciar el pago. Inténtalo de nuevo." });
    }
});

// ---------- 2) Estado del pago ----------
paymentsRouter.get("/status/:id", async (req, res) => {
    const { id } = req.params;
    if (!/^pi_[A-Za-z0-9]+$/.test(id)) return res.status(400).json({ mensaje: "Identificador no válido" });
    try {
        const pi = await stripe.paymentIntents.retrieve(id);
        const reserva = await Reserva.findOne({ "pago.paymentIntentId": id }, { codigo: 1 }).lean();
        res.json({
            status: pi.status, // succeeded | processing | requires_payment_method | ...
            codigo: reserva?.codigo ?? null,
            amount: pi.amount,
            currency: pi.currency,
            checkIn: pi.metadata.checkIn,
            checkOut: pi.metadata.checkOut,
        });
    } catch (error) {
        res.status(404).json({ mensaje: "Pago no encontrado" });
    }
});

// ---------- 3) Webhook de Stripe (body crudo) ----------
paymentsRouter.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
    let event;
    try {
        event = stripe.webhooks.constructEvent(
            req.body,
            req.headers["stripe-signature"],
            process.env.STRIPE_WEBHOOK_SECRET
        );
    } catch (err) {
        console.error("Firma de webhook inválida:", err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
        switch (event.type) {
            case "payment_intent.processing":
                await handleProcessingPayment(event.data.object);
                break;
            case "payment_intent.succeeded":
                await confirmBooking(event.data.object);
                break;
            case "payment_intent.payment_failed":
                await handleFailedPayment(event.data.object);
                break;
            case "payment_intent.canceled":
                await handleCanceledPayment(event.data.object);
                break;
            case "charge.refunded":
                await handleChargeRefunded(event.data.object);
                break;
            // Links de pago de ampliación (cambio de fechas desde el panel)
            case "checkout.session.completed":
            case "checkout.session.async_payment_succeeded":
                if (esAmpliacion(event.data.object) && event.data.object.payment_status === "paid") {
                    await completarPagoAmpliacion(event.data.object);
                }
                break;
            case "checkout.session.expired":
                if (esAmpliacion(event.data.object)) await vencerPagoAmpliacion(event.data.object);
                break;
            default:
                break;
        }
        res.json({ received: true });
    } catch (err) {
        // 500 => Stripe reintenta el envío más tarde (los correos no se duplican)
        console.error("Error procesando webhook:", event.type, err?.message || err);
        res.status(500).send("Error interno");
    }
});

module.exports = paymentsRouter;