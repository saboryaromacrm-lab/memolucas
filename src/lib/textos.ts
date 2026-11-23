/** "15 minutos", "1 hora", "2 horas y 30 minutos", "1 día". */
export function describirMinutos(min: number): string {
  if (min <= 0) return "un momento";
  const dias = Math.floor(min / 1440);
  const horas = Math.floor((min % 1440) / 60);
  const minutos = min % 60;
  const partes: string[] = [];
  if (dias) partes.push(dias === 1 ? "1 día" : `${dias} días`);
  if (horas) partes.push(horas === 1 ? "1 hora" : `${horas} horas`);
  if (minutos) partes.push(minutos === 1 ? "1 minuto" : `${minutos} minutos`);
  return partes.length > 1 ? `${partes.slice(0, -1).join(", ")} y ${partes.at(-1)}` : partes[0];
}

/** Saca tildes, signos y espacios de más: para comparar comandos. */
export function normalizar(texto: string): string {
  return texto
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[¡!¿?.,;:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Un comercio sin signos ni espacios: "Mercado Libre" y "MERCADOLIBRE" dan lo mismo. */
export const claveComercio = (s: string) => normalizar(s).replace(/[^a-z0-9]/g, "");

/** ¿Hablan del mismo servicio? "Netflix" y "NETFLIX.COM", o "Spotify" y "SPOTIFY P2B3C". */
export function pareceElMismo(a: string, b: string): boolean {
  const [x, y] = [claveComercio(a), claveComercio(b)];
  return x.length >= 4 && y.length >= 4 && (x.includes(y) || y.includes(x));
}

const pesos = new Intl.NumberFormat("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** "$ 1.234,56" (US$ en dólares). */
export const plata = (n: number, moneda: "ARS" | "USD" = "ARS") => `${moneda === "USD" ? "US$" : "$"} ${pesos.format(n)}`;
