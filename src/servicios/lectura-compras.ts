import fs from "node:fs/promises";
import type { FilaComprobante } from "../db/schema.js";
import { corregirComprobante, leerComprobantes, type ArchivoParaIa } from "../bot/ia-compras.js";
import { controlar, tituloComprobante, type Comprobante } from "../lib/comprobantes.js";
import { aLocal } from "../lib/fechas.js";
import { borrarAdjunto, imagenParaComprobante, obtenerAdjunto } from "./adjuntos.js";
import { actualizarDatos, buscarDuplicado, guardarComprobante, leerDatos, type ComprobanteGuardado } from "./compras.js";
import { obtenerConfig } from "./configuracion.js";

// Lo comparten el bot (grupo de compras) y el panel de compras.

export type ArchivoSubido = { adjuntoId: number; nombre: string };

export type ResultadoLectura =
  | { tipo: "nuevo"; fila: FilaComprobante; datos: Comprobante }
  | { tipo: "repetido"; repetido: FilaComprobante; datos: Comprobante };

export async function archivosParaIa(archivos: ArchivoSubido[]): Promise<ArchivoParaIa[]> {
  const salida: ArchivoParaIa[] = [];
  for (const a of archivos) {
    const adj = await obtenerAdjunto(a.adjuntoId);
    if (!adj) continue;
    const datos = await fs.readFile(adj.rutaArchivo).catch(() => null);
    if (!datos) continue;
    if (adj.mime === "application/pdf") salida.push({ nombre: a.nombre, mime: adj.mime, datos });
    else salida.push({ nombre: a.nombre, ...(await imagenParaComprobante(datos)) });
  }
  return salida;
}

/**
 * Lee los comprobantes, rehace las cuentas y, si no cierran, relee con el modelo más potente
 * (queda la lectura con menos diferencias). Guarda los nuevos y separa los repetidos.
 * Devuelve [] si no había ningún comprobante. Si la IA falla, tira el error.
 */
export async function leerYGuardar(
  archivos: ArchivoSubido[],
  destino: { chat: string | null; autor: string | null; origen: FilaComprobante["origen"] },
): Promise<ResultadoLectura[]> {
  const cfg = await obtenerConfig();
  const paraIa = await archivosParaIa(archivos);
  let lectura = (await leerComprobantes(cfg, paraIa, cfg.comprasModelo)).map(controlar);
  let modelo = cfg.comprasModelo;
  const fallas = (l: typeof lectura) => l.reduce((t, x) => t + x.fallas, 0);
  if (lectura.some((x) => !x.cierra) && cfg.comprasModeloReintento) {
    const aviso = lectura.flatMap((x) => (x.cierra ? [] : [x.comprobante.controles.diferencias])).join(". ");
    try {
      const otra = (await leerComprobantes(cfg, paraIa, cfg.comprasModeloReintento, aviso)).map(controlar);
      if (otra.length && fallas(otra) <= fallas(lectura)) {
        lectura = otra;
        modelo = cfg.comprasModeloReintento;
      }
    } catch {
      // Queda la primera lectura.
    }
  }

  const resultados: ResultadoLectura[] = [];
  const usados = new Set<number>();
  for (const x of lectura) {
    const repetido = await buscarDuplicado(x.comprobante);
    if (repetido) {
      resultados.push({ tipo: "repetido", repetido, datos: leerDatos(repetido) });
      continue;
    }
    const propios = archivos.filter((a) => x.comprobante.archivo.includes(a.nombre));
    const ids = (propios.length ? propios : archivos).map((a) => a.adjuntoId);
    ids.forEach((id) => usados.add(id));
    const fila = await guardarComprobante({ ...destino, datos: x.comprobante, cierra: x.cierra, modelo, adjuntoIds: ids });
    resultados.push({ tipo: "nuevo", fila, datos: x.comprobante });
  }
  // Los archivos que no quedaron en ningún comprobante (repetidos o sin comprobante) se borran.
  for (const a of archivos) if (!usados.has(a.adjuntoId)) await borrarAdjunto(a.adjuntoId);
  return resultados;
}

/** "Factura A 0012-00004567 de X, lo mandó Ana el 28/10" (para avisar que ya estaba cargado). */
export function textoRepetido(r: { repetido: FilaComprobante; datos: Comprobante }): string {
  return `${tituloComprobante(r.datos)} de ${r.datos.encabezado.razonSocialEmisor || "proveedor sin nombre"}${
    r.repetido.autor ? `, lo mandó ${r.repetido.autor}` : ""
  } el ${aLocal(r.repetido.creadoEn).toFormat("dd/MM")}`;
}

/** Corrección escrita ("el renglón 3 son 12 unidades"): la aplica la IA y se rehacen los controles. */
export async function corregirConTexto(fila: FilaComprobante, correccion: string): Promise<ComprobanteGuardado> {
  const cfg = await obtenerConfig();
  const archivos = fila.archivosBorrados ? [] : await archivosParaIa(fila.adjuntoIds.map((id) => ({ adjuntoId: id, nombre: `archivo-${id}` })));
  const nuevo = await corregirComprobante(cfg, leerDatos(fila), correccion, archivos);
  return actualizarDatos(fila.id, nuevo);
}
