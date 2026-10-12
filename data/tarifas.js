const { beds24Request } = require("../services/beds24Client");
const { fetchCalendar, ROOM_ID } = require("../services/beds24Service");
const { HORIZONTE_DIAS, ZONA_HORARIA } = require("../config/reservasConfig");

const esProduccion = process.env.NODE_ENV === "production";

// ==========================================================
// 1) REGLAS
//    Prioridad: Excepciones > Navidad > Semana Santa > Temporadas > Puentes > Base
//    Valores sacados de la planilla del cliente (temporada 02/10/2026 – 01/10/2027).
// ==========================================================

// ---------- 6) Base: resto del año, según el día de la semana ----------
const BASE = {
    semana: { precio: 197, minNoches: 3 }, // noches de domingo a jueves
    finde: { precio: 240, minNoches: 2 }, // noches de viernes y sábado
};

// ---------- 4) Temporadas (se repiten cada año por meses) ----------
const TEMPORADAS = [
    {
        nombre: "Junio y septiembre",
        meses: [6, 9],
        semana: { precio: 240, minNoches: 4 },
        finde: { precio: 267, minNoches: 4 },
    },
    {
        nombre: "Julio y agosto",
        meses: [7, 8],
        semana: { precio: 267, minNoches: 7 },
        finde: { precio: 267, minNoches: 7 },
    },
];

// ---------- 2) Navidad, Año Nuevo y Reyes (por fecha, cada año igual) ----------
// precio: null = se usa el precio normal de ese día (según si es fin de semana o no).
const NAVIDAD = {
    "12-23": { precio: null, minNoches: 4 },
    "12-24": { precio: 395, minNoches: 3 }, // Nochebuena
    "12-25": { precio: 374, minNoches: 2 }, // Navidad
    "12-26": { precio: 300, minNoches: 2 },
    "12-27": { precio: 240, minNoches: 3 },
    "12-28": { precio: 240, minNoches: 4 },
    "12-29": { precio: 240, minNoches: 3 },
    "12-30": { precio: 240, minNoches: 3 },
    "12-31": { precio: 395, minNoches: 3 }, // Nochevieja
    "01-01": { precio: 374, minNoches: 2 }, // Año Nuevo
    "01-02": { precio: 300, minNoches: 2 },
    "01-04": { precio: null, minNoches: 2 },
    "01-05": { precio: 240, minNoches: 3 }, // víspera de Reyes
};

// ---------- 3) Semana Santa (relativa al Domingo de Pascua = día 0) ----------
// 2027: Pascua el 28/03 -> noches del 24/03 (miércoles) al 29/03 (lunes) a precio de
// fin de semana, y las llegadas del martes al viernes deben quedarse hasta el domingo.
const SEMANA_SANTA = {
    nochesFinde: { desde: -4, hasta: 1 }, // miércoles santo … lunes de Pascua
    llegadas: { desde: -5, hasta: -2 }, // martes … viernes: mínimo hasta el domingo
    salidaMinima: 0, // domingo de Pascua
};

// ---------- 5) Festivos y puentes ----------
// Fijos (MM-DD) que cuentan para los puentes. Jueves y Viernes Santo se añaden solos.
// precioVispera: precio de la noche anterior al festivo (si no se pone, precio de fin de semana).
//
// Cómo se calcula un puente, cada año:
//   - Días libres = sábados, domingos, festivos y el día "puente" (lunes si el festivo
//     cae en martes; viernes si cae en jueves).
//   - Si alrededor del festivo hay 3 o más días libres seguidos, es un puente:
//       · sus noches se cobran a precio de fin de semana (o precioVispera);
//       · quien llega durante el puente tiene como mínimo las noches hasta el último día libre.
//   - Si no hay puente (por ejemplo, el festivo cae en domingo), solo se aplica precioVispera.
// Dentro de las temporadas (junio–septiembre), Navidad y Semana Santa mandan esas reglas.
const FESTIVOS = [
    { fecha: "01-06", nombre: "Reyes" },
    { fecha: "03-19", nombre: "San José (Región de Murcia)" },
    { fecha: "05-01", nombre: "Día del Trabajo" },
    { fecha: "06-09", nombre: "Día de la Región de Murcia" },
    { fecha: "08-15", nombre: "Asunción" },
    { fecha: "10-12", nombre: "Fiesta Nacional (Pilar)" },
    { fecha: "11-01", nombre: "Todos los Santos", precioVispera: 326 },
    { fecha: "12-06", nombre: "Constitución", precioVispera: 326 },
    { fecha: "12-08", nombre: "Inmaculada", precioVispera: 326 },
];

// Ajustes del calendario oficial de cada año (se publica cada otoño):
// festivos que se añaden o se quitan ese año concreto (AAAA-MM-DD).
const FESTIVOS_EXTRA = [
    // "2028-05-02", // ej.: festivo local de Caravaca/Cehegín
];
const FESTIVOS_QUITAR = [
    // "2029-03-19", // ej.: si ese año San José no es festivo en Murcia
];

