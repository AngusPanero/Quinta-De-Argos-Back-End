// Parte de viajeros (Real Decreto 933/2021) comunicado a SES.Hospedajes.
// Es el registro documental del alojamiento: se conserva 3 años desde la estancia.
const mongoose = require("mongoose");

const DireccionSchema = new mongoose.Schema({
    direccion: String,
    direccionComplementaria: String,
    codigoMunicipio: String,      // INE, 5 cifras (solo España)
    nombreMunicipio: String,      // fuera de España
    codigoPostal: String,
    pais: String,                 // ISO 3166-1 alfa-3
}, { _id: false });

const PersonaSchema = new mongoose.Schema({
    nombre: String,
    apellido1: String,
    apellido2: String,
    tipoDocumento: String,        // NIF | NIE | PAS | OTRO
    numeroDocumento: String,
    soporteDocumento: String,
    fechaNacimiento: String,      // "YYYY-MM-DD"
    nacionalidad: String,         // ISO 3166-1 alfa-3
    sexo: String,                 // H | M | O
    direccion: DireccionSchema,
    telefono: String,
    telefono2: String,
    correo: String,
    parentesco: String,           // catálogo TIPO_PARENTESCO
}, { _id: false });

const ErrorComunicacionSchema = new mongoose.Schema({
    orden: Number,
    tipoError: String,
    error: String,
}, { _id: false });

const EnvioSchema = new mongoose.Schema({
    tipo: { type: String, enum: ["alta", "anulacion"] },
    entorno: String,              // pruebas | produccion
    lote: String,
    fecha: Date,
    codigoRespuesta: Number,      // 0 = petición bien formada (NO significa aceptada)
    descripcion: String,
    codigoEstado: Number,         // 1 ok · 2 cabecera/formato · 3 inesperado · 4 en proceso · 5 pendiente · 6 con errores
    descEstado: String,
    errores: [ErrorComunicacionSchema],
    consultadoEn: Date,
}, { _id: false });

const ParteViajerosSchema = new mongoose.Schema({
    beds24Id: { type: Number, index: true },
    origen: String,                // web | airbnb | booking | direct
    nombreReserva: String,

    contrato: {
        referencia: String,
        fechaContrato: String,     // "YYYY-MM-DD"
        fechaEntrada: String,      // "YYYY-MM-DDTHH:mm:ss"
        fechaSalida: String,       // "YYYY-MM-DDTHH:mm:ss"
        numHabitaciones: Number,
        internet: Boolean,
        pago: {
            tipoPago: String,      // EFECT | TARJT | PLATF | TRANS | MOVIL | TREG | DESTI | OTRO
            fechaPago: String,     // "YYYY-MM-DD"
            medioPago: String,
            titular: String,
        },
    },
    personas: [PersonaSchema],

    estado: {
        type: String,
        enum: ["borrador", "enviando", "enviado", "comunicado", "error", "anulacion_enviada", "anulado"],
        default: "borrador",
        index: true,
    },
    codigoComunicacion: String,   // acuse del Ministerio: la prueba ante una inspección
    ultimoError: String,
    errores: [ErrorComunicacionSchema],
    envios: [EnvioSchema],

    enviadoEn: Date,
    comunicadoEn: Date,
    anuladoEn: Date,
    creadoPor: String,
}, { timestamps: true });

module.exports = mongoose.model("ParteViajeros", ParteViajerosSchema);