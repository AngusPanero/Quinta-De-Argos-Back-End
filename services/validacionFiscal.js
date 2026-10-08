// services/validacionFiscal.js — Quinta de Argos
// Validación de documentos fiscales españoles (con dígito de control).
// El front tiene una copia (checkout/datosFacturacion.ts) solo para avisar
// al usuario mientras escribe; la que manda es esta.

const LETRAS_DNI = "TRWAGMYFPDXBNJZSQVHLCKE";

function normalizarDocumento(valor) {
    return typeof valor === "string" ? valor.toUpperCase().replace(/[\s.-]/g, "") : "";
}

// DNI / NIF de persona física: 8 dígitos + letra.
function esDniValido(valor) {
    const v = normalizarDocumento(valor);
    if (!/^\d{8}[A-Z]$/.test(v)) return false;
    return LETRAS_DNI[Number(v.slice(0, 8)) % 23] === v[8];
}

// NIE: X/Y/Z + 7 dígitos + letra.
function esNieValido(valor) {
    const v = normalizarDocumento(valor);
    if (!/^[XYZ]\d{7}[A-Z]$/.test(v)) return false;
    const numero = "XYZ".indexOf(v[0]) + v.slice(1, 8);
    return LETRAS_DNI[Number(numero) % 23] === v[8];
}

// CIF / NIF de persona jurídica: letra + 7 dígitos + control (dígito o letra).
function esCifValido(valor) {
    const v = normalizarDocumento(valor);
    if (!/^[ABCDEFGHJNPQRSUVW]\d{7}[0-9A-J]$/.test(v)) return false;

    const digitos = v.slice(1, 8);
    let suma = 0;
    for (let i = 0; i < 7; i++) {
        let n = Number(digitos[i]);
        if (i % 2 === 0) {
            n *= 2;
            if (n > 9) n -= 9;
        }
        suma += n;
    }
    const control = (10 - (suma % 10)) % 10;
    const letraControl = "JABCDEFGHI"[control];
    const recibido = v[8];

    if ("PQRSNW".includes(v[0])) return recibido === letraControl; // siempre letra
    if ("ABEH".includes(v[0])) return recibido === String(control); // siempre dígito
    return recibido === String(control) || recibido === letraControl;
}

// Documento extranjero (pasaporte, ID nacional, NIF-IVA de otro país).
// No hay forma de comprobar el dígito de control de todos los países:
// validamos solo el formato básico.
function esDocumentoExtranjeroValido(valor) {
    return /^[A-Z0-9]{5,20}$/.test(normalizarDocumento(valor));
}

const VALIDADORES = {
    NIF: esDniValido,
    NIE: esNieValido,
    CIF: esCifValido,
    PASAPORTE: esDocumentoExtranjeroValido,
    ID_EXTRANJERO: esDocumentoExtranjeroValido,
};

function esDocumentoValido(tipoDocumento, valor) {
    const validar = VALIDADORES[tipoDocumento];
    return Boolean(validar && validar(valor));
}

module.exports = {
    normalizarDocumento,
    esDniValido,
    esNieValido,
    esCifValido,
    esDocumentoValido,
    TIPOS_DOCUMENTO: Object.keys(VALIDADORES),
};