// ---------- 1) Excepciones por fecha concreta ----------
// Lo que decidió el cliente para días puntuales y no sale de ninguna regla.
// Se respetan siempre, por encima de todo lo demás.
const EXCEPCIONES = {
    "2026-10-08": { precio: 197, minNoches: 4 }, // jueves antes del puente del Pilar
    "2026-12-06": { precio: 197, minNoches: 2 }, // domingo del puente de diciembre
    "2027-06-27": { precio: 255, minNoches: 4 }, // domingo de junio
};

// ==========================================================
// 2) MOTOR DE PRECIOS
// ==========================================================

// ---------- Fechas ----------
function sumarDias(fecha, dias) {
    const d = new Date(`${fecha}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + dias);
    return d.toISOString().slice(0, 10);
}
const diaSemana = (fecha) => new Date(`${fecha}T00:00:00Z`).getUTCDay(); // 0 = domingo … 6 = sábado
const diasEntre = (desde, hasta) => Math.round((Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${desde}T00:00:00Z`)) / 86_400_000);
const esNocheFinde = (fecha) => [5, 6].includes(diaSemana(fecha)); // noche de viernes o sábado

/** Domingo de Pascua (calendario gregoriano, algoritmo de Meeus/Jones/Butcher). */
function pascua(anio) {
    const a = anio % 19;
    const b = Math.floor(anio / 100);
    const c = anio % 100;
    const d = Math.floor(b / 4);
    const e = b % 4;
    const f = Math.floor((b + 8) / 25);
    const g = Math.floor((b - f + 1) / 3);
    const h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4);
    const k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7;
    const m = Math.floor((a + 11 * h + 22 * l) / 451);
    const mes = Math.floor((h + l - 7 * m + 114) / 31);
    const dia = ((h + l - 7 * m + 114) % 31) + 1;
    return `${anio}-${String(mes).padStart(2, "0")}-${String(dia).padStart(2, "0")}`;
}

// ---------- Precio "normal" de un día (temporada o base) ----------
function temporadaDe(fecha) {
    const mes = Number(fecha.slice(5, 7));
    return TEMPORADAS.find((t) => t.meses.includes(mes)) || null;
}

function valorNormal(fecha) {
    const t = temporadaDe(fecha);
    const regla = t || BASE;
    const v = esNocheFinde(fecha) ? regla.finde : regla.semana;
    return { precio: v.precio, minNoches: v.minNoches, motivo: t ? t.nombre : "Según el día de la semana" };
}

const precioFinde = (fecha) => (temporadaDe(fecha) || BASE).finde.precio;

// ---------- Navidad ----------
const enNavidad = (fecha) => Boolean(NAVIDAD[fecha.slice(5)]);

// ---------- Semana Santa (por año) ----------
const cacheSemanaSanta = new Map();
function semanaSanta(anio) {
    if (cacheSemanaSanta.has(anio)) return cacheSemanaSanta.get(anio);
    const p = pascua(anio);
    const S = SEMANA_SANTA;
    const dias = new Map(); // fecha -> { precio?, minNoches? }
    for (let o = S.nochesFinde.desde; o <= S.nochesFinde.hasta; o++) {
        const f = sumarDias(p, o);
        dias.set(f, { ...(dias.get(f) || {}), precio: precioFinde(f) });
    }
    const salida = sumarDias(p, S.salidaMinima);
    for (let o = S.llegadas.desde; o <= S.llegadas.hasta; o++) {
        const f = sumarDias(p, o);
        dias.set(f, { ...(dias.get(f) || {}), minNoches: diasEntre(f, salida) });
    }
    const resultado = { pascua: p, dias };
    cacheSemanaSanta.set(anio, resultado);
    return resultado;
}

// ---------- Festivos y puentes (por año) ----------
function festivosDelAnio(anio) {
    const p = pascua(anio);
    const lista = new Map(); // fecha -> config del festivo
    for (const f of FESTIVOS) lista.set(`${anio}-${f.fecha}`, f);
    lista.set(sumarDias(p, -3), { nombre: "Jueves Santo" });
    lista.set(sumarDias(p, -2), { nombre: "Viernes Santo" });
    for (const f of FESTIVOS_EXTRA) if (f.startsWith(`${anio}-`)) lista.set(f, lista.get(f) || { nombre: "Festivo" });
    for (const f of FESTIVOS_QUITAR) lista.delete(f);
    return lista;
}

