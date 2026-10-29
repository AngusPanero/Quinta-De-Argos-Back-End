// Express y Router
const express = require("express")
const authRouter = express.Router()
// Firebase
const auth = require("../config/firebase")
// Models
const Audit = require("../models/AuditSchema")
const SecurityIncident = require("../models/SecurityIncidentSchema")
// Middlewares
const loginLimiter = require("../middleware/rateLimitMiddleware")
const checkBanned = require("../middleware/checkBanned")
const verifyToken = require("../middleware/authMiddleware")
const adminMiddleware = require("../middleware/adminMiddleware")

// Axios
const axios = require("axios")
// Correos: misma plantilla y envío por Brevo que reservas y pagos
const { plantillaCorreo } = require("./contactRouter")
const { sendMail, layout, EMPRESA, C, SANS, escapeHtml, etiqueta, titulo, parrafo, divisor, boton } = plantillaCorreo

const esProduccion = (process.env.NODE_ENV === 'production');

// ─── Bloqueo temporal por intentos fallidos ───────────────────────────────────
// Antes: 5 intentos fallidos = ban permanente, y lo disparaba el navegador con
// /login-failed. Cualquiera podía banear al admin mandando su email 5 veces.
// Ahora: todo se cuenta en el servidor y son 15 minutos de bloqueo, sin ban.
const MAX_FAILED_ATTEMPTS = 5;
const LOCK_MINUTES        = 15;
const LOCK_MS             = LOCK_MINUTES * 60 * 1000;

// ─── Cookie de sesión ─────────────────────────────────────────────────────────
const COOKIE_BASE = esProduccion
    ? { httpOnly: true, sameSite: "lax",  secure: true, domain: ".quintadeargos.com", path: "/" }
    : { httpOnly: true, sameSite: "none", secure: true, path: "/" };

// ─── Helpers ──────────────────────────────────────────────────────────────────
// IP real del cliente detrás de Cloudflare / Render
const getClientIp = (req) => {
    const cfIp = req.headers["cf-connecting-ip"];
    if (cfIp) return String(cfIp);
    const forwarded = req.headers["x-forwarded-for"];
    if (forwarded) return String(forwarded).split(",")[0].trim();
    return req.ip || null;
};

const normalizeEmail = (value) =>
    typeof value === "string" ? value.trim().toLowerCase() : "";

const isValidEmail = (email) =>
    !!email && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

// Objeto de usuario propio — nunca mandar el token decodificado entero
const toUserPayload = (decoded) => ({
    uid:           decoded.uid,
    email:         decoded.email || null,
    emailVerified: decoded.email_verified === true,
    admin:         decoded.admin === true,
});

// Devuelve los minutos que faltan si el email está bloqueado, o 0 si no
const getLockMinutesLeft = (failedDoc, now) => {
    if (!failedDoc || (failedDoc.attempts || 0) < MAX_FAILED_ATTEMPTS) return 0;
    const lastAt = failedDoc.lastAttemptAt ? new Date(failedDoc.lastAttemptAt).getTime() : 0;
    const left = LOCK_MS - (now - lastAt);
    return left > 0 ? Math.ceil(left / 60000) : 0;
};

// ¿Existe una cuenta con ese email en Firebase?
async function emailExistsInFirebase(email) {
    try {
        await auth.getUserByEmail(email);
        return true;
    } catch (err) {
        if (err.code === "auth/user-not-found") return false;
        throw err;
    }
}

// ─── Correos de cuenta (Brevo + plantilla de la web) ──────────────────────────
// El link lo genera el Admin SDK. Se intenta que, al terminar, Firebase vuelva
// a la web; si quintadeargos.com no está en "Dominios autorizados" de Firebase,
// se genera sin redirección para no dejar al usuario sin correo.
async function generarLink(tipo, email) {
    const generar = tipo === "verificacion"
        ? (opts) => auth.generateEmailVerificationLink(email, opts)
        : (opts) => auth.generatePasswordResetLink(email, opts);
    try {
        return await generar({ url: `${EMPRESA.web}/` });
    } catch (err) {
        // Solo se reintenta si el problema es el dominio. Si es el límite de
        // Firebase, reintentar sería otro intento más que alarga el bloqueo.
        const esDominio = err?.code === "auth/unauthorized-continue-uri" || err?.code === "auth/invalid-continue-uri";
        if (!esDominio) throw err;
        console.warn(`⚠️ generarLink(${tipo}): ${EMPRESA.web} no está en "Dominios autorizados" de Firebase. Se envía sin redirección.`);
        return await generar(undefined);
    }
}

