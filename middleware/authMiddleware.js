const auth = require("../config/firebase")

const esProduccion = (process.env.NODE_ENV === 'production');

// Usuarios normales (no admin) tienen que tener el email verificado para usar
// la API. Hoy el panel es solo de admin; cuando exista el dashboard de usuario
// el registro tiene que mandar el mail de verificación.
const REQUIRE_EMAIL_VERIFIED = true;

const verifyToken = async (req, res, next) => {
    try {
        const token =
        req.cookies?.idToken || // NAVEGADOR
        req.headers.authorization?.split(" ")[1]; // POSTMAN

        if(!token){
            return res.status(401).json({ message: "No credentials! 🔴" })
        }

        // checkRevoked = true → si se revocaron las sesiones (ban, unban,
        // cambio de contraseña o de claims), el token viejo deja de servir al
        // instante en vez de seguir valiendo hasta 1 hora.
        const decoded = await auth.verifyIdToken(token, true)

        // Un token se puede conseguir directo contra Firebase con la API key,
        // sin pasar por /login. Por eso las reglas del login se aplican acá,
        // en cada pedido:

        // 1) Baneado → afuera, aunque el token sea nuevo y válido
        if (decoded.banned === true) {
            return res.status(403).json({ code: "USER_BANNED", message: "User is banned" })
        }

        // 2) Usuario normal sin email verificado → afuera (admin exento)
        if (REQUIRE_EMAIL_VERIFIED && decoded.admin !== true && decoded.email_verified !== true) {
            return res.status(403).json({ code: "auth/email-not-verified", message: "Email not verified" })
        }

        req.user = decoded // Le doy al user las custom claims verificadas

        next()
    } catch (error) {
        if (error?.code === "auth/id-token-revoked") {
            return res.status(401).json({ code: "auth/session-revoked", message: "Session revoked" });
        }
        console.error(esProduccion ? `Unauthorized! 🔴`: `Unauthorized! 🔴 ${error}`);
        return res.status(401).json({ message: "Unauthorized" });
    }
}

module.exports = verifyToken