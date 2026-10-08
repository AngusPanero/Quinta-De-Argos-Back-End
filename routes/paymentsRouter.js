// routes/paymentsRouter.js — Quinta de Argos
// Flujo de pago de reservas:
//   POST /intent        -> valida datos y consentimientos, calcula el precio EN EL SERVIDOR,
//                          guarda la reserva (pendiente_pago) y crea el PaymentIntent
//   GET  /status/:id    -> estado del pago (para la vuelta de métodos con redirección)
//   POST /webhook       -> eventos de Stripe (body crudo): marca la reserva como pagada o fallida
//
// IMPORTANTE: en index.js, app.use(paymentsRouter) va ANTES de app.use(express.json()),
// porque el webhook necesita el body sin parsear para verificar la firma.
// Por eso cada ruta declara su propio parser.
//
// Del front solo se aceptan: fechas, huéspedes, ids de adicionales, contacto,
// facturación y las casillas de consentimiento. Ningún importe del front se usa jamás.

const express = require("express");
const { stripe } = require("../config/stripe");
const Reserva = require("../models/Reserva");
const { getNochesOcupadas, invalidarCacheDisponibilidad, Beds24Error } = require("../services/beds24AvailabilityService");
const { cotizarReserva, limitesReserva, ReservaError } = require("../services/reservasService");
const { validarDatosCliente } = require("../services/datosClienteService");
const { MONEDA } = require("../config/reservasConfig");

const paymentsRouter = express.Router();

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

// TODO (siguiente paso): crear la reserva en Beds24.
// - Idempotente: si reserva.beds24.bookingId ya existe, no duplicar.
// - Volver a comprobar disponibilidad: si alguien reservó esas fechas mientras
//   este huésped pagaba (por Booking/Airbnb), reembolsar y avisar.
async function crearEnBeds24(reserva) {
    console.log("📅 Pendiente crear en Beds24:", reserva.codigo, reserva.estancia.checkIn, "→", reserva.estancia.checkOut);
}

async function confirmBooking(paymentIntent) {
    const reserva = await buscarReservaDelPago(paymentIntent);
    if (!reserva) {
        // Por ejemplo, eventos de prueba lanzados con `stripe trigger`.
        console.warn("⚠️ Pago sin reserva asociada:", paymentIntent.id);
        return;
    }
    if (reserva.estado === "pagada") return; // Stripe puede reenviar el evento: no repetimos nada.

    reserva.pago.paymentIntentId = paymentIntent.id;
    reserva.pago.estadoProveedor = paymentIntent.status;
    reserva.pago.pagadoEn = new Date();
    reserva.pago.errorMensaje = "";
    reserva.cambiarEstado("pagada", "Pago confirmado por Stripe");
    await reserva.save();

    invalidarCacheDisponibilidad();
    console.log("✅ Reserva pagada:", reserva.codigo, paymentIntent.id);

    await crearEnBeds24(reserva);
}

async function handleFailedPayment(paymentIntent) {
    const reserva = await buscarReservaDelPago(paymentIntent);
    const mensaje = paymentIntent.last_payment_error?.message || "Pago rechazado";
    console.warn("❌ Pago fallido:", paymentIntent.id, mensaje);
    if (!reserva || reserva.estado !== "pendiente_pago") return;

    reserva.pago.estadoProveedor = paymentIntent.status;
    reserva.pago.errorMensaje = mensaje.slice(0, 300);
    reserva.cambiarEstado("pago_fallido", mensaje.slice(0, 300));
    await reserva.save();
}

// ---------- 1) Guardar reserva y crear PaymentIntent ----------
paymentsRouter.post("/intent", express.json({ limit: "20kb" }), async (req, res) => {
    let reserva = null;
    try {
        // a) Datos del cliente y consentimientos (antes de llamar a nadie).
        const { contacto, facturacion, consentimientos } = validarDatosCliente(req.body, req);

        // b) Disponibilidad en FRESCO (sin caché) y precio calculado aquí.
        const { checkIn, checkOut, guests, adicionales } = req.body ?? {};
        const { hoy, ultimaNoche } = limitesReserva();
        const ocupadas = await getNochesOcupadas(hoy, ultimaNoche, { fresco: true });
        const presupuesto = cotizarReserva({ checkIn, checkOut, guests, adicionales }, ocupadas);

        // c) Guardamos la reserva ANTES de cobrar, con los consentimientos registrados.
        reserva = await crearReservaPendiente({
            estancia: {
                checkIn: presupuesto.checkIn,
                checkOut: presupuesto.checkOut,
                noches: presupuesto.noches,
                huespedes: presupuesto.guests,
            },
            importes: {
                moneda: MONEDA,
                desglose: presupuesto.desglose,
                alojamiento: presupuesto.alojamiento,
                adicionales: presupuesto.adicionales,
                totalAdicionales: presupuesto.totalAdicionales,
                total: presupuesto.total,
                totalCentimos: presupuesto.totalCentimos,
            },
            contacto,
            facturacion,
            consentimientos,
        });

        // d) PaymentIntent. En Stripe solo van los datos imprescindibles:
        //    el resto vive en nuestra base de datos.
        const paymentIntent = await stripe.paymentIntents.create(
            {
                amount: presupuesto.totalCentimos,
                currency: MONEDA,
                automatic_payment_methods: { enabled: true },
                receipt_email: contacto.email,
                description: `Reserva ${reserva.codigo} · Quinta de Argos ${presupuesto.checkIn} → ${presupuesto.checkOut}`,
                metadata: {
                    reservaId: String(reserva._id),
                    codigo: reserva.codigo,
                    checkIn: presupuesto.checkIn,
                    checkOut: presupuesto.checkOut,
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
            case "payment_intent.succeeded":
                await confirmBooking(event.data.object);
                break;
            case "payment_intent.payment_failed":
                await handleFailedPayment(event.data.object);
                break;
            default:
                break;
        }
        res.json({ received: true });
    } catch (err) {
        // 500 => Stripe reintenta el envío más tarde
        console.error("Error procesando webhook:", err);
        res.status(500).send("Error interno");
    }
});

module.exports = paymentsRouter;