// services/emailReservaService.js — Quinta de Argos
// Envío de emails relacionados con una reserva.
//
// ⏳ PENDIENTE: la plantilla HTML y el envío real con Brevo se hacen más adelante.
// De momento estas funciones reciben el objeto ya preparado, lo registran
// y devuelven { enviado: false }. El panel guarda la comunicación como
// "pendiente_envio" para que no se pierda nada.
//
// Cuando se implemente: devolver { enviado: true } si Brevo acepta el envío,
// o lanzar un error con el motivo si falla.

/**
 * @param {object} factura  objeto de facturaService.construirDatosFactura()
 * @returns {Promise<{ enviado: boolean, motivo?: string }>}
 */
async function enviarEmailFactura(factura) {
    console.log(
        "📨 [pendiente] Factura",
        factura.numero,
        "para",
        factura.destinatario.email,
        "·",
        factura.totales.total,
        factura.moneda
    );
    return { enviado: false, motivo: "ENVIO_NO_CONFIGURADO" };
}

/**
 * @param {{
 *   destinatario: { email: string, nombre: string },
 *   asunto: string,
 *   mensaje: string,
 *   reserva: { codigo: string, checkIn: string, checkOut: string, noches: number, huespedes: number }
 * }} datos
 * @returns {Promise<{ enviado: boolean, motivo?: string }>}
 */
async function enviarEmailMensaje(datos) {
    console.log("📨 [pendiente] Mensaje para", datos.destinatario.email, "·", datos.asunto);
    return { enviado: false, motivo: "ENVIO_NO_CONFIGURADO" };
}

module.exports = { enviarEmailFactura, enviarEmailMensaje };