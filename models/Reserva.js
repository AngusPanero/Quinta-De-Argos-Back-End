const mongoose = require("mongoose");
const crypto = require("crypto");

const ESTADOS = ["pendiente_pago", "pagada", "pago_fallido", "cancelada", "reembolsada"];

// ---------- Subdocumentos ----------

const nocheSchema = new mongoose.Schema(
    {
        fecha: { type: String, required: true }, // YYYY-MM-DD
        precio: { type: Number, required: true, min: 0 }, // € de esa noche
    },
    { _id: false }
);

const adicionalSchema = new mongoose.Schema(
    {
        id: { type: String, required: true },
        nombre: { type: String, required: true },
        precio: { type: Number, required: true, min: 0 },
    },
    { _id: false }
);

// Fianza: se cobra con la reserva y se devuelve al terminar la estancia si no hay daños.
const fianzaSchema = new mongoose.Schema(
    {
        porPersona: { type: Number, default: 0, min: 0 }, // €
        personas: { type: Number, default: 0, min: 0 },
        total: { type: Number, default: 0, min: 0 }, // €
        totalCentimos: { type: Number, default: 0, min: 0 },
    },
    { _id: false }
);

// Devolución de la fianza (desde el panel, al terminar la estancia).
const devolucionFianzaSchema = new mongoose.Schema(
    {
        centimos: { type: Number, default: 0, min: 0 }, // total devuelto de la fianza
        fecha: { type: Date, default: null },
        por: { type: String, default: "" },
        nota: { type: String, default: "", maxlength: 300 },
        refundIds: { type: [String], default: [] },
    },
    { _id: false }
);

const direccionSchema = new mongoose.Schema(
    {
        linea1: { type: String, required: true, trim: true, maxlength: 200 },
        linea2: { type: String, trim: true, maxlength: 200, default: "" },
        codigoPostal: { type: String, required: true, trim: true, maxlength: 12 },
        ciudad: { type: String, required: true, trim: true, maxlength: 100 },
        provincia: { type: String, trim: true, maxlength: 100, default: "" },
        pais: { type: String, required: true, uppercase: true, match: /^[A-Z]{2}$/ }, // ISO 3166-1
    },
    { _id: false }
);

// Prueba de cada aceptación: qué versión, cuándo y desde dónde.
const aceptacionSchema = new mongoose.Schema(
    {
        aceptado: { type: Boolean, required: true },
        version: { type: String, default: null },
        fecha: { type: Date, required: true },
        ip: { type: String, default: "" },
        userAgent: { type: String, default: "", maxlength: 400 },
    },
    { _id: false }
);

const cambioEstadoSchema = new mongoose.Schema(
    {
        estado: { type: String, enum: ESTADOS, required: true },
        fecha: { type: Date, default: Date.now },
        motivo: { type: String, default: "" },
    },
    { _id: false }
);

// Cada correo enviado al huésped desde el sistema o el panel.
const comunicacionSchema = new mongoose.Schema(
    {
        // Automáticos (los envía notificarReserva de contactRouter):
        //   confirmacion, pago_pendiente, pago_fallido, cancelacion, reembolso
        // Desde el panel: factura, mensaje
        tipo: {
            type: String,
            enum: ["confirmacion", "pago_pendiente", "pago_fallido", "cancelacion", "reembolso", "factura", "mensaje"],
            required: true,
        },
        destinatario: { type: String, required: true },
        asunto: { type: String, default: "", maxlength: 200 },
        mensaje: { type: String, default: "", maxlength: 5000 },
        estado: { type: String, enum: ["pendiente_envio", "enviado", "error"], required: true },
        error: { type: String, default: "" },
        creadoPor: { type: String, default: "" },
        fecha: { type: Date, default: Date.now },
    },
    { _id: true }
);

// Cobros posteriores a la reserva (ampliaciones): por Stripe o por transferencia.
const pagoExtraSchema = new mongoose.Schema(
    {
        metodo: { type: String, enum: ["stripe", "transferencia"], required: true },
        centimos: { type: Number, required: true, min: 0 },
        paymentIntentId: { type: String, default: null }, // solo Stripe
        concepto: { type: String, default: "", maxlength: 300 },
        modificacionId: { type: String, default: null },
        fecha: { type: Date, default: Date.now },
    },
    { _id: false }
);

