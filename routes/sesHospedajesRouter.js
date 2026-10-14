// Registro de viajeros (Real Decreto 933/2021) → SES.Hospedajes (Ministerio del Interior).
// Todo vive acá: validación, XML, ZIP, SOAP, envío, consulta y anulación.
// Todas las rutas están protegidas con adminMiddleware.
//
// Variables de entorno:
//   SES_ENTORNO                  pruebas | produccion   (por defecto: pruebas)
//   SES_USUARIO                  usuario del servicio web (lo da el Ministerio al dar de alta el WS)
//   SES_PASSWORD                 contraseña del servicio web
//   SES_CODIGO_ARRENDADOR        código de arrendador (10 caracteres)
//   SES_CODIGO_ESTABLECIMIENTO   código del establecimiento (10 caracteres)
//   SES_APLICACION               nombre de la aplicación (opcional, por defecto "QuintaDeArgos")
//   SES_CA_PEM                   certificado extra en PEM (opcional; solo si falla el TLS con el Ministerio)
//
// Cómo funciona el servicio del Ministerio:
// - SOAP 1.1 con autenticación HTTP Basic.
// - La "solicitud" es un XML comprimido en ZIP y codificado en Base64.
// - Es asíncrono: el envío devuelve un "lote"; el resultado real se consulta después.
// - codigo 0 solo significa "petición bien formada". Aceptado = codigoEstado 1 del lote.
// - El codigoComunicacion de cada parte es el acuse de recibo: se guarda siempre.

const express = require("express");
const https = require("https");
const http = require("http");
const crypto = require("crypto");
const tls = require("tls");
const zlib = require("zlib");
const adminMiddleware = require("../middleware/adminMiddleware");
const ParteViajeros = require("../models/ParteViajeros");
const Beds24Booking = require("../models/Beds24Booking");

const esProduccion = (process.env.NODE_ENV === "production");
const sesHospedajesRouter = express.Router();

const logError = (label, error) =>
    console.error(esProduccion ? `${label} 🔴` : `${label} 🔴 ${error?.stack || error}`);

// ==========================================================
// CONFIGURACIÓN
// ==========================================================

const SES_URLS = {
    pruebas: "https://hospedajes.pre-ses.mir.es/hospedajes-web/ws/v1/comunicacion",
    produccion: "https://hospedajes.ses.mir.es/hospedajes-web/ws/v1/comunicacion",
};

const NS_SOAP = "http://schemas.xmlsoap.org/soap/envelope/";
const NS_COM = "http://www.soap.servicios.hospedajes.mir.es/comunicacion";
const NS_ALTA_PV = "http://www.neg.hospedajes.mir.es/altaParteHospedaje";
const NS_ANULAR = "http://www.neg.hospedajes.mir.es/anularComunicacion";

const REQUIRED_ENV = ["SES_USUARIO", "SES_PASSWORD", "SES_CODIGO_ARRENDADOR", "SES_CODIGO_ESTABLECIMIENTO"];

function sesConfig() {
    const entorno = process.env.SES_ENTORNO === "produccion" ? "produccion" : "pruebas";
    return {
        entorno,
        url: SES_URLS[entorno],
        usuario: process.env.SES_USUARIO,
        password: process.env.SES_PASSWORD,
        arrendador: process.env.SES_CODIGO_ARRENDADOR,
        establecimiento: process.env.SES_CODIGO_ESTABLECIMIENTO,
        aplicacion: (process.env.SES_APLICACION || "QuintaDeArgos").slice(0, 50),
        faltan: REQUIRED_ENV.filter((key) => !process.env[key]),
    };
}

// ---------- Certificados ----------
// El servidor del Ministerio no envía su certificado intermedio (error UNABLE_TO_VERIFY_LEAF_SIGNATURE).
// Se descarga una sola vez de la dirección que indica su propio certificado (AIA "CA Issuers"),
// como hacen los navegadores, y se añade a los de confianza. La cadena se sigue verificando
// contra las autoridades raíz de Node: no se desactiva ninguna comprobación.
// Opcional: SES_CA_PEM con el intermedio en PEM, por si la descarga automática fallara.
const TLS_CHAIN_ERRORS = new Set([
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
    "UNABLE_TO_GET_ISSUER_CERT",
]);
const extraCAs = new Set();
let httpsAgent = null;

function getAgent() {
    if (httpsAgent) return httpsAgent;
    const list = [...extraCAs];
    if (process.env.SES_CA_PEM) list.push(process.env.SES_CA_PEM.replace(/\\n/g, "\n"));
    httpsAgent = new https.Agent({
        keepAlive: false,
        ca: list.length ? [...tls.rootCertificates, ...list] : undefined,
    });
    return httpsAgent;
}

function downloadBuffer(url, redirects = 2) {
    return new Promise((resolve, reject) => {
        const client = url.startsWith("https:") ? https : http;
        const req = client.get(url, { timeout: 15000 }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
                res.resume();
                return resolve(downloadBuffer(new URL(res.headers.location, url).toString(), redirects - 1));
            }
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error(`descarga del certificado intermedio: estado ${res.statusCode}`));
            }
            const chunks = [];
            let size = 0;
            res.on("data", (chunk) => {
                size += chunk.length;
                if (size > 200 * 1024) req.destroy(new Error("certificado intermedio demasiado grande"));
                else chunks.push(chunk);
            });
            res.on("end", () => resolve(Buffer.concat(chunks)));
        });
        req.on("timeout", () => req.destroy(new Error("descarga del certificado intermedio: tiempo agotado")));
        req.on("error", reject);
    });
}

