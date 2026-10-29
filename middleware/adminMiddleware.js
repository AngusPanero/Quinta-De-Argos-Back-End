const auth = require("../config/firebase");
const esProduccion = (process.env.NODE_ENV === 'production');

const adminMiddleware = async (req, res, next) => {
    // Solo cookie httpOnly: el token nunca lo puede leer el JS del navegador
    const token = req.cookies?.idToken;

    if (!token) {
        return res.status(401).json({ message: "No credentials! 🔴" });
    }
    try {
        // checkRevoked = true → si se revocaron las sesiones (ban, cambio de
        // rol), el token viejo deja de servir al instante
        const decodedClaims = await auth.verifyIdToken(token, true);

        if (decodedClaims.banned === true) {
            return res.status(403).json({ code: "USER_BANNED", message: "User is banned" });
        }

        if (decodedClaims.admin !== true) {
            console.warn(`ADMIN_ACCESS_DENIED 🔴 uid=${decodedClaims.uid} ${req.method} ${req.originalUrl}`);
            return res.status(403).json({ message: "ACCESS_DENIED: ADMIN_ONLY_ZONE 🔴" });
        }

        req.user = decodedClaims;
        next();
    } catch (error) {
        if (error?.code === "auth/id-token-revoked") {
            return res.status(401).json({ code: "auth/session-revoked", message: "Session revoked" });
        }
        console.error(esProduccion ? `Unauthorized! 🔴` : `Unauthorized! 🔴 ${error}`);
        return res.status(401).json({ message: "Unauthorized" });
    }
};

module.exports = adminMiddleware;