// Cambio de fechas desde el panel (acortar, alargar o mover la estancia).
const modificacionSchema = new mongoose.Schema(
    {
        // aplicada: hecha (transferencia o sin cobro)
        // pendiente_pago: link de Stripe enviado; la reserva NO cambia hasta que pague
        // pagada: el huésped pagó el link y el cambio se aplicó (web + Beds24)
        // vencida: el link caducó sin pagar; la reserva sigue con sus fechas
        // rechazada: pagó, pero las noches nuevas ya no estaban libres; se le devolvió el pago
        estado: { type: String, enum: ["aplicada", "pendiente_pago", "pagada", "vencida", "rechazada"], required: true },
        fecha: { type: Date, default: Date.now },
        por: { type: String, default: "" },
        nota: { type: String, default: "", maxlength: 300 },

        antes: {
            checkIn: { type: String, required: true },
            checkOut: { type: String, required: true },
            noches: { type: Number, required: true },
        },
        despues: {
            checkIn: { type: String, required: true },
            checkOut: { type: String, required: true },
            noches: { type: Number, required: true },
        },
        // Copia de los importes antes del cambio
        importesAntes: { type: mongoose.Schema.Types.Mixed, default: null },
        // Importes con las fechas nuevas (con link de Stripe se aplican al recibir el pago,
        // con los precios del día en que se generó el link)
        importesDespues: { type: mongoose.Schema.Types.Mixed, default: null },

        nochesQuitadas: { type: [nocheSchema], default: [] }, // con el precio que se pagó
        nochesNuevas: { type: [nocheSchema], default: [] }, // con el precio web del día del cambio

        cargoCentimos: { type: Number, default: 0, min: 0 }, // noches nuevas + fianza adicional
        fianzaAdicionalCentimos: { type: Number, default: 0, min: 0 },
        metodoCobro: { type: String, enum: ["stripe", "transferencia", "sin_cargo"], default: "sin_cargo" },

        reembolsoCentimos: { type: Number, default: 0, min: 0 }, // devuelto por Stripe
        reembolsoPendienteCentimos: { type: Number, default: 0, min: 0 }, // se devuelve al pagar el link
        refundIds: { type: [String], default: [] },

        // Link de pago (Stripe Checkout)
        checkoutSessionId: { type: String, default: null },
        checkoutUrl: { type: String, default: null },
        venceEn: { type: Date, default: null },
        paymentIntentId: { type: String, default: null },

        error: { type: String, default: "" },
    },
    { _id: true }
);

// Cancelación y reembolsos (se rellena al cancelar desde el panel).
const cancelacionSchema = new mongoose.Schema(
    {
        fecha: { type: Date, default: null },
        motivo: { type: String, default: "", maxlength: 300 },
        por: { type: String, default: "" }, // email del admin o "sistema"
        reembolsoCentimos: { type: Number, default: 0, min: 0 }, // total devuelto hasta ahora
        refundIds: { type: [String], default: [] }, // ids de reembolso de Stripe (re_...)
        beds24Cancelada: { type: Boolean, default: false },
    },
    { _id: false }
);

// ---------- Reserva ----------

