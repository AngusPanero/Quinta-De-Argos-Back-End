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

    // ↓ Esto es lo nuevo: reemplaza la línea "await brevo.transactionalEmails.sendTransacEmail(payload);"
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
//    Devuelven { enviado: true } o lanzan un error con el motivo.
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
// La llama routes/paymentsRouter.js cuando Stripe confirma el cobro y la reserva
// ya está creada en Beds24. Aquí solo se arma y se envía el correo: cuándo
// enviarlo (y no repetirlo) lo decide paymentsRouter.

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
    "/api/admin/reservations-web/:id/factura-adjunta",
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

module.exports = contactRouter;
module.exports.validarConsulta = validarConsulta;
// Para services/emailReservaService.js (mensajes y facturas del panel de reservas)
module.exports.enviarEmailMensaje = enviarEmailMensaje;
module.exports.enviarEmailFactura = enviarEmailFactura;
// Para routes/paymentsRouter.js (pago aprobado)
module.exports.enviarEmailConfirmacionReserva = enviarEmailConfirmacionReserva;