// Enlace en texto plano por si el botón no funciona
const enlaceAlternativo = (link) => `
    <p style="margin:0 0 8px; font-family:${SANS}; font-size:12px; font-weight:300; line-height:1.6; color:${C.suave};">Si el botón no funciona, copia y pega este enlace en tu navegador:</p>
    <p style="margin:0 0 24px; font-family:${SANS}; font-size:12px; line-height:1.6; word-break:break-all;"><a href="${escapeHtml(link)}" target="_blank" style="color:${C.arcilla};">${escapeHtml(link)}</a></p>`;

function emailVerificacion(link) {
    const contenido = `
        ${etiqueta("Verificación de cuenta")}
        ${titulo("Confirma tu correo")}
        ${parrafo("Gracias por registrarte en Quinta de Argos. Para activar tu cuenta, confirma que esta dirección de correo es tuya pulsando el botón.")}
        <div style="margin:8px 0 20px;">
            ${boton(link, "Confirmar mi correo")}
        </div>
        ${enlaceAlternativo(link)}
        ${divisor}
        ${parrafo("Cuando la confirmes, ya podrás iniciar sesión con tu correo y tu contraseña.")}
    `;
    const text = [
        "Confirma tu correo — Quinta de Argos",
        "",
        "Gracias por registrarte. Para activar tu cuenta, abre este enlace:",
        link,
        "",
        "Cuando la confirmes, ya podrás iniciar sesión.",
        "",
        EMPRESA.nombre,
        EMPRESA.localidad,
    ].join("\n");

    return {
        subject: "Confirma tu correo — Quinta de Argos",
        html: layout({
            tituloDocumento: "Confirma tu correo — Quinta de Argos",
            preheader: "Un clic para activar tu cuenta.",
            etiquetaCabecera: "Verificación<br />de cuenta",
            contenido,
            notaPie: "Recibes este correo porque se ha creado una cuenta en quintadeargos.com con esta dirección. Si no has sido tú, puedes ignorarlo: la cuenta no se activará.",
        }),
        text,
    };
}

function emailRestablecer(link) {
    const contenido = `
        ${etiqueta("Restablecer contraseña")}
        ${titulo("Elige una contraseña nueva")}
        ${parrafo("Hemos recibido una solicitud para restablecer la contraseña de tu cuenta. Pulsa el botón para elegir una nueva. El enlace caduca en una hora.")}
        <div style="margin:8px 0 20px;">
            ${boton(link, "Restablecer contraseña")}
        </div>
        ${enlaceAlternativo(link)}
        ${divisor}
        ${parrafo("Si no has sido tú, ignora este correo: tu contraseña actual sigue funcionando y nadie puede cambiarla sin este enlace.")}
    `;
    const text = [
        "Restablecer contraseña — Quinta de Argos",
        "",
        "Para elegir una contraseña nueva, abre este enlace (caduca en una hora):",
        link,
        "",
        "Si no has sido tú, ignora este correo.",
        "",
        EMPRESA.nombre,
        EMPRESA.localidad,
    ].join("\n");

    return {
        subject: "Restablece tu contraseña — Quinta de Argos",
        html: layout({
            tituloDocumento: "Restablece tu contraseña — Quinta de Argos",
            preheader: "El enlace caduca en una hora.",
            etiquetaCabecera: "Restablecer<br />contraseña",
            contenido,
            notaPie: "Recibes este correo porque se ha pedido restablecer la contraseña de tu cuenta en quintadeargos.com.",
        }),
        text,
    };
}