function peerCertificate(host, port) {
    return new Promise((resolve, reject) => {
        // Solo se lee el certificado para saber de dónde bajar el intermedio; no se envía nada
        const socket = tls.connect({ host, port, servername: host, rejectUnauthorized: false, timeout: 15000 }, () => {
            const cert = socket.getPeerCertificate(true);
            socket.end();
            resolve(cert);
        });
        socket.on("timeout", () => socket.destroy(new Error("tiempo agotado leyendo el certificado")));
        socket.on("error", reject);
    });
}

let learning = null;
function learnIntermediate(url) {
    if (learning) return learning;
    learning = (async () => {
        const { hostname, port } = new URL(url);
        const cert = await peerCertificate(hostname, Number(port) || 443);
        const uris = (cert?.infoAccess?.["CA Issuers - URI"] || []).filter((u) => /^https?:\/\//.test(u));
        if (!uris.length) throw new Error("el certificado del Ministerio no indica dónde descargar su intermedio");

        let lastError = null;
        for (const uri of uris) {
            try {
                const buf = await downloadBuffer(uri);
                const text = buf.toString("latin1");
                const pem = text.includes("-----BEGIN CERTIFICATE-----")
                    ? text
                    : new crypto.X509Certificate(buf).toString();
                extraCAs.add(pem);
                httpsAgent = null;
                console.log(`SES: certificado intermedio del Ministerio añadido (${new crypto.X509Certificate(pem).subject.split("\n").find((l) => l.startsWith("CN=")) || uri}) 🟢`);
                return true;
            } catch (err) {
                lastError = err;
            }
        }
        throw lastError || new Error("no se pudo descargar el certificado intermedio");
    })().finally(() => { learning = null; });
    return learning;
}

// ==========================================================
// CATÁLOGOS (manual de comunicaciones del Ministerio)
// ==========================================================

const TIPOS_DOCUMENTO = ["NIF", "NIE", "PAS", "OTRO"];
const SEXOS = ["H", "M", "O"];
const PARENTESCOS = ["AB", "BA", "BN", "CD", "CY", "HJ", "HR", "NI", "PM", "SB", "SG", "TI", "YN", "TU", "OT"];
const TIPOS_PAGO = ["EFECT", "TARJT", "PLATF", "TRANS", "MOVIL", "TREG", "DESTI", "OTRO"];

// ==========================================================
// UTILIDADES
// ==========================================================

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

function isValidDate(value) {
    if (typeof value !== "string" || !ISO_DATE.test(value)) return false;
    const d = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function todayMadrid() {
    return new Intl.DateTimeFormat("en-CA", {
        timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date());
}

function addDays(date, days) {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
}

// Edad cumplida en una fecha dada
function ageOn(birth, onDate) {
    const [by, bm, bd] = birth.split("-").map(Number);
    const [y, m, d] = onDate.split("-").map(Number);
    let age = y - by;
    if (m < bm || (m === bm && d < bd)) age -= 1;
    return age;
}

const clean = (value) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "");
const upperCode = (value) => clean(value).toUpperCase();
const docNumber = (value) => clean(value).toUpperCase().replace(/[^A-Z0-9]/g, "");

const NIF_LETTERS = "TRWAGMYFPDXBNJZSQVHLCKE";
function isValidNif(value) {
    if (!/^\d{8}[A-Z]$/.test(value)) return false;
    return NIF_LETTERS[Number(value.slice(0, 8)) % 23] === value[8];
}
function isValidNie(value) {
    if (!/^[XYZ]\d{7}[A-Z]$/.test(value)) return false;
    const num = "XYZ".indexOf(value[0]) + value.slice(1, 8);
    return NIF_LETTERS[Number(num) % 23] === value[8];
}

function escXml(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

function unescXml(value) {
    return String(value)
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, "\"")
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, "&");
}

// ==========================================================
// VALIDACIÓN DEL PARTE
// Devuelve { value, errors } con errores por campo ("personas.0.nombre": "…")
// ==========================================================

function validarParte(body, { paraEnviar }) {
    const errors = {};
    const req = (path, ok, msg) => { if (!ok && !errors[path]) errors[path] = msg; };
    const max = (path, value, n) => req(path, !value || value.length <= n, `Máximo ${n} caracteres`);

    const c = body?.contrato || {};
    const pago = c.pago || {};

    const contrato = {
        referencia: clean(c.referencia),
        fechaContrato: clean(c.fechaContrato),
        fechaEntrada: clean(c.fechaEntrada),
        fechaSalida: clean(c.fechaSalida),
        numHabitaciones: c.numHabitaciones === "" || c.numHabitaciones === null || c.numHabitaciones === undefined
            ? undefined : Number(c.numHabitaciones),
        internet: typeof c.internet === "boolean" ? c.internet : undefined,
        pago: {
            tipoPago: upperCode(pago.tipoPago),
            fechaPago: clean(pago.fechaPago),
            medioPago: clean(pago.medioPago),
            titular: clean(pago.titular),
        },
    };

    // ---------- Contrato ----------
    max("contrato.referencia", contrato.referencia, 50);
    max("contrato.pago.medioPago", contrato.pago.medioPago, 50);
    max("contrato.pago.titular", contrato.pago.titular, 100);
    if (contrato.fechaContrato) req("contrato.fechaContrato", isValidDate(contrato.fechaContrato), "Fecha no válida");
    if (contrato.fechaEntrada) req("contrato.fechaEntrada", ISO_DATETIME.test(contrato.fechaEntrada), "Fecha y hora no válidas");
    if (contrato.fechaSalida) req("contrato.fechaSalida", ISO_DATETIME.test(contrato.fechaSalida), "Fecha y hora no válidas");
    if (contrato.pago.fechaPago) req("contrato.pago.fechaPago", isValidDate(contrato.pago.fechaPago), "Fecha no válida");
    if (contrato.pago.tipoPago) req("contrato.pago.tipoPago", TIPOS_PAGO.includes(contrato.pago.tipoPago), "Tipo de pago no válido");
    if (contrato.numHabitaciones !== undefined) {
        req("contrato.numHabitaciones", Number.isInteger(contrato.numHabitaciones) && contrato.numHabitaciones > 0, "Número no válido");
    }

    if (paraEnviar) {
        req("contrato.referencia", !!contrato.referencia, "Obligatorio");
        req("contrato.fechaContrato", !!contrato.fechaContrato, "Obligatorio");
        req("contrato.fechaEntrada", !!contrato.fechaEntrada, "Obligatorio");
        req("contrato.fechaSalida", !!contrato.fechaSalida, "Obligatorio");
        req("contrato.pago.tipoPago", !!contrato.pago.tipoPago, "Obligatorio");
        if (ISO_DATETIME.test(contrato.fechaEntrada) && ISO_DATETIME.test(contrato.fechaSalida)) {
            req("contrato.fechaSalida", contrato.fechaSalida > contrato.fechaEntrada, "La salida debe ser posterior a la entrada");
        }
    }

    // ---------- Personas ----------
    const rawPersonas = Array.isArray(body?.personas) ? body.personas.slice(0, 30) : [];
    const entradaDia = ISO_DATETIME.test(contrato.fechaEntrada) ? contrato.fechaEntrada.slice(0, 10) : todayMadrid();

    const personas = rawPersonas.map((p = {}, i) => {
        const k = (field) => `personas.${i}.${field}`;
        const d = p.direccion || {};
        const persona = {
            nombre: clean(p.nombre),
            apellido1: clean(p.apellido1),
            apellido2: clean(p.apellido2),
            tipoDocumento: upperCode(p.tipoDocumento),
            numeroDocumento: docNumber(p.numeroDocumento),
            soporteDocumento: docNumber(p.soporteDocumento),
            fechaNacimiento: clean(p.fechaNacimiento),
            nacionalidad: upperCode(p.nacionalidad),
            sexo: upperCode(p.sexo),
            direccion: {
                direccion: clean(d.direccion),
                direccionComplementaria: clean(d.direccionComplementaria),
                codigoMunicipio: clean(d.codigoMunicipio),
                nombreMunicipio: clean(d.nombreMunicipio),
                codigoPostal: clean(d.codigoPostal),
                pais: upperCode(d.pais),
            },
            telefono: clean(p.telefono),
            telefono2: clean(p.telefono2),
            correo: clean(p.correo).toLowerCase(),
            parentesco: upperCode(p.parentesco),
        };

        // Formato (se valida también en borrador)
        max(k("nombre"), persona.nombre, 50);
        max(k("apellido1"), persona.apellido1, 50);
        max(k("apellido2"), persona.apellido2, 50);
        max(k("numeroDocumento"), persona.numeroDocumento, 15);
        max(k("soporteDocumento"), persona.soporteDocumento, 9);
        max(k("telefono"), persona.telefono, 20);
        max(k("telefono2"), persona.telefono2, 20);
        max(k("correo"), persona.correo, 50);
        max(k("direccion.direccion"), persona.direccion.direccion, 100);
        max(k("direccion.direccionComplementaria"), persona.direccion.direccionComplementaria, 100);
        max(k("direccion.nombreMunicipio"), persona.direccion.nombreMunicipio, 100);
        max(k("direccion.codigoPostal"), persona.direccion.codigoPostal, 20);

        if (persona.tipoDocumento) req(k("tipoDocumento"), TIPOS_DOCUMENTO.includes(persona.tipoDocumento), "Tipo no válido");
        if (persona.sexo) req(k("sexo"), SEXOS.includes(persona.sexo), "Valor no válido");
        if (persona.parentesco) req(k("parentesco"), PARENTESCOS.includes(persona.parentesco), "Parentesco no válido");
        if (persona.nacionalidad) req(k("nacionalidad"), /^[A-Z]{3}$/.test(persona.nacionalidad), "País no válido");
        if (persona.direccion.pais) req(k("direccion.pais"), /^[A-Z]{3}$/.test(persona.direccion.pais), "País no válido");
        if (persona.direccion.codigoMunicipio) req(k("direccion.codigoMunicipio"), /^\d{5}$/.test(persona.direccion.codigoMunicipio), "Son 5 cifras del INE");
        if (persona.correo) req(k("correo"), /^[^@\s]+@[^.@\s]+\.[^@\s]+$/.test(persona.correo), "Correo no válido");
        if (persona.fechaNacimiento) {
            req(k("fechaNacimiento"), isValidDate(persona.fechaNacimiento) && persona.fechaNacimiento <= todayMadrid(), "Fecha no válida");
        }
        if (persona.tipoDocumento === "NIF" && persona.numeroDocumento) {
            req(k("numeroDocumento"), isValidNif(persona.numeroDocumento), "DNI no válido (revisa la letra)");
        }
        if (persona.tipoDocumento === "NIE" && persona.numeroDocumento) {
            req(k("numeroDocumento"), isValidNie(persona.numeroDocumento), "NIE no válido (revisa la letra)");
        }

        if (paraEnviar) {
            req(k("nombre"), !!persona.nombre, "Obligatorio");
            req(k("apellido1"), !!persona.apellido1, "Obligatorio");
            req(k("fechaNacimiento"), !!persona.fechaNacimiento, "Obligatorio");

            const adulto = isValidDate(persona.fechaNacimiento) && ageOn(persona.fechaNacimiento, entradaDia) >= 18;
            if (adulto) {
                req(k("tipoDocumento"), !!persona.tipoDocumento, "Obligatorio para mayores de edad");
                req(k("numeroDocumento"), !!persona.numeroDocumento, "Obligatorio para mayores de edad");
            }
            if (persona.numeroDocumento) req(k("tipoDocumento"), !!persona.tipoDocumento, "Indica el tipo de documento");
            if (persona.tipoDocumento === "NIF") req(k("apellido2"), !!persona.apellido2, "Obligatorio con DNI");
            if (persona.tipoDocumento === "NIF" || persona.tipoDocumento === "NIE") {
                req(k("soporteDocumento"), !!persona.soporteDocumento, "Obligatorio con DNI o NIE");
            }

            req(k("direccion.direccion"), !!persona.direccion.direccion, "Obligatorio");
            req(k("direccion.codigoPostal"), !!persona.direccion.codigoPostal, "Obligatorio");
            req(k("direccion.pais"), !!persona.direccion.pais, "Obligatorio");
            if (persona.direccion.pais === "ESP") {
                req(k("direccion.codigoMunicipio"), !!persona.direccion.codigoMunicipio, "Obligatorio en España");
            } else if (persona.direccion.pais) {
                req(k("direccion.nombreMunicipio"), !!persona.direccion.nombreMunicipio, "Obligatorio fuera de España");
            }

            // El esquema lo deja opcional, pero el Ministerio rechaza el lote sin ninguno de los tres
            req(k("telefono"), !!(persona.telefono || persona.telefono2 || persona.correo), "Indica un teléfono o un correo");
        }
        return persona;
    });

    if (paraEnviar) {
        req("personas", personas.length > 0, "Añade al menos un viajero");
        const edades = personas.map((p) => (isValidDate(p.fechaNacimiento) ? ageOn(p.fechaNacimiento, entradaDia) : null));
        const hayMenores = edades.some((e) => e !== null && e < 18);
        if (hayMenores) {
            personas.forEach((p, i) => {
                if (edades[i] !== null && edades[i] < 18) req(`personas.${i}.parentesco`, !!p.parentesco, "Obligatorio en menores");
            });
            const adultoConParentesco = personas.some((p, i) => edades[i] !== null && edades[i] >= 18 && !!p.parentesco);
            req("personas", adultoConParentesco, "Con menores, al menos un adulto debe indicar su parentesco con el menor");
            req("personas", edades.some((e) => e !== null && e >= 18), "Debe haber al menos un adulto");
        }
    }

    return { value: { contrato, personas }, errors };
}

// ==========================================================
// XML, ZIP Y SOAP
// ==========================================================

const tag = (name, value) =>
    (value === undefined || value === null || value === "" ? "" : `<${name}>${escXml(value)}</${name}>`);

function buildAltaPV(parte, codigoEstablecimiento) {
    const c = parte.contrato;
    const personas = parte.personas.map((p) => [
        "<persona>",
        tag("rol", "VI"),
        tag("nombre", p.nombre),
        tag("apellido1", p.apellido1),
        tag("apellido2", p.apellido2),
        tag("tipoDocumento", p.tipoDocumento),
        tag("numeroDocumento", p.numeroDocumento),
        tag("soporteDocumento", p.soporteDocumento),
        tag("fechaNacimiento", p.fechaNacimiento),
        tag("nacionalidad", p.nacionalidad),
        tag("sexo", p.sexo),
        "<direccion>",
        tag("direccion", p.direccion.direccion),
        tag("direccionComplementaria", p.direccion.direccionComplementaria),
        tag("codigoMunicipio", p.direccion.pais === "ESP" ? p.direccion.codigoMunicipio : ""),
        tag("nombreMunicipio", p.direccion.nombreMunicipio),
        tag("codigoPostal", p.direccion.codigoPostal),
        tag("pais", p.direccion.pais),
        "</direccion>",
        tag("telefono", p.telefono),
        tag("telefono2", p.telefono2),
        tag("correo", p.correo),
        tag("parentesco", p.parentesco),
        "</persona>",
    ].join("")).join("");

    return [
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
        `<ns2:peticion xmlns:ns2="${NS_ALTA_PV}">`,
        "<solicitud>",
        tag("codigoEstablecimiento", codigoEstablecimiento),
        "<comunicacion>",
        "<contrato>",
        tag("referencia", c.referencia),
        tag("fechaContrato", c.fechaContrato),
        tag("fechaEntrada", c.fechaEntrada),
        tag("fechaSalida", c.fechaSalida),
        tag("numPersonas", parte.personas.length),
        tag("numHabitaciones", c.numHabitaciones),
        typeof c.internet === "boolean" ? tag("internet", c.internet ? "true" : "false") : "",
        "<pago>",
        tag("tipoPago", c.pago.tipoPago),
        tag("fechaPago", c.pago.fechaPago),
        tag("medioPago", c.pago.medioPago),
        tag("titular", c.pago.titular),
        "</pago>",
        "</contrato>",
        personas,
        "</comunicacion>",
        "</solicitud>",
        "</ns2:peticion>",
    ].join("");
}

function buildAnulacion(codigosComunicacion) {
    return [
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
        `<comunicaciones xmlns="${NS_ANULAR}">`,
        codigosComunicacion.map((code) => tag("codigoComunicacion", code)).join(""),
        "</comunicaciones>",
    ].join("");
}

// ---------- ZIP de un solo archivo (sin dependencias) ----------
const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        table[n] = c >>> 0;
    }
    return table;
})();

