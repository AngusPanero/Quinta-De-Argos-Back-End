// services/datosClienteService.js — Quinta de Argos
// Valida y limpia los datos de contacto, facturación y consentimientos
// que llegan del checkout. Nada se guarda tal cual viene del front:
// se normaliza, se valida y la fecha/versión/IP las pone el servidor.

const { ReservaError } = require("./reservasService");
const { esDocumentoValido, normalizarDocumento } = require("./validacionFiscal");
const { VERSION_POLITICA_PRIVACIDAD, VERSION_CONDICIONES_RESERVA } = require("../config/legalConfig");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TELEFONO_RE = /^\+?[\d\s().-]{7,20}$/;
const PAIS_RE = /^[A-Z]{2}$/;

const DOCUMENTOS_POR_TIPO = {
    particular: ["NIF", "NIE", "PASAPORTE", "ID_EXTRANJERO"],
    empresa: ["CIF", "ID_EXTRANJERO"],
};

function texto(valor, max) {
    return typeof valor === "string" ? valor.trim().replace(/\s+/g, " ").slice(0, max) : "";
}

function falla(mensaje, campo) {
    return new ReservaError("DATOS_INVALIDOS", mensaje, 400, { campo });
}

function validarContacto(c = {}) {
    const contacto = {
        nombre: texto(c.nombre, 120),
        email: texto(c.email, 200).toLowerCase(),
        telefono: texto(c.telefono, 40),
    };
    if (contacto.nombre.length < 2) throw falla("Indica tu nombre y apellidos.", "contacto.nombre");
    if (!EMAIL_RE.test(contacto.email)) throw falla("Indica un correo electrónico válido.", "contacto.email");
    if (!TELEFONO_RE.test(contacto.telefono)) throw falla("Indica un teléfono válido.", "contacto.telefono");
    return contacto;
}

function validarFacturacion(f = {}) {
    const tipo = f.tipo === "empresa" ? "empresa" : f.tipo === "particular" ? "particular" : null;
    if (!tipo) throw falla("Indica si la factura es a nombre de un particular o de una empresa.", "facturacion.tipo");

    const tipoDocumento = typeof f.tipoDocumento === "string" ? f.tipoDocumento : "";
    if (!DOCUMENTOS_POR_TIPO[tipo].includes(tipoDocumento)) {
        throw falla("El tipo de documento no es válido.", "facturacion.tipoDocumento");
    }

    const documento = normalizarDocumento(f.documento);
    if (!esDocumentoValido(tipoDocumento, documento)) {
        const mensajes = {
            NIF: "El NIF/DNI no es válido. Revisa los números y la letra.",
            NIE: "El NIE no es válido. Revisa los números y la letra.",
            CIF: "El CIF no es válido. Revisa el número.",
        };
        throw falla(mensajes[tipoDocumento] || "El número de documento no es válido.", "facturacion.documento");
    }

    const nombre = texto(f.nombre, 200);
    if (nombre.length < 2) {
        throw falla(
            tipo === "empresa" ? "Indica la razón social de la empresa." : "Indica el nombre y apellidos para la factura.",
            "facturacion.nombre"
        );
    }

    const d = f.direccion || {};
    const direccion = {
        linea1: texto(d.linea1, 200),
        linea2: texto(d.linea2, 200),
        codigoPostal: texto(d.codigoPostal, 12).toUpperCase(),
        ciudad: texto(d.ciudad, 100),
        provincia: texto(d.provincia, 100),
        pais: texto(d.pais, 2).toUpperCase(),
    };
    if (!PAIS_RE.test(direccion.pais)) throw falla("Indica el país.", "facturacion.direccion.pais");
    if (direccion.linea1.length < 3) throw falla("Indica la dirección de facturación.", "facturacion.direccion.linea1");
    if (direccion.ciudad.length < 2) throw falla("Indica la localidad.", "facturacion.direccion.ciudad");
    if (direccion.pais === "ES" && !/^\d{5}$/.test(direccion.codigoPostal)) {
        throw falla("El código postal debe tener 5 dígitos.", "facturacion.direccion.codigoPostal");
    }
    if (direccion.codigoPostal.length < 3) {
        throw falla("Indica el código postal.", "facturacion.direccion.codigoPostal");
    }
    if (direccion.pais === "ES" && direccion.provincia.length < 2) {
        throw falla("Indica la provincia.", "facturacion.direccion.provincia");
    }

    return { tipo, nombre, tipoDocumento, documento, direccion };
}

/**
 * @param {object} c   consentimientos enviados por el front (booleanos)
 * @param {import('express').Request} req  para registrar IP y navegador
 */
function validarConsentimientos(c = {}, req) {
    if (c.politicaPrivacidad !== true) {
        throw falla("Debes aceptar la política de privacidad para continuar.", "consentimientos.politicaPrivacidad");
    }
    if (c.condicionesReserva !== true) {
        throw falla("Debes aceptar las condiciones de reserva para continuar.", "consentimientos.condicionesReserva");
    }

    const prueba = {
        fecha: new Date(),
        ip: req.ip || "",
        userAgent: String(req.get("user-agent") || "").slice(0, 400),
    };

    return {
        politicaPrivacidad: { aceptado: true, version: VERSION_POLITICA_PRIVACIDAD, ...prueba },
        condicionesReserva: { aceptado: true, version: VERSION_CONDICIONES_RESERVA, ...prueba },
        comunicacionesComerciales: { aceptado: c.comunicacionesComerciales === true, version: null, ...prueba },
    };
}

function validarDatosCliente(body, req) {
    return {
        contacto: validarContacto(body?.contacto),
        facturacion: validarFacturacion(body?.facturacion),
        consentimientos: validarConsentimientos(body?.consentimientos, req),
    };
}

module.exports = { validarDatosCliente };