// Firebase limita cuántos links se generan por email en poco tiempo y lo
// devuelve como auth/internal-error con TOO_MANY_ATTEMPTS_TRY_LATER adentro
const esLimiteFirebase = (error) =>
    error?.code === "auth/too-many-requests" ||
    String(error?.message || "").includes("TOO_MANY_ATTEMPTS_TRY_LATER");

// Nunca corta el flujo: devuelve { sent, rateLimited } y se loguea si falla
async function sendVerificationEmail(email) {
    try {
        const link = await generarLink("verificacion", email);
        await sendMail({ to: email, ...emailVerificacion(link) });
        return { sent: true, rateLimited: false };
    } catch (error) {
        if (esLimiteFirebase(error)) {
            console.warn(`⚠️ Verificación no reenviada a ${email}: límite de Firebase (ya se mandó hace poco)`);
            return { sent: false, rateLimited: true };
        }
        // El mensaje trae la respuesta cruda de Firebase / Brevo: es lo que dice el motivo real
        console.error(`Error sending verification email 🔴 ${error?.code || ""} — ${error?.message || error}`);
        return { sent: false, rateLimited: false };
    }
}

async function sendPasswordResetEmail(email) {
    const link = await generarLink("restablecer", email);
    await sendMail({ to: email, ...emailRestablecer(link) });
}

