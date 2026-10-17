// routes/adminPreciosWebRouter.js — Quinta de Argos
// Precios de la web desde el panel (Configuración → Precios de la web).
// NO toca Beds24: Booking y Airbnb siguen con su precio. Solo cambia lo que ve y paga
// el huésped que reserva en quintadeargos.com.
//
//   GET  /api/admin/precios-web                     -> descuento general, límites y precios fijados a mano
//   GET  /api/admin/precios-web/dias?from&to        -> precio web de cada día (para el calendario del panel)
//   POST /api/admin/precios-web/preview             -> cómo quedan las fechas (no escribe)
//   POST /api/admin/precios-web                     -> lo aplica                          [firma]
//   POST /api/admin/precios-web/descuento/preview   -> ejemplos con el nuevo descuento (no escribe)
//   POST /api/admin/precios-web/descuento           -> cambia el descuento general        [firma]
//
// Se monta en index.js DESPUÉS de express.json() y cookieParser().

const express = require("express");
const adminMiddleware = require("../middleware/adminMiddleware");
const requireFreshAdmin = require("../middleware/requireFreshAdmin");
const { requireSignature, audit } = require("../middleware/requireSignature");
const { PrecioWeb, AjustesWeb } = require("../models/PrecioWeb");
const { HORIZONTE_DIAS, DESCUENTO_WEB } = require("../config/reservasConfig");
const {
    hoyEnEspana,
    sumarDias,
    esFechaValida,
    tarifaDe,
    tarifaSegunReglas,
    cargarPreciosWeb,
    descuentoWeb,
    precioWebAutomatico,
} = require("../services/reservasService");

const router = express.Router();

// Misma sección de firma que el resto del calendario (mismo bloqueo y auditoría).
const SECCION_FIRMA = "calendario";

const LIMITES = {
    precio: { min: 20, max: 3000 }, // € por noche
    porcentaje: { min: -80, max: 100 }, // % sobre el precio de Booking y Airbnb
    descuento: { min: 0, max: 50 }, // % de descuento general
    maxDias: 400,
};

class PreciosWebError extends Error {
    constructor(codigo, message, status = 400, extra = {}) {
        super(message);
        this.codigo = codigo;
        this.status = status;
        this.extra = extra;
    }
}

const quienEs = (req) => req.freshAdmin?.email || req.user?.email || "admin";

function enviarError(res, error, etiqueta) {
    if (error instanceof PreciosWebError) {
        return res.status(error.status).json({ message: error.codigo, detail: error.message, ...error.extra });
    }
    console.error(`${etiqueta} 🔴`, error?.message || error);
    return res.status(500).json({ message: "ERROR", detail: "No se ha podido guardar. Inténtalo de nuevo." });
}

