// Canales: multiplicador de precios de Airbnb.
// Router aparte para no tocar adminConfigRouter.
// - Lectura y vista previa: adminMiddleware.
// - Cambio: adminMiddleware + requireFreshAdmin + clave de firma.
const express = require("express");
const adminMiddleware = require("../middleware/adminMiddleware");
const requireFreshAdmin = require("../middleware/requireFreshAdmin");
const { requireSignature, audit } = require("../middleware/requireSignature");
const { ConfigError } = require("../services/beds24ConfigService");
const { getAirbnbConfig, planAirbnbMultiplier, applyAirbnbMultiplier } = require("../services/channelConfigService");

const adminChannelsRouter = express.Router();
let busy = false;

function sendError(res, error, label) {
    if (error instanceof ConfigError) {
        return res.status(error.status).json({ message: error.code, detail: error.message, ...error.extra });
    }
    console.error(`${label} 🔴`, error?.message || error, error?.details ? JSON.stringify(error.details) : "");
    return res.status(502).json({
        message: "BEDS24_ERROR",
        detail: "Beds24 no respondió o rechazó el cambio. Probá de nuevo en unos minutos.",
    });
}

adminChannelsRouter.get("/api/admin/config/canales", adminMiddleware, async (req, res) => {
    try {
        res.json({ airbnb: await getAirbnbConfig() });
    } catch (error) {
        sendError(res, error, "Error leyendo la configuración de Airbnb");
    }
});

adminChannelsRouter.post("/api/admin/config/canales/airbnb/preview", adminMiddleware, async (req, res) => {
    try {
        res.json(await planAirbnbMultiplier(req.body));
    } catch (error) {
        sendError(res, error, "Error en la vista previa del multiplicador de Airbnb");
    }
});

adminChannelsRouter.post(
    "/api/admin/config/canales/airbnb",
    adminMiddleware, requireFreshAdmin, requireSignature("canales"),
    async (req, res) => {
        if (busy) return res.status(409).json({ message: "EN_CURSO", detail: "Ya se está aplicando un cambio. Esperá unos segundos." });
        busy = true;
        try {
            const { plan, config } = await applyAirbnbMultiplier(req.body);
            await audit(req, "canales", "ok", { channel: "airbnb", before: plan.before, after: plan.after });
            res.json({ applied: plan.after, airbnb: config });
        } catch (error) {
            await audit(req, "canales", error instanceof ConfigError ? "rejected" : "error",
                { channel: "airbnb", code: error.code || "BEDS24_ERROR" });
            sendError(res, error, "Error aplicando el multiplicador de Airbnb");
        } finally {
            busy = false;
        }
    }
);

module.exports = adminChannelsRouter;