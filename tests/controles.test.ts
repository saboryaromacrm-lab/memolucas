import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../src/db/index.js";
import { comprobante } from "../src/db/schema.js";
import { controlar, type Comprobante } from "../src/lib/comprobantes.js";
import { columnas, leerDatos, recontrolarPendientes } from "../src/servicios/compras.js";
import { baseLimpia } from "./ayuda.js";
import { facturaDePrueba } from "./fabrica.js";

/** La factura de Salta Refrescos de la tónica: precio unitario sin IVA e importe con IVA. */
function tonica(alicuotaIva = 21): Comprobante {
  const f = facturaDePrueba();
  f.encabezado = { ...f.encabezado, razonSocialEmisor: "SALTA REFRESCOS S.A.", numero: "00119708" };
  f.renglones = [
    { clase: "mercaderia", codigo: "3176", descripcion: "SCHWEPPES TONICA 354ML*6L", cantidad: 1, unidad: "", unidadesPorBulto: 6, precioUnitario: 8954.31, descuentos: [], importe: 10834.72, alicuotaIva, cierra: true },
  ];
  f.pie = {
    subtotal: 8954.31,
    bonificacionPct: 0,
    bonificacionImporte: 0,
    ivas: [{ alicuota: 21, importe: 1880.41 }],
    percepciones: [
      { nombre: "Percepc. IVA", tipo: "iva", alicuota: 0, importe: 268.63 },
      { nombre: "Percepc. DGR", tipo: "iibb", alicuota: 0, importe: 273.59 },
    ],
    impuestosInternos: 0,
    otrosImpuestos: 165.29,
    total: 11542.23,
  };
  return f;
}

describe("control de renglones", () => {
  it("cierra con precio sin IVA e importe con IVA (con la alícuota del renglón o la única de la factura)", () => {
    for (const alicuota of [21, 0]) {
      const r = controlar(tonica(alicuota));
      expect(r.cierra).toBe(true);
      expect(r.comprobante.controles.diferencias).toBe("");
    }
  });

  it("una diferencia de verdad sigue sin cerrar", () => {
    const f = tonica();
    f.renglones[0].importe = 12000;
    const r = controlar(f);
    expect(r.comprobante.renglones[0].cierra).toBe(false);
    expect(r.comprobante.controles.diferencias).toContain("pero dice $ 12.000,00");
  });
});

describe("volver a controlar las facturas sin confirmar", () => {
  beforeEach(async () => {
    await baseLimpia();
  });

  it("la que no cerraba con el control viejo pasa a confirmar; las confirmadas no se tocan", async () => {
    // Como la guardó el control viejo: el renglón marcado como que no cierra.
    const vieja = controlar(tonica()).comprobante;
    const guardada = { ...vieja, renglones: [{ ...vieja.renglones[0], cierra: false }], controles: { ...vieja.controles, diferencias: "Renglón 1 no cierra" } };
    const guardar = (estado: "revisar" | "confirmado") =>
      db
        .insert(comprobante)
        .values({ estado, origen: "panel", ...columnas(guardada, false) })
        .returning();
    const [[revisar], [confirmada]] = await Promise.all([guardar("revisar"), guardar("confirmado")]);

    await recontrolarPendientes();
    const [ahora] = await db.select().from(comprobante).where(eq(comprobante.id, revisar.id));
    expect(ahora).toMatchObject({ estado: "pendiente", cierra: true });
    expect(leerDatos(ahora).controles.diferencias).toBe("");
    const [igual] = await db.select().from(comprobante).where(eq(comprobante.id, confirmada.id));
    expect(igual).toMatchObject({ estado: "confirmado", cierra: false });
  });
});
