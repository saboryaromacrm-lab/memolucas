/**
 * Normaliza un número a formato internacional sin "+" (ej. 5491112345678).
 * Pensado para Argentina: agrega el 54 y el 9 de celulares si faltan, y saca el 0 y el 15.
 */
export function normalizarNumero(entrada: string): string {
  let d = (entrada ?? "").replace(/\D/g, "");
  if (!d) return "";
  if (d.startsWith("00")) d = d.slice(2);
  const conPlus = entrada.trim().startsWith("+");
  if (!conPlus && !d.startsWith("54") && (d.length === 10 || d.length === 11 || d.startsWith("0"))) {
    // Número local argentino: 011 15 1234-5678, 11 1234-5678, 0351 15 ...
    d = d.replace(/^0/, "");
    d = quitar15(d);
    return `549${d}`;
  }
  if (d.startsWith("54")) {
    let resto = d.slice(2);
    if (resto.startsWith("9")) resto = resto.slice(1);
    resto = quitar15(resto.replace(/^0/, ""));
    return `549${resto}`;
  }
  return d;
}

// Saca el "15" que va entre el código de área y el número (área de 2 a 4 dígitos + 6 a 8 dígitos = 10).
function quitar15(d: string): string {
  if (d.length !== 12) return d;
  for (const largoArea of [2, 3, 4]) {
    if (d.slice(largoArea, largoArea + 2) === "15") return d.slice(0, largoArea) + d.slice(largoArea + 2);
  }
  return d;
}

/** Para comparar: en Argentina WhatsApp a veces usa 549… y a veces 54…; se ignora ese 9. */
export function claveComparacion(numero: string): string {
  const d = numero.replace(/\D/g, "");
  return d.startsWith("549") ? `54${d.slice(3)}` : d;
}

export const mismoNumero = (a: string, b: string) => !!a && !!b && claveComparacion(a) === claveComparacion(b);

export const jidDeNumero = (numero: string) => `${numero}@s.whatsapp.net`;

/** "5491112345678" → "+54 9 11 1234-5678" (aproximado, solo para mostrar). */
export function mostrarNumero(numero: string): string {
  const d = numero.replace(/\D/g, "");
  if (d.startsWith("549") && d.length === 13) return `+54 9 ${d.slice(3, 5)} ${d.slice(5, 9)}-${d.slice(9)}`;
  return d ? `+${d}` : "";
}
