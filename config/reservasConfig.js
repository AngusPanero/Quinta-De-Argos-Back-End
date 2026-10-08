// config/reservasConfig.js — Quinta de Argos
// Reglas de reserva que el backend aplica SIEMPRE, diga lo que diga el front.
// Si cambias algo aquí, el front lo recibe en GET /api/reservas/disponibilidad.

// Antelación mínima: la llegada tiene que ser, como pronto, dentro de 3 días
// naturales (72 h) contando desde hoy en hora de España.
const MIN_DIAS_ANTELACION = 3;
const MIN_HORAS_ANTELACION = MIN_DIAS_ANTELACION * 24;

// Hasta cuántos días hacia el futuro se puede reservar desde hoy.
const HORIZONTE_DIAS = 365;

// Máximo de noches por reserva.
const MAX_NOCHES = 14;

// Capacidad máxima de la casa.
const MAX_HUESPEDES = 6;

// Zona horaria de la finca: "hoy" siempre es hoy en España,
// aunque el servidor (Render) corra en UTC.
const ZONA_HORARIA = "Europe/Madrid";

const MONEDA = "eur";

// Adicionales que se pueden contratar. ESTOS son los precios que se cobran.
// Los ids tienen que coincidir con los de BookingConfig.ts del front
// (allí solo se usan para mostrar nombre y descripción).
// Precio en euros, una vez por estancia.
const ADICIONALES = [
    { id: "cena-privada", nombre: "Cena privada en el porche", precio: 180 },
    { id: "decoracion-especial", nombre: "Decoración especial", precio: 60 },
    { id: "traslado", nombre: "Traslado desde Caravaca de la Cruz", precio: 40 },
    { id: "desayuno-gourmet", nombre: "Desayuno gourmet en el porche", precio: 25 },
];

module.exports = {
    MIN_DIAS_ANTELACION,
    MIN_HORAS_ANTELACION,
    HORIZONTE_DIAS,
    MAX_NOCHES,
    MAX_HUESPEDES,
    ZONA_HORARIA,
    MONEDA,
    ADICIONALES,
};