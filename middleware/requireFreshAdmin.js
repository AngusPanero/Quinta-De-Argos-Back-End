// Vuelve a consultar Firebase en el momento: si al admin le sacaron el claim
// o deshabilitaron la cuenta, no puede firmar aunque su cookie siga vigente.
// Va DESPUÉS de adminMiddleware (que deja el token verificado en req.user).
const auth = require("../config/firebase");

const esProduccion = (process.env.NODE_ENV === "production");

const requireFreshAdmin = async (req, res, next) => {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ message: "Unauthorized" });

    try {
        const user = await auth.getUser(uid);
        if (user.disabled || user.customClaims?.admin !== true) {
            return res.status(403).json({ message: "ACCESS_DENIED: ADMIN_ONLY_ZONE 🔴" });
        }
        req.freshAdmin = { uid: user.uid, email: user.email || null };
        next();
    } catch (error) {
        console.error(esProduccion ? "requireFreshAdmin falló 🔴" : `requireFreshAdmin falló 🔴 ${error}`);
        return res.status(401).json({ message: "Unauthorized" });
    }
};

module.exports = requireFreshAdmin;