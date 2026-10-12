const express = require("express");
const { BrevoClient } = require("@getbrevo/brevo");
const mongoose = require("mongoose");
const multer = require("multer");
const ConsultaContacto = require("../models/ConsultaContacto");
const Reserva = require("../models/Reserva");
const adminMiddleware = require("../middleware/adminMiddleware");
const requireFreshAdmin = require("../middleware/requireFreshAdmin");
const { requireSignature, audit } = require("../middleware/requireSignature");

const esProduccion = process.env.NODE_ENV === "production";



// ==========================================================
// 1) ENVÍO CON BREVO
// ==========================================================

const brevo = new BrevoClient({ apiKey: process.env.BREVO_API_KEY });

/**
 * @param {object}  opciones
 * @param {string}  opciones.to           destinatario
 * @param {string}  opciones.subject      asunto
 * @param {string}  opciones.html         cuerpo en HTML
 * @param {string} [opciones.text]        versión en texto plano (mejora la entrega)
 * @param {{ email: string, name?: string }} [opciones.replyTo]  a quién se responde
 * @param {{ filename: string, content: Buffer }[]} [opciones.attachments]
 */

async function sendMail({ to, subject, html, text, replyTo, attachments = [] }) {
    if (!process.env.BREVO_API_KEY || !process.env.EMAIL_FROM) {
        throw new Error("Faltan BREVO_API_KEY o EMAIL_FROM");
    }

    const payload = {
        sender: { email: process.env.EMAIL_FROM, name: process.env.EMAIL_FROM_NAME || "Quinta de Argos" },
        to: [{ email: to }],
        subject,
        htmlContent: html,
    };

    if (text) payload.textContent = text;
    if (replyTo?.email) payload.replyTo = { email: replyTo.email, ...(replyTo.name ? { name: replyTo.name } : {}) };

    if (attachments.length > 0) {
        payload.attachment = attachments.map((a) => ({
            name: a.filename,
            content: a.content.toString("base64"),
        }));
    }

    try {
        const respuesta = await brevo.transactionalEmails.sendTransacEmail(payload);
        const messageId = respuesta?.messageId ?? respuesta?.body?.messageId;
        console.log(`✉️ Brevo OK → ${to} | ${subject} | ${messageId ?? "sin messageId"}`);
        return { messageId };
    } catch (err) {
        const detalle = err?.body ?? err?.response?.body ?? err?.message;
        console.error(`❌ Brevo error → ${to} | ${subject} |`, JSON.stringify(detalle));
        throw err;
    }
}

// ==========================================================
// 2) PLANTILLA DE LOS CORREOS (logo: public/Isologo_Icon.png de la web)
// ==========================================================

const WEB_URL = (process.env.FRONT_END || "https://quintadeargos.com").replace(/\/+$/, "");

