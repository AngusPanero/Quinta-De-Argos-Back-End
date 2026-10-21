const express = require("express");
const mongoose = require("mongoose");
const multer = require("multer");
const Reserva = require("../models/Reserva");
const adminMiddleware = require("../middleware/adminMiddleware");
const requireFreshAdmin = require("../middleware/requireFreshAdmin");
const { requireSignature, audit } = require("../middleware/requireSignature");
const { hoyEnEspana, sumarDias } = require("../services/reservasService");
const { plantillaCorreo: P } = require("./contactRouter");

const esProduccion = process.env.NODE_ENV === "production";
const router = express.Router();

const SECCION_FIRMA = "calendario"; // misma firma que el resto de Configuración → Calendario
const ZONA = "Europe/Madrid";
const MAX_PDF_BYTES = 5 * 1024 * 1024; // Brevo limita el tamaño total del correo
const MAX_HORAS_ANTES = 168; // 7 días
const MAX_INTENTOS = 3;
const REINTENTO_MS = 15 * 60 * 1000;
const ENVIANDO_CADUCA_MS = 30 * 60 * 1000; // si un proceso muere a mitad de envío
const VUELTA_MS = 5 * 60 * 1000;
const HORA_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

// ==========================================================
// 1) MODELOS
// ==========================================================

const configSchema = new mongoose.Schema(
    {
        clave: { type: String, default: "principal", unique: true },
        activo: { type: Boolean, default: false },
        horasAntes: { type: Number, default: 5, min: 0, max: MAX_HORAS_ANTES },
        horaCheckIn: { type: String, default: "15:00", match: HORA_RE },
        asunto: { type: String, default: "", maxlength: 150 }, // vacío -> asunto por defecto
        mensaje: { type: String, default: "", maxlength: 3000 }, // texto libre que va en el correo
        ubicacionUrl: { type: String, default: "", maxlength: 500 }, // enlace de Google Maps (botón «Cómo llegar»)
        pdf: {
            nombre: { type: String, default: null },
            tamano: { type: Number, default: 0 },
            datos: { type: Buffer, default: null, select: false },
            subidoEn: { type: Date, default: null },
            subidoPor: { type: String, default: "" },
        },
        actualizadoPor: { type: String, default: "" },
    },
    { timestamps: true, collection: "instruccionescasaconfig" }
);

const envioSchema = new mongoose.Schema(
    {
        reserva: { type: mongoose.Schema.Types.ObjectId, ref: "Reserva", required: true },
        codigo: { type: String, default: "" },
        checkIn: { type: String, required: true }, // la llegada para la que se envió
        email: { type: String, default: "" },
        estado: { type: String, enum: ["enviando", "enviado", "error"], required: true },
        intentos: { type: Number, default: 0 },
        manual: { type: Boolean, default: false },
        por: { type: String, default: "sistema" },
        enviadoEn: { type: Date, default: null },
        error: { type: String, default: "" },
    },
    { timestamps: true, collection: "instruccionescasaenvios" }
);
envioSchema.index({ reserva: 1, checkIn: 1 }, { unique: true });
envioSchema.index({ updatedAt: -1 });

const InstruccionesConfig =
    mongoose.models.InstruccionesCasaConfig || mongoose.model("InstruccionesCasaConfig", configSchema);
const InstruccionesEnvio =
    mongoose.models.InstruccionesCasaEnvio || mongoose.model("InstruccionesCasaEnvio", envioSchema);

async function leerConfig({ conPdf = false } = {}) {
    const consulta = InstruccionesConfig.findOneAndUpdate(
        { clave: "principal" },
        { $setOnInsert: { clave: "principal" } },
        { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }
    );
    return conPdf ? consulta.select("+pdf.datos") : consulta;
}

const tienePdf = (config) => !!config?.pdf?.nombre;

function configPublica(config) {
    return {
        activo: config.activo,
        horasAntes: config.horasAntes,
        horaCheckIn: config.horaCheckIn,
        asunto: config.asunto,
        mensaje: config.mensaje,
        ubicacionUrl: config.ubicacionUrl,
        pdf: tienePdf(config)
            ? { nombre: config.pdf.nombre, tamano: config.pdf.tamano, subidoEn: config.pdf.subidoEn, subidoPor: config.pdf.subidoPor }
            : null,
        actualizadoEn: config.updatedAt,
        actualizadoPor: config.actualizadoPor,
    };
}

