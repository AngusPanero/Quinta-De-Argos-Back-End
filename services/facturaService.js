// services/facturaService.js — Quinta de Argos
// Construye el objeto con TODOS los datos de la factura de una reserva.
// Este objeto es lo que recibirá más adelante la plantilla HTML / PDF del email.
//
// Contenido mínimo exigido por el Reglamento de facturación (RD 1619/2012, art. 6):
// número y serie, fecha de expedición, datos del emisor y del destinatario (nombre,
// NIF y domicilio), descripción de las operaciones, base imponible, tipo de IVA,
// cuota y total. Todo se calcula en céntimos para no arrastrar decimales.

const Contador = require("../models/Contador");
const { EMISOR, SERIE_FACTURA, IVA_POR_CONCEPTO, IVA_POR_DEFECTO } = require("../config/empresaConfig");

const aCentimos = (euros) => Math.round(Number(euros) * 100);
const aEuros = (centimos) => Math.round(centimos) / 100;

// Importe con IVA incluido -> { base, cuota } en céntimos.
function desglosarIva(totalCentimos, tipoIva) {
    const base = Math.round(totalCentimos / (1 + tipoIva / 100));
    return { base, cuota: totalCentimos - base };
}

function linea(concepto, cantidad, precioUnitarioCentimos, tipoIva) {
    const importe = cantidad * precioUnitarioCentimos;
    const { base, cuota } = desglosarIva(importe, tipoIva);
    return {
        concepto,
        cantidad,
        precioUnitario: aEuros(precioUnitarioCentimos), // IVA incluido
        importe: aEuros(importe), // IVA incluido
        baseImponible: aEuros(base),
        tipoIva,
        cuotaIva: aEuros(cuota),
        _base: base,
        _cuota: cuota,
        _importe: importe,
    };
}

/** Asigna número correlativo si la reserva aún no tiene (no guarda: lo hace quien llama). */
async function asignarNumeroFactura(reserva, fecha = new Date()) {
    if (reserva.factura?.numero) return reserva.factura.numero;
    const anio = fecha.getFullYear();
    const n = await Contador.siguiente(`factura-${SERIE_FACTURA}-${anio}`);
    reserva.factura.numero = `${SERIE_FACTURA}-${anio}-${String(n).padStart(4, "0")}`;
    reserva.factura.fechaEmision = fecha;
    return reserva.factura.numero;
}

/** Objeto completo de la factura a partir de una reserva pagada y numerada. */
function construirDatosFactura(reserva) {
    const r = typeof reserva.toObject === "function" ? reserva.toObject() : reserva;
    const ivaAlojamiento = IVA_POR_CONCEPTO.alojamiento ?? IVA_POR_DEFECTO;

    // Alojamiento: una línea por cada precio distinto de noche.
    const grupos = new Map();
    for (const noche of r.importes.desglose) {
        const c = aCentimos(noche.precio);
        grupos.set(c, (grupos.get(c) ?? 0) + 1);
    }
    const lineas = [...grupos.entries()].map(([precio, noches]) =>
        linea(
            `Alojamiento Quinta de Argos (${r.estancia.checkIn} a ${r.estancia.checkOut}) · ${noches} ${noches === 1 ? "noche" : "noches"}`,
            noches,
            precio,
            ivaAlojamiento
        )
    );

    for (const a of r.importes.adicionales) {
        lineas.push(linea(a.nombre, 1, aCentimos(a.precio), IVA_POR_CONCEPTO[a.id] ?? IVA_POR_DEFECTO));
    }

    // Resumen por tipo de IVA (la factura debe indicar base y cuota de cada tipo).
    const porTipo = new Map();
    for (const l of lineas) {
        const t = porTipo.get(l.tipoIva) ?? { base: 0, cuota: 0 };
        t.base += l._base;
        t.cuota += l._cuota;
        porTipo.set(l.tipoIva, t);
    }
    const totalCentimos = lineas.reduce((s, l) => s + l._importe, 0);
    const baseCentimos = [...porTipo.values()].reduce((s, t) => s + t.base, 0);

    return {
        numero: r.factura?.numero ?? null,
        fechaEmision: r.factura?.fechaEmision ?? null,
        // Fecha de la operación: el periodo de la estancia.
        periodoOperacion: { desde: r.estancia.checkIn, hasta: r.estancia.checkOut },
        moneda: (r.importes.moneda || "eur").toUpperCase(),

        emisor: EMISOR,
        receptor: {
            tipo: r.facturacion.tipo,
            nombre: r.facturacion.nombre,
            tipoDocumento: r.facturacion.tipoDocumento,
            documento: r.facturacion.documento,
            direccion: r.facturacion.direccion,
        },

        reserva: {
            codigo: r.codigo,
            checkIn: r.estancia.checkIn,
            checkOut: r.estancia.checkOut,
            noches: r.estancia.noches,
            huespedes: r.estancia.huespedes,
        },

        lineas: lineas.map(({ _base, _cuota, _importe, ...publica }) => publica),

        impuestos: [...porTipo.entries()]
            .sort(([a], [b]) => a - b)
            .map(([tipoIva, t]) => ({ tipoIva, baseImponible: aEuros(t.base), cuotaIva: aEuros(t.cuota) })),

        totales: {
            baseImponible: aEuros(baseCentimos),
            cuotaIva: aEuros(totalCentimos - baseCentimos),
            total: aEuros(totalCentimos),
        },

        pago: {
            metodo: "Pago con tarjeta / online (Stripe)",
            fecha: r.pago?.pagadoEn ?? null,
            referencia: r.pago?.paymentIntentId ?? null,
        },

        // Para el email.
        destinatario: { email: r.contacto.email, nombre: r.contacto.nombre },
    };
}

module.exports = { asignarNumeroFactura, construirDatosFactura, desglosarIva };