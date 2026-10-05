// Clave de firma para cualquier cambio del panel.
// Uso: router.post(ruta, adminMiddleware, requireFreshAdmin, requireSignature("calendario"), handler)
// Lee req.body.pin, lo verifica y lo borra del body antes de seguir.
const AdminSignGuard = require("../models/AdminSignGuard");
const ConfigAudit = require("../models/ConfigAudit");
const { verifyPin } = require("../utils/signPin");

const esProduccion = (process.env.NODE_ENV === "production");
const MAX_FAILED_ATTEMPTS = 5;
const LOCK_MINUTES = 15;

async function audit(req, section, result, summary) {
    try {
        await ConfigAudit.create({
            adminUid: req.freshAdmin?.uid || req.user?.uid || null,
            adminEmail: req.freshAdmin?.email || null,
            section,
            result,
            summary: summary ?? null,
            ip: req.ip,
            userAgent: String(req.get("user-agent") || "").slice(0, 200),
        });
    } catch (error) {
        // La auditoría nunca debe frenar la operación
        console.error(esProduccion ? "No se pudo auditar 🟠" : `No se pudo auditar 🟠 ${error}`);
    }
}

async function getLock(adminUid) {
    const guard = await AdminSignGuard.findOne({ adminUid }).lean();
    if (guard?.lockedUntil && guard.lockedUntil > new Date()) return guard.lockedUntil;
    return null;
}

async function registerFailedAttempt(adminUid) {
    const guard = await AdminSignGuard.findOneAndUpdate(
        { adminUid },
        { $inc: { failedCount: 1 }, $set: { lastFailedAt: new Date() } },
        { upsert: true, new: true }
    );
    if (guard.failedCount >= MAX_FAILED_ATTEMPTS) {
        const lockedUntil = new Date(Date.now() + LOCK_MINUTES * 60 * 1000);
        await AdminSignGuard.updateOne({ adminUid }, { $set: { lockedUntil, failedCount: 0 } });
        return { locked: true, lockedUntil };
    }
    return { locked: false, remaining: MAX_FAILED_ATTEMPTS - guard.failedCount };
}

async function resetAttempts(adminUid) {
    await AdminSignGuard.updateOne({ adminUid }, { $set: { failedCount: 0, lockedUntil: null } });
}

const timeMadrid = (date) =>
    new Intl.DateTimeFormat("es-ES", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Madrid" }).format(date);

function requireSignature(section) {
    return async (req, res, next) => {
        const adminUid = req.freshAdmin?.uid || req.user?.uid;
        const pin = req.body?.pin;
        if (req.body) delete req.body.pin;

        try {
            // 1. Bloqueo vigente
            const lockedUntil = await getLock(adminUid);
            if (lockedUntil) {
                await audit(req, section, "locked");
                return res.status(429).json({
                    message: "CLAVE_BLOQUEADA",
                    detail: `Demasiados intentos fallidos. Probá de nuevo después de las ${timeMadrid(lockedUntil)}.`,
                    lockedUntil,
                });
            }

            // 2. Clave
            let ok = false;
            try {
                ok = await verifyPin(typeof pin === "string" ? pin : "");
            } catch (error) {
                console.error(esProduccion ? "Clave de firma sin configurar 🔴" : `Clave de firma sin configurar 🔴 ${error}`);
                return res.status(500).json({
                    message: "CLAVE_NO_CONFIGURADA",
                    detail: "La clave de firma no está configurada en el servidor.",
                });
            }

            if (!ok) {
                const attempt = await registerFailedAttempt(adminUid);
                await audit(req, section, "bad_pin");
                if (attempt.locked) {
                    return res.status(429).json({
                        message: "CLAVE_BLOQUEADA",
                        detail: `Clave incorrecta. La firma queda bloqueada ${LOCK_MINUTES} minutos.`,
                        lockedUntil: attempt.lockedUntil,
                    });
                }
                return res.status(401).json({
                    message: "CLAVE_INCORRECTA",
                    detail: `Clave incorrecta. ${attempt.remaining === 1 ? "Queda 1 intento" : `Quedan ${attempt.remaining} intentos`}.`,
                    remaining: attempt.remaining,
                });
            }

            await resetAttempts(adminUid);
            req.signedSection = section;
            next();
        } catch (error) {
            console.error(esProduccion ? "Error verificando la firma 🔴" : `Error verificando la firma 🔴 ${error}`);
            return res.status(500).json({ message: "ERROR_INTERNO", detail: "No se pudo verificar la firma." });
        }
    };
}

module.exports = { requireSignature, audit };