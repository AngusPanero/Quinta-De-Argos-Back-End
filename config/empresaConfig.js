// config/empresaConfig.js — Quinta de Argos
// Datos del EMISOR de las facturas y tipos de IVA.
//
// ⚠️ TODO (Angus + cliente): completar con los datos fiscales reales del
// titular y confirmar los tipos de IVA con su gestoría antes de emitir
// facturas reales.

const EMISOR = {
    razonSocial: "TODO: nombre o razón social del titular",
    nif: "TODO: NIF del titular",
    direccion: {
        linea1: "TODO: dirección fiscal",
        codigoPostal: "30430",
        ciudad: "Cehegín",
        provincia: "Murcia",
        pais: "ES",
    },
    email: "TODO: email de contacto",
    telefono: "TODO: teléfono de contacto",
    web: "https://quintadeargos.com",
};

// Serie de facturación: QA-2026-0001, QA-2026-0002…
const SERIE_FACTURA = "QA";

// Los precios de la web (tarifas y adicionales) son FINALES, con IVA incluido.
// Para la factura se desglosa la base imponible y la cuota de IVA.
// Tipos orientativos: alojamiento turístico y restauración suelen ir al 10 %,
// otros servicios al 21 %. Confírmalos con la gestoría.
const IVA_POR_CONCEPTO = {
    alojamiento: 10,
    "cena-privada": 10,
    "desayuno-gourmet": 10,
    traslado: 10,
    "decoracion-especial": 21,
};
const IVA_POR_DEFECTO = 21;

module.exports = { EMISOR, SERIE_FACTURA, IVA_POR_CONCEPTO, IVA_POR_DEFECTO };