function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}

function zipSingleFile(fileName, content) {
    const data = Buffer.from(content, "utf8");
    const compressed = zlib.deflateRawSync(data);
    const name = Buffer.from(fileName, "utf8");
    const crc = crc32(data);

    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);           // nombres en UTF-8
    local.writeUInt16LE(8, 8);                // deflate
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(0, 42);             // offset del encabezado local

    const localSize = local.length + name.length + compressed.length;
    const centralSize = central.length + name.length;

    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(1, 8);
    end.writeUInt16LE(1, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(localSize, 16);
    end.writeUInt16LE(0, 20);

    return Buffer.concat([local, name, compressed, central, name, end]);
}

const encodeSolicitud = (xml) => zipSingleFile("solicitud.xml", xml).toString("base64");

function soapEnvelope(body) {
    return `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="${NS_SOAP}" xmlns:com="${NS_COM}"><soapenv:Header/><soapenv:Body>${body}</soapenv:Body></soapenv:Envelope>`;
}

function comunicacionBody(cfg, tipoOperacion, tipoComunicacion, solicitudBase64) {
    return [
        "<com:comunicacionRequest><peticion><cabecera>",
        tag("codigoArrendador", cfg.arrendador),
        tag("aplicacion", cfg.aplicacion),
        tag("tipoOperacion", tipoOperacion),
        tag("tipoComunicacion", tipoComunicacion),
        "</cabecera>",
        `<solicitud>${solicitudBase64}</solicitud>`,
        "</peticion></com:comunicacionRequest>",
    ].join("");
}

