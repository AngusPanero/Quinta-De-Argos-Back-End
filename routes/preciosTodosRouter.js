const express = require("express");
const adminMiddleware = require("../middleware/adminMiddleware");
const requireFreshAdmin = require("../middleware/requireFreshAdmin");
const { requireSignature, audit } = require("../middleware/requireSignature");
const { addDays } = require("../utils/dates");
const { ConfigError, planCalendar, applyCalendar } = require("../services/beds24ConfigService");
const { cargarPreciosWeb, descuentoWeb, tarifaDe } = require("../services/reservasService");

const esProduccion = process.env.NODE_ENV === "production";
const preciosTodosRouter = express.Router();
const SECCION_FIRMA = "calendario";

const isoWeekday = (date) => {
    const d = new Date(`${date}T00:00:00Z`).getUTCDay();
    return d === 0 ? 7 : d; // 1 = lunes … 7 = domingo
};

const precioWebDe = (precioBeds24, descuento) => Math.round(precioBeds24 * (1 - descuento));
const quien = (req) => req.freshAdmin?.email || req.user?.email || "admin";

function sendError(res, error, label) {
    if (error instanceof ConfigError) {
        return res.status(error.status).json({ message: error.code, detail: error.message, ...error.extra });
    }
    console.error(esProduccion ? `${label} 🔴` : `${label} 🔴 ${error?.stack || error} ${JSON.stringify(error?.details || "")}`);
    return res.status(502).json({
        message: "BEDS24_ERROR",
        detail: "Beds24 no respondió o rechazó el cambio. No se ha cambiado nada. Prueba de nuevo en unos minutos.",
    });
}

/** El pedido del panel convertido al formato de planCalendar (precio fijo). */
function aPedidoBeds24(body = {}) {
    return {
        from: body.from,
        to: body.to,
        weekdays: body.weekdays,
        price: { mode: "fixed", value: body.precio },
    };
}

/**
 * Plan completo: lo que cambia en Beds24 (planCalendar) y lo que cambia en la web.
 * La web se calcula para TODOS los días elegidos, aunque en Beds24 ya tengan ese precio.
 */
async function planTodos(body) {
    await cargarPreciosWeb(); // descuento y precios a mano al día
    const plan = await planCalendar(aPedidoBeds24(body)); // valida y lanza ConfigError si algo está mal
    const precioBeds24 = plan.request.price.value; // ya redondeado y validado
    const descuento = descuentoWeb();
    const precioWeb = precioWebDe(precioBeds24, descuento);

    const beds24PorFecha = new Map(plan.changes.map((c) => [c.date, c]));
    const dias = [];
    for (let date = plan.request.from; date <= plan.request.to; date = addDays(date, 1)) {
        const weekday = isoWeekday(date);
        if (!plan.request.weekdays.includes(weekday)) continue;

        const cambioBeds24 = beds24PorFecha.get(date);
        const web = tarifaDe(date);
        const webAntes = web ? { precio: web.precio, manual: web.manual } : { precio: null, manual: false };
        const cambiaWeb = !(webAntes.manual && webAntes.precio === precioWeb);

        dias.push({
            date,
            weekday,
            beds24: {
                antes: cambioBeds24 ? cambioBeds24.before.price : precioBeds24,
                despues: precioBeds24,
                cambia: !!cambioBeds24,
            },
            web: {
                antes: webAntes.precio,
                antesManual: webAntes.manual,
                despues: precioWeb,
                cambia: cambiaWeb,
            },
        });
    }

    const webCambia = dias.filter((d) => d.web.cambia);
    return {
        plan,
        resumen: {
            from: plan.request.from,
            to: plan.request.to,
            weekdays: plan.request.weekdays,
            precioBeds24,
            precioWeb,
            descuento, // fracción: 0.05 = 5 %
            diasBeds24: plan.changes.length,
            diasWeb: webCambia.length,
        },
        dias,
        webCambia,
    };
}

// ---------- Vista previa ----------
preciosTodosRouter.post("/api/admin/precios-todos/preview", adminMiddleware, async (req, res) => {
    try {
        const { resumen, dias } = await planTodos(req.body);
        res.json({ summary: resumen, days: dias });
    } catch (error) {
        sendError(res, error, "Error en la vista previa de «cambiar en todos lados»");
    }
});

// ---------- Aplicar (con firma) ----------
let enCurso = false;

preciosTodosRouter.post(
    "/api/admin/precios-todos",
    adminMiddleware,
    requireFreshAdmin,
    requireSignature(SECCION_FIRMA),
    async (req, res) => {
        if (enCurso) return res.status(409).json({ message: "EN_CURSO", detail: "Ya se está aplicando un cambio. Espera unos segundos." });
        enCurso = true;
        try {
            const { plan, resumen, webCambia } = await planTodos(req.body);
            if (!plan.changes.length && !webCambia.length) {
                throw new ConfigError("SIN_CAMBIOS", "Las fechas elegidas ya tienen ese precio en Beds24 y en la web.");
            }

            // 1) Beds24 (Booking y Airbnb). Si falla, se corta aquí: la web no se toca.
            if (plan.changes.length) await applyCalendar(aPedidoBeds24(req.body));

            // 2) Calendario propio de la web: precio fijado a mano para esas noches.
            let webError = null;
            if (webCambia.length) {
                try {
                    const { PrecioWeb } = require("../models/PrecioWeb");
                    await PrecioWeb.bulkWrite(
                        webCambia.map((d) => ({
                            updateOne: {
                                filter: { fecha: d.date },
                                update: { $set: { precio: d.web.despues, actualizadoPor: quien(req) }, $setOnInsert: { fecha: d.date } },
                                upsert: true,
                            },
                        }))
                    );
                } catch (error) {
                    webError = error;
                }
            }

            await cargarPreciosWeb();
            try {
                require("../services/beds24AvailabilityService").invalidarCacheDisponibilidad?.();
            } catch {
                // si no existe, la caché caduca sola
            }

            await audit(req, SECCION_FIRMA, webError ? "error" : "ok", {
                accion: "precio_todos",
                ...resumen,
                webError: webError ? String(webError.message || webError).slice(0, 200) : undefined,
            });

            if (webError) {
                console.error("Precio aplicado en Beds24 pero no en la web 🔴", webError?.message || webError);
                return res.status(500).json({
                    message: "WEB_SIN_ACTUALIZAR",
                    detail: "Beds24 ya tiene el precio nuevo, pero no se ha podido guardar en la web. Vuelve a aplicarlo: Beds24 no se repite y la web se completa.",
                    applied: resumen,
                });
            }
            res.json({ applied: resumen });
        } catch (error) {
            if (!(error instanceof ConfigError)) {
                await audit(req, SECCION_FIRMA, "error", { accion: "precio_todos", code: "BEDS24_ERROR", body: { ...req.body, pin: undefined } }).catch(() => {});
            }
            sendError(res, error, "Error aplicando «cambiar en todos lados»");
        } finally {
            enCurso = false;
        }
    }
);

module.exports = preciosTodosRouter;