// ==========================================================
// 2) HORA DE ENVÍO (hora de España, con cambio de horario incluido)
// ==========================================================

/** Diferencia en ms entre la hora de España y UTC en ese instante. */
function desfaseEspana(instante) {
    const partes = new Intl.DateTimeFormat("en-US", {
        timeZone: ZONA,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    }).formatToParts(instante);
    const v = Object.fromEntries(partes.map((p) => [p.type, p.value]));
    return Date.UTC(+v.year, +v.month - 1, +v.day, +v.hour, +v.minute, +v.second) - instante.getTime();
}

/** "2027-09-25" + "15:00" (hora de España) -> Date (instante real). */
function instanteEspana(fecha, hora) {
    const [y, m, d] = fecha.split("-").map(Number);
    const [hh, mm] = hora.split(":").map(Number);
    const comoUtc = Date.UTC(y, m - 1, d, hh, mm);
    let t = comoUtc - desfaseEspana(new Date(comoUtc));
    t = comoUtc - desfaseEspana(new Date(t)); // segunda pasada por si cae junto al cambio de hora
    return new Date(t);
}

const horaDeEnvio = (checkIn, config) =>
    new Date(instanteEspana(checkIn, config.horaCheckIn).getTime() - config.horasAntes * 3_600_000);

/** Último momento en que tiene sentido enviarlo: el final del día de llegada. */
const finDelDiaDeLlegada = (checkIn) => instanteEspana(sumarDias(checkIn, 1), "00:00");

const horaTexto = (fecha) =>
    new Intl.DateTimeFormat("es-ES", { timeZone: ZONA, weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }).format(
        fecha
    );

// ==========================================================
// 3) EL CORREO
// ==========================================================

function cuandoLlega(checkIn) {
    const hoy = hoyEnEspana();
    if (checkIn === hoy) return "hoy";
    if (checkIn === sumarDias(hoy, 1)) return "mañana";
    return `el ${P.fechaLarga(checkIn)}`;
}

function nombrePdf(nombre) {
    const base = String(nombre || "Instrucciones-Quinta-de-Argos")
        .replace(/\.pdf$/i, "")
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/[^A-Za-z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 80);
    return `${base || "Instrucciones-Quinta-de-Argos"}.pdf`;
}

/**
 * Envía el correo con el PDF. `reserva` puede ser un documento o un objeto con la misma forma.
 * @returns {Promise<{ asunto: string }>}
 */