const consultaLoteBody = (lotes) =>
    `<com:consultaLoteRequest><codigosLote>${lotes.map((l) => tag("lote", l)).join("")}</codigosLote></com:consultaLoteRequest>`;

// ---------- Lectura de la respuesta (sin librerías, ignora prefijos de namespace) ----------
function getTag(xml, name) {
    const m = new RegExp(`<(?:[\\w-]+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`).exec(xml);
    return m ? unescXml(m[1].trim()) : null;
}

function getAll(xml, name) {
    const re = new RegExp(`<(?:[\\w-]+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`, "g");
    const out = [];
    let m;
    while ((m = re.exec(xml)) !== null) out.push(m[1]);
    return out;
}

function parseResultados(xml) {
    return getAll(xml, "resultado").map((block) => {
        // El servicio devuelve "resutadoComunicacion" (sin la "l"): se aceptan las dos grafías
        const items = [...getAll(block, "resultadoComunicacion"), ...getAll(block, "resutadoComunicacion")];
        return {
            lote: getTag(block, "lote"),
            codigoEstado: Number(getTag(block, "codigoEstado")),
            descEstado: getTag(block, "descEstado"),
            comunicaciones: items.map((item) => ({
                orden: Number(getTag(item, "orden")),
                codigoComunicacion: getTag(item, "codigoComunicacion"),
                tipoError: getTag(item, "tipoError"),
                error: getTag(item, "error"),
            })),
        };
    });
}

