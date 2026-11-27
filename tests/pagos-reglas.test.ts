import { describe, expect, it } from "vitest";
import { aCsv, alertasDelMes, errorDeReparto, esperadoDe, estadoDe, repartir, sumarMeses, tocaEnMes, venceEn } from "../src/servicios/pagos-reglas.js";

describe("reglas de Pagos", () => {
  it("en qué meses toca cada pago según su frecuencia", () => {
    const bimestral = { frecuencia: "bimestral" as const, desde: "2026-11" };
    expect(["2026-10", "2026-11", "2026-12", "2027-01", "2027-03"].map((p) => tocaEnMes(bimestral, p))).toEqual([false, true, false, true, true]);
    expect(tocaEnMes({ frecuencia: "anual", desde: "2026-03" }, "2027-03")).toBe(true);
    expect(tocaEnMes({ frecuencia: "unica", desde: "2026-11" }, "2026-12")).toBe(false);
    expect(sumarMeses("2026-12", 1)).toBe("2027-01");
  });

  it("el día 31 en un mes de 30 es el último día", () => {
    expect(venceEn(31, "2026-11")).toBe("2026-11-30");
    expect(venceEn(30, "2027-02")).toBe("2027-02-28");
    expect(venceEn(5, "2026-12")).toBe("2026-12-05");
  });

  it("el variable se sugiere con el promedio de los últimos 3 meses; el fijo, siempre el mismo", () => {
    expect(esperadoDe({ monto: 70000, variable: true }, [])).toBe(70000);
    expect(esperadoDe({ monto: 70000, variable: true }, [50000, 60000, 90000, 96000])).toBe(82000);
    expect(esperadoDe({ monto: 650000, variable: false }, [700000])).toBe(650000);
  });

  it("pagado, en parte o pendiente", () => {
    expect(estadoDe(1000, [])).toBe("pendiente");
    expect(estadoDe(1000, [{ monto: 400, fecha: "2026-11-01" }])).toBe("parcial");
    expect(estadoDe(1000, [{ monto: 400, fecha: "2026-11-01" }, { monto: 600, fecha: "2026-11-10" }])).toBe("pagado");
    expect(estadoDe(0, [{ monto: 500, fecha: "2026-11-01" }])).toBe("pagado");
  });

  it("alertas: lo vencido, las subas raras y cómo viene contra el mes anterior", () => {
    const base = { moneda: "ARS" as const, estado: "pendiente" as const, promedioAnterior: null };
    const alertas = alertasDelMes(
      [
        { ...base, nombre: "ABL", lugar: "Casa", monto: 38400, vence: "2026-11-20" },
        { ...base, nombre: "Luz", lugar: "Express 1", monto: 96200, vence: "2026-11-28", promedioAnterior: 70000 },
        { ...base, nombre: "Alquiler", lugar: "Fontana", monto: 800000, vence: "2026-11-10", estado: "pagado" },
      ],
      "2026-11-26",
      { ARS: 1_100_000, USD: 0 },
    );
    expect(alertas).toEqual([
      "Venció sin pagar: ABL · Casa (20/11).",
      "Luz · Express 1 viene 37 % más que el promedio de los meses anteriores.",
      "El mes viene 15 % abajo del anterior.",
    ]);
  });

  it("repartir en partes iguales o por porcentaje, con los centavos que cierran justo", () => {
    expect(repartir(85000, [1, 2, 3, 4, 5].map((lugarId) => ({ lugarId, porcentaje: null }))).map((p) => p.monto)).toEqual([17000, 17000, 17000, 17000, 17000]);
    expect(repartir(100, [1, 2, 3].map((lugarId) => ({ lugarId, porcentaje: null }))).map((p) => p.monto)).toEqual([33.33, 33.33, 33.34]);
    expect(repartir(85000, [{ lugarId: 1, porcentaje: 40 }, { lugarId: 2, porcentaje: 30 }, { lugarId: 3, porcentaje: 30 }]).map((p) => [p.monto, p.porcentaje])).toEqual([
      [34000, 40],
      [25500, 30],
      [25500, 30],
    ]);
    expect(errorDeReparto([{ lugarId: 1, porcentaje: null }])).toContain("al menos 2");
    expect(errorDeReparto([{ lugarId: 1, porcentaje: 50 }, { lugarId: 2, porcentaje: null }])).toContain("de todos los lugares, o de ninguno");
    expect(errorDeReparto([{ lugarId: 1, porcentaje: 50 }, { lugarId: 2, porcentaje: 40 }])).toContain("sumar 100");
    expect(errorDeReparto([{ lugarId: 1, porcentaje: null }, { lugarId: 2, porcentaje: null }])).toBeNull();
  });

  it("el CSV abre bien en Excel: punto y coma, coma decimal y tildes", () => {
    const csv = aCsv([
      { periodo: "2026-11", vence: "2026-11-10", lugar: "Fontana", tipo: "Negocio", categoria: "Alquiler", nombre: "Alquiler; local", moneda: "ARS", esperado: 800000, pagado: 800000.5, estado: "pagado", pagadoEn: "2026-11-09", forma: "Transferencia", reparto: "", nota: "" },
    ]);
    expect(csv.startsWith("﻿Mes;Vence;Lugar;Tipo;Categoría;Pago")).toBe(true);
    expect(csv).toContain('2026-11;10/11/2026;Fontana;Negocio;Alquiler;"Alquiler; local";ARS;800000,00;800000,50;Pagado;09/11/2026;Transferencia;;');
  });
});
