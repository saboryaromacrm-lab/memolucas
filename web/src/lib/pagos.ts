import { DateTime } from "luxon";
import { ahora } from "./fechas";
import { plata } from "./numeros";
import type { AlcancePago, FrecuenciaPago, LugarPago, RepartoPago, TipoLugar, Totales } from "./tipos";

// Lo común de las pantallas de Pagos.

export const periodoActual = () => ahora().toFormat("yyyy-MM");
export const sumarMeses = (periodo: string, n: number) => DateTime.fromISO(`${periodo}-01`).plus({ months: n }).toFormat("yyyy-MM");
/** "Noviembre 2026" (con mayúscula). */
export const nombreMes = (periodo: string) => {
  const t = DateTime.fromISO(`${periodo}-01`).setLocale("es").toFormat("LLLL yyyy");
  return t.charAt(0).toUpperCase() + t.slice(1);
};
export const mesCorto = (periodo: string) => DateTime.fromISO(`${periodo}-01`).setLocale("es").toFormat("LLL").replace(".", "");
export const diaMes = (iso: string) => iso.slice(8, 10) + "/" + iso.slice(5, 7);

/** "$ 1.234,00 + US$ 20,00" (sin la parte en cero). */
export const plataTotales = (t: Totales) => [t.ARS || !t.USD ? plata(t.ARS) : "", t.USD ? plata(t.USD, "USD") : ""].filter(Boolean).join(" + ");

export const FRECUENCIAS_PAGO: Record<FrecuenciaPago, string> = {
  mensual: "Mensual",
  bimestral: "Cada 2 meses",
  trimestral: "Cada 3 meses",
  cuatrimestral: "Cada 4 meses",
  semestral: "Cada 6 meses",
  anual: "Una vez por año",
  unica: "Una sola vez",
};

/** "Express 1", "Repartido: Express 1, Fontana (40 %, 60 %)" o "General · personal". */
export function describirAlcance(a: { alcance: AlcancePago; lugarId: number | null; tipo: TipoLugar | null; reparto: RepartoPago | null }, lugares: LugarPago[]): string {
  const nombre = (id: number | null) => lugares.find((l) => l.id === id)?.nombre ?? "—";
  if (a.alcance === "general") return `General · ${a.tipo ?? "personal"}`;
  if (a.alcance === "repartido" && a.reparto) {
    const con = a.reparto.every((r) => r.porcentaje !== null);
    return `Repartido: ${a.reparto.map((r) => nombre(r.lugarId) + (con ? ` ${r.porcentaje} %` : "")).join(", ")}${con ? "" : " (partes iguales)"}`;
  }
  return nombre(a.lugarId);
}