class SesError extends Error {
    constructor(message, status) {
        super(message);
        this.status = status;
    }
}

// Hace la petición; si falla la cadena TLS, aprende el intermedio y reintenta una vez
async function sesRequest(cfg, body) {
    try {
        return await sesRequestOnce(cfg, body);
    } catch (error) {
        if (!TLS_CHAIN_ERRORS.has(error.tlsCode)) throw error;
        try {
            await learnIntermediate(cfg.url);
        } catch (learnError) {
            logError("SES: no se pudo obtener el certificado intermedio", learnError);
            throw new SesError(`No se pudo verificar el certificado del Ministerio (${error.tlsCode}). Añade su certificado intermedio en SES_CA_PEM.`, 502);
        }
        return sesRequestOnce(cfg, body);
    }
}

function sesRequestOnce(cfg, body) {
    const payload = soapEnvelope(body);
    const auth = Buffer.from(`${cfg.usuario}:${cfg.password}`).toString("base64");

    return new Promise((resolve, reject) => {
        const req = https.request(cfg.url, {
            method: "POST",
            agent: getAgent(),
            timeout: 30000,
            headers: {
                "Content-Type": "text/xml; charset=utf-8",
                "Content-Length": Buffer.byteLength(payload),
                SOAPAction: "\"\"",
                Authorization: `Basic ${auth}`,
            },
        }, (res) => {
            const chunks = [];
            res.on("data", (chunk) => chunks.push(chunk));
            res.on("end", () => {
                const text = Buffer.concat(chunks).toString("utf8");
                if (res.statusCode === 401 || res.statusCode === 403) {
                    return reject(new SesError("El Ministerio rechazó el usuario o la contraseña del servicio web", 502));
                }
                const fault = getTag(text, "faultstring");
                if (fault) return reject(new SesError(`El Ministerio devolvió un error: ${fault}`, 502));
                if (res.statusCode >= 400) {
                    // Extracto legible de la respuesta (HTML o texto) para saber qué devolvió
                    const extracto = text.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ")
                        .replace(/\s+/g, " ").trim().slice(0, 200);
                    if (!esProduccion) console.warn(`SES: respuesta ${res.statusCode} de ${cfg.url}: ${text.slice(0, 1500)}`);
                    return reject(new SesError(
                        `El Ministerio respondió con el estado ${res.statusCode}${res.statusCode >= 500 ? " (su servidor no está disponible en este momento)" : ""}${extracto ? `: ${extracto}` : ""}`,
                        502
                    ));
                }
                resolve(text);
            });
        });
        req.on("timeout", () => req.destroy(new SesError("El Ministerio no respondió a tiempo", 504)));
        req.on("error", (err) => {
            if (err instanceof SesError) return reject(err);
            const wrapped = new SesError(`No se pudo conectar con el Ministerio (${err.code || err.message})`, 502);
            wrapped.tlsCode = err.code;
            reject(wrapped);
        });
        req.end(payload);
    });
}

// Envía una comunicación (alta o anulación) y devuelve { codigo, descripcion, lote, resultados }
async function enviarComunicacion(cfg, tipoOperacion, tipoComunicacion, xml) {
    const text = await sesRequest(cfg, comunicacionBody(cfg, tipoOperacion, tipoComunicacion, encodeSolicitud(xml)));
    const respuesta = getAll(text, "respuesta")[0] || text;
    return {
        codigo: Number(getTag(respuesta, "codigo")),
        descripcion: getTag(respuesta, "descripcion") || "",
        lote: getTag(respuesta, "lote"),
        resultados: parseResultados(text),
    };
}