// Lunes = 1 … domingo = 7 (igual que el front)
const diaSemana = (fecha) => ((new Date(`${fecha}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;

function leerNumero(valor) {
    if (typeof valor === "number") return valor;
    if (typeof valor !== "string" || !valor.trim()) return NaN;
    return Number(valor.trim().replace(",", "."));
}

// Días consecutivos con el mismo precio -> un rango (para el resumen del panel)
function agruparManuales(filas) {
    const rangos = [];
    for (const f of filas) {
        const ultimo = rangos[rangos.length - 1];
        if (ultimo && sumarDias(ultimo.to, 1) === f.fecha && ultimo.precio === f.precio) ultimo.to = f.fecha;
        else rangos.push({ from: f.fecha, to: f.fecha, precio: f.precio });
    }
    return rangos;
}

// ---------- Validación de una petición por fechas ----------
// body: { from, to, weekdays: number[], mode: "fixed" | "percent" | "auto", value?: string }
function validarPeticion(body) {
    const errors = {};
    const hoy = hoyEnEspana();
    const ultimo = sumarDias(hoy, HORIZONTE_DIAS);
    const { from, to, mode } = body ?? {};
    const weekdays = Array.isArray(body?.weekdays) ? [...new Set(body.weekdays.map(Number))].filter((d) => d >= 1 && d <= 7) : [];

    if (!esFechaValida(from)) errors.from = "Elige la fecha de inicio.";
    else if (from < hoy) errors.from = "No se pueden cambiar fechas pasadas.";
    if (!esFechaValida(to)) errors.to = "Elige la fecha final.";
    else if (esFechaValida(from) && to < from) errors.to = "Tiene que ser igual o posterior a la fecha de inicio.";
    else if (to > ultimo) errors.to = "Solo se puede reservar hasta un año vista.";
    if (!errors.from && !errors.to) {
        const dias = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
        if (dias > LIMITES.maxDias) errors.to = `Como mucho ${LIMITES.maxDias} días de una vez.`;
    }
    if (!weekdays.length) errors.weekdays = "Elige al menos un día de la semana.";

    let value = null;
    if (!["fixed", "percent", "auto"].includes(mode)) {
        errors.value = "Elige qué hacer con el precio.";
    } else if (mode === "fixed") {
        value = leerNumero(body.value);
        if (!Number.isFinite(value) || value < LIMITES.precio.min || value > LIMITES.precio.max) {
            errors.value = `Entre ${LIMITES.precio.min} y ${LIMITES.precio.max} €.`;
        } else value = Math.round(value);
    } else if (mode === "percent") {
        value = leerNumero(body.value);
        if (!Number.isFinite(value) || value === 0 || value < LIMITES.porcentaje.min || value > LIMITES.porcentaje.max) {
            errors.value = `Entre ${LIMITES.porcentaje.min} % y +${LIMITES.porcentaje.max} % (distinto de 0).`;
        }
    }

    if (Object.keys(errors).length) {
        throw new PreciosWebError("DATOS_INVALIDOS", "Revisa los campos marcados.", 400, { errors });
    }
    return { from, to, weekdays: weekdays.sort(), mode, value };
}

// ---------- Cálculo de cambios (vista previa y aplicar usan lo mismo) ----------
async function calcularCambios(peticion) {
    await cargarPreciosWeb(); // en fresco: lo que se ve es lo que se guarda
    const { from, to, weekdays, mode, value } = peticion;
    const changes = [];
    const skipped = [];

    for (let fecha = from; fecha <= to; fecha = sumarDias(fecha, 1)) {
        const weekday = diaSemana(fecha);
        if (!weekdays.includes(weekday)) continue;
        const reglas = tarifaSegunReglas(fecha);
        if (!reglas) {
            skipped.push({ date: fecha, reason: "Sin precio en las reglas" });
            continue;
        }
        const actual = tarifaDe(fecha);
        const automatico = precioWebAutomatico(reglas.precio);

        let despues;
        let manualDespues;
        if (mode === "auto") {
            despues = automatico;
            manualDespues = false;
        } else if (mode === "fixed") {
            despues = value;
            manualDespues = true;
        } else {
            despues = Math.max(1, Math.round(reglas.precio * (1 + value / 100)));
            manualDespues = true;
        }

        if (despues === actual.precio && manualDespues === actual.manual) continue;
        changes.push({
            date: fecha,
            weekday,
            channels: reglas.precio, // Booking y Airbnb (reglas)
            before: { price: actual.precio, manual: actual.manual },
            after: { price: despues, manual: manualDespues },
        });
    }
    return { changes, skipped };
}

const resumen = (peticion, changes) => ({
    from: peticion.from,
    to: peticion.to,
    weekdays: peticion.weekdays,
    mode: peticion.mode,
    days: changes.length,
});

// ---------- Estado actual ----------
router.get("/api/admin/precios-web", adminMiddleware, async (req, res) => {
    try {
        await cargarPreciosWeb();
        const hoy = hoyEnEspana();
        const filas = await PrecioWeb.find({ fecha: { $gte: hoy } }, { fecha: 1, precio: 1, _id: 0 }).sort({ fecha: 1 }).lean();
        res.set("Cache-Control", "no-store");
        res.json({
            today: hoy,
            lastDay: sumarDias(hoy, HORIZONTE_DIAS),
            descuento: Math.round(descuentoWeb() * 1000) / 10, // en %
            descuentoPorDefecto: Math.round(DESCUENTO_WEB * 1000) / 10,
            limits: LIMITES,
            manuales: agruparManuales(filas),
        });
    } catch (error) {
        enviarError(res, error, "Error leyendo los precios de la web");
    }
});

// ---------- Precio web día a día (calendario de Configuración) ----------
router.get("/api/admin/precios-web/dias", adminMiddleware, async (req, res) => {
    const { from, to } = req.query;
    if (!esFechaValida(from) || !esFechaValida(to) || to < from) {
        return res.status(400).json({ message: "DATOS_INVALIDOS", detail: "Fechas no válidas." });
    }
    const dias = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
    if (dias > 62) return res.status(400).json({ message: "DATOS_INVALIDOS", detail: "Como mucho 62 días." });
    try {
        await cargarPreciosWeb();
        const days = [];
        for (let fecha = from; fecha <= to; fecha = sumarDias(fecha, 1)) {
            const t = tarifaDe(fecha);
            days.push({ date: fecha, price: t ? t.precio : null, manual: !!t?.manual });
        }
        res.set("Cache-Control", "no-store");
        res.json({ descuento: Math.round(descuentoWeb() * 1000) / 10, days });
    } catch (error) {
        enviarError(res, error, "Error leyendo el precio web por días");
    }
});

// ---------- Precios por fechas ----------
router.post("/api/admin/precios-web/preview", adminMiddleware, async (req, res) => {
    try {
        const peticion = validarPeticion(req.body);
        const { changes, skipped } = await calcularCambios(peticion);
        res.json({ summary: resumen(peticion, changes), changes, skipped });
    } catch (error) {
        enviarError(res, error, "Error en la vista previa de precios web");
    }
});

router.post(
    "/api/admin/precios-web",
    adminMiddleware,
    requireFreshAdmin,
    requireSignature(SECCION_FIRMA),
    async (req, res) => {
        try {
            const peticion = validarPeticion(req.body);
            const { changes, skipped } = await calcularCambios(peticion);
            const por = quienEs(req);

            if (changes.length) {
                await PrecioWeb.bulkWrite(
                    changes.map((c) =>
                        c.after.manual
                            ? {
                                  updateOne: {
                                      filter: { fecha: c.date },
                                      update: { $set: { precio: c.after.price, actualizadoPor: por } },
                                      upsert: true,
                                  },
                              }
                            : { deleteOne: { filter: { fecha: c.date } } }
                    ),
                    { ordered: false }
                );
                await cargarPreciosWeb();
            }

            await audit(req, SECCION_FIRMA, "ok", {
                accion: "precios_web",
                from: peticion.from,
                to: peticion.to,
                weekdays: peticion.weekdays.join(","),
                modo: peticion.mode,
                valor: peticion.value,
                dias: changes.length,
            });
            res.json({ applied: resumen(peticion, changes), skipped });
        } catch (error) {
            await audit(req, SECCION_FIRMA, error instanceof PreciosWebError ? "rejected" : "error", {
                accion: "precios_web",
                code: error.codigo || "ERROR",
            }).catch(() => {});
            enviarError(res, error, "Error guardando precios de la web");
        }
    }
);

// ---------- Descuento general ----------
function validarDescuento(body) {
    const valor = leerNumero(body?.percent);
    const { min, max } = LIMITES.descuento;
    if (!Number.isFinite(valor) || valor < min || valor > max) {
        throw new PreciosWebError("DATOS_INVALIDOS", "Revisa el descuento.", 400, {
            errors: { percent: `Entre ${min} y ${max} %.` },
        });
    }
    return Math.round(valor * 10) / 10; // en %, con un decimal
}

// Ejemplos con los precios distintos de las reglas que hay en los próximos 12 meses
function ejemplosDescuento(porcentaje) {
    const hoy = hoyEnEspana();
    const precios = new Set();
    for (let f = hoy, i = 0; i < HORIZONTE_DIAS; f = sumarDias(f, 1), i++) {
        const t = tarifaSegunReglas(f);
        if (t) precios.add(t.precio);
    }
    return [...precios]
        .sort((a, b) => a - b)
        .map((precio) => ({
            price: precio,
            before: precioWebAutomatico(precio),
            after: precioWebAutomatico(precio, porcentaje / 100),
        }));
}

router.post("/api/admin/precios-web/descuento/preview", adminMiddleware, async (req, res) => {
    try {
        const porcentaje = validarDescuento(req.body);
        await cargarPreciosWeb();
        const manuales = (await PrecioWeb.countDocuments({ fecha: { $gte: hoyEnEspana() } })) || 0;
        res.json({
            before: Math.round(descuentoWeb() * 1000) / 10,
            after: porcentaje,
            examples: ejemplosDescuento(porcentaje),
            manuales, // noches con precio a mano: el descuento no les afecta
        });
    } catch (error) {
        enviarError(res, error, "Error en la vista previa del descuento web");
    }
});

router.post(
    "/api/admin/precios-web/descuento",
    adminMiddleware,
    requireFreshAdmin,
    requireSignature(SECCION_FIRMA),
    async (req, res) => {
        try {
            const porcentaje = validarDescuento(req.body);
            const antes = Math.round(descuentoWeb() * 1000) / 10;
            await AjustesWeb.updateOne(
                { _id: "web" },
                { $set: { descuento: porcentaje / 100, actualizadoPor: quienEs(req) } },
                { upsert: true }
            );
            await cargarPreciosWeb();
            await audit(req, SECCION_FIRMA, "ok", { accion: "descuento_web", antes, despues: porcentaje });
            res.json({ descuento: porcentaje });
        } catch (error) {
            await audit(req, SECCION_FIRMA, error instanceof PreciosWebError ? "rejected" : "error", {
                accion: "descuento_web",
                code: error.codigo || "ERROR",
            }).catch(() => {});
            enviarError(res, error, "Error guardando el descuento web");
        }
    }
);

module.exports = router;