async function enviarCorreoInstrucciones(reserva, config, { destinatario, prueba = false } = {}) {
    if (!tienePdf(config) || !config.pdf.datos) throw new Error("No hay PDF de instrucciones guardado.");
    const r = typeof reserva?.toObject === "function" ? reserva.toObject() : reserva;
    const para = destinatario || r.contacto?.email;
    if (!para) throw new Error("La reserva no tiene correo.");

    const pila = P.nombreDePila(r.contacto?.nombre);
    const cuando = cuandoLlega(r.estancia.checkIn);
    const asuntoBase = config.asunto?.trim() || `Instrucciones para tu llegada a Quinta de Argos · reserva ${r.codigo}`;
    const asunto = `${prueba ? "[PRUEBA] " : ""}${asuntoBase}`;

    const intro = `Te esperamos <strong>${P.escapeHtml(cuando)}</strong> en Quinta de Argos. El check-in es a partir de las <strong>${P.escapeHtml(
        config.horaCheckIn
    )} h</strong>. Te adjuntamos en PDF las instrucciones de la casa: cómo llegar, cómo entrar y todo lo que necesitas saber para tu estancia.`;

    const botones = [
        config.ubicacionUrl ? P.boton(config.ubicacionUrl, "Cómo llegar") : "",
        P.botonWhatsApp(),
    ].join("");

    const html = P.layout({
        tituloDocumento: asunto,
        preheader: `Tu llegada ${cuando} · check-in desde las ${config.horaCheckIn} h · instrucciones en PDF`,
        etiquetaCabecera: "Tu<br />llegada",
        contenido: `
            ${P.etiqueta("Instrucciones de la casa")}
            ${P.titulo(pila ? `Hola, ${P.escapeHtml(pila)}` : "Hola")}
            ${P.parrafo(intro)}
            ${prueba ? P.parrafo("<em>Correo de prueba enviado desde el panel con datos de ejemplo.</em>") : ""}
            ${
                config.mensaje?.trim()
                    ? P.bloqueTexto(config.mensaje.trim(), "Para tu llegada")
                    : ""
            }
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
                style="margin:0 0 24px; background-color:${P.C.papel}; border:1px solid ${P.C.linea}; border-left:3px solid ${P.C.arcilla};">
                <tr><td style="padding:16px 20px;">
                    <p style="margin:0; font-family:${P.SANS}; font-size:14px; font-weight:400; line-height:1.6; color:${P.C.tinta};">
                        📎 <strong>${P.escapeHtml(nombrePdf(config.pdf.nombre))}</strong> va adjunto a este correo. Guárdalo en el móvil: te servirá durante toda la estancia.
                    </p>
                </td></tr>
            </table>
            ${P.divisor}
            ${P.tablaReserva(P.estanciaDe(r), "Tu reserva")}
            ${P.parrafo("Si tienes cualquier duda antes de llegar, responde a este correo o escríbenos por WhatsApp.")}
            <div style="margin:0 0 20px;">${botones}</div>`,
        notaPie: `Recibes este correo por tu reserva ${P.escapeHtml(r.codigo)} en quintadeargos.com.`,
    });

    const text = [
        pila ? `Hola, ${pila}:` : "Hola:",
        "",
        `Te esperamos ${cuando} en Quinta de Argos. El check-in es a partir de las ${config.horaCheckIn} h.`,
        "Te adjuntamos en PDF las instrucciones de la casa.",
        config.mensaje?.trim() ? `\n${config.mensaje.trim()}\n` : null,
        `Llegada: ${P.fechaLarga(r.estancia.checkIn)}`,
        `Salida: ${P.fechaLarga(r.estancia.checkOut)}`,
        config.ubicacionUrl ? `Cómo llegar: ${config.ubicacionUrl}` : null,
        "",
        "Las instrucciones completas van en el PDF adjunto.",
        `${P.EMPRESA.nombre} · WhatsApp ${P.EMPRESA.whatsappTexto}`,
    ]
        .filter((l) => l !== null)
        .join("\n");

    await P.sendMail({
        to: para,
        subject: asunto,
        html,
        text,
        replyTo: { email: P.BUZON_FINCA(), name: P.EMPRESA.nombre },
        attachments: [{ filename: nombrePdf(config.pdf.nombre), content: Buffer.from(config.pdf.datos) }],
    });
    return { asunto };
}

/** Deja constancia en la reserva (la ve el panel de reservas). */
async function registrarEnReserva(reserva, { asunto, estado, error = "", por = "sistema" }) {
    await Reserva.updateOne(
        { _id: reserva._id },
        {
            $push: {
                comunicaciones: {
                    tipo: "mensaje",
                    destinatario: reserva.contacto?.email || "",
                    asunto: String(asunto || "Instrucciones de la casa").slice(0, 200),
                    mensaje: "Aviso automático: Instrucciones de la casa (PDF adjunto)",
                    estado,
                    error: String(error || "").slice(0, 300),
                    creadoPor: por,
                    fecha: new Date(),
                },
            },
        }
    ).catch(() => {});
}

// ==========================================================
// 4) PROGRAMADOR (cada 5 minutos)
// ==========================================================

/**
 * Reclama el envío de una reserva para este proceso. Devuelve el registro o null si
 * ya se envió, lo está enviando otro, o agotó los reintentos.
 */
async function reclamarEnvio(reserva) {
    const clave = { reserva: reserva._id, checkIn: reserva.estancia.checkIn };
    try {
        return await InstruccionesEnvio.create({
            ...clave,
            codigo: reserva.codigo,
            email: reserva.contacto?.email || "",
            estado: "enviando",
            intentos: 1,
        });
    } catch (error) {
        if (error?.code !== 11000) throw error;
    }
    const ahora = Date.now();
    return InstruccionesEnvio.findOneAndUpdate(
        {
            ...clave,
            intentos: { $lt: MAX_INTENTOS },
            $or: [
                { estado: "error", updatedAt: { $lt: new Date(ahora - REINTENTO_MS) } },
                { estado: "enviando", updatedAt: { $lt: new Date(ahora - ENVIANDO_CADUCA_MS) } },
            ],
        },
        { $set: { estado: "enviando", error: "" }, $inc: { intentos: 1 } },
        { returnDocument: "after" }
    );
}

