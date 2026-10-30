import type { Comprobante } from "../src/lib/comprobantes.js";

/** Una factura A que cierra: 2 renglones, IVA 21% y una percepción de IIBB. */
export function facturaDePrueba(cambios: Partial<Comprobante> = {}): Comprobante {
  return {
    archivo: "foto-1.jpg",
    clase: "mercaderia",
    motivoClase: "",
    encabezado: {
      tipo: "factura",
      letra: "A",
      codigoArca: 1,
      puntoVenta: "0012",
      numero: "00004567",
      fecha: "2026-10-28",
      cae: "76123456789012",
      cuitEmisor: "30-71234567-8",
      razonSocialEmisor: "Distribuidora del Café SA",
      domicilioEmisor: "",
      condicionIvaEmisor: "responsable_inscripto",
      cuitReceptor: "",
      razonSocialReceptor: "Coffit",
      moneda: "PES",
      condicionVentaImpresa: "Cuenta corriente",
      vencimientoPago: "",
      comprobanteQueAjusta: "",
    },
    renglones: [
      { clase: "mercaderia", codigo: "CF1", descripcion: "Café en grano 1 kg", cantidad: 10, unidad: "KG", unidadesPorBulto: 0, precioUnitario: 15000, descuentos: [10], importe: 135000, alicuotaIva: 21, cierra: true },
      { clase: "mercaderia", codigo: "LE1", descripcion: "Leche entera 1 L", cantidad: 2, unidad: "CJ", unidadesPorBulto: 12, precioUnitario: 1000, descuentos: [], importe: 24000, alicuotaIva: 21, cierra: true },
    ],
    pie: {
      subtotal: 159000,
      bonificacionPct: 0,
      bonificacionImporte: 0,
      ivas: [{ alicuota: 21, importe: 33390 }],
      percepciones: [{ nombre: "Perc. IIBB CABA", tipo: "iibb", alicuota: 3, importe: 4770 }],
      impuestosInternos: 0,
      otrosImpuestos: 0,
      total: 197160,
    },
    pagoQueFigura: { figura: false, medio: "", fecha: "", importe: 0, referencia: "" },
    controles: { sumaRenglones: 0, cierraSubtotal: true, cierraTotal: true, diferencias: "" },
    dudas: [],
    ...cambios,
  };
}