const reservaSchema = new mongoose.Schema(
    {
        // Código legible para el huésped y para el panel (ej. QA-7KQ3M9TX).
        // También se guarda en Beds24 como apiReference.
        codigo: { type: String, required: true, unique: true },

        estado: { type: String, enum: ESTADOS, default: "pendiente_pago", index: true },
        historialEstados: { type: [cambioEstadoSchema], default: [] },

        origen: { type: String, enum: ["web"], default: "web" },

        estancia: {
            checkIn: { type: String, required: true, index: true }, // YYYY-MM-DD
            checkOut: { type: String, required: true },
            noches: { type: Number, required: true, min: 1 },
            huespedes: { type: Number, required: true, min: 1 }, // adultos + menores
            adultos: { type: Number, default: null, min: 0 }, // 18 años o más (null en reservas antiguas)
            menores: { type: Number, default: 0, min: 0 }, // menores de 18
            cuna: { type: Boolean, default: false }, // cuna para bebé (gratuita)
        },

        importes: {
            moneda: { type: String, default: "eur" },
            desglose: { type: [nocheSchema], default: [] },
            alojamiento: { type: Number, required: true, min: 0 },
            adicionales: { type: [adicionalSchema], default: [] },
            totalAdicionales: { type: Number, required: true, min: 0 },
            fianza: { type: fianzaSchema, default: () => ({}) },
            // Valor ACTUAL de la estancia con la fianza (cambia si se modifican las fechas).
            // Lo cobrado de verdad: pago.importeCentimos + pagosExtra.
            total: { type: Number, required: true, min: 0 },
            totalCentimos: { type: Number, required: true, min: 0 },
        },

        // Persona de contacto de la estancia.
        contacto: {
            nombre: { type: String, required: true, trim: true, maxlength: 120 },
            email: { type: String, required: true, trim: true, lowercase: true, maxlength: 200, index: true },
            telefono: { type: String, required: true, trim: true, maxlength: 40 },
        },

        // Datos de la factura: particular (persona física) o empresa.
        facturacion: {
            tipo: { type: String, enum: ["particular", "empresa"], required: true },
            // Particular: nombre y apellidos. Empresa: razón social.
            nombre: { type: String, required: true, trim: true, maxlength: 200 },
            tipoDocumento: {
                type: String,
                enum: ["NIF", "NIE", "CIF", "PASAPORTE", "ID_EXTRANJERO"],
                required: true,
            },
            documento: { type: String, required: true, uppercase: true, trim: true, maxlength: 20 },
            direccion: { type: direccionSchema, required: true },
        },

        consentimientos: {
            // Información de la política de privacidad (art. 13 RGPD): obligatoria.
            politicaPrivacidad: { type: aceptacionSchema, required: true },
            // Condiciones de la reserva y cancelación (contrato): obligatoria.
            condicionesReserva: { type: aceptacionSchema, required: true },
            // Comunicaciones comerciales (LSSI art. 21): OPCIONAL.
            comunicacionesComerciales: { type: aceptacionSchema, required: true },
        },

        pago: {
            proveedor: { type: String, default: "stripe" },
            paymentIntentId: { type: String, default: null },
            // Lo cobrado en el pago original (los importes pueden cambiar después con modificaciones).
            // null en reservas antiguas: entonces vale importes.totalCentimos.
            importeCentimos: { type: Number, default: null },
            estadoProveedor: { type: String, default: null }, // status de Stripe
            pagadoEn: { type: Date, default: null },
            errorMensaje: { type: String, default: "" },
        },

        // Reserva creada en Beds24 al confirmarse el pago (la reparte a Booking y Airbnb).
        beds24: {
            bookingId: { type: String, default: null, index: true },
            sincronizadoEn: { type: Date, default: null },
            error: { type: String, default: "" },
            intentos: { type: Number, default: 0 },
        },

        cancelacion: { type: cancelacionSchema, default: null },

        // Devolución de la fianza al terminar la estancia.
        devolucionFianza: { type: devolucionFianzaSchema, default: null },

        // Cobros posteriores (ampliaciones) y cambios de fechas.
        pagosExtra: { type: [pagoExtraSchema], default: [] },
        modificaciones: { type: [modificacionSchema], default: [] },

        // Factura: la genera el propietario y la envía adjunta desde el panel.
        factura: {
            numero: { type: String, default: null },
            fechaEmision: { type: Date, default: null },
            ultimoEnvio: { type: Date, default: null },
        },

        // Correos automáticos: marcas para no enviarlos dos veces si Stripe repite el aviso.
        emails: {
            // Al huésped
            confirmacionEnviadaEn: { type: Date, default: null },
            pendienteEnviadaEn: { type: Date, default: null },
            fallidoEnviadoEn: { type: Date, default: null },
            cancelacionEnviadaEn: { type: Date, default: null },
            reembolsosNotificados: { type: [String], default: [] }, // ids de reembolso de Stripe (re_...)
            // A la finca (EMAIL_CONTACTO, por defecto quintadeargos@gmail.com)
            finca: {
                confirmada: { type: Date, default: null },
                pendiente: { type: Date, default: null },
                fallido: { type: Date, default: null },
                cancelacion: { type: Date, default: null },
                reembolsos: { type: [String], default: [] },
            },
        },

        comunicaciones: { type: [comunicacionSchema], default: [] },
    },
    { timestamps: true }
);

// Únicos solo cuando hay un valor real. Con "sparse" los null SÍ cuentan
// (el campo existe con valor null), y la segunda reserva sin PaymentIntent
// o sin factura daba E11000. Con partialFilterExpression solo se indexan
// los documentos donde el campo es un string.
reservaSchema.index(
    { "pago.paymentIntentId": 1 },
    { unique: true, partialFilterExpression: { "pago.paymentIntentId": { $type: "string" } } }
);
reservaSchema.index(
    { "factura.numero": 1 },
    { unique: true, partialFilterExpression: { "factura.numero": { $type: "string" } } }
);
reservaSchema.index({ createdAt: -1 });
reservaSchema.index({ "pagosExtra.paymentIntentId": 1 });

// Cambia de estado dejando rastro en el historial.
reservaSchema.methods.cambiarEstado = function (estado, motivo = "") {
    this.estado = estado;
    this.historialEstados.push({ estado, fecha: new Date(), motivo });
};

// Código aleatorio sin caracteres ambiguos (sin 0/O, 1/I/L).
const ALFABETO = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
reservaSchema.statics.generarCodigo = function () {
    const bytes = crypto.randomBytes(8);
    let codigo = "QA-";
    for (const b of bytes) codigo += ALFABETO[b % ALFABETO.length];
    return codigo;
};

module.exports = mongoose.models.Reserva || mongoose.model("Reserva", reservaSchema);
module.exports.ESTADOS_RESERVA = ESTADOS;