async function enviarYRegistrar(reserva, config, registro) {
    let asunto = "";
    try {
        ({ asunto } = await enviarCorreoInstrucciones(reserva, config));
        registro.estado = "enviado";
        registro.enviadoEn = new Date();
        registro.error = "";
        await registro.save();
        await registrarEnReserva(reserva, { asunto, estado: "enviado", por: registro.por });
        console.log(`🏡 Instrucciones de la casa enviadas: ${reserva.codigo} (${reserva.estancia.checkIn})`);
        return true;
    } catch (error) {
        registro.estado = "error";
        registro.error = String(error?.message || error).slice(0, 300);
        await registro.save().catch(() => {});
        if (registro.intentos >= MAX_INTENTOS || registro.manual) {
            await registrarEnReserva(reserva, { asunto, estado: "error", error: registro.error, por: registro.por });
        }
        console.error(`Error enviando las instrucciones de ${reserva.codigo} 🔴`, esProduccion ? "" : registro.error);
        return false;
    }
}

/** Reservas web pagadas cuya llegada está dentro de la ventana de envío. */
async function reservasCandidatas(config, { hasta } = {}) {
    const hoy = hoyEnEspana();
    const ultimoDia = hasta || sumarDias(hoy, Math.ceil(config.horasAntes / 24) + 1);
    return Reserva.find({ estado: "pagada", "estancia.checkIn": { $gte: hoy, $lte: ultimoDia } })
        .sort({ "estancia.checkIn": 1 })
        .select("codigo estado estancia contacto beds24");
}

let enVuelta = false;

async function vueltaProgramador() {
    if (enVuelta) return;
    enVuelta = true;
    try {
        const config = await leerConfig({ conPdf: true });
        if (!config.activo || !tienePdf(config)) return;
        const ahora = Date.now();
        for (const reserva of await reservasCandidatas(config)) {
            if (!reserva.contacto?.email) continue;
            const envio = horaDeEnvio(reserva.estancia.checkIn, config).getTime();
            if (ahora < envio || ahora >= finDelDiaDeLlegada(reserva.estancia.checkIn).getTime()) continue;
            const registro = await reclamarEnvio(reserva);
            if (registro) await enviarYRegistrar(reserva, config, registro);
        }
    } catch (error) {
        console.error("Error en el envío automático de instrucciones 🔴", error?.message || error);
    } finally {
        enVuelta = false;
    }
}

if (String(process.env.INSTRUCCIONES_AUTO || "").toLowerCase() !== "off") {
    setTimeout(vueltaProgramador, 30_000).unref(); // primera vuelta al arrancar (con la BD ya conectada)
    setInterval(vueltaProgramador, VUELTA_MS).unref();
} else {
    console.log("🏡 Envío automático de instrucciones desactivado en este servidor (INSTRUCCIONES_AUTO=off)");
}

// ==========================================================
// 5) RUTAS DEL PANEL
// ==========================================================

const quien = (req) => req.freshAdmin?.email || req.user?.email || "admin";

function errorRespuesta(res, status, codigo, mensaje, errors) {
    return res.status(status).json({ message: codigo, code: codigo, mensaje, detail: mensaje, ...(errors ? { errors } : {}) });
}

function errorInterno(res, error, contexto) {
    console.error(esProduccion ? `Error ${contexto} 🔴` : `Error ${contexto} 🔴 ${error?.stack || error}`);
    return errorRespuesta(res, 500, "ERROR_INTERNO", "No se ha podido completar la operación.");
}

