/**
 * Un número escrito como en Argentina: "1.234,56" → 1234.56, "14.000" → 14000, "3,5" o "3.5" → 3.5.
 * null si está vacío o no es un número.
 */
export function aNumero(texto: string): number | null {
  const s = texto.replace(/[\s$%]/g, "");
  if (!s) return null;
  const normal = s.includes(",") ? s.replace(/\./g, "").replace(",", ".") : /^-?\d{1,3}(\.\d{3})+$/.test(s) ? s.replace(/\./g, "") : s;
  const n = Number(normal);
  return Number.isFinite(n) ? n : null;
}

const formato = (decimales: number) => new Intl.NumberFormat("es-AR", { minimumFractionDigits: decimales, maximumFractionDigits: decimales });
const pesos = formato(2);
const porciento = formato(2);

/** "$ 1.234,56" (US$ en dólares). */
export const plata = (n: number, moneda: "ARS" | "USD" = "ARS") => `${moneda === "USD" ? "US$" : "$"} ${pesos.format(n)}`;

/** "+12,50 %" (con signo si se pide). */
export const pct = (n: number, conSigno = false) => `${conSigno && n > 0 ? "+" : ""}${porciento.format(n)} %`;

/** Para mostrar un número en un campo que se edita: 1234.5 → "1234,5" (vacío si es 0 y se pide). */
export const aCampo = (n: number, vacioSiCero = false) => (vacioSiCero && !n ? "" : String(n).replace(".", ","));