// ─── POST /register ───────────────────────────────────────────────────────────
authRouter.post("/register", loginLimiter, async (req, res) => {
    const email    = normalizeEmail(req.body?.email)
    const password = req.body?.password

    const regex = /^(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{10,}$/;
    try {
        if (!isValidEmail(email) || typeof password !== "string") {
            return res.status(400).json({ message: "All fields are required to create an user! 🔴" })
        }

        if (!regex.test(password)) {
            return res.status(400).json({ message: "Password does not meet security requirements! 🔴" });
        }

        // Control: email ya registrado
        if (await emailExistsInFirebase(email)) {
            return res.status(409).json({
                code: "auth/email-already-exists",
                message: "This email is already registered! 🔴"
            });
        }

        await auth.createUser({ email, password })

        // Mail de verificación por Brevo. No se setea cookie: el usuario recién
        // puede entrar cuando verifique. Si falla, se reenvía al intentar loguearse.
        const verification = await sendVerificationEmail(email);

        return res.status(201).json({
            message: `User created successfully! 🟢`,
            verificationSent: verification.sent,
            verificationRateLimited: verification.rateLimited,
        })
    } catch (error) {
        if (error.code === 'auth/email-already-exists') {
            return res.status(409).json({
                code: "auth/email-already-exists",
                message: "This email is already registered! 🔴"
            });
        }
        console.error(esProduccion ? `Error creating user! 🔴` : `Error creating user! 🔴 ${error}`);
        res.status(500).send({ message: `Error creating user! 🔴` })
    }
})

// ─── POST /login ──────────────────────────────────────────────────────────────
authRouter.post("/login", loginLimiter, async (req, res) => {
    const email    = normalizeEmail(req.body?.email)
    const password = typeof req.body?.password === "string" ? req.body.password : ""
    const now      = Date.now()

    if (!isValidEmail(email) || !password) {
        return res.status(401).json({ code: "auth/invalid-credential" });
    }

    try {
        // 0. Bloqueo vigente: ni se consulta a Firebase (frena la fuerza bruta)
        const failed = await Audit.findOne({ email, event: "login-failed" }).lean();
        const lockLeft = getLockMinutesLeft(failed, now);
        if (lockLeft > 0) {
            return res.status(429).json({ code: "auth/too-many-attempts", retryAfterMinutes: lockLeft });
        }

        // 0.5 Control: email no registrado. Se responde antes de contar
        //     intentos, así un email inexistente no acumula bloqueos.
        if (!(await emailExistsInFirebase(email))) {
            return res.status(404).json({
                code: "auth/user-not-found",
                message: "No existe ninguna cuenta registrada con ese email.",
            });
        }

        // 1. Validar credenciales contra la API de Firebase Auth
        const firebaseResponse = await axios.post(
            `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${process.env.FIREBASE_API_KEY}`,
            { email, password, returnSecureToken: true }
        );

        const { idToken, localId: uid } = firebaseResponse.data;

        // 2. Verificar el token obtenido y obtener claims
        const decoded = await auth.verifyIdToken(idToken);

        // 3. Control de Baneo
        if (decoded.banned === true) {
            return res.status(403).json({ code: "auth/user-banned", message: "User is banned" });
        }

        // 4. Usuario normal sin email verificado (el admin queda exento).
        //    Como la contraseña es correcta, se le reenvía el mail de verificación
        //    (sirve de "reenviar verificación" sin exponer un endpoint aparte).
        if (decoded.admin !== true && decoded.email_verified !== true) {
            const verification = await sendVerificationEmail(email);
            return res.status(403).json({
                code: "auth/email-not-verified",
                message: "Email not verified",
                verificationSent: verification.sent,
                verificationRateLimited: verification.rateLimited,
            });
        }

        // 5. Limpiar intentos fallidos y auditar
        await Audit.findOneAndUpdate(
            { email, event: "login-failed" },
            { $set: { attempts: 0, lastAttemptAt: null } }
        );

        await Audit.create({
            uid: uid,
            email: decoded.email,
            event: "login",
            ip: getClientIp(req),
            userAgent: req.headers["user-agent"]
        });

        // 6. Cookie httpOnly (el token NO viaja en el body: el JS no lo puede leer)
        res.cookie("idToken", idToken, { ...COOKIE_BASE, maxAge: 60 * 60 * 1000 });

        const user = toUserPayload(decoded);
        return res.status(200).json({ user, isAdmin: user.admin });

    } catch (error) {
        const errorCode = error.response?.data?.error?.message?.split(" ")[0];

        const loginErrors = ["INVALID_PASSWORD", "EMAIL_NOT_FOUND", "INVALID_LOGIN_CREDENTIALS", "USER_DISABLED"];
        if (loginErrors.includes(errorCode)) {
            try {
                // Si el último intento fue hace más de 15 min, el contador arranca de cero
                const prev = await Audit.findOne({ email, event: "login-failed" }).lean();
                const prevLast = prev?.lastAttemptAt ? new Date(prev.lastAttemptAt).getTime() : 0;
                const expired = !prev || now - prevLast >= LOCK_MS;

                const attempt = await Audit.findOneAndUpdate(
                    { email, event: "login-failed" },
                    expired
                        ? { $set: { attempts: 1, lastAttemptAt: now } }
                        : { $inc: { attempts: 1 }, $set: { lastAttemptAt: now } },
                    { upsert: true, returnDocument: "after" }
                );

                if (attempt.attempts >= MAX_FAILED_ATTEMPTS) {
                    return res.status(429).json({ code: "auth/too-many-attempts", retryAfterMinutes: LOCK_MINUTES });
                }
                return res.status(401).json({
                    code: "auth/invalid-credential",
                    attemptsLeft: MAX_FAILED_ATTEMPTS - attempt.attempts,
                });
            } catch (dbError) {
                console.error(esProduccion ? "Audit login-failed error 🔴" : `Audit login-failed error 🔴 ${dbError}`);
                return res.status(401).json({ code: "auth/invalid-credential" });
            }
        }

        // Firebase también frena por su cuenta cuando detecta abuso
        if (errorCode === "TOO_MANY_ATTEMPTS_TRY_LATER") {
            return res.status(429).json({ code: "auth/too-many-attempts", retryAfterMinutes: LOCK_MINUTES });
        }

        console.error(esProduccion ? "Login Error" : "Login Error:", errorCode || error.message);
        return res.status(500).json({ message: "Internal Server Error" });
    }
});

// ─── POST /logout ─────────────────────────────────────────────────────────────
// El token se lee de la cookie (antes venía en el body desde el SDK de Firebase)
authRouter.post("/logout", async (req, res) => {
    const idToken = req.cookies?.idToken
    try {
        if (idToken) {
            const decoded = await auth.verifyIdToken(idToken)
            await Audit.create({
                uid: decoded.uid,
                email: decoded.email,
                event: "logout",
                ip: getClientIp(req),
                userAgent: req.headers["user-agent"]
            })
        }
        res.clearCookie("idToken", COOKIE_BASE);
        return res.status(200).json({ message: "Logout audited! 🟢" })
    } catch (error) {
        console.error(esProduccion ? `Logout fallback! 🔴` : `Logout fallback! 🔴 ${error}`);
        // 200 igual: la cookie se borra aunque el token ya no sirva
        res.clearCookie("idToken", COOKIE_BASE);
        return res.status(200).json({ message: "Logout fallback! 🟡" });
    }
})

// ─── POST /reset-password ─────────────────────────────────────────────────────
// El backend genera el link con el Admin SDK y lo manda por Brevo con la
// plantilla de la web. El frontend no necesita el SDK de Firebase ni la API key.
// Responde SIEMPRE lo mismo, exista o no el email (no sirve para averiguar cuentas).
authRouter.post("/reset-password", loginLimiter, async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    if (!isValidEmail(email)) {
        return res.status(400).json({ code: "auth/invalid-email", message: "Invalid email" });
    }

    const genericOk = { message: "Si el email está registrado, vas a recibir un link para restablecer la contraseña. 🟢" };

    try {
        // Baneados y cuentas deshabilitadas no reciben link (respuesta igual)
        const userRecord = await auth.getUserByEmail(email);
        if (userRecord.disabled || userRecord.customClaims?.banned === true) {
            return res.status(200).json(genericOk);
        }

        await sendPasswordResetEmail(email);
        return res.status(200).json(genericOk);
    } catch (error) {
        if (error?.code === "auth/user-not-found") {
            return res.status(200).json(genericOk);
        }
        if (esLimiteFirebase(error)) {
            return res.status(429).json({ code: "auth/too-many-requests" });
        }
        console.error(esProduccion ? "Error sending password reset 🔴" : `Error sending password reset 🔴 ${error?.code || error}`);
        return res.status(500).json({ message: "Error sending email" });
    }
});

