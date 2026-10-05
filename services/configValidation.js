// Validación y comparación de valores. Todo lo que llega del panel pasa por acá.
const TIME_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_REGEX = /^[+\d\s()-]{6,30}$/;

function parseNumber(raw) {
    if (typeof raw === "number") return raw;
    if (typeof raw !== "string" || raw.trim() === "") return NaN;
    return Number(raw.trim().replace(",", "."));
}

// Devuelve { value } o { error }
function validateField(field, raw) {
    switch (field.type) {
        case "int": {
            const n = parseNumber(raw);
            if (!Number.isInteger(n)) return { error: "Tiene que ser un número entero." };
            if (n < field.min || n > field.max) return { error: `Tiene que estar entre ${field.min} y ${field.max}.` };
            return { value: n };
        }
        case "number": {
            const n = parseNumber(raw);
            if (!Number.isFinite(n)) return { error: "Tiene que ser un número." };
            if (n < field.min || n > field.max) return { error: `Tiene que estar entre ${field.min} y ${field.max}.` };
            return { value: Math.round(n * 100) / 100 };
        }
        case "select": {
            if (!field.options.some((o) => o.value === raw)) return { error: "Opción no válida." };
            return { value: raw };
        }
        case "time": {
            if (typeof raw !== "string" || !TIME_REGEX.test(raw)) return { error: "Usá el formato HH:MM." };
            return { value: raw };
        }
        case "email": {
            const v = typeof raw === "string" ? raw.trim() : "";
            if (v === "") return { value: "" };
            if (v.length > field.maxLength || !EMAIL_REGEX.test(v)) return { error: "Email no válido." };
            return { value: v };
        }
        case "phone": {
            const v = typeof raw === "string" ? raw.trim() : "";
            if (v === "") return { value: "" };
            if (!PHONE_REGEX.test(v)) return { error: "Usá solo números, espacios, +, guiones o paréntesis." };
            return { value: v };
        }
        case "text":
        case "textarea": {
            if (typeof raw !== "string") return { error: "Texto no válido." };
            const v = raw.replace(/\r\n/g, "\n").trim();
            if (v.length > field.maxLength) return { error: `Máximo ${field.maxLength} caracteres.` };
            return { value: v };
        }
        default:
            return { error: "Campo desconocido." };
    }
}

// Valida solo los campos que vinieron y los compara con los actuales.
// Devuelve { errors, changes: [{ key, label, before, after }] }
function diffFields(fields, current, incoming) {
    const errors = {};
    const changes = [];
    if (!incoming || typeof incoming !== "object") return { errors: { _: "Datos no válidos." }, changes };

    for (const field of fields) {
        if (!Object.prototype.hasOwnProperty.call(incoming, field.key)) continue;
        const { value, error } = validateField(field, incoming[field.key]);
        if (error) {
            errors[field.key] = error;
            continue;
        }
        const before = current[field.key] ?? null;
        if (String(before ?? "") !== String(value ?? "")) {
            changes.push({ key: field.key, label: field.label, before, after: value });
        }
    }
    return { errors, changes };
}

module.exports = { validateField, diffFields, parseNumber };