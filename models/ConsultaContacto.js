const mongoose = require("mongoose");

const consultaContactoSchema = new mongoose.Schema(
    {
        nombre: { type: String, required: true, trim: true, maxlength: 120 },
        email: { type: String, required: true, trim: true, lowercase: true, maxlength: 200, index: true },
        telefono: { type: String, required: true, trim: true, maxlength: 40 },
        checkin: { type: String, default: null }, // YYYY-MM-DD
        checkout: { type: String, default: null },
        huespedes: { type: Number, default: null, min: 1 },
        mensaje: { type: String, default: "", maxlength: 3000 },

        emails: {
            propietario: { type: Boolean, default: false }, // aviso a la finca enviado
            huesped: { type: Boolean, default: false }, // acuse de recibo enviado
            error: { type: String, default: "" },
        },

        ip: { type: String, default: "" },
    },
    { timestamps: true }
);

module.exports = mongoose.models.ConsultaContacto || mongoose.model("ConsultaContacto", consultaContactoSchema);