// ─── POST /admin/ban-user ─────────────────────────────────────────────────────
authRouter.post("/admin/ban-user", adminMiddleware, async (req, res) => {
    const email = normalizeEmail(req.body?.email)
    if (!isValidEmail(email)) {
        return res.status(400).json({ message: "Email is required to ban a user! 🔴" })
    }
    try {
        const user = await auth.getUserByEmail(email)
        const currentClaims = user.customClaims || {}

        if (user.uid === req.user.uid) {
            return res.status(403).json({ message: "No podés banear tu propia cuenta. 🔴" })
        }
        if (currentClaims.admin === true) {
            return res.status(403).json({ message: "No se pueden banear cuentas admin. 🔴" })
        }

        // Merge: setCustomUserClaims REEMPLAZA todo el objeto. Sin el spread
        // se borrarían el resto de las claims del usuario.
        await auth.setCustomUserClaims(user.uid, {
            ...currentClaims,
            banned: true,
            bannedAt: Date.now(),
            bannedReason: "Banned directly by admin."
        })
        await auth.revokeRefreshTokens(user.uid) // Corta sus sesiones al instante

        await Audit.create({
            uid: user.uid,
            email: user.email,
            event: "forced_logout",
            ip: getClientIp(req),
            metadata: { action: "ban", by: req.user.email || req.user.uid }
        }).catch(() => {});

        return res.status(200).json({ message: "User banned successfully! 🟢" })
    } catch (error) {
        if (error?.code === "auth/user-not-found") {
            return res.status(404).json({ message: "User not found! 🔴" })
        }
        console.error(esProduccion ? `Error banning user 🔴` : `Error banning user 🔴 ${error}`);
        return res.status(500).json({ message: "Error banning user! 🔴" });
    }
})

