// Reglas del texto del Bloc: lo resaltado (tramos aparte del texto) y mayúsculas / minúsculas.

export type Tramo = { desde: number; hasta: number };

/** Ordenados, sin vacíos y unidos los que se tocan o se pisan. */
export function unirTramos(tramos: Tramo[]): Tramo[] {
  const r: Tramo[] = [];
  for (const t of [...tramos].filter((x) => x.hasta > x.desde).sort((a, b) => a.desde - b.desde)) {
    const ultimo = r.at(-1);
    if (ultimo && t.desde <= ultimo.hasta) ultimo.hasta = Math.max(ultimo.hasta, t.hasta);
    else r.push({ ...t });
  }
  return r;
}

/**
 * Lo resaltado sigue al texto cuando se escribe: se mira qué parte cambió (lo igual del principio y del final) y lo que
 * está después se corre. Lo que se escribe adentro de un resaltado queda resaltado; lo que se borra, se va.
 */
export function moverTramos(antes: string, despues: string, tramos: Tramo[]): Tramo[] {
  if (antes === despues || !tramos.length) return tramos;
  let p = 0;
  const max = Math.min(antes.length, despues.length);
  while (p < max && antes[p] === despues[p]) p++;
  let s = 0;
  while (s < max - p && antes[antes.length - 1 - s] === despues[despues.length - 1 - s]) s++;
  const finAntes = antes.length - s;
  const finDespues = despues.length - s;
  // Mismo largo (por ejemplo, mayúsculas): las posiciones no cambian.
  if (finAntes - p === finDespues - p) return tramos;
  const delta = finDespues - finAntes;
  const mover = (x: number, esFin: boolean) => (x <= p ? x : x >= finAntes ? x + delta : esFin ? finDespues : p);
  return unirTramos(tramos.map((t) => ({ desde: mover(t.desde, false), hasta: mover(t.hasta, true) })));
}

/** Resaltar o sacar el resaltado de lo seleccionado: si ya estaba todo resaltado, se saca; si no, se resalta. */
export function alternarTramo(tramos: Tramo[], desde: number, hasta: number): Tramo[] {
  const cubierto = (() => {
    let x = desde;
    for (const t of unirTramos(tramos)) if (t.desde <= x && t.hasta > x) x = t.hasta;
    return x >= hasta;
  })();
  if (!cubierto) return unirTramos([...tramos, { desde, hasta }]);
  return unirTramos(tramos.flatMap((t) => (t.hasta <= desde || t.desde >= hasta ? [t] : [{ desde: t.desde, hasta: desde }, { desde: hasta, hasta: t.hasta }])));
}

export type Mayusculas = "mayusculas" | "minusculas" | "oracion" | "palabras";

/** MAYÚSCULAS, minúsculas, Tipo oración (mayúscula al empezar cada oración) o Cada Palabra Con Mayúscula. */
export function convertir(texto: string, modo: Mayusculas): string {
  const bajo = texto.toLocaleLowerCase("es");
  if (modo === "mayusculas") return texto.toLocaleUpperCase("es");
  if (modo === "minusculas") return bajo;
  if (modo === "palabras") return bajo.replace(/(^|[^\p{L}\p{N}'’])(\p{L})/gu, (_, antes: string, letra: string) => antes + letra.toLocaleUpperCase("es"));
  // Al principio, después de . ! ? … o de un salto de línea (salteando signos de apertura como ¿ ¡ « ").
  return bajo.replace(/(^|[.!?…]\s+|\n)(\s*[¿¡«"“(\-–•*]*\s*)(\p{L})/gu, (_, corte: string, signos: string, letra: string) => corte + signos + letra.toLocaleUpperCase("es"));
}

/** Shift+F3, como en Word: minúsculas → MAYÚSCULAS → Tipo oración → minúsculas… */
export function siguienteMayuscula(texto: string): Mayusculas {
  if (texto === texto.toLocaleLowerCase("es")) return "mayusculas";
  if (texto === texto.toLocaleUpperCase("es")) return "oracion";
  return "minusculas";
}