async function consultarLotes(cfg, lotes) {
    const text = await sesRequest(cfg, consultaLoteBody(lotes));
    const respuesta = getAll(text, "respuesta")[0] || "";
    return {
        codigo: Number(getTag(respuesta, "codigo")),
        descripcion: getTag(respuesta, "descripcion") || "",
        resultados: parseResultados(text),
    };
}

// Aplica el resultado de un lote al parte y lo guarda
function aplicarResultado(parte, resultado) {
    const envio = parte.envios.find((e) => e.lote === resultado.lote);
    if (!envio) return false;

    envio.codigoEstado = resultado.codigoEstado;
    envio.descEstado = resultado.descEstado;
    envio.consultadoEn = new Date();
    envio.errores = resultado.comunicaciones
        .filter((c) => c.tipoError || c.error)
        .map((c) => ({ orden: c.orden, tipoError: c.tipoError, error: c.error }));

    // 4 en proceso · 5 pendiente: se vuelve a consultar más tarde
    if (resultado.codigoEstado === 4 || resultado.codigoEstado === 5) return true;

    const esUltimo = parte.envios[parte.envios.length - 1] === envio;
    if (!esUltimo) return true;

    const ok = resultado.codigoEstado === 1 && envio.errores.length === 0;
    const mensajeError = envio.errores.map((e) => [e.tipoError, e.error].filter(Boolean).join(": ")).join(" · ")
        || resultado.descEstado || "El Ministerio rechazó la comunicación";

    if (envio.tipo === "alta") {
        if (ok) {
            const codigo = resultado.comunicaciones.find((c) => c.codigoComunicacion)?.codigoComunicacion;
            parte.estado = "comunicado";
            parte.codigoComunicacion = codigo || parte.codigoComunicacion;
            parte.comunicadoEn = new Date();
            parte.ultimoError = null;
            parte.errores = [];
        } else {
            parte.estado = "error";
            parte.ultimoError = mensajeError;
            parte.errores = envio.errores;
        }
    } else if (ok) {
        parte.estado = "anulado";
        parte.anuladoEn = new Date();
        parte.ultimoError = null;
    } else {
        // La anulación falló: el parte sigue comunicado
        parte.estado = "comunicado";
        parte.ultimoError = `No se pudo anular: ${mensajeError}`;
    }
    return true;
}

// Consulta los lotes pendientes (máx. 10 por llamada al Ministerio)
let ultimoRefresco = 0;
async function refrescarPendientes({ forzar = false, ids = null } = {}) {
    const cfg = sesConfig();
    if (cfg.faltan.length) return;
    if (!forzar && Date.now() - ultimoRefresco < 15000) return;
    ultimoRefresco = Date.now();

    // Un envío que se cortó a mitad (reinicio del servidor) no puede quedar bloqueado para siempre
    const atascado = { estado: "enviando", updatedAt: { $lt: new Date(Date.now() - 10 * 60 * 1000) } };
    await ParteViajeros.updateMany(
        { ...atascado, codigoComunicacion: { $nin: [null, ""] } },
        { $set: { estado: "comunicado", ultimoError: "La anulación se interrumpió. Vuelve a intentarlo." } }
    );
    await ParteViajeros.updateMany(
        atascado,
        { $set: {
            estado: "error",
            ultimoError: "El envío se interrumpió. Antes de reenviar, comprueba en SES.Hospedajes que no conste ya.",
        } }
    );

    const filtro = { estado: { $in: ["enviado", "anulacion_enviada"] } };
    if (ids) filtro._id = { $in: ids };
    const pendientes = await ParteViajeros.find(filtro).limit(10);
    if (!pendientes.length) return;

    const lotes = pendientes.map((p) => p.envios[p.envios.length - 1]?.lote).filter(Boolean);
    if (!lotes.length) return;

    const { resultados } = await consultarLotes(cfg, lotes);
    for (const parte of pendientes) {
        const lote = parte.envios[parte.envios.length - 1]?.lote;
        const resultado = resultados.find((r) => r.lote === lote);
        if (resultado && aplicarResultado(parte, resultado)) {
            parte.markModified("envios");
            await parte.save();
        }
    }
}

const summary = (p) => ({
    _id: p._id,
    estado: p.estado,
    codigoComunicacion: p.codigoComunicacion || null,
    ultimoError: p.ultimoError || null,
});

const quien = (req) => req.user?.email || req.user?.uid || null;

// ==========================================================
// RUTAS
// ==========================================================

// Estado de la configuración (nunca devuelve credenciales)
sesHospedajesRouter.get("/api/admin/ses/estado", adminMiddleware, (req, res) => {
    const cfg = sesConfig();
    res.json({
        configurado: cfg.faltan.length === 0,
        faltan: cfg.faltan,
        entorno: cfg.entorno,
        establecimiento: cfg.establecimiento || null,
    });
});