// ---------- Datos de la empresa (cámbialos aquí si cambian) ----------
const EMPRESA = {
    nombre: "Quinta de Argos",
    lema: "Finca con piscina en Cehegín",
    localidad: "Cehegín, Región de Murcia · España",
    email: "quintadeargos@gmail.com",
    whatsappTexto: "+34 633 49 18 25",
    whatsappUrl: "https://wa.me/34633491825",
    web: WEB_URL,
    webTexto: WEB_URL.replace(/^https?:\/\//, ""),
    logoUrl: `${WEB_URL}/Isologo_Icon.png`,
};

// ---------- Paleta de la marca ----------
const C = {
    pino: "#2a3626",
    crema: "#f2ede1",
    papel: "#f8f4ea",
    tinta: "#2c2a24",
    arcilla: "#b8763e",
    arena: "#d3a06c",
    linea: "#e2dccd",
    suave: "#6d6a60",
};

const SERIF = "'Playfair Display', Georgia, 'Times New Roman', serif";
const SANS = "'Jost', 'Helvetica Neue', Helvetica, Arial, sans-serif";

/** Escapa todo lo que escribe el usuario antes de meterlo en el HTML. */
function escapeHtml(valor) {
    return String(valor ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

// ---------- Piezas reutilizables ----------

/** Etiqueta pequeña en mayúsculas (como los "eyebrow" de la web). */
const etiqueta = (texto, color = C.arcilla) =>
    `<p style="margin:0 0 10px; font-family:${SANS}; font-size:11px; font-weight:500; letter-spacing:3px; text-transform:uppercase; color:${color};">${texto}</p>`;

const titulo = (texto) =>
    `<h1 class="qa-titulo" style="margin:0 0 16px; font-family:${SERIF}; font-size:30px; font-weight:600; line-height:1.2; color:${C.pino};">${texto}</h1>`;

const parrafo = (texto) =>
    `<p style="margin:0 0 16px; font-family:${SANS}; font-size:15px; font-weight:300; line-height:1.7; color:${C.tinta};">${texto}</p>`;

const divisor = `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 28px;">
        <tr><td style="border-top:1px solid ${C.linea}; font-size:0; line-height:0;">&nbsp;</td></tr>
    </table>`;

/**
 * Tabla de datos: [{ label, value, html?: true }]
 * Los valores se escapan salvo que vengan marcados como html (ya seguros).
 */
function tablaDatos(filas, tituloBloque) {
    const visibles = filas.filter((f) => f.value !== undefined && f.value !== null && f.value !== "");
    return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
        style="margin:0 0 24px; background-color:${C.papel}; border:1px solid ${C.linea}; border-left:3px solid ${C.arcilla};">
        <tr><td style="padding:20px 22px 12px;">
            ${tituloBloque ? etiqueta(tituloBloque) : ""}
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                ${visibles
                    .map(
                        (f, i) => `
                <tr>
                    <td valign="top" width="34%" style="padding:9px 12px 9px 0; ${i < visibles.length - 1 ? `border-bottom:1px solid ${C.linea};` : ""} font-family:${SANS}; font-size:12px; letter-spacing:1px; text-transform:uppercase; color:${C.suave};">${escapeHtml(f.label)}</td>
                    <td valign="top" style="padding:9px 0; ${i < visibles.length - 1 ? `border-bottom:1px solid ${C.linea};` : ""} font-family:${SANS}; font-size:15px; font-weight:500; color:${C.tinta}; word-break:break-word;">${f.html ? f.value : escapeHtml(f.value)}</td>
                </tr>`
                    )
                    .join("")}
            </table>
        </td></tr>
    </table>`;
}

/** Bloque con texto libre del usuario (respeta los saltos de línea). */
function bloqueTexto(texto, tituloBloque) {
    return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
        style="margin:0 0 28px; background-color:#ffffff; border:1px solid ${C.linea};">
        <tr><td style="padding:20px 22px;">
            ${tituloBloque ? etiqueta(tituloBloque) : ""}
            <p style="margin:0; font-family:${SANS}; font-size:15px; font-weight:300; line-height:1.8; color:${C.tinta}; white-space:pre-line;">${escapeHtml(texto)}</p>
        </td></tr>
    </table>`;
}

/** Botón (enlace) compatible con clientes de correo. */
function boton(href, texto, { secundario = false } = {}) {
    const fondo = secundario ? "transparent" : C.pino;
    const color = secundario ? C.pino : C.crema;
    return `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="display:inline-table; margin:0 10px 12px 0;">
        <tr><td style="border-radius:999px; background-color:${fondo}; border:1px solid ${C.pino};">
            <a href="${escapeHtml(href)}" target="_blank"
               style="display:inline-block; padding:13px 26px; font-family:${SANS}; font-size:14px; font-weight:500; color:${color}; text-decoration:none; border-radius:999px;">${texto}</a>
        </td></tr>
    </table>`;
}

// ---------- Plantilla completa ----------

/**
 * @param {object} p
 * @param {string} p.tituloDocumento  <title> del correo
 * @param {string} p.preheader        texto que se ve en la bandeja junto al asunto
 * @param {string} p.etiquetaCabecera texto a la derecha del logo (ej. "Nueva consulta")
 * @param {string} p.contenido        HTML del cuerpo
 * @param {string} p.notaPie          texto pequeño bajo el pie
 */
function layout({ tituloDocumento, preheader, etiquetaCabecera, contenido, notaPie }) {
    return `<!DOCTYPE html>
<html lang="es" xmlns="http://www.w3.org/1999/xhtml">
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta http-equiv="X-UA-Compatible" content="IE=edge" />
    <meta name="color-scheme" content="light only" />
    <meta name="supported-color-schemes" content="light" />
    <title>${escapeHtml(tituloDocumento)}</title>
    <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@500;600&family=Jost:wght@300;400;500&display=swap" rel="stylesheet" />
    <style>
        body { margin:0; padding:0; background-color:${C.crema}; }
        a { color:${C.arcilla}; }
        @media only screen and (max-width:620px) {
            .qa-pad { padding-left:22px !important; padding-right:22px !important; }
            .qa-col { display:block !important; width:100% !important; text-align:left !important; padding:0 0 14px !important; }
            .qa-titulo { font-size:26px !important; }
            .qa-ocultar-movil { display:none !important; }
        }
    </style>
</head>
<body style="margin:0; padding:0; background-color:${C.crema};">
    <!-- Preheader: se ve en la bandeja de entrada, oculto en el correo -->
    <div style="display:none; max-height:0; overflow:hidden; opacity:0; color:transparent;">${escapeHtml(preheader || "")}</div>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${C.crema}; padding:36px 12px;">
    <tr><td align="center">

        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"
            style="max-width:600px; width:100%; background-color:#ffffff; border:1px solid ${C.linea};">

            <!-- Cabecera -->
            <tr><td class="qa-pad" style="background-color:${C.pino}; padding:26px 40px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
                    <td valign="middle" style="width:64px;">
                        <a href="${EMPRESA.web}" target="_blank" style="text-decoration:none;">
                            <img src="${EMPRESA.logoUrl}" width="52" height="52" alt="Quinta de Argos"
                                 style="display:block; width:52px; height:52px; border:0; outline:none; text-decoration:none;" />
                        </a>
                    </td>
                    <td valign="middle" style="padding-left:14px;">
                        <p style="margin:0; font-family:${SERIF}; font-size:22px; font-weight:600; color:${C.crema}; line-height:1.1;">${EMPRESA.nombre}</p>
                        <p style="margin:4px 0 0; font-family:${SANS}; font-size:10px; letter-spacing:3px; text-transform:uppercase; color:${C.arena};">${EMPRESA.lema}</p>
                    </td>
                    <td class="qa-ocultar-movil" valign="middle" align="right" style="font-family:${SANS}; font-size:10px; font-weight:500; letter-spacing:2px; text-transform:uppercase; color:${C.arena}; line-height:1.5;">
                        ${etiquetaCabecera || ""}
                    </td>
                </tr></table>
            </td></tr>

            <!-- Línea arcilla -->
            <tr><td style="background-color:${C.arcilla}; height:3px; font-size:0; line-height:0;">&nbsp;</td></tr>

            <!-- Cuerpo -->
            <tr><td class="qa-pad" style="padding:40px 40px 12px;">
                ${contenido}
            </td></tr>

            <!-- Pie con los datos de la finca -->
            <tr><td class="qa-pad" style="background-color:${C.papel}; border-top:1px solid ${C.linea}; padding:26px 40px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
                    <td class="qa-col" valign="top" width="50%" style="padding-right:16px;">
                        <p style="margin:0 0 4px; font-family:${SERIF}; font-size:17px; font-weight:600; color:${C.pino};">${EMPRESA.nombre}</p>
                        <p style="margin:0; font-family:${SANS}; font-size:13px; font-weight:300; line-height:1.6; color:${C.suave};">${EMPRESA.localidad}</p>
                    </td>
                    <td class="qa-col" valign="top" width="50%" align="right" style="font-family:${SANS}; font-size:13px; line-height:1.8; color:${C.suave};">
                        <a href="mailto:${EMPRESA.email}" style="color:${C.arcilla}; text-decoration:none;">${EMPRESA.email}</a><br />
                        <a href="${EMPRESA.whatsappUrl}" target="_blank" style="color:${C.arcilla}; text-decoration:none;">WhatsApp ${EMPRESA.whatsappTexto}</a><br />
                        <a href="${EMPRESA.web}" target="_blank" style="color:${C.arcilla}; text-decoration:none;">${EMPRESA.webTexto}</a>
                    </td>
                </tr></table>
            </td></tr>

            <tr><td class="qa-pad" style="background-color:${C.pino}; padding:12px 40px;">
                <p style="margin:0; font-family:${SANS}; font-size:10px; letter-spacing:2px; text-transform:uppercase; color:${C.arena};">
                    © ${new Date().getFullYear()} ${EMPRESA.nombre}
                </p>
            </td></tr>
        </table>

        ${
            notaPie
                ? `<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px; width:100%;">
            <tr><td style="padding:18px 20px 0;">
                <p style="margin:0; font-family:${SANS}; font-size:11px; line-height:1.7; color:${C.suave}; text-align:center;">${notaPie}</p>
            </td></tr>
        </table>`
                : ""
        }

    </td></tr>
    </table>
</body>
</html>`;
}

// ==========================================================
// 3) CORREOS DEL FORMULARIO DE CONTACTO
// ==========================================================

// "2026-11-14" -> "viernes, 14 de noviembre de 2026"
function fechaLarga(iso) {
    if (!iso) return "";
    const d = new Date(`${iso}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString("es-ES", {
        timeZone: "UTC",
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
    });
}

function noches(checkin, checkout) {
    if (!checkin || !checkout) return null;
    const n = Math.round((Date.parse(`${checkout}T00:00:00Z`) - Date.parse(`${checkin}T00:00:00Z`)) / 86_400_000);
    return n > 0 ? n : null;
}

function resumenEstancia({ checkin, checkout, huespedes }) {
    const n = noches(checkin, checkout);
    return {
        llegada: checkin ? fechaLarga(checkin) : "Sin indicar",
        salida: checkout ? fechaLarga(checkout) : "Sin indicar",
        noches: n ? `${n} ${n === 1 ? "noche" : "noches"}` : "",
        huespedes: huespedes ? `${huespedes} ${Number(huespedes) === 1 ? "persona" : "personas"}` : "Sin indicar",
    };
}

function fechaRecepcion(fecha = new Date()) {
    return new Intl.DateTimeFormat("es-ES", {
        timeZone: "Europe/Madrid",
        day: "numeric",
        month: "long",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    }).format(fecha);
}

// Teléfono para enlaces: solo dígitos (y el + inicial).
function telefonoEnlace(tel) {
    return String(tel || "").replace(/[^\d+]/g, "");
}

// ==========================================================
// 3a) Aviso a la finca
// ==========================================================
function emailConsultaPropietario(c) {
    const e = resumenEstancia(c);
    const telWa = telefonoEnlace(c.telefono).replace(/^\+/, "");
    const asuntoFechas = c.checkin ? ` · ${c.checkin}${c.checkout ? ` → ${c.checkout}` : ""}` : "";

    const contenido = `
        ${etiqueta("Nueva consulta desde la web")}
        ${titulo(`${escapeHtml(c.nombre)} quiere información`)}
        ${parrafo(`Recibida el ${escapeHtml(fechaRecepcion(c.recibidaEn))}. Puedes responder directamente a este correo: la respuesta le llega a <strong>${escapeHtml(c.email)}</strong>.`)}

        ${divisor}

        ${tablaDatos(
            [
                { label: "Nombre", value: c.nombre },
                {
                    label: "Email",
                    value: `<a href="mailto:${escapeHtml(c.email)}" style="color:#b8763e; text-decoration:none;">${escapeHtml(c.email)}</a>`,
                    html: true,
                },
                {
                    label: "Teléfono",
                    value: `<a href="tel:${escapeHtml(telefonoEnlace(c.telefono))}" style="color:#2c2a24; text-decoration:none;">${escapeHtml(c.telefono)}</a>`,
                    html: true,
                },
            ],
            "Datos de contacto"
        )}

        ${tablaDatos(
            [
                { label: "Llegada", value: e.llegada },
                { label: "Salida", value: e.salida },
                { label: "Duración", value: e.noches },
                { label: "Huéspedes", value: e.huespedes },
            ],
            "Estancia que busca"
        )}

        ${c.mensaje ? bloqueTexto(c.mensaje, "Mensaje") : parrafo("<em>No ha escrito ningún mensaje.</em>")}

        <div style="margin:0 0 20px;">
            ${boton(`mailto:${c.email}?subject=${encodeURIComponent("Tu consulta en Quinta de Argos")}`, "Responder por email")}
            ${telWa ? boton(`https://wa.me/${telWa}`, "Escribir por WhatsApp", { secundario: true }) : ""}
        </div>
    `;

    const text = [
        `Nueva consulta desde la web — ${c.nombre}`,
        "",
        `Email: ${c.email}`,
        `Teléfono: ${c.telefono}`,
        `Llegada: ${e.llegada}`,
        `Salida: ${e.salida}`,
        e.noches ? `Duración: ${e.noches}` : null,
        `Huéspedes: ${e.huespedes}`,
        "",
        "Mensaje:",
        c.mensaje || "(sin mensaje)",
    ]
        .filter((l) => l !== null)
        .join("\n");

    return {
        subject: `Nueva consulta — ${c.nombre}${asuntoFechas}`,
        html: layout({
            tituloDocumento: `Nueva consulta — ${c.nombre}`,
            preheader: `${c.nombre} · ${e.llegada !== "Sin indicar" ? e.llegada : "sin fechas"} · ${e.huespedes}`,
            etiquetaCabecera: "Nueva<br />consulta",
            contenido,
            notaPie: "Aviso automático del formulario de contacto de quintadeargos.com.",
        }),
        text,
    };
}

// ==========================================================
// 3b) Acuse de recibo a quien escribió
// ==========================================================
function emailAcuseHuesped(c) {
    const e = resumenEstancia(c);
    const nombrePila = String(c.nombre).trim().split(/\s+/)[0] || c.nombre;

    const contenido = `
        ${etiqueta("Consulta recibida")}
        ${titulo(`Gracias, ${escapeHtml(nombrePila)}`)}
        ${parrafo("Hemos recibido tu consulta y te responderemos en menos de 24 horas con la disponibilidad, las tarifas y todo lo que necesites saber antes de reservar.")}

        ${divisor}

        ${tablaDatos(
            [
                { label: "Llegada", value: e.llegada },
                { label: "Salida", value: e.salida },
                { label: "Duración", value: e.noches },
                { label: "Huéspedes", value: e.huespedes },
            ],
            "Lo que nos has pedido"
        )}

        ${c.mensaje ? bloqueTexto(c.mensaje, "Tu mensaje") : ""}

        ${parrafo("Si prefieres, también puedes consultar la disponibilidad y reservar directamente en nuestra web, o escribirnos por WhatsApp.")}

        <div style="margin:0 0 20px;">
            ${boton(`${EMPRESA.web}/reservations`, "Ver disponibilidad")}
            ${boton(EMPRESA.whatsappUrl, "Escribir por WhatsApp", { secundario: true })}
        </div>
    `;

    const text = [
        `Gracias, ${nombrePila}.`,
        "",
        "Hemos recibido tu consulta y te responderemos en menos de 24 horas.",
        "",
        `Llegada: ${e.llegada}`,
        `Salida: ${e.salida}`,
        e.noches ? `Duración: ${e.noches}` : null,
        `Huéspedes: ${e.huespedes}`,
        "",
        `Reserva online: ${EMPRESA.web}/reservations`,
        `WhatsApp: ${EMPRESA.whatsappTexto}`,
        "",
        EMPRESA.nombre,
        EMPRESA.localidad,
    ]
        .filter((l) => l !== null)
        .join("\n");

    return {
        subject: "Hemos recibido tu consulta — Quinta de Argos",
        html: layout({
            tituloDocumento: "Hemos recibido tu consulta — Quinta de Argos",
            preheader: "Te responderemos en menos de 24 horas.",
            etiquetaCabecera: "Consulta<br />recibida",
            contenido,
            notaPie:
                "Recibes este correo porque has enviado una consulta desde quintadeargos.com. Si no has sido tú, puedes ignorarlo.",
        }),
        text,
    };
}

// ==========================================================
// 4) CORREOS DE RESERVAS: MENSAJE AL HUÉSPED Y FACTURA ADJUNTA
//    - El mensaje lo usa adminReservasWebRouter (vía services/emailReservaService.js).
//    - La factura NO se genera aquí: la crea el propietario con su programa o su
//      gestoría, la adjunta en el panel y aquí solo se envía con un correo de
//      presentación (ruta de la sección 6, con clave de firma).
//    Devuelven { enviado: true } o lanzan un error con el motivo
// ==========================================================

const BUZON_FINCA = () => process.env.EMAIL_CONTACTO || EMPRESA.email;

function nombreDePila(nombre) {
    return String(nombre || "").trim().split(/\s+/)[0] || "";
}

function tablaReserva(reserva, tituloBloque = "Tu reserva") {
    const n = reserva.noches;
    return tablaDatos(
        [
            { label: "Código", value: reserva.codigo },
            { label: "Llegada", value: fechaLarga(reserva.checkIn) },
            { label: "Salida", value: fechaLarga(reserva.checkOut) },
            { label: "Duración", value: n ? `${n} ${n === 1 ? "noche" : "noches"}` : "" },
            { label: "Huéspedes", value: reserva.huespedes ? `${reserva.huespedes} ${reserva.huespedes === 1 ? "persona" : "personas"}` : "" },
        ],
        tituloBloque
    );
}

// ---------- 4a) Mensaje libre del propietario al huésped ----------

/**
 * @param {{ destinatario: { email, nombre }, asunto, mensaje, reserva: { codigo, checkIn, checkOut, noches, huespedes } }} datos
 */
async function enviarEmailMensaje(datos) {
    const { destinatario, asunto, mensaje, reserva } = datos;
    const pila = nombreDePila(destinatario.nombre);

    const contenido = `
        ${etiqueta(`Reserva ${escapeHtml(reserva.codigo)}`)}
        ${titulo(pila ? `Hola, ${escapeHtml(pila)}` : "Hola")}
        ${bloqueTexto(mensaje)}
        ${tablaReserva(reserva)}
        ${parrafo("Si tienes cualquier duda, responde a este correo o escríbenos por WhatsApp.")}
        <div style="margin:0 0 20px;">
            ${boton(EMPRESA.whatsappUrl, "Escribir por WhatsApp", { secundario: true })}
        </div>
    `;

    const text = [
        pila ? `Hola, ${pila}:` : "Hola:",
        "",
        mensaje,
        "",
        `Reserva ${reserva.codigo}: ${fechaLarga(reserva.checkIn)} → ${fechaLarga(reserva.checkOut)}`,
        "",
        `${EMPRESA.nombre} · WhatsApp ${EMPRESA.whatsappTexto}`,
    ].join("\n");

    await sendMail({
        to: destinatario.email,
        subject: asunto,
        html: layout({
            tituloDocumento: asunto,
            preheader: mensaje.slice(0, 120),
            etiquetaCabecera: "Mensaje de<br />la finca",
            contenido,
            notaPie: `Recibes este correo por tu reserva ${escapeHtml(reserva.codigo)} en Quinta de Argos.`,
        }),
        text,
        replyTo: { email: BUZON_FINCA(), name: EMPRESA.nombre },
    });

    return { enviado: true };
}

// ---------- 4b) Factura adjunta (el archivo lo sube el propietario) ----------

/**
 * @param {{
 *   destinatario: { email: string, nombre: string },
 *   reserva: { codigo, checkIn, checkOut, noches, huespedes },
 *   archivo: { filename: string, content: Buffer },
 *   numero?: string,   // nº de factura (opcional, solo para mostrarlo)
 *   nota?: string      // texto opcional del propietario
 * }} datos
 */
async function enviarEmailFactura(datos) {
    const { destinatario, reserva, archivo, numero, nota } = datos || {};
    if (!archivo?.content?.length) throw new Error("Falta el archivo de la factura");

    const pila = nombreDePila(destinatario.nombre);
    const asunto = numero ? `Factura ${numero} — Quinta de Argos` : "Tu factura — Quinta de Argos";

    const contenido = `
        ${etiqueta(numero ? `Factura ${escapeHtml(numero)}` : "Factura")}
        ${titulo(pila ? `Tu factura, ${escapeHtml(pila)}` : "Tu factura")}
        ${parrafo("Te enviamos adjunta la factura de tu estancia en Quinta de Argos. Guárdala como justificante.")}
        ${nota ? bloqueTexto(nota) : ""}
        ${tablaDatos(
            [
                { label: "Archivo adjunto", value: archivo.filename },
                { label: "Nº de factura", value: numero || "" },
            ],
            "Documento"
        )}
        ${tablaReserva(reserva, "Estancia")}
        ${parrafo("Si necesitas corregir algún dato de facturación, responde a este correo.")}
    `;

    await sendMail({
        to: destinatario.email,
        subject: asunto,
        html: layout({
            tituloDocumento: asunto,
            preheader: "Te enviamos adjunta la factura de tu estancia.",
            etiquetaCabecera: "Tu<br />factura",
            contenido,
            notaPie: `Factura de tu reserva ${escapeHtml(reserva.codigo)} en Quinta de Argos.`,
        }),
        text: [
            pila ? `Hola, ${pila}:` : "Hola:",
            "",
            "Te enviamos adjunta la factura de tu estancia en Quinta de Argos.",
            nota ? `\n${nota}\n` : "",
            `Reserva ${reserva.codigo}: ${fechaLarga(reserva.checkIn)} → ${fechaLarga(reserva.checkOut)}`,
            "",
            EMPRESA.nombre,
        ].join("\n"),
        replyTo: { email: BUZON_FINCA(), name: EMPRESA.nombre },
        attachments: [archivo],
    });

    return { enviado: true };
}

// ---------- 4c) Confirmación de reserva (al aprobarse el pago) ----------
// La usa notificarReserva("confirmada", ...) de la sección 4d.

const formatoEuros = (valor) =>
    Number(valor || 0).toLocaleString("es-ES", { style: "currency", currency: "EUR", minimumFractionDigits: 2 });

/**
 * @param {object} reserva  documento de models/Reserva (o su toObject())
 * @param {{ prueba?: boolean }} [opciones]  prueba: pago en modo test de Stripe
 * @returns {Promise<{ enviado: true, asunto: string }>}
 */
async function enviarEmailConfirmacionReserva(reserva, { prueba = false } = {}) {
    const r = typeof reserva?.toObject === "function" ? reserva.toObject() : reserva;
    if (!r?.contacto?.email) throw new Error("La reserva no tiene email de contacto");

    const pila = nombreDePila(r.contacto.nombre);
    const asunto = `${prueba ? "[PRUEBA] " : ""}Reserva confirmada ${r.codigo} — Quinta de Argos`;

    // Noches agrupadas por precio: "2 noches × 197,00 €"
    const grupos = new Map();
    for (const noche of r.importes?.desglose ?? []) grupos.set(noche.precio, (grupos.get(noche.precio) ?? 0) + 1);
    const filasImporte = [
        ...[...grupos.entries()].map(([precio, n]) => ({
            label: `${n} ${n === 1 ? "noche" : "noches"} × ${formatoEuros(precio)}`,
            value: formatoEuros(precio * n),
        })),
        ...(r.importes?.adicionales ?? []).map((a) => ({ label: a.nombre, value: formatoEuros(a.precio) })),
        {
            label: "Total pagado",
            value: `<strong>${escapeHtml(formatoEuros(r.importes?.total))}</strong>`,
            html: true,
        },
    ];

    const contenido = `
        ${etiqueta("Reserva confirmada")}
        ${titulo(pila ? `¡Te esperamos, ${escapeHtml(pila)}!` : "¡Te esperamos!")}
        ${parrafo(`Hemos recibido tu pago y tu reserva en Quinta de Argos está confirmada. Guarda este correo: tu código de reserva es <strong>${escapeHtml(r.codigo)}</strong>.`)}
        ${prueba ? parrafo("<em>Este correo corresponde a un pago de prueba: no es una reserva real.</em>") : ""}

        ${divisor}

        ${tablaReserva(
            {
                codigo: r.codigo,
                checkIn: r.estancia?.checkIn,
                checkOut: r.estancia?.checkOut,
                noches: r.estancia?.noches,
                huespedes: r.estancia?.huespedes,
            },
            "Tu estancia"
        )}

        ${tablaDatos(filasImporte, "Importe (IVA incluido)")}

        ${parrafo("Unos días antes de tu llegada te escribiremos con las indicaciones para llegar y la entrada a la finca. Si necesitas cualquier cosa antes, responde a este correo o escríbenos por WhatsApp.")}

        <div style="margin:0 0 20px;">
            ${boton(EMPRESA.whatsappUrl, "Escribir por WhatsApp")}
            ${boton(`${EMPRESA.web}/policy-terms`, "Condiciones de reserva", { secundario: true })}
        </div>
    `;

    const text = [
        pila ? `¡Te esperamos, ${pila}!` : "¡Te esperamos!",
        "",
        `Tu reserva en Quinta de Argos está confirmada. Código: ${r.codigo}`,
        prueba ? "(Pago de prueba: no es una reserva real.)" : null,
        "",
        `Llegada: ${fechaLarga(r.estancia?.checkIn)}`,
        `Salida: ${fechaLarga(r.estancia?.checkOut)}`,
        `Huéspedes: ${r.estancia?.huespedes}`,
        `Total pagado: ${formatoEuros(r.importes?.total)} (IVA incluido)`,
        "",
        `WhatsApp: ${EMPRESA.whatsappTexto}`,
        `Condiciones de reserva: ${EMPRESA.web}/policy-terms`,
        "",
        EMPRESA.nombre,
        EMPRESA.localidad,
    ]
        .filter((l) => l !== null)
        .join("\n");

    await sendMail({
        to: r.contacto.email,
        subject: asunto,
        html: layout({
            tituloDocumento: asunto,
            preheader: `Reserva ${r.codigo} · ${fechaLarga(r.estancia?.checkIn)} → ${fechaLarga(r.estancia?.checkOut)}`,
            etiquetaCabecera: "Reserva<br />confirmada",
            contenido,
            notaPie: `Recibes este correo porque has reservado en quintadeargos.com (reserva ${escapeHtml(r.codigo)}).`,
        }),
        text,
        replyTo: { email: BUZON_FINCA(), name: EMPRESA.nombre },
    });

    return { enviado: true, asunto };
}

// ==========================================================
// 4d) AVISOS DE RESERVA AL HUÉSPED Y A LA FINCA
//     Una sola función para paymentsRouter: notificarReserva(evento, reserva, opciones)
//
//       "pendiente"   el pago tarda en confirmarse (SEPA u otros métodos diferidos)
//       "confirmada"  pago aprobado: confirmación al huésped y aviso a la finca
//                     (si antes estuvo pendiente, la finca recibe "pago aprobado")
//       "fallido"     el pago que estaba pendiente se rechaza o se cancela
//       "reembolso"   reembolso emitido en Stripe. Si la reserva está cancelada,
//                     el primer aviso es el de cancelación con su reembolso;
//                     los siguientes reembolsos se avisan como "reembolso".
//
//     Cada correo sale UNA sola vez aunque Stripe repita el evento: antes de
//     enviar se reclama una marca en reserva.emails de forma atómica. Si el
//     envío falla, la marca se libera y se reintenta en el siguiente aviso.
//     Los correos al huésped quedan en reserva.comunicaciones; los de la finca
//     (EMAIL_CONTACTO, por defecto quintadeargos@gmail.com) solo en los logs.
// ==========================================================

const centimosAEuros = (centimos) => formatoEuros((Number(centimos) || 0) / 100);
const prefijoPrueba = (prueba) => (prueba ? "[PRUEBA] " : "");
const avisoPrueba = (prueba) => (prueba ? parrafo("<em>Corresponde a un pago de prueba: no es una reserva real.</em>") : "");
const fechasCortas = (r) => `${r.estancia?.checkIn} → ${r.estancia?.checkOut}`;
const leerRuta = (obj, ruta) => ruta.split(".").reduce((o, k) => o?.[k], obj);
const estaCancelada = (r) => ["cancelada", "reembolsada"].includes(r.estado);
const botonWhatsApp = () => boton(EMPRESA.whatsappUrl, "Escribir por WhatsApp", { secundario: true });

function estanciaDe(r) {
    return {
        codigo: r.codigo,
        checkIn: r.estancia?.checkIn,
        checkOut: r.estancia?.checkOut,
        noches: r.estancia?.noches,
        huespedes: r.estancia?.huespedes,
    };
}

// Noches agrupadas por precio + adicionales + total.
function filasImporteDe(r) {
    const grupos = new Map();
    for (const noche of r.importes?.desglose ?? []) grupos.set(noche.precio, (grupos.get(noche.precio) ?? 0) + 1);
    return [
        ...[...grupos.entries()].map(([precio, n]) => ({
            label: `${n} ${n === 1 ? "noche" : "noches"} × ${formatoEuros(precio)}`,
            value: formatoEuros(precio * n),
        })),
        ...(r.importes?.adicionales ?? []).map((a) => ({ label: a.nombre, value: formatoEuros(a.precio) })),
        { label: "Total", value: `<strong>${escapeHtml(formatoEuros(r.importes?.total))}</strong>`, html: true },
    ];
}

// ---------- Marcas de "ya enviado" en reserva.emails ----------

const marcaFecha = (ruta) => ({
    filtro: { [ruta]: null },
    cambio: { $set: { [ruta]: new Date() } },
    deshacer: { $set: { [ruta]: null } },
});

const marcaLista = (ruta, valor) => ({
    filtro: { [ruta]: { $ne: valor } },
    cambio: { $addToSet: { [ruta]: valor } },
    deshacer: { $pull: { [ruta]: valor } },
});

function unirMarcas(...marcas) {
    const unir = (clave) => {
        const salida = {};
        for (const m of marcas) {
            for (const [op, valor] of Object.entries(m[clave])) salida[op] = { ...(salida[op] || {}), ...valor };
        }
        return salida;
    };
    return {
        filtro: Object.assign({}, ...marcas.map((m) => m.filtro)),
        cambio: unir("cambio"),
        deshacer: unir("deshacer"),
    };
}

/**
 * Reclama la marca, envía y registra. Devuelve "enviado" | "error" | "ya_enviado".
 * @param {{ reserva, marca, comunicacion?: string, etiquetaLog: string, enviar: (r) => Promise<{ asunto: string }> }} p
 */
async function enviarUnaVez({ reserva, marca, comunicacion, etiquetaLog, enviar }) {
    const r = await Reserva.findOneAndUpdate({ _id: reserva._id, ...marca.filtro }, marca.cambio, { returnDocument: "after" });
    if (!r) return "ya_enviado";

    let estado = "enviado";
    let error = "";
    let asunto = "";
    try {
        asunto = (await enviar(r))?.asunto || "";
        console.log(`📧 ${etiquetaLog}:`, r.codigo);
    } catch (e) {
        estado = "error";
        error = String(e?.message || e).slice(0, 300);
        console.error(`Error enviando ${etiquetaLog} 🔴`, r.codigo, esProduccion ? "" : error);
    }

    // Si falló, se libera la marca para reintentarlo en el próximo aviso de Stripe.
    const cambio = estado === "error" ? { ...marca.deshacer } : {};
    if (comunicacion) {
        cambio.$push = {
            comunicaciones: {
                tipo: comunicacion,
                destinatario: r.contacto.email,
                asunto: (asunto || etiquetaLog).slice(0, 200),
                estado,
                error,
                creadoPor: "sistema",
                fecha: new Date(),
            },
        };
    }
    if (Object.keys(cambio).length) await Reserva.updateOne({ _id: r._id }, cambio);

    return estado;
}

// ---------- Correos al huésped ----------

async function correoAlHuesped(r, { asunto, etiquetaCabecera, preheader, contenido, text }) {
    await sendMail({
        to: r.contacto.email,
        subject: asunto,
        html: layout({
            tituloDocumento: asunto,
            preheader,
            etiquetaCabecera,
            contenido,
            notaPie: `Recibes este correo por tu reserva ${escapeHtml(r.codigo)} en quintadeargos.com.`,
        }),
        text,
        replyTo: { email: BUZON_FINCA(), name: EMPRESA.nombre },
    });
    return { asunto };
}

function correoPagoPendiente(r, { prueba }) {
    const pila = nombreDePila(r.contacto?.nombre);
    return correoAlHuesped(r, {
        asunto: `${prefijoPrueba(prueba)}Pago en proceso: reserva ${r.codigo} — Quinta de Argos`,
        etiquetaCabecera: "Pago en<br />proceso",
        preheader: `Reserva ${r.codigo} · estamos esperando la confirmación de tu banco.`,
        contenido: `
            ${etiqueta("Pago en proceso")}
            ${titulo(pila ? `Gracias, ${escapeHtml(pila)}` : "Gracias")}
            ${parrafo(`Hemos recibido tu solicitud de reserva <strong>${escapeHtml(r.codigo)}</strong>. Tu banco todavía está procesando el pago: según el método elegido, puede tardar desde unos minutos hasta unos días hábiles.`)}
            ${parrafo("En cuanto se confirme el cobro te enviaremos la confirmación de la reserva. No tienes que hacer nada más.")}
            ${avisoPrueba(prueba)}
            ${divisor}
            ${tablaReserva(estanciaDe(r), "Tu solicitud")}
            ${tablaDatos(filasImporteDe(r), "Importe (IVA incluido)")}
            ${parrafo("Si tienes cualquier duda, responde a este correo o escríbenos por WhatsApp.")}
            <div style="margin:0 0 20px;">${botonWhatsApp()}</div>`,
        text: [
            pila ? `Gracias, ${pila}.` : "Gracias.",
            "",
            `Hemos recibido tu solicitud de reserva ${r.codigo}. Tu banco todavía está procesando el pago.`,
            "En cuanto se confirme el cobro te enviaremos la confirmación de la reserva.",
            "",
            `Llegada: ${fechaLarga(r.estancia?.checkIn)}`,
            `Salida: ${fechaLarga(r.estancia?.checkOut)}`,
            `Total: ${formatoEuros(r.importes?.total)} (IVA incluido)`,
            "",
            `${EMPRESA.nombre} · WhatsApp ${EMPRESA.whatsappTexto}`,
        ].join("\n"),
    });
}

function correoPagoFallido(r, { prueba }) {
    const pila = nombreDePila(r.contacto?.nombre);
    return correoAlHuesped(r, {
        asunto: `${prefijoPrueba(prueba)}No se ha completado el pago de tu reserva ${r.codigo} — Quinta de Argos`,
        etiquetaCabecera: "Pago no<br />completado",
        preheader: `Reserva ${r.codigo} · el pago no se ha completado.`,
        contenido: `
            ${etiqueta("Pago no completado")}
            ${titulo(pila ? `Lo sentimos, ${escapeHtml(pila)}` : "Lo sentimos")}
            ${parrafo(`Tu banco no ha completado el pago de la reserva <strong>${escapeHtml(r.codigo)}</strong>, así que la reserva no se ha confirmado y no se te cobrará.`)}
            ${parrafo("Si quieres, puedes volver a intentarlo desde la web con otro método de pago, o escribirnos y te ayudamos.")}
            ${avisoPrueba(prueba)}
            ${divisor}
            ${tablaReserva(estanciaDe(r), "La reserva que intentabas hacer")}
            <div style="margin:0 0 20px;">
                ${boton(`${EMPRESA.web}/reservations`, "Volver a reservar")}
                ${botonWhatsApp()}
            </div>`,
        text: [
            pila ? `Lo sentimos, ${pila}.` : "Lo sentimos.",
            "",
            `Tu banco no ha completado el pago de la reserva ${r.codigo}: la reserva no se ha confirmado y no se te cobrará.`,
            `Puedes volver a intentarlo en ${EMPRESA.web}/reservations o escribirnos por WhatsApp (${EMPRESA.whatsappTexto}).`,
            "",
            EMPRESA.nombre,
        ].join("\n"),
    });
}

/** Cancelación con reembolso (primer aviso de una reserva cancelada) o reembolso suelto. */
function correoReembolso(r, { cancelada, importeCentimos, totalReembolsadoCentimos, prueba }) {
    const pila = nombreDePila(r.contacto?.nombre);
    const importe = centimosAEuros(importeCentimos);
    const pagado = centimosAEuros(r.importes?.totalCentimos);
    const total = centimosAEuros(totalReembolsadoCentimos);
    const porSistema = cancelada && r.cancelacion?.por === "sistema";

    const asunto = cancelada
        ? `${prefijoPrueba(prueba)}Reserva cancelada ${r.codigo} — Quinta de Argos`
        : `${prefijoPrueba(prueba)}Reembolso de ${importe}: reserva ${r.codigo} — Quinta de Argos`;

    return correoAlHuesped(r, {
        asunto,
        etiquetaCabecera: cancelada ? "Reserva<br />cancelada" : "Reembolso<br />emitido",
        preheader: cancelada
            ? `Reserva ${r.codigo} cancelada · reembolso de ${importe}.`
            : `Reembolso de ${importe} de tu reserva ${r.codigo}.`,
        contenido: `
            ${etiqueta(cancelada ? "Reserva cancelada" : "Reembolso emitido")}
            ${titulo(pila ? `Hola, ${escapeHtml(pila)}` : "Hola")}
            ${cancelada ? parrafo(`Tu reserva <strong>${escapeHtml(r.codigo)}</strong> en Quinta de Argos ha quedado cancelada.`) : ""}
            ${porSistema ? parrafo("Lo sentimos: mientras se procesaba tu pago, esas fechas se ocuparon y no hemos podido confirmar tu estancia.") : ""}
            ${parrafo(`Hemos emitido un reembolso de <strong>${escapeHtml(importe)}</strong>${cancelada ? "" : ` de tu reserva <strong>${escapeHtml(r.codigo)}</strong>`} al mismo medio de pago que usaste. Según tu banco, puede tardar entre 5 y 10 días hábiles en aparecer en tu cuenta.`)}
            ${avisoPrueba(prueba)}
            ${divisor}
            ${tablaDatos(
                [
                    { label: "Este reembolso", value: importe },
                    { label: "Total reembolsado", value: `${total} de ${pagado}` },
                ],
                "Reembolso"
            )}
            ${tablaReserva(estanciaDe(r), cancelada ? "Reserva cancelada" : "Tu reserva")}
            ${parrafo("Si tienes cualquier duda, responde a este correo o escríbenos por WhatsApp.")}
            <div style="margin:0 0 20px;">
                ${cancelada ? boton(`${EMPRESA.web}/reservations`, "Volver a reservar") : ""}
                ${botonWhatsApp()}
            </div>`,
        text: [
            pila ? `Hola, ${pila}:` : "Hola:",
            "",
            cancelada ? `Tu reserva ${r.codigo} en Quinta de Argos ha quedado cancelada.` : null,
            `Hemos emitido un reembolso de ${importe} al mismo medio de pago que usaste.`,
            "Según tu banco, puede tardar entre 5 y 10 días hábiles en aparecer en tu cuenta.",
            `Total reembolsado: ${total} de ${pagado}`,
            "",
            `${EMPRESA.nombre} · WhatsApp ${EMPRESA.whatsappTexto}`,
        ]
            .filter((l) => l !== null)
            .join("\n"),
    });
}

// ---------- Avisos a la finca ----------

const AVISOS_FINCA = {
    confirmada: {
        etiqueta: "Nueva reserva",
        cabecera: "Nueva<br />reserva",
        asunto: (r) => `Nueva reserva ${r.codigo} · ${fechasCortas(r)} · ${formatoEuros(r.importes?.total)}`,
        intro: () =>
            "Pago confirmado. La reserva ya está creada en Beds24, así que las fechas quedan bloqueadas también en Booking y Airbnb.",
    },
    aprobada: {
        etiqueta: "Pago aprobado",
        cabecera: "Pago<br />aprobado",
        asunto: (r) => `Pago aprobado: reserva ${r.codigo} confirmada · ${fechasCortas(r)}`,
        intro: () =>
            "El pago que estaba pendiente se ha confirmado. La reserva ya está creada en Beds24 y las fechas quedan bloqueadas.",
    },
    pendiente: {
        etiqueta: "Pago pendiente",
        cabecera: "Pago<br />pendiente",
        asunto: (r) => `Pago pendiente: reserva ${r.codigo} · ${fechasCortas(r)}`,
        intro: () =>
            "El huésped ha pagado con un método que tarda en confirmarse. <strong>Las fechas todavía no están bloqueadas en Beds24</strong>: se bloquearán cuando el banco confirme el cobro, y te avisaremos.",
    },
    fallido: {
        etiqueta: "Pago no completado",
        cabecera: "Pago no<br />completado",
        asunto: (r) => `Pago no completado: reserva ${r.codigo} · ${fechasCortas(r)}`,
        intro: (r, x) =>
            `El pago que estaba pendiente no se ha completado${x.mensaje ? ` (${escapeHtml(x.mensaje)})` : ""}. La reserva no se ha confirmado ni se ha creado en Beds24.`,
    },
    cancelacion: {
        etiqueta: "Reserva cancelada",
        cabecera: "Reserva<br />cancelada",
        asunto: (r, x) => `Reserva cancelada ${r.codigo} · reembolso ${centimosAEuros(x.importeCentimos)}`,
        intro: (r, x) =>
            `La reserva está cancelada y se ha emitido un reembolso de <strong>${escapeHtml(centimosAEuros(x.importeCentimos))}</strong> al huésped.`,
    },
    reembolso: {
        etiqueta: "Reembolso emitido",
        cabecera: "Reembolso<br />emitido",
        asunto: (r, x) => `Reembolso de ${centimosAEuros(x.importeCentimos)}: reserva ${r.codigo}`,
        intro: (r, x) =>
            `Se ha emitido un reembolso de <strong>${escapeHtml(centimosAEuros(x.importeCentimos))}</strong> al huésped.${
                estaCancelada(r) ? "" : " <strong>La reserva sigue activa</strong>: el reembolso no la ha cancelado."
            }`,
    },
};

async function correoFinca(r, tipo, extra = {}) {
    const aviso = AVISOS_FINCA[tipo];
    const asunto = `${prefijoPrueba(extra.prueba)}${aviso.asunto(r, extra)}`;

    const email = r.contacto?.email || "";
    const telefono = r.contacto?.telefono || "";
    const telWa = telefonoEnlace(telefono).replace(/^\+/, "");
    const f = r.facturacion || {};
    const d = f.direccion || {};
    const direccion = [d.linea1, d.linea2, [d.codigoPostal, d.ciudad].filter(Boolean).join(" "), d.provincia, d.pais]
        .filter(Boolean)
        .join(", ");

    const bloqueReembolso =
        extra.importeCentimos != null
            ? tablaDatos(
                  [
                      { label: "Este reembolso", value: centimosAEuros(extra.importeCentimos) },
                      {
                          label: "Total reembolsado",
                          value: `${centimosAEuros(extra.totalReembolsadoCentimos)} de ${centimosAEuros(r.importes?.totalCentimos)}`,
                      },
                  ],
                  "Reembolso"
              )
            : "";

    const bloqueCancelacion =
        estaCancelada(r) && (r.cancelacion?.por || r.cancelacion?.motivo)
            ? tablaDatos(
                  [
                      { label: "Cancelada por", value: r.cancelacion?.por },
                      { label: "Motivo", value: r.cancelacion?.motivo },
                  ],
                  "Cancelación"
              )
            : "";

    const contenido = `
        ${etiqueta(aviso.etiqueta)}
        ${titulo(`${escapeHtml(r.contacto?.nombre || "Huésped")} · ${escapeHtml(r.codigo)}`)}
        ${parrafo(aviso.intro(r, extra))}
        ${avisoPrueba(extra.prueba)}
        ${divisor}
        ${bloqueReembolso}
        ${bloqueCancelacion}
        ${tablaDatos(
            [
                { label: "Nombre", value: r.contacto?.nombre },
                {
                    label: "Email",
                    value: `<a href="mailto:${escapeHtml(email)}" style="color:${C.arcilla}; text-decoration:none;">${escapeHtml(email)}</a>`,
                    html: true,
                },
                {
                    label: "Teléfono",
                    value: `<a href="tel:${escapeHtml(telefonoEnlace(telefono))}" style="color:${C.tinta}; text-decoration:none;">${escapeHtml(telefono)}</a>`,
                    html: true,
                },
            ],
            "Huésped"
        )}
        ${tablaReserva(estanciaDe(r), "Estancia")}
        ${tablaDatos(filasImporteDe(r), "Importe (IVA incluido)")}
        ${tablaDatos(
            [
                { label: "Tipo", value: f.tipo === "empresa" ? "Empresa" : "Particular" },
                { label: f.tipo === "empresa" ? "Razón social" : "Nombre", value: f.nombre },
                { label: "Documento", value: [f.tipoDocumento, f.documento].filter(Boolean).join(" ") },
                { label: "Dirección", value: direccion },
                { label: "Acepta publicidad", value: r.consentimientos?.comunicacionesComerciales?.aceptado ? "Sí" : "No" },
            ],
            "Datos de facturación"
        )}
        <div style="margin:0 0 20px;">
            ${boton(`mailto:${email}?subject=${encodeURIComponent(`Tu reserva ${r.codigo} en Quinta de Argos`)}`, "Responder por email")}
            ${telWa ? boton(`https://wa.me/${telWa}`, "Escribir por WhatsApp", { secundario: true }) : ""}
        </div>`;

    const text = [
        `${aviso.etiqueta} — ${r.codigo}`,
        "",
        `Huésped: ${r.contacto?.nombre} · ${email} · ${telefono}`,
        `Llegada: ${fechaLarga(r.estancia?.checkIn)}`,
        `Salida: ${fechaLarga(r.estancia?.checkOut)}`,
        `Huéspedes: ${r.estancia?.huespedes}`,
        `Total: ${formatoEuros(r.importes?.total)} (IVA incluido)`,
        extra.importeCentimos != null ? `Reembolso: ${centimosAEuros(extra.importeCentimos)}` : null,
        r.cancelacion?.motivo && estaCancelada(r) ? `Motivo de la cancelación: ${r.cancelacion.motivo}` : null,
    ]
        .filter((l) => l !== null)
        .join("\n");

    await sendMail({
        to: BUZON_FINCA(),
        subject: asunto,
        html: layout({
            tituloDocumento: asunto,
            preheader: `${r.contacto?.nombre} · ${fechasCortas(r)} · ${formatoEuros(r.importes?.total)}`,
            etiquetaCabecera: aviso.cabecera,
            contenido,
            notaPie: "Aviso automático de reservas de quintadeargos.com.",
        }),
        text,
        replyTo: email ? { email, name: r.contacto?.nombre } : undefined, // «Responder» contesta al huésped
    });

    return { asunto };
}

// ---------- Reembolso: primero como cancelación si toca, si no como reembolso ----------

async function avisarReembolso({ reserva, refundId, rutaCancelacion, rutaLista, comunicacion, etiquetaLog, enviar }) {
    const marcaReembolso = marcaLista(rutaLista, refundId);

    if (estaCancelada(reserva) && !leerRuta(reserva, rutaCancelacion)) {
        const estado = await enviarUnaVez({
            reserva,
            marca: unirMarcas(marcaFecha(rutaCancelacion), marcaReembolso),
            comunicacion: comunicacion ? "cancelacion" : undefined,
            etiquetaLog: `cancelación ${etiquetaLog}`,
            enviar: (r) => enviar(r, true),
        });
        if (estado !== "ya_enviado") return estado;
    }

    return enviarUnaVez({
        reserva,
        marca: marcaReembolso,
        comunicacion,
        etiquetaLog: `reembolso ${etiquetaLog}`,
        enviar: (r) => enviar(r, false),
    });
}

// ---------- Función pública ----------

/**
 * @param {"pendiente" | "confirmada" | "fallido" | "reembolso"} evento
 * @param {object} reserva  documento de models/Reserva (recién leído)
 * @param {{
 *   prueba?: boolean,                    // pago en modo test de Stripe
 *   mensaje?: string,                    // "fallido": motivo del banco
 *   refund?: { id: string, amount: number },  // "reembolso"
 *   totalReembolsadoCentimos?: number    // "reembolso"
 * }} [opciones]
 * @returns {Promise<{ huesped: string, finca: string }>}  "enviado" | "error" | "ya_enviado" | "omitido"
 */
async function notificarReserva(evento, reserva, opciones = {}) {
    const { prueba = false } = opciones;
    if (!reserva?._id) throw new Error("notificarReserva necesita una reserva guardada");

    switch (evento) {
        case "pendiente": {
            const huesped = await enviarUnaVez({
                reserva,
                marca: marcaFecha("emails.pendienteEnviadaEn"),
                comunicacion: "pago_pendiente",
                etiquetaLog: "aviso de pago pendiente al huésped",
                enviar: (r) => correoPagoPendiente(r, { prueba }),
            });
            const finca = await enviarUnaVez({
                reserva,
                marca: marcaFecha("emails.finca.pendiente"),
                etiquetaLog: "aviso de pago pendiente a la finca",
                enviar: (r) => correoFinca(r, "pendiente", { prueba }),
            });
            return { huesped, finca };
        }

        case "confirmada": {
            const huesped = await enviarUnaVez({
                reserva,
                marca: marcaFecha("emails.confirmacionEnviadaEn"),
                comunicacion: "confirmacion",
                etiquetaLog: "confirmación al huésped",
                enviar: (r) => enviarEmailConfirmacionReserva(r, { prueba }),
            });
            const finca = await enviarUnaVez({
                reserva,
                marca: marcaFecha("emails.finca.confirmada"),
                etiquetaLog: "aviso de reserva a la finca",
                enviar: (r) => correoFinca(r, r.emails?.finca?.pendiente ? "aprobada" : "confirmada", { prueba }),
            });
            return { huesped, finca };
        }

        case "fallido": {
            // Solo se avisa si antes se avisó del pago pendiente. Si una tarjeta se
            // rechaza en el momento, el huésped ya lo ve en pantalla.
            const huesped = reserva.emails?.pendienteEnviadaEn
                ? await enviarUnaVez({
                      reserva,
                      marca: marcaFecha("emails.fallidoEnviadoEn"),
                      comunicacion: "pago_fallido",
                      etiquetaLog: "aviso de pago fallido al huésped",
                      enviar: (r) => correoPagoFallido(r, { prueba }),
                  })
                : "omitido";
            const finca = reserva.emails?.finca?.pendiente
                ? await enviarUnaVez({
                      reserva,
                      marca: marcaFecha("emails.finca.fallido"),
                      etiquetaLog: "aviso de pago fallido a la finca",
                      enviar: (r) => correoFinca(r, "fallido", { prueba, mensaje: opciones.mensaje }),
                  })
                : "omitido";
            return { huesped, finca };
        }

        case "reembolso": {
            const { refund, totalReembolsadoCentimos = 0 } = opciones;
            if (!refund?.id) throw new Error("notificarReserva('reembolso') necesita el refund de Stripe");
            const datos = { importeCentimos: refund.amount, totalReembolsadoCentimos, prueba };

            const huesped = await avisarReembolso({
                reserva,
                refundId: refund.id,
                rutaCancelacion: "emails.cancelacionEnviadaEn",
                rutaLista: "emails.reembolsosNotificados",
                comunicacion: "reembolso",
                etiquetaLog: "al huésped",
                enviar: (r, cancelada) => correoReembolso(r, { ...datos, cancelada }),
            });
            const finca = await avisarReembolso({
                reserva,
                refundId: refund.id,
                rutaCancelacion: "emails.finca.cancelacion",
                rutaLista: "emails.finca.reembolsos",
                etiquetaLog: "a la finca",
                enviar: (r, cancelada) => correoFinca(r, cancelada ? "cancelacion" : "reembolso", datos),
            });
            return { huesped, finca };
        }

        default:
            throw new Error(`Evento de aviso desconocido: ${evento}`);
    }
}

// ==========================================================
// 5) RUTA POST /contact
// ==========================================================

const contactRouter = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TELEFONO_RE = /^\+?[\d\s().-]{7,20}$/;
const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_HUESPEDES = 6;

// ---------- Límite anti-abuso: 5 consultas cada 15 minutos por IP ----------
const VENTANA_MS = 15 * 60 * 1000;
const MAX_POR_VENTANA = 5;
const intentosPorIp = new Map();

function limiteContacto(req, res, next) {
    const ahora = Date.now();
    const ip = req.ip || "desconocida";
    const registro = intentosPorIp.get(ip);

    if (!registro || ahora - registro.desde > VENTANA_MS) {
        intentosPorIp.set(ip, { desde: ahora, total: 1 });
        return next();
    }
    if (registro.total >= MAX_POR_VENTANA) {
        return res.status(429).json({
            codigo: "DEMASIADAS_CONSULTAS",
            mensaje: "Has enviado varias consultas seguidas. Espera unos minutos o escríbenos por WhatsApp.",
        });
    }
    registro.total += 1;
    return next();
}

// Limpieza periódica para que el mapa no crezca sin fin.
setInterval(() => {
    const ahora = Date.now();
    for (const [ip, r] of intentosPorIp) if (ahora - r.desde > VENTANA_MS) intentosPorIp.delete(ip);
}, VENTANA_MS).unref();

// ---------- Validación ----------
function texto(valor, max) {
    return typeof valor === "string" ? valor.trim().slice(0, max) : "";
}

function esFechaValida(str) {
    if (!FECHA_RE.test(str)) return false;
    const d = new Date(`${str}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === str;
}

function validarConsulta(body = {}) {
    const errors = {};
    const datos = {
        nombre: texto(body.nombre, 120).replace(/\s+/g, " "),
        email: texto(body.email, 200).toLowerCase(),
        telefono: texto(body.telefono, 40),
        checkin: texto(body.checkin, 10) || null,
        checkout: texto(body.checkout, 10) || null,
        huespedes: body.huespedes === "" || body.huespedes == null ? null : Number(body.huespedes),
        // Mensaje: se quitan caracteres de control salvo saltos de línea y tabuladores.
        mensaje: texto(body.mensaje, 3000).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ""),
    };

    if (datos.nombre.length < 2) errors.nombre = "Indica tu nombre.";
    if (!EMAIL_RE.test(datos.email)) errors.email = "Indica un correo electrónico válido.";
    if (!TELEFONO_RE.test(datos.telefono)) errors.telefono = "Indica un teléfono válido.";
    if (datos.checkin && !esFechaValida(datos.checkin)) errors.checkin = "La fecha de llegada no es válida.";
    if (datos.checkout && !esFechaValida(datos.checkout)) errors.checkout = "La fecha de salida no es válida.";
    if (datos.checkin && datos.checkout && !errors.checkin && !errors.checkout && datos.checkout <= datos.checkin) {
        errors.checkout = "La salida tiene que ser posterior a la llegada.";
    }
    if (datos.huespedes !== null && (!Number.isInteger(datos.huespedes) || datos.huespedes < 1 || datos.huespedes > MAX_HUESPEDES)) {
        errors.huespedes = `Entre 1 y ${MAX_HUESPEDES} huéspedes.`;
    }

    return { datos, errors };
}

// ---------- Ruta ----------
contactRouter.post("/contact", limiteContacto, async (req, res) => {
    const { datos, errors } = validarConsulta(req.body);
    if (Object.keys(errors).length) {
        return res.status(400).json({
            codigo: "DATOS_INVALIDOS",
            mensaje: Object.values(errors)[0],
            errors,
        });
    }

    // 1) Guardar la consulta (si falla, no seguimos: no queremos perderla)
    let consulta;
    try {
        consulta = await ConsultaContacto.create({ ...datos, ip: req.ip || "" });
    } catch (dbError) {
        console.error(esProduccion ? "Error guardando la consulta 🔴" : `Error guardando la consulta 🔴 ${dbError}`);
        return res.status(500).json({
            codigo: "ERROR_INTERNO",
            mensaje: "No hemos podido enviar tu consulta. Inténtalo de nuevo o escríbenos por WhatsApp.",
        });
    }

    // 2) Correos. La consulta ya está guardada: si un correo falla, se registra
    //    pero al usuario se le confirma igualmente.
    const datosEmail = { ...datos, recibidaEn: consulta.createdAt };
    const errores = [];

    try {
        const aviso = emailConsultaPropietario(datosEmail);
        await sendMail({
            to: process.env.EMAIL_CONTACTO || EMPRESA.email,
            subject: aviso.subject,
            html: aviso.html,
            text: aviso.text,
            replyTo: { email: datos.email, name: datos.nombre }, // «Responder» contesta al huésped
        });
        consulta.emails.propietario = true;
    } catch (mailError) {
        errores.push(`propietario: ${mailError?.message || mailError}`);
        console.error(esProduccion ? "Error enviando el aviso de consulta 🔴" : `Error enviando el aviso de consulta 🔴 ${mailError}`);
    }

    try {
        const acuse = emailAcuseHuesped(datosEmail);
        await sendMail({
            to: datos.email,
            subject: acuse.subject,
            html: acuse.html,
            text: acuse.text,
            replyTo: { email: process.env.EMAIL_CONTACTO || EMPRESA.email, name: EMPRESA.nombre },
        });
        consulta.emails.huesped = true;
    } catch (mailError) {
        errores.push(`huesped: ${mailError?.message || mailError}`);
        console.error(esProduccion ? "Error enviando el acuse al huésped 🔴" : `Error enviando el acuse al huésped 🔴 ${mailError}`);
    }

    consulta.emails.error = errores.join(" | ").slice(0, 500);
    await consulta.save().catch(() => {});

    return res.status(201).json({ mensaje: "Consulta enviada correctamente." });
});

// ==========================================================
// 6) RUTA POST /api/admin/reservas-web/:id/factura-adjunta
//    El propietario adjunta SU factura (PDF/JPG/PNG) y se envía al huésped
//    con el correo de presentación. Protecciones: admin + Firebase en el
//    momento + clave de firma (mismo bloqueo y auditoría que el calendario).
//
//    multipart/form-data:
//      factura  archivo (obligatorio)
//      numero   nº de factura (opcional, para el panel y el correo)
//      nota     texto opcional para el huésped
//      pin      clave de firma
// ==========================================================

const MAX_FACTURA_BYTES = 5 * 1024 * 1024; // 5 MB: Brevo limita el tamaño total del correo
const TIPOS_FACTURA = { "application/pdf": ".pdf", "image/jpeg": ".jpg", "image/png": ".png" };
// La firma comparte sección con el resto del panel (bloqueo y auditoría en configaudits).
const SECCION_FIRMA_FACTURA = "calendario";

const subidaFactura = multer({
    storage: multer.memoryStorage(), // no se guarda en disco: va directa al correo
    limits: { fileSize: MAX_FACTURA_BYTES, files: 1, fields: 10 },
    fileFilter: (req, file, cb) => {
        if (TIPOS_FACTURA[file.mimetype]) return cb(null, true);
        const error = new Error("TIPO_NO_PERMITIDO");
        error.code = "TIPO_NO_PERMITIDO";
        return cb(error);
    },
}).single("factura");

// multer con errores en el mismo formato que el resto del panel
function recibirFactura(req, res, next) {
    subidaFactura(req, res, (error) => {
        if (!error) return next();
        const mensaje =
            error.code === "LIMIT_FILE_SIZE"
                ? "El archivo pesa demasiado (máximo 5 MB)."
                : error.code === "TIPO_NO_PERMITIDO"
                  ? "La factura tiene que ser un PDF, JPG o PNG."
                  : "No se ha podido leer el archivo.";
        return res.status(400).json({ message: "ARCHIVO_INVALIDO", mensaje, detail: mensaje });
    });
}

// Nombre de archivo seguro para el adjunto.
function nombreArchivoSeguro(original, mimetype, numero) {
    const ext = TIPOS_FACTURA[mimetype] || "";
    const base = String(numero || original || "factura")
        .replace(/\.[^.]+$/, "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^A-Za-z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 80);
    return `${numero ? "Factura-" : ""}${base || "factura"}${ext}`;
}

const facturaEnCurso = new Set();
const quienEnvia = (req) => req.freshAdmin?.email || req.user?.email || "admin";

contactRouter.post(
    "/api/admin/reservas-web/:id/factura-adjunta",
    adminMiddleware,
    requireFreshAdmin,
    recibirFactura, // primero el archivo: así req.body.pin existe para la firma
    requireSignature(SECCION_FIRMA_FACTURA),
    async (req, res) => {
        const { id } = req.params;
        if (!mongoose.isValidObjectId(id)) {
            return res.status(400).json({ mensaje: "Identificador de reserva no válido." });
        }
        if (!req.file) {
            return res.status(400).json({ mensaje: "Adjunta el archivo de la factura." });
        }
        if (facturaEnCurso.has(id)) {
            return res.status(409).json({ mensaje: "Ya se está enviando una factura de esta reserva. Espera unos segundos." });
        }

        const numero = typeof req.body?.numero === "string" ? req.body.numero.trim().slice(0, 40) : "";
        const nota = typeof req.body?.nota === "string" ? req.body.nota.trim().slice(0, 2000) : "";

        facturaEnCurso.add(id);
        try {
            const reserva = await Reserva.findById(id);
            if (!reserva) return res.status(404).json({ mensaje: "La reserva no existe." });
            if (["pendiente_pago", "pago_fallido"].includes(reserva.estado)) {
                return res.status(409).json({ mensaje: "Esta reserva no llegó a cobrarse: no se puede enviar una factura." });
            }

            const archivo = {
                filename: nombreArchivoSeguro(req.file.originalname, req.file.mimetype, numero),
                content: req.file.buffer,
            };

            let envio;
            try {
                envio = await enviarEmailFactura({
                    destinatario: { email: reserva.contacto.email, nombre: reserva.contacto.nombre },
                    reserva: {
                        codigo: reserva.codigo,
                        checkIn: reserva.estancia.checkIn,
                        checkOut: reserva.estancia.checkOut,
                        noches: reserva.estancia.noches,
                        huespedes: reserva.estancia.huespedes,
                    },
                    archivo,
                    numero,
                    nota,
                });
            } catch (error) {
                envio = { enviado: false, error: error?.message || "Error desconocido" };
            }

            // Registro en la reserva (el archivo no se guarda: solo su nombre).
            reserva.comunicaciones.push({
                tipo: "factura",
                destinatario: reserva.contacto.email,
                asunto: numero ? `Factura ${numero}` : `Factura (${archivo.filename})`,
                mensaje: [nota, `Adjunto: ${archivo.filename}`].filter(Boolean).join("\n\n").slice(0, 5000),
                estado: envio.enviado ? "enviado" : "error",
                error: envio.error || "",
                creadoPor: quienEnvia(req),
            });
            if (envio.enviado) {
                if (numero) reserva.factura.numero = numero;
                if (!reserva.factura.fechaEmision) reserva.factura.fechaEmision = new Date();
                reserva.factura.ultimoEnvio = new Date();
            }

            try {
                await reserva.save();
            } catch (error) {
                if (error?.code === 11000) {
                    return res.status(409).json({ mensaje: `El número ${numero} ya está asignado a otra reserva.`, envio });
                }
                throw error;
            }

            await audit(req, SECCION_FIRMA_FACTURA, envio.enviado ? "ok" : "error", {
                accion: "enviar_factura",
                codigo: reserva.codigo,
                numero: numero || null,
                archivo: archivo.filename,
            });

            res.json({ reserva: reserva.toObject({ versionKey: false }), envio, factura: { numero: numero || null } });
        } catch (error) {
            console.error(esProduccion ? "Error enviando la factura adjunta 🔴" : `Error enviando la factura adjunta 🔴 ${error}`);
            res.status(500).json({ mensaje: "No se ha podido enviar la factura." });
        } finally {
            facturaEnCurso.delete(id);
        }
    }
);

// ==========================================================
// 7) RUTA POST /api/admin/reservas-web/:id/mensaje
//    Mensaje libre del propietario al huésped (sin clave de firma).
//    Body JSON: { asunto, mensaje }
// ==========================================================
contactRouter.post("/api/admin/reservas-web/:id/mensaje", adminMiddleware, async (req, res) => {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
        return res.status(400).json({ mensaje: "Identificador de reserva no válido." });
    }

    const asunto = typeof req.body?.asunto === "string" ? req.body.asunto.trim().slice(0, 200) : "";
    const mensaje = typeof req.body?.mensaje === "string" ? req.body.mensaje.trim().slice(0, 5000) : "";
    if (asunto.length < 2) return res.status(400).json({ mensaje: "Escribe un asunto." });
    if (mensaje.length < 2) return res.status(400).json({ mensaje: "Escribe el mensaje." });

    try {
        const reserva = await Reserva.findById(id);
        if (!reserva) return res.status(404).json({ mensaje: "La reserva no existe." });

        let envio;
        try {
            envio = await enviarEmailMensaje({
                destinatario: { email: reserva.contacto.email, nombre: reserva.contacto.nombre },
                asunto,
                mensaje,
                reserva: {
                    codigo: reserva.codigo,
                    checkIn: reserva.estancia.checkIn,
                    checkOut: reserva.estancia.checkOut,
                    noches: reserva.estancia.noches,
                    huespedes: reserva.estancia.huespedes,
                },
            });
        } catch (error) {
            envio = { enviado: false, error: error?.message || "Error desconocido" };
        }

        reserva.comunicaciones.push({
            tipo: "mensaje",
            destinatario: reserva.contacto.email,
            asunto,
            mensaje,
            estado: envio.enviado ? "enviado" : "error",
            error: envio.error || "",
            creadoPor: quienEnvia(req),
        });
        await reserva.save();

        res.json({ reserva: reserva.toObject({ versionKey: false }), envio });
    } catch (error) {
        console.error(esProduccion ? "Error enviando el mensaje 🔴" : `Error enviando el mensaje 🔴 ${error}`);
        res.status(500).json({ mensaje: "No se ha podido enviar el mensaje." });
    }
});

module.exports = contactRouter;
module.exports.validarConsulta = validarConsulta;
// Para services/emailReservaService.js (mensajes y facturas del panel de reservas)
module.exports.enviarEmailMensaje = enviarEmailMensaje;
module.exports.enviarEmailFactura = enviarEmailFactura;
// Para routes/paymentsRouter.js: todos los avisos de reserva (huésped y finca)
module.exports.notificarReserva = notificarReserva;
module.exports.enviarEmailConfirmacionReserva = enviarEmailConfirmacionReserva;