// ---------- GET: configuración + próximos envíos + historial ----------
router.get("/api/admin/instrucciones-casa", adminMiddleware, async (req, res) => {
    try {
        const config = await leerConfig();
        const hoy = hoyEnEspana();
        const reservas = await reservasCandidatas(config, { hasta: sumarDias(hoy, 30) });
        const envios = await InstruccionesEnvio.find({ reserva: { $in: reservas.map((r) => r._id) } }).lean();
        const envioDe = new Map(envios.map((e) => [`${e.reserva}|${e.checkIn}`, e]));
        const ahora = Date.now();

        const proximos = reservas.map((r) => {
            const envio = horaDeEnvio(r.estancia.checkIn, config);
            const registro = envioDe.get(`${r._id}|${r.estancia.checkIn}`);
            let estado;
            if (registro?.estado === "enviado") estado = "enviado";
            else if (registro?.estado === "error" && registro.intentos >= MAX_INTENTOS) estado = "error";
            else if (registro) estado = "enviando";
            else if (!r.contacto?.email) estado = "sin_email";
            else if (!tienePdf(config)) estado = "sin_pdf";
            else if (!config.activo) estado = "inactivo";
            else if (ahora >= finDelDiaDeLlegada(r.estancia.checkIn).getTime()) estado = "vencido";
            else estado = ahora >= envio.getTime() ? "en_cola" : "programado";
            return {
                id: String(r._id),
                codigo: r.codigo,
                nombre: r.contacto?.nombre || "",
                email: r.contacto?.email || "",
                checkIn: r.estancia.checkIn,
                checkOut: r.estancia.checkOut,
                envioProgramado: envio,
                envioTexto: horaTexto(envio),
                estado,
                enviadoEn: registro?.enviadoEn || null,
                error: registro?.error || "",
                intentos: registro?.intentos || 0,
            };
        });

        const ultimos = await InstruccionesEnvio.find({ estado: { $in: ["enviado", "error"] } })
            .sort({ updatedAt: -1 })
            .limit(15)
            .lean();

        res.json({
            config: configPublica(config),
            ejemplo: {
                checkIn: hoy,
                envioTexto: horaTexto(horaDeEnvio(hoy, config)),
            },
            limites: { maxHorasAntes: MAX_HORAS_ANTES, maxPdfMb: MAX_PDF_BYTES / 1024 / 1024 },
            automatico: String(process.env.INSTRUCCIONES_AUTO || "").toLowerCase() !== "off",
            proximos,
            ultimos: ultimos.map((e) => ({
                id: String(e._id),
                reservaId: String(e.reserva),
                codigo: e.codigo,
                email: e.email,
                checkIn: e.checkIn,
                estado: e.estado,
                manual: e.manual,
                por: e.por,
                enviadoEn: e.enviadoEn,
                error: e.error,
                fecha: e.updatedAt,
            })),
        });
    } catch (error) {
        errorInterno(res, error, "cargando las instrucciones de la casa");
    }
});

// ---------- PUT: guardar configuración (con firma) ----------
router.put(
    "/api/admin/instrucciones-casa",
    adminMiddleware,
    requireFreshAdmin,
    requireSignature(SECCION_FIRMA),
    async (req, res) => {
        try {
            const b = req.body || {};
            const errors = {};

            const activo = b.activo === true || b.activo === "true";
            const horasTexto = String(b.horasAntes ?? "").trim().replace(",", ".");
            const horasAntes = horasTexto === "" ? NaN : Number(horasTexto);
            if (!Number.isInteger(horasAntes) || horasAntes < 0 || horasAntes > MAX_HORAS_ANTES) {
                errors.horasAntes = `Un número entero de horas entre 0 y ${MAX_HORAS_ANTES}.`;
            }
            const horaCheckIn = String(b.horaCheckIn ?? "").trim();
            if (!HORA_RE.test(horaCheckIn)) errors.horaCheckIn = "Formato HH:MM (por ejemplo 15:00).";
            const asunto = String(b.asunto ?? "").trim();
            if (asunto.length > 150) errors.asunto = "Máximo 150 caracteres.";
            const mensaje = String(b.mensaje ?? "").trim();
            if (mensaje.length > 3000) errors.mensaje = "Máximo 3000 caracteres.";
            const ubicacionUrl = String(b.ubicacionUrl ?? "").trim();
            if (ubicacionUrl && (!/^https:\/\/\S+$/i.test(ubicacionUrl) || ubicacionUrl.length > 500)) {
                errors.ubicacionUrl = "Pega un enlace completo que empiece por https://";
            }

            const config = await leerConfig();
            if (activo && !tienePdf(config)) errors.activo = "Sube primero el PDF de instrucciones.";
            if (Object.keys(errors).length) {
                return errorRespuesta(res, 400, "DATOS_INVALIDOS", "Revisa los campos marcados.", errors);
            }

            Object.assign(config, { activo, horasAntes, horaCheckIn, asunto, mensaje, ubicacionUrl, actualizadoPor: quien(req) });
            await config.save();
            await audit(req, SECCION_FIRMA, "ok", { accion: "instrucciones_config", activo, horasAntes, horaCheckIn });

            // Si se activó o cambió la hora, que lo pendiente salga sin esperar a la próxima vuelta.
            setImmediate(vueltaProgramador);
            res.json({ config: configPublica(config) });
        } catch (error) {
            errorInterno(res, error, "guardando las instrucciones de la casa");
        }
    }
);