// Probar conexión y credenciales sin comunicar nada: consulta un lote inexistente
sesHospedajesRouter.post("/api/admin/ses/probar", adminMiddleware, async (req, res) => {
    const cfg = sesConfig();
    if (cfg.faltan.length) {
        return res.status(503).json({ message: `Falta configurar el servicio web: ${cfg.faltan.join(", ")}` });
    }
    try {
        const text = await sesRequest(cfg, consultaLoteBody([crypto.randomUUID()]));
        const respuesta = getAll(text, "respuesta")[0] || "";
        const codigo = getTag(respuesta, "codigo");
        const descripcion = getTag(respuesta, "descripcion");
        res.json({
            ok: true,
            entorno: cfg.entorno,
            message: `Conexión correcta con el entorno de ${cfg.entorno}: el Ministerio aceptó las credenciales`
                + (codigo !== null ? ` (respuesta ${codigo}${descripcion ? `: ${descripcion}` : ""}).` : "."),
        });
    } catch (error) {
        // Un error SOAP significa que se llegó al servicio y la autenticación pasó
        if (error instanceof SesError && error.message.startsWith("El Ministerio devolvió un error")) {
            return res.json({
                ok: true,
                entorno: cfg.entorno,
                message: `Conexión y credenciales correctas (${cfg.entorno}). El servicio respondió: ${error.message.replace("El Ministerio devolvió un error: ", "")}`,
            });
        }
        logError("SES: prueba de conexión fallida", error);
        res.status(error.status || 502).json({
            ok: false,
            entorno: cfg.entorno,
            message: error instanceof SesError ? error.message : "No se ha podido probar la conexión",
        });
    }
});

// Reservas que necesitan parte: llegadas de los últimos 30 días y los próximos 60
sesHospedajesRouter.get("/api/admin/ses/reservas", adminMiddleware, async (req, res) => {
    try {
        const today = todayMadrid();
        const bookings = await Beds24Booking.find({
            deletedInBeds24: false,
            status: { $in: ["confirmed", "new", "request"] },
            source: { $ne: "owner" },
            arrival: { $gte: addDays(today, -30), $lte: addDays(today, 60) },
        })
            .sort({ arrival: 1 })
            .select("beds24Id status source arrival departure nights numAdult numChild firstName lastName email phone mobile country2 apiReference bookingTime price")
            .lean();

        const partes = await ParteViajeros.find({ beds24Id: { $in: bookings.map((b) => b.beds24Id) } })
            .sort({ createdAt: 1 })
            .select("beds24Id estado codigoComunicacion ultimoError")
            .lean();

        // Por reserva, el parte más reciente que no esté anulado (o el último anulado)
        const porReserva = new Map();
        for (const p of partes) {
            const actual = porReserva.get(p.beds24Id);
            if (!actual || actual.estado === "anulado" || p.estado !== "anulado") porReserva.set(p.beds24Id, p);
        }

        res.json({
            today,
            reservas: bookings.map((b) => ({ ...b, parte: porReserva.has(b.beds24Id) ? summary(porReserva.get(b.beds24Id)) : null })),
        });
    } catch (error) {
        logError("SES: error listando reservas", error);
        res.status(500).json({ message: "No se han podido cargar las reservas" });
    }
});

// Historial de partes (actualiza antes los lotes pendientes)
sesHospedajesRouter.get("/api/admin/ses/partes", adminMiddleware, async (req, res) => {
    try {
        try {
            await refrescarPendientes();
        } catch (error) {
            logError("SES: no se pudieron consultar los lotes pendientes", error);
        }
        const partes = await ParteViajeros.find({})
            .sort({ "contrato.fechaEntrada": -1, createdAt: -1 })
            .limit(200)
            .select("-__v")
            .lean();
        res.json({ partes });
    } catch (error) {
        logError("SES: error listando partes", error);
        res.status(500).json({ message: "No se han podido cargar los partes" });
    }
});

sesHospedajesRouter.get("/api/admin/ses/partes/:id", adminMiddleware, async (req, res) => {
    try {
        const parte = await ParteViajeros.findById(req.params.id).select("-__v").lean();
        if (!parte) return res.status(404).json({ message: "Parte no encontrado" });
        res.json({ parte });
    } catch (error) {
        res.status(400).json({ message: "Identificador no válido" });
    }
});

// Crear borrador
sesHospedajesRouter.post("/api/admin/ses/partes", adminMiddleware, async (req, res) => {
    try {
        const { value, errors } = validarParte(req.body, { paraEnviar: false });
        if (Object.keys(errors).length) return res.status(422).json({ message: "Revisa los campos marcados", errors });

        const beds24Id = Number(req.body?.beds24Id) || null;
        if (beds24Id) {
            const activo = await ParteViajeros.findOne({ beds24Id, estado: { $ne: "anulado" } }).select("_id").lean();
            if (activo) return res.status(409).json({ message: "Esta reserva ya tiene un parte. Ábrelo desde el historial.", id: activo._id });
        }

        const parte = await ParteViajeros.create({
            ...value,
            beds24Id,
            origen: clean(req.body?.origen) || null,
            nombreReserva: clean(req.body?.nombreReserva).slice(0, 120) || null,
            creadoPor: quien(req),
        });
        res.status(201).json({ parte });
    } catch (error) {
        logError("SES: error creando parte", error);
        res.status(500).json({ message: "No se ha podido guardar el parte" });
    }
});

// Editar (solo borradores o rechazados)
sesHospedajesRouter.put("/api/admin/ses/partes/:id", adminMiddleware, async (req, res) => {
    try {
        const { value, errors } = validarParte(req.body, { paraEnviar: false });
        if (Object.keys(errors).length) return res.status(422).json({ message: "Revisa los campos marcados", errors });

        const parte = await ParteViajeros.findOneAndUpdate(
            { _id: req.params.id, estado: { $in: ["borrador", "error"] } },
            { $set: { contrato: value.contrato, personas: value.personas } },
            { new: true }
        ).select("-__v");
        if (!parte) return res.status(409).json({ message: "Este parte ya se ha enviado y no se puede editar" });
        res.json({ parte });
    } catch (error) {
        logError("SES: error editando parte", error);
        res.status(500).json({ message: "No se ha podido guardar el parte" });
    }
});

