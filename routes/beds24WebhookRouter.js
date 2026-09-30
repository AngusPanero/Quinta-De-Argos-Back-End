// Webhook de Beds24.
// ÚNICA ruta sin adminMiddleware: la llama el servidor de Beds24, que no tiene sesión de Firebase.
// Se protege con el header secreto configurado en Beds24 (Properties → Access → Custom Header).
const express = require("express");
const crypto = require("crypto");
const { handleWebhookBooking } = require("../services/bookingSync");

const esProduccion = (process.env.NODE_ENV === "production");
const beds24WebhookRouter = express.Router();

function safeEqual(a, b) {
    const bufA = Buffer.from(String(a));
    const bufB = Buffer.from(String(b));
    return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

beds24WebhookRouter.post("/api/webhooks/beds24", async (req, res) => {
    const secret = process.env.BEDS24_WEBHOOK_SECRET;
    const received = req.get("x-quinta-secret") || "";

    if (!secret || !safeEqual(received, secret)) {
        return res.status(401).json({ message: "Unauthorized" });
    }

    const incoming = req.body?.booking;

    // Se responde enseguida: si Beds24 no recibe 200 rápido, reintenta
    res.status(200).json({ ok: true });

    if (!incoming?.id) return;
    try {
        await handleWebhookBooking(incoming);
    } catch (error) {
        console.error(esProduccion
            ? `Webhook Beds24: error procesando reserva 🔴`
            : `Webhook Beds24: error procesando reserva ${incoming.id} 🔴 ${error}`);
    }
});

module.exports = beds24WebhookRouter;