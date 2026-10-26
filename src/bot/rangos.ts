import { aLocal } from "../lib/fechas.js";
import type { Rango } from "../servicios/listados.js";

/** Arma un rango a partir de lo que devolvió la IA (puede faltar uno de los extremos). */
export function listarRango(desde: Date | null, hasta: Date | null): Rango {
  const d = aLocal(desde ?? hasta!).startOf(desde ? "minute" : "day");
  const h = hasta ? aLocal(hasta) : d.endOf("day");
  const mismoDia = d.toISODate() === h.toISODate();
  const etiqueta = mismoDia ? `el ${d.setLocale("es").toFormat("cccc dd/MM")}` : `del ${d.toFormat("dd/MM")} al ${h.toFormat("dd/MM")}`;
  return { desde: d.toJSDate(), hasta: h.toJSDate(), etiqueta };
}
