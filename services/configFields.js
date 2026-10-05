// Definición de cada campo editable desde el panel.
// Es la única fuente de verdad: el servidor valida con esto y el panel
// dibuja el formulario con lo mismo (etiquetas, límites y opciones).
//
// IMPORTANTE: los valores de las opciones (stayThrough, firstNight, autoConfirmed…)
// tienen que coincidir con los del esquema de Beds24 en el Swagger.

// ---------- Reglas de la casa (habitación 736171) ----------
const REGLAS_FIELDS = [
    { key: "minStay", label: "Estancia mínima por defecto", type: "int", min: 1, max: 30, unit: "noches",
        help: "Se usa en las fechas que no tienen una estancia mínima propia." },
    { key: "maxStay", label: "Estancia máxima por defecto", type: "int", min: 1, max: 365, unit: "noches",
        help: "Tiene que coincidir con la estancia máxima configurada para Booking (hoy 30)." },
    { key: "restrictionStrategy", label: "Cómo se aplica la estancia mínima", type: "select",
        options: [
            { value: "stayThrough", label: "En cada noche de la estadía" },
            { value: "firstNight", label: "Solo según el día de llegada" },
        ] },
    { key: "blockAfterCheckOutDays", label: "Días de preparación tras cada salida", type: "int", min: 0, max: 7, unit: "días",
        help: "Días que quedan cerrados después de cada salida para limpieza." },
    { key: "maxPeople", label: "Capacidad máxima", type: "int", min: 1, max: 12, unit: "personas" },
    { key: "minPrice", label: "Precio mínimo de seguridad", type: "number", min: 0, max: 1000, unit: "€",
        help: "Ningún precio por noche puede quedar por debajo de este valor. 0 lo desactiva." },
    { key: "cleaningFee", label: "Tasa de limpieza", type: "number", min: 0, max: 1000, unit: "€",
        help: "Revisá cómo la aplica cada canal antes de usarla." },
    { key: "securityDeposit", label: "Depósito de seguridad", type: "number", min: 0, max: 5000, unit: "€" },
    { key: "taxPercentage", label: "Impuesto", type: "number", min: 0, max: 30, unit: "%" },
];

// ---------- Datos y políticas de la propiedad (357162) ----------
const PROPIEDAD_FIELDS = [
    { key: "checkInStart", label: "Entrada desde", type: "time", group: "horarios" },
    { key: "checkInEnd", label: "Entrada hasta", type: "time", group: "horarios" },
    { key: "checkOutEnd", label: "Salida hasta", type: "time", group: "horarios" },

    { key: "phone", label: "Teléfono", type: "phone", maxLength: 30, group: "contacto" },
    { key: "email", label: "Email", type: "email", maxLength: 120, group: "contacto" },
    { key: "permit", label: "Licencia turística", type: "text", maxLength: 80, group: "contacto" },

    { key: "bookingType", label: "Confirmación de reservas", type: "select", group: "reservas",
        options: [
            { value: "autoConfirmed", label: "Automática" },
            { value: "request", label: "Pendiente de aprobación" },
        ] },
    { key: "bookingCutOffHour", label: "Hora límite para reservar en el día", type: "int", min: 0, max: 24, unit: "h", group: "reservas",
        help: "24 permite reservar hasta la medianoche." },
    { key: "allowGuestCancellation", label: "El huésped puede cancelar", type: "select", group: "reservas",
        options: [
            { value: "never", label: "Nunca" },
            { value: "always", label: "Siempre" },
        ] },

    { key: "propertyDescription", label: "Descripción de la casa", type: "textarea", maxLength: 5000, group: "textos" },
    { key: "houseRules", label: "Normas de la casa", type: "textarea", maxLength: 5000, group: "textos" },
    { key: "cancellationPolicy", label: "Política de cancelación", type: "textarea", maxLength: 5000, group: "textos" },
    { key: "generalPolicy", label: "Política general", type: "textarea", maxLength: 5000, group: "textos" },
];

// ---------- Calendario ----------
const OVERRIDE_OPTIONS = [
    { value: "none", label: "Abrir fechas" },
    { value: "blackout", label: "Cerrar fechas" },
    { value: "noCheckIn", label: "Sin entrada" },
    { value: "noCheckOut", label: "Sin salida" },
    { value: "noCheckInOrCheckOut", label: "Sin entrada ni salida" },
];

const CALENDAR_LIMITS = {
    maxDays: 400,
    price: { min: 20, max: 3000 },
    percent: { min: -50, max: 100 },
    minStay: { min: 1, max: 30 },
    maxStay: { min: 1, max: 365 },
};

module.exports = { REGLAS_FIELDS, PROPIEDAD_FIELDS, OVERRIDE_OPTIONS, CALENDAR_LIMITS };