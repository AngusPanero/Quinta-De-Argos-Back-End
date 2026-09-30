// Copia local de las reservas de Beds24 (Beds24 sigue siendo la fuente de verdad).
const mongoose = require("mongoose");

const Beds24BookingSchema = new mongoose.Schema({
    beds24Id: { type: Number, required: true, unique: true },
    propertyId: Number,
    roomId: Number,

    status: { type: String, index: true },      // confirmed | new | request | black | cancelled | inquiry
    source: {                                    // de dónde vino la reserva
        type: String,
        enum: ["web", "airbnb", "booking", "owner", "direct"],
        index: true,
    },
    channel: String,
    apiSource: String,
    apiReference: String,                        // número de reserva en Airbnb / Booking
    referer: String,

    arrival: { type: String, index: true },      // "YYYY-MM-DD"
    departure: { type: String, index: true },    // "YYYY-MM-DD" (no es noche ocupada)
    nights: Number,
    numAdult: { type: Number, default: 0 },
    numChild: { type: Number, default: 0 },

    firstName: String,
    lastName: String,
    email: String,
    phone: String,
    mobile: String,
    country2: String,
    lang: String,
    comments: String,

    price: Number,
    commission: Number,

    flagText: String,
    flagColor: String,

    bookingTime: Date,
    modifiedTime: Date,
    cancelTime: Date,

    deletedInBeds24: { type: Boolean, default: false, index: true },
    lastSyncedAt: Date,
}, { timestamps: true });

module.exports = mongoose.model("Beds24Booking", Beds24BookingSchema);