// ---------- PDF: subir (con firma) ----------
const subidaPdf = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_PDF_BYTES, files: 1, fields: 5 },
    fileFilter: (req, file, cb) => {
        if (file.mimetype === "application/pdf") return cb(null, true);
        const error = new Error("TIPO_NO_PERMITIDO");
        error.code = "TIPO_NO_PERMITIDO";
        return cb(error);
    },
}).single("pdf");

function recibirPdf(req, res, next) {
    subidaPdf(req, res, (error) => {
        if (!error) return next();
        const mensaje =
            error.code === "LIMIT_FILE_SIZE"
                ? `El PDF pesa demasiado (máximo ${MAX_PDF_BYTES / 1024 / 1024} MB).`
                : error.code === "TIPO_NO_PERMITIDO"
                  ? "El archivo tiene que ser un PDF."
                  : "No se ha podido leer el archivo.";
        return errorRespuesta(res, 400, "ARCHIVO_INVALIDO", mensaje);
    });
}

router.post(
    "/api/admin/instrucciones-casa/pdf",
    adminMiddleware,
    requireFreshAdmin,
    recibirPdf, // primero el archivo: así req.body.pin existe para la firma
    requireSignature(SECCION_FIRMA),
    async (req, res) => {
        try {
            if (!req.file) return errorRespuesta(res, 400, "ARCHIVO_INVALIDO", "Adjunta el PDF de instrucciones.");
            if (req.file.buffer.subarray(0, 5).toString("latin1") !== "%PDF-") {
                return errorRespuesta(res, 400, "ARCHIVO_INVALIDO", "El archivo no es un PDF válido.");
            }
            const config = await leerConfig();
            config.pdf = {
                nombre: nombrePdf(req.file.originalname),
                tamano: req.file.size,
                datos: req.file.buffer,
                subidoEn: new Date(),
                subidoPor: quien(req),
            };
            config.actualizadoPor = quien(req);
            await config.save();
            await audit(req, SECCION_FIRMA, "ok", { accion: "instrucciones_pdf", nombre: config.pdf.nombre, tamano: req.file.size });
            res.json({ config: configPublica(config) });
        } catch (error) {
            errorInterno(res, error, "guardando el PDF de instrucciones");
        }
    }
);

// ---------- PDF: borrar (con firma). Sin PDF no se puede enviar: se desactiva. ----------
router.delete(
    "/api/admin/instrucciones-casa/pdf",
    adminMiddleware,
    requireFreshAdmin,
    requireSignature(SECCION_FIRMA),
    async (req, res) => {
        try {
            const config = await leerConfig();
            config.pdf = { nombre: null, tamano: 0, datos: null, subidoEn: null, subidoPor: "" };
            config.activo = false;
            config.actualizadoPor = quien(req);
            await config.save();
            await audit(req, SECCION_FIRMA, "ok", { accion: "instrucciones_pdf_borrado" });
            res.json({ config: configPublica(config) });
        } catch (error) {
            errorInterno(res, error, "borrando el PDF de instrucciones");
        }
    }
);