// ─── POST /unban-user ─────────────────────────────────────────────────────────
authRouter.post("/unban-user", adminMiddleware, async (req, res) => {
    const { uid } = req.body || {}
    if (typeof uid !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(uid)) {
        return res.status(400).json({ message: "User UID is required! 🔴" })
    }
    try {
        const user = await auth.getUser(uid)

        // Quita solo los datos del ban y conserva el resto de las claims
        const { banned, bannedAt, bannedReason, ...restClaims } = user.customClaims || {};
        await auth.setCustomUserClaims(uid, { ...restClaims, banned: false })
        await auth.revokeRefreshTokens(uid)

        // Reseteo intentos fallidos (se guardan por email)
        await Audit.findOneAndUpdate(
            { email: normalizeEmail(user.email), event: "login-failed" },
            { $set: { attempts: 0, lastAttemptAt: null } }
        )
        await Audit.create({
            uid,
            email: user.email,
            event: "forced_logout",
            ip: getClientIp(req),
            metadata: { action: "unban", by: req.user.email || req.user.uid }
        });
        return res.status(200).json({ message: "User unbanned successfully! 🟢" });

    } catch (error) {
        if (error?.code === "auth/user-not-found") {
            return res.status(404).json({ message: "User not found! 🔴" })
        }
        console.error(esProduccion ? `Error unbanning user! 🔴` : `Error unbanning user! 🔴 ${error}`);
        return res.status(500).json({ message: "Error unbanning user! 🔴" });
    }
})

// ─── GET /check-auth ──────────────────────────────────────────────────────────
// verifyToken ya validó el token (con checkRevoked) y dejó las claims en req.user
authRouter.get("/check-auth", verifyToken, (req, res) => {
    const user = toUserPayload(req.user);
    return res.status(200).json({ authenticated: true, user, isAdmin: user.admin });
});

