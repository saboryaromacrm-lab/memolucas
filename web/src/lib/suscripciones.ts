import type { FrecuenciaSuscripcion, SugerenciaTarjeta, Suscripcion } from "./tipos";
import { diasParaVencer } from "./vencimientos";
import { useDatos } from "./vivo";

export const FRECUENCIAS: Record<FrecuenciaSuscripcion, string> = { "7dias": "Cada 7 días", quincenal: "Quincenal", mensual: "Mensual", anual: "Anual" };

/**
 * Las suscripciones, con cuántos días de anticipación avisa el bot (lo mismo marca "vence pronto" en el panel) y con
 * qué tarjeta parece pagarse cada una que no lo tiene definido.
 */
export function useSuscripciones() {
  const r = useDatos<{ suscripciones: Suscripcion[]; sugerencias: Record<number, SugerenciaTarjeta>; diasAviso: number }>("/api/suscripciones", [
    "suscripciones",
    "tarjetas",
    "configuracion",
  ]);
  const porVencer = (r.datos?.suscripciones ?? []).filter((s) => diasParaVencer(s.fechaVto) <= r.datos!.diasAviso);
  return { ...r, porVencer };
}