const cachePuentes = new Map();
function puentesDelAnio(anio) {
    if (cachePuentes.has(anio)) return cachePuentes.get(anio);
    const festivos = festivosDelAnio(anio);

    // Días libres: fines de semana, festivos y días puente.
    const libres = new Set(festivos.keys());
    for (const f of festivos.keys()) {
        if (diaSemana(f) === 2) libres.add(sumarDias(f, -1)); // martes -> lunes puente
        if (diaSemana(f) === 4) libres.add(sumarDias(f, 1)); // jueves -> viernes puente
    }
    const esLibre = (f) => libres.has(f) || [0, 6].includes(diaSemana(f));

    const semana = semanaSanta(anio).dias;
    const dias = new Map(); // fecha -> { precio?, minNoches?, motivo }
    const poner = (f, valores, motivo) => {
        // Navidad, Semana Santa y temporadas tienen prioridad sobre los puentes.
        if (enNavidad(f) || semana.has(f) || temporadaDe(f)) return;
        const previo = dias.get(f) || {};
        dias.set(f, {
            ...previo,
            ...valores,
            precio: Math.max(previo.precio ?? 0, valores.precio ?? 0) || undefined,
            motivo: previo.motivo || motivo,
        });
    };

    for (const [festivo, cfg] of festivos) {
        if (!festivo.startsWith(`${anio}-`)) continue;
        // Bloque de días libres seguidos alrededor del festivo.
        let ini = festivo;
        let fin = festivo;
        while (esLibre(sumarDias(ini, -1))) ini = sumarDias(ini, -1);
        while (esLibre(sumarDias(fin, 1))) fin = sumarDias(fin, 1);
        const motivo = `Puente: ${cfg.nombre}`;

        if (diasEntre(ini, fin) + 1 >= 3) {
            // Noches del puente: desde la víspera del primer día libre hasta la víspera del último.
            for (let n = sumarDias(ini, -1); n < fin; n = sumarDias(n, 1)) {
                const vispera = sumarDias(n, 1);
                const cfgVispera = festivos.get(vispera);
                const precio = cfgVispera?.precioVispera ?? precioFinde(n);
                const noches = diasEntre(n, fin);
                poner(n, { precio, ...(noches >= 2 ? { minNoches: noches } : {}) }, motivo);
            }
        } else if (cfg.precioVispera) {
            poner(sumarDias(festivo, -1), { precio: cfg.precioVispera }, `Víspera: ${cfg.nombre}`);
        }
    }

    cachePuentes.set(anio, dias);
    return dias;
}

// ---------- API ----------

/** Precio, estancia mínima y la regla que se ha aplicado. */
function detalleTarifa(fecha) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return null;
    const anio = Number(fecha.slice(0, 4));
    const normal = valorNormal(fecha);

    // 1) Excepción por fecha concreta
    const exc = EXCEPCIONES[fecha];
    if (exc) return { precio: exc.precio ?? normal.precio, minNoches: exc.minNoches ?? normal.minNoches, motivo: "Excepción" };

    // 2) Navidad
    const nav = NAVIDAD[fecha.slice(5)];
    if (nav) return { precio: nav.precio ?? normal.precio, minNoches: nav.minNoches ?? normal.minNoches, motivo: "Navidad" };

    // 3) Semana Santa
    const ss = semanaSanta(anio).dias.get(fecha);
    if (ss) return { precio: ss.precio ?? normal.precio, minNoches: ss.minNoches ?? normal.minNoches, motivo: "Semana Santa" };

    // 4) Temporada
    if (temporadaDe(fecha)) return normal;

    // 5) Puente / víspera de festivo
    const pu = puentesDelAnio(anio).get(fecha);
    if (pu) return { precio: pu.precio ?? normal.precio, minNoches: pu.minNoches ?? normal.minNoches, motivo: pu.motivo };

    // 6) Base
    return normal;
}

/** { precio, minNoches } o null si la fecha no es válida. */
function tarifaDe(fecha) {
    const d = detalleTarifa(fecha);
    return d ? { precio: d.precio, minNoches: d.minNoches } : null;
}

// ==========================================================
// 3) RELLENO AUTOMÁTICO DE BEDS24
//    Beds24 solo deja cargar precios hasta ~1 año vista: cada día que pasa se abre
//    un día nuevo al final del calendario sin precio (Booking y Airbnb lo ven
//    cerrado). Una vez al día se revisan los últimos 60 días del horizonte y los
//    que no tienen precio se rellenan con las reglas.
// ==========================================================

// "Hoy" en España, aunque el servidor esté en UTC.
function hoyEnEspana(ahora = new Date()) {
    return new Intl.DateTimeFormat("en-CA", {
        timeZone: ZONA_HORARIA || "Europe/Madrid",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).format(ahora);
}

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
        else pendientes.push(fecha); // las reglas no dieron precio (no debería pasar)
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
                    `Precios Beds24: ${r.pendientes.length} días sin precio en las reglas, siguen cerrados 🟠`,
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

module.exports = {
    // Motor
    tarifaDe,
    detalleTarifa,
    pascua,
    festivosDelAnio,
    // Beds24
    startBeds24TarifasJob,
    rellenarPreciosHorizonte,
};