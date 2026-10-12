const { beds24Request } = require("../services/beds24Client");
const { fetchCalendar, ROOM_ID } = require("../services/beds24Service");
const { tarifaDe, sumarDias, hoyEnEspana } = require("../services/reservasService");
const { HORIZONTE_DIAS } = require("../config/reservasConfig");

const esProduccion = process.env.NODE_ENV === "production";

const VENTANA_DIAS = 60; // revisa los últimos 60 días: cubre semanas con el servidor dormido
const INTERVALO_MS = 24 * 60 * 60 * 1000; // una vez al día
const RETRASO_INICIAL_MS = 60 * 1000; // 1 minuto después de arrancar

// Días consecutivos con el mismo precio y mínimo -> un solo rango (menos créditos).
function agruparEnRangos(dias) {
    const rangos = [];
    for (const d of dias) {
        const ultimo = rangos[rangos.length - 1];
        if (ultimo && sumarDias(ultimo.to, 1) === d.fecha && ultimo.price1 === d.precio && ultimo.minStay === d.minNoches) {
            ultimo.to = d.fecha;
        } else {
            rangos.push({ from: d.fecha, to: d.fecha, price1: d.precio, minStay: d.minNoches });
        }
    }
    return rangos;
}

/**
 * Rellena los días sin precio al final del horizonte.
 * @param {{ simular?: boolean }} opciones  simular: calcula pero no escribe en Beds24
 * @returns {Promise<{ desde, hasta, revisados, sinPrecio, rellenados, pendientes, rangos }>}
 */
async function rellenarPreciosHorizonte({ simular = false } = {}) {
    const hoy = hoyEnEspana();
    const hasta = sumarDias(hoy, HORIZONTE_DIAS);
    const desde = sumarDias(hasta, -(VENTANA_DIAS - 1));

    const calendario = await fetchCalendar(desde, hasta); // [{ date, price, minStay, ... }]
    const conPrecio = new Set(calendario.filter((d) => typeof d.price === "number" && d.price > 0).map((d) => d.date));

    const aRellenar = [];
    const pendientes = [];
    let revisados = 0;
    for (let fecha = desde; fecha <= hasta; fecha = sumarDias(fecha, 1)) {
        revisados += 1;
        if (conPrecio.has(fecha)) continue;
        const tarifa = tarifaDe(fecha);
        if (tarifa) aRellenar.push({ fecha, precio: tarifa.precio, minNoches: tarifa.minNoches });
        else pendientes.push(fecha); // sin tarifa en tarifas.js (PENDIENTE o fuera de VIGENCIA)
    }

    const rangos = agruparEnRangos(aRellenar);
    if (rangos.length && !simular) {
        const data = await beds24Request("/inventory/rooms/calendar", {
            method: "POST",
            body: [{ roomId: ROOM_ID, calendar: rangos }],
        });
        const r = Array.isArray(data) ? data[0] : data;
        if (r?.success === false) {
            throw new Error(`Beds24 rechazó los precios: ${JSON.stringify(r.errors || r)}`);
        }
        try {
            require("../services/bookingSync").invalidateCalendarCache?.();
        } catch {
            /* la caché caduca sola */
        }
    }

    return {
        desde,
        hasta,
        revisados,
        sinPrecio: aRellenar.length + pendientes.length,
        rellenados: simular ? 0 : aRellenar.length,
        pendientes,
        rangos,
    };
}

let iniciado = false;

function startBeds24TarifasJob() {
    if (iniciado) return;
    iniciado = true;

    const ejecutar = async () => {
        try {
            const r = await rellenarPreciosHorizonte();
            if (r.rellenados) {
                console.log(`Precios Beds24: ${r.rellenados} días nuevos con precio (${r.desde} → ${r.hasta}) 🟢`);
            }
            if (r.pendientes.length) {
                console.warn(
                    `Precios Beds24: ${r.pendientes.length} días sin tarifa en data/tarifas.js, siguen cerrados 🟠`,
                    esProduccion ? "" : r.pendientes.join(", ")
                );
            }
        } catch (error) {
            console.error("Precios Beds24: no se pudo rellenar el horizonte 🔴", error?.message || error);
        }
    };

    setTimeout(ejecutar, RETRASO_INICIAL_MS).unref?.();
    setInterval(ejecutar, INTERVALO_MS).unref?.();
}

module.exports = { startBeds24TarifasJob, rellenarPreciosHorizonte, agruparEnRangos };