// ─── GET /me ──────────────────────────────────────────────────────────────────
// Lo usa PrivateRoute para preguntar el rol real al servidor
authRouter.get("/me", verifyToken, checkBanned, (req, res) => {
    res.set("Cache-Control", "no-store");
    return res.status(200).json({ user: toUserPayload(req.user) });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  ZONAS PROTEGIDAS — detección de acceso indebido (Burp)
// ═══════════════════════════════════════════════════════════════════════════════
// Para sumar otra zona en el futuro: agregala acá, creá su ruta abajo y sumala
// a los enum de SecurityIncidentSchema.
const PROTECTED_ZONES = {
    admin: {
        claim:  "admin",
        type:   "unauthorized-admin-access",
        reason: "Unauthorized admin access attempt",
    },
};

// Lo llama cada panel protegido al montar. Si el token firmado NO tiene el rol
// de la zona, alguien llegó al panel manipulando respuestas (Burp): se registra
// el incidente, se banea la cuenta, se revocan sus sesiones y se borra la cookie.
const verifyZoneAccess = (zoneKey) => async (req, res) => {
    const zone    = PROTECTED_ZONES[zoneKey];
    const decoded = req.user;

    // Acceso legítimo (según el token verificado y firmado por Firebase)
    if (decoded[zone.claim] === true && decoded.banned !== true) {
        return res.status(200).json({ ok: true });
    }

    const now = Date.now();
    const str = (v, max = 300) => (v == null ? null : String(v).slice(0, max));

    let userRecord = null;
    try {
        userRecord = await auth.getUser(decoded.uid);
    } catch (err) {
        console.error(esProduccion ? "verify-zone getUser failed 🔴" : `verify-zone getUser failed 🔴 ${err}`);
    }
    const currentClaims = userRecord?.customClaims || {};

    // Caso legítimo: le acaban de dar el rol y su token todavía es el viejo.
    // No es un ataque → no se banea, solo se pide volver a iniciar sesión.
    if (currentClaims[zone.claim] === true && currentClaims.banned !== true) {
        return res.status(409).json({ code: "SESSION_REFRESH_REQUIRED", message: "Volvé a iniciar sesión." });
    }

    // ── Ban (merge: conserva el resto de las claims) ─────────────────────────
    // Nunca se banea automáticamente una cuenta admin.
    let actionTaken = "banned";
    let actionError = null;
    try {
        if (currentClaims.admin === true || decoded.admin === true) {
            actionTaken = "skipped-admin";
        } else if (decoded.banned === true || currentClaims.banned === true) {
            actionTaken = "already-banned";
            await auth.revokeRefreshTokens(decoded.uid);
        } else {
            await auth.setCustomUserClaims(decoded.uid, {
                ...currentClaims,
                banned:       true,
                bannedAt:     now,
                bannedReason: zone.reason,
            });
            await auth.revokeRefreshTokens(decoded.uid);
        }
    } catch (err) {
        actionTaken = "ban-failed";
        actionError = str(err?.message, 500);
        console.error(esProduccion ? "verify-zone ban failed 🔴" : `verify-zone ban failed 🔴 ${err}`);
    }

    // ── Registro del incidente ───────────────────────────────────────────────
    let incidentId = null;
    try {
        const incident = await SecurityIncident.create({
            type:             zone.type,
            zone:             zoneKey,
            uid:              decoded.uid,
            email:            decoded.email || userRecord?.email || null,
            emailVerified:    userRecord?.emailVerified ?? decoded.email_verified ?? null,
            accountCreatedAt: userRecord?.metadata?.creationTime ? new Date(userRecord.metadata.creationTime) : null,
            lastSignInAt:     userRecord?.metadata?.lastSignInTime ? new Date(userRecord.metadata.lastSignInTime) : null,

            ip:             getClientIp(req),
            ipChain:        str(req.headers["x-forwarded-for"]),
            country:        str(req.headers["cf-ipcountry"], 10),
            userAgent:      str(req.headers["user-agent"], 500),
            acceptLanguage: str(req.headers["accept-language"], 200),
            referer:        str(req.headers["referer"], 500),
            origin:         str(req.headers["origin"], 200),

            method:        req.method,
            endpoint:      str(req.originalUrl, 200),
            attemptedPath: str(req.body?.path, 200),
            attemptedTab:  str(req.body?.tab, 50),

            tokenClaims: {
                admin:  decoded.admin === true,
                banned: decoded.banned === true,
            },
            signInProvider: str(decoded.firebase?.sign_in_provider, 50),
            tokenIssuedAt:  decoded.iat ? new Date(decoded.iat * 1000) : null,
            tokenAuthTime:  decoded.auth_time ? new Date(decoded.auth_time * 1000) : null,

            actionTaken,
            actionError,
            detectedAt: new Date(now),
        });
        incidentId = String(incident._id);
    } catch (err) {
        console.error(esProduccion ? "SECURITY_INCIDENT save failed 🔴" : `SECURITY_INCIDENT save failed 🔴 ${err}`);
    }

    // Queda también en la auditoría general
    try {
        await Audit.create({
            uid:       decoded.uid,
            email:     decoded.email,
            event:     "security-threat",
            ip:        getClientIp(req),
            userAgent: req.headers["user-agent"],
            metadata:  { reason: zone.type, incidentId, actionTaken },
        });
    } catch (err) {
        console.error(esProduccion ? "Audit security-threat failed 🔴" : `Audit security-threat failed 🔴 ${err}`);
    }

    console.warn(`🚨 SECURITY_THREAT // ${zone.type} uid=${decoded.uid} email=${decoded.email} ip=${getClientIp(req)} action=${actionTaken}`);

    // ── Cerrar la sesión en el navegador (salvo admin, que no se banea) ──────
    if (actionTaken !== "skipped-admin") {
        res.clearCookie("idToken", COOKIE_BASE);
    }

    return res.status(403).json({
        code:    "SECURITY_THREAT",
        message: "Unauthorized access attempt detected.",
        incidentId,
    });
};

// ─── POST /security/verify-admin-access ──────────────────────── (AdminDashboard)
// Fuera del prefijo /admin a propósito, para que no choque con otros routers.
authRouter.post("/security/verify-admin-access", verifyToken, verifyZoneAccess("admin"));

module.exports = authRouter