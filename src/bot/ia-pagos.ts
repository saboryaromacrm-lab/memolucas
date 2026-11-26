import { z } from "zod";
import { normalizar, plata } from "../lib/textos.js";
import { obtenerConfig } from "../servicios/configuracion.js";
import { guardarAnalisis, listarLugares, resumenPagos, verMes } from "../servicios/pagos.js";
import { CATEGORIAS, MEDIOS, nombreMes } from "../servicios/pagos-reglas.js";
import { hoyIso } from "../lib/fechas.js";
import { ErrorUsuario } from "../servicios/recordatorios.js";
import { gastoDelMes, pedir } from "./ia.js";

// La IA en Pagos: arma la lista de lo que pagás a partir de lo que dictás, y analiza cada mes.

/** Con el tope de gasto de IA del mes alcanzado, no se usa (igual que el asistente). */
async function conTope() {
  const cfg = await obtenerConfig();
  if (cfg.agenteTopeUsd > 0 && (await gastoDelMes()).costoUsd >= cfg.agenteTopeUsd)
    throw new ErrorUsuario(`Llegaste al tope de IA de este mes (US$ ${cfg.agenteTopeUsd}). Lo podés subir en Configuración → IA.`);
  return cfg;
}

const EsquemaArmado = z.object({
  pagos: z.array(
    z.object({
      lugar: z.string().describe("El lugar tal cual figura en la lista; si es otro, su nombre"),
      lugar_nuevo_tipo: z.enum(["negocio", "personal"]).describe('Solo si el lugar no está en la lista: "negocio" (un local) o "personal" (casa, auto…)'),
      nombre: z.string().describe("Qué se paga, corto: Alquiler, Luz, ABL, Sueldos…"),
      categoria: z.string().describe("Una de las categorías de la lista"),
      monto: z.number().describe("En números (650 mil = 650000). 0 si no lo dijo"),
      variable: z.boolean().describe("true si cambia mes a mes (luz, gas, agua) o dijo 'más o menos'"),
      moneda: z.enum(["ARS", "USD"]),
      dia: z.number().int().describe("Día del mes en que vence (1 a 31). 'A mitad de mes' = 15; si no lo dijo, 10"),
      frecuencia: z.enum(["mensual", "bimestral", "trimestral", "cuatrimestral", "semestral", "anual", "unica"]),
      medio: z.string().describe('Cómo lo paga: Transferencia, Efectivo, Débito automático… "" si no lo dijo'),
      cuenta: z.string().describe('Número de cliente, partida o cuenta si lo dijo; si no, ""'),
      nota: z.string().describe('Otro dato útil que dijo; si no, ""'),
    }),
  ),
});

/** Lo que dictaste o pegaste, armado como pagos fijos para revisar antes de guardar (no guarda nada). */
export async function armarFijosConIa(texto: string) {
  const cfg = await conTope();
  const lugares = await listarLugares();
  const system = `Armás la lista de pagos que ${cfg.nombreUsuario} hace todos los meses (sus locales, su casa, sus cosas), a partir de lo que escribe o dicta como le sale.
Lugares que ya tiene: ${lugares.map((l) => `${l.nombre} (${l.tipo})`).join(", ") || "ninguno"}.
Categorías: ${CATEGORIAS.join(", ")}.
Medios de pago habituales: ${MEDIOS.join(", ")}.
Un pago por cosa y por lugar ("luz y gas en casa" son dos). Si dice "en todos los locales", uno por cada local. No inventes montos ni datos que no dijo.`;
  const r = await pedir(cfg, EsquemaArmado, system, [{ role: "user", content: texto }]);
  return {
    fijos: r.pagos.map((p) => {
      const lugar = lugares.find((l) => normalizar(l.nombre) === normalizar(p.lugar));
      return {
        lugarId: lugar?.id ?? null,
        lugarNuevo: lugar ? undefined : { nombre: p.lugar.trim(), tipo: p.lugar_nuevo_tipo },
        nombre: p.nombre,
        categoria: CATEGORIAS.includes(p.categoria) ? p.categoria : "Otros",
        monto: Math.max(0, p.monto),
        variable: p.variable,
        moneda: p.moneda,
        dia: Math.min(31, Math.max(1, p.dia)),
        frecuencia: p.frecuencia,
        medio: p.medio,
        cuenta: p.cuenta,
        avisoDias: null,
        nota: p.nota,
      };
    }),
  };
}

const EsquemaAnalisis = z.object({ vinetas: z.array(z.string()).describe("De 3 a 6 viñetas cortas") });

/** El análisis del mes (lo pide el panel, o sale solo el día 1 por el mes que cerró). Se guarda para verlo en Pagos. */
export async function analizarMesPagos(periodo: string): Promise<string> {
  const cfg = await conTope();
  const [mes, resumen] = await Promise.all([verMes(periodo), resumenPagos(periodo)]);
  if (!mes.items.length) throw new ErrorUsuario(`No hay pagos en ${nombreMes(periodo)} para analizar.`);
  const montos = (t: { ARS: number; USD: number }) => [plata(t.ARS), t.USD ? plata(t.USD, "USD") : ""].filter(Boolean).join(" + ");
  const datos = [
    `Mes: ${mes.nombre}. Hoy es ${hoyIso()}.`,
    `Total ${montos(mes.totales.total)}; pagado ${montos(mes.totales.pagado)}; falta ${montos(mes.totales.falta)}; vencidos ${mes.totales.vencidos}.`,
    `Mes anterior: total ${montos(resumen.anterior.total)}.`,
    `Últimos meses (total): ${resumen.meses
      .slice(-6)
      .map((m) => `${m.periodo} ${montos(m.total)}`)
      .join(" · ")}.`,
    "Por lugar este mes: " + resumen.mes.porLugar.map((g) => `${g.nombre} ${montos(g.total)}`).join(", "),
    "Por categoría este mes: " + resumen.mes.porCategoria.map((g) => `${g.nombre} ${montos(g.total)}`).join(", "),
    "Pagos (nombre | lugar | vence | monto | pagado | estado):",
    ...mes.items.map((i) => `${i.nombre} | ${i.lugar} | ${i.vence} | ${plata(i.monto, i.moneda)} | ${plata(i.pagado, i.moneda)} | ${i.estado}${i.vencido ? " (vencido)" : ""}`),
    mes.alertas.length ? `Alertas calculadas: ${mes.alertas.join(" ")}` : "",
  ].join("\n");
  const system = `Sos el asistente de finanzas de ${cfg.nombreUsuario} (tiene locales, su casa y sus cosas). Analizás sus pagos del mes en español rioplatense, con voseo.
Escribí de 3 a 6 viñetas cortas y concretas: cómo viene el mes contra el anterior, subas o montos raros, lo que falta o venció, qué lugar o categoría pesa más, y un consejo práctico si lo hay.
Usá solo los números que te paso (no inventes). Montos como "$ 96.200". Sin saludos ni títulos.`;
  const r = await pedir(cfg, EsquemaAnalisis, system, [{ role: "user", content: datos }]);
  const texto = r.vinetas.map((v) => `• ${v.trim()}`).join("\n");
  await guardarAnalisis(periodo, texto);
  return texto;
}