// Borrar (solo si nunca llegó a aceptarse)
sesHospedajesRouter.delete("/api/admin/ses/partes/:id", adminMiddleware, async (req, res) => {
    try {
        const result = await ParteViajeros.deleteOne({ _id: req.params.id, estado: { $in: ["borrador", "error"] } });
        if (!result.deletedCount) return res.status(409).json({ message: "Solo se pueden borrar borradores o partes rechazados" });
        res.json({ ok: true });
    } catch (error) {
        logError("SES: error borrando parte", error);
        res.status(500).json({ message: "No se ha podido borrar el parte" });
    }
});

// Enviar al Ministerio
sesHospedajesRouter.post("/api/admin/ses/partes/:id/enviar", adminMiddleware, async (req, res) => {
    const cfg = sesConfig();
    if (cfg.faltan.length) {
        return res.status(503).json({ message: `Falta configurar el servicio web: ${cfg.faltan.join(", ")}` });
    }

    let parte;
    try {
        parte = await ParteViajeros.findById(req.params.id);
    } catch {
        return res.status(400).json({ message: "Identificador no válido" });
    }
    if (!parte) return res.status(404).json({ message: "Parte no encontrado" });

    const { value, errors } = validarParte(parte.toObject(), { paraEnviar: true });
    if (Object.keys(errors).length) {
        return res.status(422).json({ message: "Faltan datos obligatorios para enviar el parte", errors });
    }

    // Bloqueo: evita dos envíos simultáneos del mismo parte
    const estadoPrevio = parte.estado;
    const bloqueado = await ParteViajeros.findOneAndUpdate(
        { _id: parte._id, estado: { $in: ["borrador", "error"] } },
        { $set: { estado: "enviando" } },
        { new: true }
    );
    if (!bloqueado) return res.status(409).json({ message: "Este parte ya se ha enviado" });

    try {
        const xml = buildAltaPV(value, cfg.establecimiento);
        const r = await enviarComunicacion(cfg, "A", "PV", xml);

        bloqueado.envios.push({
            tipo: "alta",
            entorno: cfg.entorno,
            lote: r.lote,
            fecha: new Date(),
            codigoRespuesta: r.codigo,
            descripcion: r.descripcion,
        });

        if (r.codigo !== 0 || !r.lote) {
            bloqueado.estado = "error";
            bloqueado.ultimoError = r.descripcion || `El Ministerio devolvió el código ${r.codigo}`;
        } else {
            bloqueado.estado = "enviado";
            bloqueado.enviadoEn = new Date();
            bloqueado.ultimoError = null;
            bloqueado.errores = [];
            const inmediato = r.resultados.find((x) => x.lote === r.lote);
            if (inmediato) aplicarResultado(bloqueado, inmediato);
        }
        bloqueado.markModified("envios");
        await bloqueado.save();
        res.json({ parte: bloqueado });
    } catch (error) {
        logError("SES: error enviando parte", error);
        await ParteViajeros.updateOne({ _id: parte._id, estado: "enviando" }, { $set: { estado: estadoPrevio } });
        res.status(error.status || 502).json({ message: error instanceof SesError ? error.message : "No se ha podido enviar el parte" });
    }
});

// Consultar ahora el resultado del último envío
sesHospedajesRouter.post("/api/admin/ses/partes/:id/consultar", adminMiddleware, async (req, res) => {
    try {
        await refrescarPendientes({ forzar: true, ids: [req.params.id] });
        const parte = await ParteViajeros.findById(req.params.id).select("-__v").lean();
        if (!parte) return res.status(404).json({ message: "Parte no encontrado" });
        res.json({ parte });
    } catch (error) {
        logError("SES: error consultando lote", error);
        res.status(error.status || 502).json({ message: error instanceof SesError ? error.message : "No se ha podido consultar el estado" });
    }
});

// Anular un parte ya comunicado
sesHospedajesRouter.post("/api/admin/ses/partes/:id/anular", adminMiddleware, async (req, res) => {
    const cfg = sesConfig();
    if (cfg.faltan.length) {
        return res.status(503).json({ message: `Falta configurar el servicio web: ${cfg.faltan.join(", ")}` });
    }

    let parte;
    try {
        parte = await ParteViajeros.findOneAndUpdate(
            { _id: req.params.id, estado: "comunicado", codigoComunicacion: { $ne: null } },
            { $set: { estado: "enviando" } },
            { new: true }
        );
    } catch {
        return res.status(400).json({ message: "Identificador no válido" });
    }
    if (!parte) return res.status(409).json({ message: "Solo se pueden anular partes comunicados" });

    try {
        const r = await enviarComunicacion(cfg, "B", null, buildAnulacion([parte.codigoComunicacion]));
        parte.envios.push({
            tipo: "anulacion",
            entorno: cfg.entorno,
            lote: r.lote,
            fecha: new Date(),
            codigoRespuesta: r.codigo,
            descripcion: r.descripcion,
        });
        if (r.codigo !== 0 || !r.lote) {
            parte.estado = "comunicado";
            parte.ultimoError = `No se pudo anular: ${r.descripcion || `código ${r.codigo}`}`;
        } else {
            parte.estado = "anulacion_enviada";
            const inmediato = r.resultados.find((x) => x.lote === r.lote);
            if (inmediato) aplicarResultado(parte, inmediato);
        }
        parte.markModified("envios");
        await parte.save();
        res.json({ parte });
    } catch (error) {
        logError("SES: error anulando parte", error);
        await ParteViajeros.updateOne({ _id: parte._id, estado: "enviando" }, { $set: { estado: "comunicado" } });
        res.status(error.status || 502).json({ message: error instanceof SesError ? error.message : "No se ha podido anular el parte" });
    }
});

module.exports = sesHospedajesRouter;
// Para pruebas locales sin red
module.exports._internals = { validarParte, buildAltaPV, buildAnulacion, zipSingleFile, parseResultados, aplicarResultado };