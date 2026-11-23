/** Lo que se lee de un PDF: el texto, o que hace falta (o está mal) la contraseña. */
export type LecturaPdf = { texto: string } | { error: "clave" | "clave-incorrecta" | "ilegible" };

type Fragmento = { x: number; y: number; texto: string };

/** Fragmentos a menos de 3 puntos de altura van en el mismo renglón; cada renglón, de izquierda a derecha. */
function renglones(fragmentos: Fragmento[]): string[] {
  const ordenados = [...fragmentos].sort((a, b) => b.y - a.y || a.x - b.x);
  const lineas: Fragmento[][] = [];
  for (const f of ordenados) {
    const ultima = lineas.at(-1);
    if (ultima && Math.abs(ultima[0].y - f.y) < 3) ultima.push(f);
    else lineas.push([f]);
  }
  return lineas.map((l) => l.sort((a, b) => a.x - b.x).map((f) => f.texto).join(" "));
}

/**
 * Saca el texto de un PDF en el navegador: el archivo no se sube a ningún lado. PDF.js se carga recién acá
 * (no pesa en el resto del panel).
 */
export async function leerPdf(archivo: File, clave: string): Promise<LecturaPdf> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
  const tarea = pdfjs.getDocument({ data: new Uint8Array(await archivo.arrayBuffer()), password: clave || undefined });
  try {
    const doc = await tarea.promise;
    const paginas: string[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const { items } = await (await doc.getPage(n)).getTextContent();
      const fragmentos = items.flatMap((it) => ("str" in it && it.str.trim() ? [{ x: it.transform[4], y: it.transform[5], texto: it.str.trim() }] : []));
      paginas.push(renglones(fragmentos).join("\n"));
    }
    return { texto: paginas.join("\n\n") };
  } catch (err) {
    if (err instanceof pdfjs.PasswordException) return { error: err.code === pdfjs.PasswordResponses.INCORRECT_PASSWORD ? "clave-incorrecta" : "clave" };
    return { error: "ilegible" };
  } finally {
    void tarea.destroy();
  }
}
