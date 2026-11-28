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
export const diasDelMes = (periodo: string) => DateTime.fromISO(`${periodo}-01`).daysInMonth!;
/** «octubre» (para «corresponde a octubre»). */
export const soloMes = (periodo: string) => DateTime.fromISO(`${periodo}-01`).setLocale("es").toFormat("LLLL");
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

/** Un grupo de una lista agrupada: su clave, el título y el orden en que va. */
export type Grupo = { clave: string; titulo: string; orden: number };

/** Agrupa en el orden de cada grupo (y por título si empatan), sin cambiar el orden de adentro. */
export function agrupar<T>(items: T[], de: (t: T) => Grupo) {
  const grupos = new Map<string, Grupo & { items: T[] }>();
  for (const t of items) {
    const g = de(t);
    const actual = grupos.get(g.clave) ?? { ...g, items: [] };
    actual.items.push(t);
    grupos.set(g.clave, actual);
  }
  return [...grupos.values()].sort((a, b) => a.orden - b.orden || a.titulo.localeCompare(b.titulo));
}

/** A qué corresponde, como grupo: los lugares en el orden de tu lista, después los nuevos, los repartidos y lo general. */
export function grupoDeAlcance(
  a: { alcance: AlcancePago; lugarId: number | null; tipo: TipoLugar | null; reparto: RepartoPago | null; lugarNuevo?: { nombre: string } },
  lugares: LugarPago[],
): Grupo {
  if (a.lugarNuevo) return { clave: `n:${a.lugarNuevo.nombre}`, titulo: `${a.lugarNuevo.nombre} (lugar nuevo)`, orden: 900 };
  if (a.alcance === "repartido") return { clave: `r:${(a.reparto ?? []).map((r) => r.lugarId).sort().join(",")}`, titulo: describirAlcance(a, lugares), orden: 1000 };
  if (a.alcance === "general") return { clave: `g:${a.tipo}`, titulo: describirAlcance(a, lugares), orden: 2000 };
  const k = lugares.findIndex((l) => l.id === a.lugarId);
  return { clave: `l:${a.lugarId}`, titulo: describirAlcance(a, lugares), orden: k < 0 ? 899 : k };
}

const MESES_DE: Record<FrecuenciaPago, number> = { mensual: 1, bimestral: 2, trimestral: 3, cuatrimestral: 4, semestral: 6, anual: 12, unica: 0 };
/**
 * Lo que sale por mes, en promedio (lo bimestral, la mitad; lo de una sola vez no cuenta), con el estimado de cada uno
 * (en los variables, el promedio de lo pagado). Los que no tienen monto se cuentan aparte: «$ X por mes · 2 sin monto».
 */
export function textoPorMes(fijos: { estimado: number; moneda: "ARS" | "USD"; frecuencia: FrecuenciaPago }[]): string {
  const sinMonto = fijos.filter((f) => !(f.estimado > 0)).length;
  const totales = fijos.reduce((t, f) => (MESES_DE[f.frecuencia] && f.estimado > 0 ? { ...t, [f.moneda]: t[f.moneda] + f.estimado / MESES_DE[f.frecuencia] } : t), { ARS: 0, USD: 0 });
  return [sinMonto < fijos.length ? `${plataTotales(totales)} por mes` : "", sinMonto ? `${sinMonto} sin monto` : ""].filter(Boolean).join(" · ");
}
