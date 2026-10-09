// models/Reserva.js — Quinta de Argos
// Cada intento de reserva desde la web: quién reserva, qué reserva, cuánto
// cuesta, datos de facturación, consentimientos y estado del pago.
//
// Ciclo de vida:
//   pendiente_pago  -> se crea al pulsar «Pagar», ANTES de cobrar
//   pagada          -> el webhook de Stripe confirma el cobro y se crea en Beds24
//   pago_fallido    -> el pago fue rechazado
//   cancelada       -> cancelada desde el panel, sin devolver dinero
//   reembolsada     -> cancelada con reembolso total o parcial (o reembolso
//                      automático porque las fechas se ocuparon mientras pagaba)
//
// Los importes los escribe SIEMPRE el backend (reservasService.cotizarReserva),
// nunca vienen del front.

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
            huespedes: { type: Number, required: true, min: 1 },
        },

        importes: {
            moneda: { type: String, default: "eur" },
            desglose: { type: [nocheSchema], default: [] },
            alojamiento: { type: Number, required: true, min: 0 },
            adicionales: { type: [adicionalSchema], default: [] },
            totalAdicionales: { type: Number, required: true, min: 0 },
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
    },
    { timestamps: true }
);

reservaSchema.index({ "pago.paymentIntentId": 1 }, { unique: true, sparse: true });

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