// ---------- PDF: ver ----------
router.get("/api/admin/instrucciones-casa/pdf", adminMiddleware, async (req, res) => {
    try {
        const config = await leerConfig({ conPdf: true });
        if (!tienePdf(config) || !config.pdf.datos) return errorRespuesta(res, 404, "SIN_PDF", "Todavía no hay PDF guardado.");
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `inline; filename="${config.pdf.nombre}"`);
        res.setHeader("Cache-Control", "no-store");
        res.send(Buffer.from(config.pdf.datos));
    } catch (error) {
        errorInterno(res, error, "leyendo el PDF de instrucciones");
    }
});

// ---------- Correo de prueba (con datos de ejemplo, no toca ninguna reserva) ----------
router.post("/api/admin/instrucciones-casa/prueba", adminMiddleware, async (req, res) => {
    try {
        const email = String(req.body?.email || req.user?.email || "").trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return errorRespuesta(res, 400, "DATOS_INVALIDOS", "Escribe un correo válido.", { email: "Correo no válido." });
        }
        const config = await leerConfig({ conPdf: true });
        if (!tienePdf(config)) return errorRespuesta(res, 409, "SIN_PDF", "Sube primero el PDF de instrucciones.");

        const llegada = sumarDias(hoyEnEspana(), 1);
        const ejemplo = {
            codigo: "QA-EJEMPLO",
            contacto: { nombre: "Huésped de ejemplo", email },
            estancia: { checkIn: llegada, checkOut: sumarDias(llegada, 3), noches: 3, huespedes: 4, adultos: 2, menores: 2, cuna: false },
        };
        await enviarCorreoInstrucciones(ejemplo, config, { destinatario: email, prueba: true });
        res.json({ enviado: true, email });
    } catch (error) {
        console.error("Error enviando la prueba de instrucciones 🔴", error?.message || error);
        errorRespuesta(res, 502, "ENVIO_FALLIDO", `No se ha podido enviar el correo: ${error?.message || "error de Brevo"}`);
    }
});

// ---------- Enviar ya (o reenviar) a una reserva (con firma) ----------
const enviandoManual = new Set();

router.post(
    "/api/admin/instrucciones-casa/enviar/:id",
    adminMiddleware,
    requireFreshAdmin,
    requireSignature(SECCION_FIRMA),
    async (req, res) => {
        const { id } = req.params;
        if (!mongoose.isValidObjectId(id)) return errorRespuesta(res, 400, "DATOS_INVALIDOS", "Reserva no válida.");
        if (enviandoManual.has(id)) return errorRespuesta(res, 409, "EN_CURSO", "Ya se está enviando. Espera unos segundos.");
        enviandoManual.add(id);
        try {
            const config = await leerConfig({ conPdf: true });
            if (!tienePdf(config)) return errorRespuesta(res, 409, "SIN_PDF", "Sube primero el PDF de instrucciones.");
            const reserva = await Reserva.findById(id).select("codigo estado estancia contacto");
            if (!reserva) return errorRespuesta(res, 404, "NO_EXISTE", "La reserva no existe.");
            if (reserva.estado !== "pagada") return errorRespuesta(res, 409, "ESTADO_NO_VALIDO", "Solo se envía a reservas pagadas y activas.");

            const registro = await InstruccionesEnvio.findOneAndUpdate(
                { reserva: reserva._id, checkIn: reserva.estancia.checkIn },
                {
                    $set: { codigo: reserva.codigo, email: reserva.contacto.email, estado: "enviando", manual: true, por: quien(req), error: "" },
                    $inc: { intentos: 1 },
                },
                { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }
            );
            const ok = await enviarYRegistrar(reserva, config, registro);
            await audit(req, SECCION_FIRMA, ok ? "ok" : "error", { accion: "instrucciones_envio_manual", codigo: reserva.codigo });
            if (!ok) return errorRespuesta(res, 502, "ENVIO_FALLIDO", `No se ha podido enviar: ${registro.error}`);
            res.json({ enviado: true, codigo: reserva.codigo, email: reserva.contacto.email });
        } catch (error) {
            errorInterno(res, error, "enviando las instrucciones");
        } finally {
            enviandoManual.delete(id);
        }
    }
);

module.exports = router;
module.exports.vueltaProgramador = vueltaProgramador; // por si se quiere lanzar a mano (tests, scripts)
module.exports.enviarCorreoInstrucciones = enviarCorreoInstrucciones;