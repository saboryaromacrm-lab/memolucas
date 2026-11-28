import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, or } from "drizzle-orm";
import { DateTime } from "luxon";
import { db } from "../db/index.js";
import { pagoCarga, pagoCategoria, pagoFijo, pagoForma, pagoLugar, pagoMes, type FilaGuardada, type RegistroCarga, type TipoLugar } from "../db/schema.js";
import { abrir, sellar } from "../lib/cifrado.js";
import { bus } from "../lib/eventos.js";
import { normalizar, plata } from "../lib/textos.js";
import { almacenCifrado, comoWebp } from "./archivos-cifrados.js";
import { asegurarCategoria, borrarCategoria } from "./pagos-categorias.js";
import {
  abrirFijo,
  abrirMes,
  actualizarFijo,
  actualizarPagoDelMes,
  alcanceValido,
  borrarFijo,
  borrarFila,
  borrarLugar,
  crearFijo,
  crearLugar,
  crearSuelto,
  pendientesDesdeHoy,
  prepararCorresponde,
  registrarPago,
  type Alcance,
  type EntradaFijo,
} from "./pagos.js";
import { nombreMes, totalPagado, type Moneda } from "./pagos-reglas.js";
import { ErrorUsuario } from "./recordatorios.js";
import { marcarPago } from "./tarjetas.js";

// Las cargas con IA de Pagos: cada vez que aplicás lo que propuso la IA (conceptos, montos de uno o varios meses, lo
// pagado y los pagos sueltos) queda lo que le pasaste, lo que hizo y cómo estaba todo antes, para verlo, deshacerlo
// entero o corregirlo.

type FilaFijo = typeof pagoFijo.$inferSelect;
type FilaMes = typeof pagoMes.$inferSelect;
type Lugar = typeof pagoLugar.$inferSelect;

/** Un renglón de lo que hizo una carga (o, si se deshizo en parte, de lo que quedó). fijoId: el concepto, para abrirlo. */
export type LineaCarga = { tipo: "nuevo" | "cambio" | "borrar" | "monto" | "suelto" | "lugar" | "categoria" | "queda"; nombre: string; detalle: string; fijoId?: number };
/** propuesta: lo que se aplicó tal cual (para corregirlo); las cargas de antes de la IA general no la tienen. */
type DatosCarga = { texto: string; lineas: LineaCarga[]; propuesta?: CargaPropuesta };

const archivos = almacenCifrado("pagos-cargas");
/** En las reconstruidas: lo que se tocó hasta 2 segundos después de aplicar es de la carga; lo de después, tuyo. */
const MARGEN_MS = 2000;

const abrirCarga = (c: string): DatosCarga => ({ texto: "", lineas: [], ...abrir<Partial<DatosCarga>>(c, {}) });
const guardar = <T>(fila: T) => JSON.parse(JSON.stringify(fila)) as FilaGuardada<T>;
const vacio = (): RegistroCarga => ({ lugares: [], categorias: [], creados: [], cambiados: [], borrados: [], meses: [] });
/** «Octubre 2026». */
const mesTexto = (periodo: string) => nombreMes(periodo).replace(/^./, (l) => l.toUpperCase());
const montoDe = (c: string) => {
  const d = abrirMes(c);
  return d.boleta ?? d.esperado;
};
/**
 * Cómo está un concepto o un pago del mes (sin la categoría: renombrarla no es tocarlo). Los datos que se suman con el
 * tiempo van al final y solo si no tienen su valor de siempre: así una carga hecha antes de sumarlos se sigue
 * reconociendo como intacta. huellasViejas: las que se guardaron del 28/11/2026 (con el mes de pago en el medio).
 */
const huellaFijo = (f: FilaFijo) =>
  JSON.stringify([f.lugarId, f.alcance, f.tipo, f.reparto, f.frecuencia, f.dia, f.desde, f.moneda, f.variable, f.formaId, f.avisoDias, abrirFijo(f.datosCifrados), ...(f.desfase ? [f.desfase] : [])]);
const huellaMes = (f: FilaMes) =>
  JSON.stringify([f.estado, f.formaId, f.pagadoEn, f.vence, f.comprobante, abrirMes(f.datosCifrados), ...(f.mesPago !== f.periodo ? [f.mesPago] : [])]);
const huellasViejas = {
  fijo: (f: FilaFijo) => JSON.stringify([f.lugarId, f.alcance, f.tipo, f.reparto, f.frecuencia, f.dia, f.desde, f.desfase, f.moneda, f.variable, f.formaId, f.avisoDias, abrirFijo(f.datosCifrados)]),
  mes: (f: FilaMes) => JSON.stringify([f.estado, f.formaId, f.pagadoEn, f.mesPago, f.vence, f.comprobante, abrirMes(f.datosCifrados)]),
};

/** Si no es un error para mostrarte (algo que quedó en uso, por ejemplo), sigue de largo. */
const siQueda = (e: unknown) => {
  if (!(e instanceof ErrorUsuario)) throw e;
};

/** A qué corresponde, en palabras: el lugar, «Repartido · …» o «General · …». */
export function dondeVa(f: Alcance, lugares: Lugar[]) {
  const nombre = (id: number | null) => lugares.find((l) => l.id === id)?.nombre ?? "lugar borrado";
  if (f.alcance === "general") return `General · ${f.tipo ?? "personal"}`;
  if (f.alcance === "repartido") return `Repartido · ${(f.reparto ?? []).map((r) => nombre(r.lugarId)).join(", ")}`;
  return nombre(f.lugarId);
}

/** Un fijo guardado como lo que se edita (para volverlo a como estaba o revisarlo al corregir). */
function entradaDe(f: FilaFijo | FilaGuardada<FilaFijo>, formas: Set<number>): EntradaFijo {
  const d = abrirFijo(f.datosCifrados);
  return {
    alcance: f.alcance,
    lugarId: f.lugarId,
    tipo: f.tipo,
    reparto: f.reparto,
    nombre: d.nombre,
    categoria: f.categoria,
    monto: d.monto,
    variable: f.variable,
    moneda: f.moneda,
    dia: f.dia,
    frecuencia: f.frecuencia,
    desde: f.desde,
    desfase: f.desfase,
    formaId: f.formaId && formas.has(f.formaId) ? f.formaId : null,
    cuenta: d.cuenta,
    avisoDias: f.avisoDias,
    nota: d.nota,
  };
}

// ───────────── Aplicar lo que propuso la IA (y registrarlo) ─────────────

/** Un pago fijo propuesto por la IA: si es de un lugar que todavía no existe, trae el lugar a crear. */
export type FijoPropuesto = EntradaFijo & {
  lugarNuevo?: { nombre: string; tipo: TipoLugar };
  /** Cómo figuraba en la imagen o el texto que leyó la IA (solo para mostrarlo en la revisión). */
  original?: string;
};

/**
 * Un monto de un mes (el mes al que corresponde): al pago de un concepto que ya tenés (fijoId), de uno nuevo de la misma
 * carga (ref) o a un pago puntual (itemId). pagadoCon: ya está pagado con esa forma, el día fechaPago (de entrada, hoy).
 */
export type MontoPropuesto = ({ fijoId: number } | { ref: string } | { itemId: number }) & { mes: string; monto: number; pagadoCon?: number; fechaPago?: string };
/** Un pago de una sola vez, de un lugar (también uno nuevo) o general. pagadoCon: ya está pagado, el día de la fecha. */
export type SueltoPropuesto = Pick<FijoPropuesto, "lugarId" | "tipo" | "lugarNuevo"> & {
  alcance: "lugar" | "general";
  nombre: string;
  categoria: string;
  monto: number;
  moneda: Moneda;
  fecha: string;
  pagadoCon?: number;
  nota: string;
};
/** Lo que propuso la IA y revisaste, todo junto. Los nuevos llevan un ref para que los montos los nombren. */
export type CargaPropuesta = {
  nuevos: (FijoPropuesto & { ref: string; desde: string })[];
  cambios: (FijoPropuesto & { id: number })[];
  borrar: number[];
  montos: MontoPropuesto[];
  sueltos: SueltoPropuesto[];
};

/** Antes de tocar nada se revisa todo lo propuesto (así no queda a medias). */
function revisar(c: CargaPropuesta) {
  for (const e of [...c.nuevos, ...c.cambios, ...c.sueltos]) {
    if (!e.nombre.trim()) throw new ErrorUsuario("Falta el nombre de un pago.");
    if (e.alcance === "lugar" && !e.lugarId && !e.lugarNuevo?.nombre.trim()) throw new ErrorUsuario(`Falta el lugar de «${e.nombre}».`);
    if (e.alcance !== "lugar" && "reparto" in e) alcanceValido(e);
  }
  for (const s of c.sueltos) if (!(s.monto > 0)) throw new ErrorUsuario(`Falta el monto de «${s.nombre}».`);
  const refs = new Set(c.nuevos.map((n) => n.ref));
  if (refs.size !== c.nuevos.length) throw new ErrorUsuario("Hay dos pagos nuevos con el mismo nombre interno: volvé a armar la carga.");
  if (c.montos.some((m) => "ref" in m && !refs.has(m.ref))) throw new ErrorUsuario("Un monto va a un pago nuevo que ya no está: revisalo.");
}

/** Lo que nombra de lo que ya tenés tiene que seguir estando. */
async function existen(c: CargaPropuesta) {
  const ids = [...c.cambios.map((e) => e.id), ...c.borrar, ...c.montos.flatMap((m) => ("fijoId" in m ? [m.fijoId] : []))];
  if (ids.length) {
    const hay = new Set((await db.select({ id: pagoFijo.id }).from(pagoFijo).where(inArray(pagoFijo.id, ids))).map((f) => f.id));
    if (ids.some((id) => !hay.has(id))) throw new ErrorUsuario("Algún pago ya no existe: volvé a armar los cambios.");
  }
}

/** Crea los lugares nuevos que nombran los pagos propuestos, una sola vez aunque los nombren varios. */
function creadorDeLugares() {
  const creados = new Map<string, number>();
  return async <T extends Pick<FijoPropuesto, "lugarId" | "lugarNuevo"> & { alcance: string }>(e: T): Promise<T> => {
    if (e.alcance !== "lugar" || e.lugarId || !e.lugarNuevo) return e;
    const clave = normalizar(e.lugarNuevo.nombre);
    const lugarId = creados.get(clave) ?? (await crearLugar(e.lugarNuevo)).id;
    creados.set(clave, lugarId);
    return { ...e, lugarId };
  };
}

async function idsActuales() {
  const [lugares, categorias] = await Promise.all([db.select({ id: pagoLugar.id }).from(pagoLugar), db.select({ id: pagoCategoria.id, nombre: pagoCategoria.nombre }).from(pagoCategoria)]);
  return { lugares, categorias };
}

/**
 * Hace los cambios y anota en la carga qué hizo (también si se corta a mitad de camino: lo que llegó a hacer se puede
 * deshacer).
 */
async function registrando<T>(cargaId: number | undefined, propuesta: CargaPropuesta, hacer: (r: RegistroCarga) => Promise<T>): Promise<T> {
  const antes = await idsActuales();
  const r = vacio();
  try {
    return await hacer(r);
  } finally {
    const ahora = await idsActuales();
    r.lugares = ahora.lugares.filter((l) => !antes.lugares.some((x) => x.id === l.id)).map((l) => l.id);
    r.categorias = ahora.categorias.filter((c) => !antes.categorias.some((x) => x.id === c.id)).map((c) => c.nombre);
    r.huellas = await huellasDe(r);
    await guardarRegistro(cargaId, propuesta, r);
  }
}

/** Cómo quedó todo lo que tocó: los conceptos que creó y cambió, sus pagos, los pagos del mes y los sueltos. */
async function huellasDe(r: RegistroCarga) {
  const idsCreados = r.creados.map((c) => c.id);
  const [fijos, filas] = await Promise.all([
    db.select().from(pagoFijo).where(inArray(pagoFijo.id, [...idsCreados, ...r.cambiados.map((f) => f.id)])),
    db
      .select()
      .from(pagoMes)
      .where(or(inArray(pagoMes.fijoId, idsCreados), inArray(pagoMes.id, [...r.meses.map((m) => m.antes.id), ...(r.sueltos ?? [])]))),
  ]);
  return Object.fromEntries([...fijos.map((f) => [`f:${f.id}`, huellaFijo(f)]), ...filas.map((f) => [`m:${f.id}`, huellaMes(f)])]);
}

async function guardarRegistro(cargaId: number | undefined, propuesta: CargaPropuesta, r: RegistroCarga) {
  const [previa] = cargaId ? await db.select().from(pagoCarga).where(eq(pagoCarga.id, cargaId)) : [];
  const hizoAlgo = [r.lugares, r.categorias, r.creados, r.cambiados, r.borrados, r.meses, r.sueltos ?? []].some((lista) => lista.length);
  // Sin nada hecho: una lectura queda para volver a intentar; una carga corregida a nada, ya no está.
  if (!hizoAlgo) {
    if (previa?.estado === "aplicada") await borrarCarga(previa);
    return;
  }
  // El primer mes que toca (de los montos o desde cuándo van los nuevos).
  const periodo = [...propuesta.montos.map((m) => m.mes), ...propuesta.nuevos.map((n) => n.desde)].sort()[0] ?? null;
  const valores = {
    tipo: "general" as const,
    periodo,
    estado: "aplicada" as const,
    reconstruida: false,
    registro: r,
    datosCifrados: sellar({ texto: previa ? abrirCarga(previa.datosCifrados).texto : "", lineas: await lineasDe(r), propuesta } satisfies DatosCarga),
    aplicadaEn: new Date(),
  };
  if (previa) await db.update(pagoCarga).set(valores).where(eq(pagoCarga.id, previa.id));
  else await db.insert(pagoCarga).values(valores);
  bus.avisar("pagos");
}

/**
 * Lo que propuso la IA y revisaste, todo junto y en una sola carga: crea, cambia y borra conceptos; cada monto va al
 * pago del mes al que corresponde (aunque se pague el siguiente) y lo que ya está pagado queda pagado; los sueltos se
 * anotan. Al final revisa que lo marcado como pagado haya quedado pagado (avisos). cargaId: la lectura de la IA.
 */
export async function aplicarCarga(c: CargaPropuesta, cargaId?: number) {
  revisar(c);
  await existen(c);
  return registrando(cargaId, c, async (r) => {
    const conLugar = creadorDeLugares();
    const porRef = new Map<string, number>();
    for (const { ref, ...e } of c.nuevos) {
      const { id } = await crearFijo(await conLugar(e));
      porRef.set(ref, id);
      r.creados.push({ id });
    }
    for (const { id, ...e } of c.cambios) {
      const [antes] = await db.select().from(pagoFijo).where(eq(pagoFijo.id, id));
      r.cambiados.push(guardar(antes));
      await actualizarFijo(id, await conLugar(e));
    }
    for (const id of c.borrar) {
      const [fijo] = await db.select().from(pagoFijo).where(eq(pagoFijo.id, id));
      const filas = await pendientesDesdeHoy(id);
      const historial = (await db.select({ id: pagoMes.id }).from(pagoMes).where(eq(pagoMes.fijoId, id))).map((x) => x.id).filter((x) => !filas.some((f) => f.id === x));
      r.borrados.push({ fijo: guardar(fijo), filas: filas.map(guardar), historial });
      await borrarFijo(id);
    }

    // Cada monto, al pago del mes al que corresponde (los de los fijos se arman si todavía no están).
    for (const mes of new Set(c.montos.map((m) => m.mes))) await prepararCorresponde(mes);
    const fijoDe = (m: MontoPropuesto) => ("fijoId" in m ? m.fijoId : "ref" in m ? porRef.get(m.ref)! : null);
    const filas = await db
      .select()
      .from(pagoMes)
      .where(or(and(inArray(pagoMes.fijoId, c.montos.flatMap((m) => fijoDe(m) ?? [])), inArray(pagoMes.periodo, c.montos.map((m) => m.mes))), inArray(pagoMes.id, c.montos.flatMap((m) => ("itemId" in m ? [m.itemId] : [])))));
    const destinos = c.montos.map((m) => {
      const fijoId = fijoDe(m);
      const fila = fijoId ? filas.find((x) => x.fijoId === fijoId && x.periodo === m.mes) : filas.find((x) => "itemId" in m && x.id === m.itemId);
      if (!fila) throw new ErrorUsuario(`Un pago no se paga en ${nombreMes(m.mes)} (por su frecuencia o porque empieza después): revisalo.`);
      return { fila, ...m };
    });
    // Cómo estaban (los pagos de los conceptos nuevos se van con el concepto).
    const nuevos = new Set(porRef.values());
    for (const d of destinos) {
      if ((d.fila.fijoId && nuevos.has(d.fila.fijoId)) || r.meses.some((m) => m.antes.id === d.fila.id)) continue;
      r.meses.push({ antes: guardar(d.fila), ...(d.pagadoCon && d.fila.estado !== "pagado" ? { pagadoCon: d.pagadoCon } : {}) });
    }
    for (const d of destinos) if (d.monto !== montoDe(d.fila.datosCifrados)) await actualizarPagoDelMes(d.fila.id, { monto: d.monto });
    // Lo que ya está pagado (por la contadora, por ejemplo) queda pagado con esa forma, en esa fecha.
    for (const d of destinos) if (d.pagadoCon && d.fila.estado !== "pagado") await registrarPago(d.fila.id, { formaId: d.pagadoCon, ...(d.fechaPago ? { fecha: d.fechaPago } : {}) });

    r.sueltos = [];
    const sueltosPagados: number[] = [];
    for (const s of c.sueltos) {
      const e = await conLugar(s);
      const item = await crearSuelto({ nombre: e.nombre, lugarId: e.alcance === "lugar" ? e.lugarId : null, tipo: e.tipo ?? undefined, categoria: e.categoria, monto: e.monto, moneda: e.moneda, fecha: e.fecha, formaId: e.pagadoCon ?? null, nota: e.nota, pagado: !!e.pagadoCon });
      r.sueltos.push(item.id);
      if (e.pagadoCon) sueltosPagados.push(item.id);
    }
    const avisos = await sinPagar([...destinos.filter((d) => d.pagadoCon).map((d) => d.fila.id), ...sueltosPagados]);
    return { creados: c.nuevos.length, cambiados: c.cambios.length, borrados: c.borrar.length, montos: destinos.length, sueltos: c.sueltos.length, avisos };
  });
}

/** La revisión después de aplicar: lo que se marcó como pagado y no quedó pagado (entero). */
async function sinPagar(ids: number[]): Promise<string[]> {
  if (!ids.length) return [];
  const filas = await db.select().from(pagoMes).where(inArray(pagoMes.id, ids));
  return filas.flatMap((f) => {
    if (f.estado === "pagado") return [];
    const d = abrirMes(f.datosCifrados);
    const que = `${d.nombre} · ${mesTexto(f.periodo)}`;
    return [f.estado === "parcial" ? `${que} quedó pagado en parte (falta ${plata(montoDe(f.datosCifrados) - totalPagado(d.pagos), f.moneda)}).` : `${que} no quedó pagado.`];
  });
}

// ───────────── Lo que le pasaste a la IA ─────────────

/**
 * Lo que leyó la IA, antes de aplicarlo: lo que escribiste y el archivo (la foto como la leyó, el PDF tal cual).
 * Devuelve el id que va con lo que aplicás.
 */
export async function crearBorrador(texto: string, archivo?: { datos: Buffer; mime: string }) {
  let guardado: { nombre: string; mime: string } | null = null;
  if (archivo) {
    const datos = archivo.mime === "application/pdf" ? archivo.datos : (await comoWebp(archivo.datos, { ancho: 1600, alto: 1600 }).catch(() => null))?.data;
    if (datos) {
      guardado = { nombre: archivos.nuevoNombre(), mime: archivo.mime === "application/pdf" ? archivo.mime : "image/webp" };
      await archivos.guardar(guardado.nombre, datos);
    }
  }
  const [c] = await db
    .insert(pagoCarga)
    .values({ tipo: "general", datosCifrados: sellar({ texto: texto.trim(), lineas: [] } satisfies DatosCarga), archivo: guardado?.nombre, archivoMime: guardado?.mime })
    .returning({ id: pagoCarga.id });
  return c.id;
}

async function borrarCarga(c: typeof pagoCarga.$inferSelect) {
  await db.delete(pagoCarga).where(eq(pagoCarga.id, c.id));
  if (c.archivo) await archivos.borrar([c.archivo]);
}

/** Mantenimiento: las lecturas que no aplicaste (de más de un día) y los archivos de más de 12 meses. */
export async function purgarCargas() {
  const ayer = new Date(Date.now() - 86_400_000);
  for (const c of await db.select().from(pagoCarga).where(and(eq(pagoCarga.estado, "borrador"), lt(pagoCarga.creadoEn, ayer)))) await borrarCarga(c);
  const viejas = await db
    .select()
    .from(pagoCarga)
    .where(and(isNotNull(pagoCarga.archivo), lt(pagoCarga.aplicadaEn, DateTime.now().minus({ months: 12 }).toJSDate())));
  if (!viejas.length) return;
  await archivos.borrar(viejas.map((c) => c.archivo!));
  await db.update(pagoCarga).set({ archivo: null, archivoMime: null }).where(inArray(pagoCarga.id, viejas.map((c) => c.id)));
}

// ───────────── Ver las cargas ─────────────

const cuandoSePaga = (desfase: number) => (desfase ? "el mes siguiente" : "el mismo mes");

/** Qué cambió de un concepto, en palabras. */
function diferencias(antes: FilaGuardada<FilaFijo>, ahora: FilaFijo, lugares: Lugar[], formas: Map<number, string>) {
  const [a, d] = [abrirFijo(antes.datosCifrados), abrirFijo(ahora.datosCifrados)];
  const dia = (x: number | null) => (x ? `día ${x}` : "sin vencimiento");
  const forma = (x: number | null) => (x ? (formas.get(x) ?? "forma borrada") : "sin forma fija");
  const partes = [
    a.nombre !== d.nombre && `nombre: ${a.nombre} → ${d.nombre}`,
    (a.monto !== d.monto || antes.moneda !== ahora.moneda) && `monto: ${plata(a.monto, antes.moneda)} → ${plata(d.monto, ahora.moneda)}`,
    dondeVa(antes, lugares) !== dondeVa(ahora, lugares) && `va en: ${dondeVa(antes, lugares)} → ${dondeVa(ahora, lugares)}`,
    antes.categoria !== ahora.categoria && `categoría: ${antes.categoria} → ${ahora.categoria}`,
    antes.dia !== ahora.dia && `vence: ${dia(antes.dia)} → ${dia(ahora.dia)}`,
    antes.variable !== ahora.variable && (ahora.variable ? "ahora cambia mes a mes" : "ahora es fijo"),
    antes.frecuencia !== ahora.frecuencia && `frecuencia: ${antes.frecuencia} → ${ahora.frecuencia}`,
    antes.desfase !== ahora.desfase && `se paga: ${cuandoSePaga(antes.desfase)} → ${cuandoSePaga(ahora.desfase)}`,
    antes.formaId !== ahora.formaId && `forma de pago: ${forma(antes.formaId)} → ${forma(ahora.formaId)}`,
    (a.cuenta !== d.cuenta || a.nota !== d.nota || antes.avisoDias !== ahora.avisoDias) && "otros datos",
  ];
  return partes.filter(Boolean).join(" · ") || "sin cambios";
}

const fechaCorta = (iso: string) => iso.split("-").reverse().join("/");
/** Con qué se pagó un pago del mes (la última parte), o null si no está pagado. */
const formaDelPago = (f: FilaMes) => (f.estado === "pagado" || f.estado === "parcial" ? (abrirMes(f.datosCifrados).pagos.at(-1)?.formaId ?? f.formaId) : null);

/** El detalle de lo que hizo, con los nombres de ese momento (se calcula al aplicar y se guarda). */
async function lineasDe(r: RegistroCarga): Promise<LineaCarga[]> {
  const idsCreados = r.creados.map((c) => c.id);
  const idsFijos = [...idsCreados, ...r.cambiados.map((f) => f.id)];
  const [fijos, lugares, listaFormas, filas] = await Promise.all([
    idsFijos.length ? db.select().from(pagoFijo).where(inArray(pagoFijo.id, idsFijos)) : [],
    db.select().from(pagoLugar),
    db.select().from(pagoForma),
    db
      .select()
      .from(pagoMes)
      .where(or(inArray(pagoMes.id, [...r.meses.map((m) => m.antes.id), ...(r.sueltos ?? [])]), inArray(pagoMes.fijoId, idsCreados)))
      .orderBy(asc(pagoMes.periodo), asc(pagoMes.id)),
  ]);
  const formas = new Map(listaFormas.map((f) => [f.id, f.nombre]));
  /** «pagado con Lo pagó: Contadora el 12/11/2026». */
  const pagado = (f: FilaMes | undefined, formaId?: number | null) => {
    if (!formaId) return "";
    const fecha = f && abrirMes(f.datosCifrados).pagos.at(-1)?.fecha;
    return `pagado con ${formas.get(formaId) ?? "una forma borrada"}${fecha ? ` el ${fechaCorta(fecha)}` : ""}`;
  };
  // Los pagos de los conceptos nuevos que la carga dejó con monto o pagados.
  const deNuevos = filas.filter((f) => {
    const d = abrirMes(f.datosCifrados);
    return f.fijoId && idsCreados.includes(f.fijoId) && r.huellas?.[`m:${f.id}`] && (d.boleta !== null || d.pagos.length > 0);
  });
  return [
    ...r.lugares.flatMap((id) => {
      const l = lugares.find((x) => x.id === id);
      return l ? [{ tipo: "lugar" as const, nombre: l.nombre, detalle: l.tipo === "personal" ? "Lugar nuevo · personal" : "Lugar nuevo · negocio" }] : [];
    }),
    ...r.categorias.map((nombre) => ({ tipo: "categoria" as const, nombre, detalle: "Categoría nueva" })),
    ...r.creados.flatMap((c) => {
      const f = fijos.find((x) => x.id === c.id);
      if (!f) return [];
      const d = abrirFijo(f.datosCifrados);
      const detalle = [dondeVa(f, lugares), f.categoria, d.monto ? plata(d.monto, f.moneda) : "sin monto", `desde ${nombreMes(f.desde)}`].join(" · ");
      return [{ tipo: "nuevo" as const, nombre: d.nombre, detalle, fijoId: f.id }];
    }),
    ...r.cambiados.map((antes) => {
      const f = fijos.find((x) => x.id === antes.id);
      return { tipo: "cambio" as const, nombre: abrirFijo((f ?? antes).datosCifrados).nombre, detalle: f ? diferencias(antes, f, lugares, formas) : "ya no está", fijoId: antes.id };
    }),
    ...r.borrados.map((b) => ({ tipo: "borrar" as const, nombre: abrirFijo(b.fijo.datosCifrados).nombre, detalle: `${dondeVa(b.fijo, lugares)} · ${b.fijo.categoria}` })),
    ...r.meses.map((m) => {
      const fila = filas.find((x) => x.id === m.antes.id);
      const [antes, ahora] = [montoDe(m.antes.datosCifrados), fila ? montoDe(fila.datosCifrados) : null];
      const monto = ahora === null || ahora === antes ? plata(antes, m.antes.moneda) : `${plata(antes, m.antes.moneda)} → ${plata(ahora, m.antes.moneda)}`;
      const detalle = [mesTexto(m.antes.periodo), dondeVa(m.antes, lugares), monto, pagado(fila, m.pagadoCon)].filter(Boolean).join(" · ");
      return { tipo: "monto" as const, nombre: abrirMes(m.antes.datosCifrados).nombre, detalle, ...(m.antes.fijoId ? { fijoId: m.antes.fijoId } : {}) };
    }),
    ...deNuevos.map((f) => ({
      tipo: "monto" as const,
      nombre: abrirMes(f.datosCifrados).nombre,
      detalle: [mesTexto(f.periodo), dondeVa(f, lugares), plata(montoDe(f.datosCifrados), f.moneda), pagado(f, formaDelPago(f))].filter(Boolean).join(" · "),
      fijoId: f.fijoId!,
    })),
    ...filas
      .filter((f) => r.sueltos?.includes(f.id))
      .map((f) => ({
        tipo: "suelto" as const,
        nombre: abrirMes(f.datosCifrados).nombre,
        detalle: [f.vence ? fechaCorta(f.vence) : mesTexto(f.periodo), dondeVa(f, lugares), plata(montoDe(f.datosCifrados), f.moneda), pagado(f, formaDelPago(f)) || "para pagar"].join(" · "),
      })),
  ];
}

/** Las que se ven en la lista: aplicadas y deshechas en parte (con lo que quedó). */
const VISIBLES: ("aplicada" | "parcial")[] = ["aplicada", "parcial"];

/** Las cargas aplicadas, de la más nueva a la más vieja. */
export async function listarCargas() {
  const filas = await db.select().from(pagoCarga).where(inArray(pagoCarga.estado, VISIBLES)).orderBy(desc(pagoCarga.aplicadaEn), desc(pagoCarga.id));
  return Promise.all(
    filas.map(async (c) => {
      const d = abrirCarga(c.datosCifrados);
      return {
        id: c.id,
        tipo: c.tipo,
        periodo: c.periodo,
        estado: c.estado,
        reconstruida: c.reconstruida,
        aplicadaEn: c.aplicadaEn,
        texto: d.texto,
        archivo: c.archivo ? c.archivoMime : null,
        // Las reconstruidas no guardaron el detalle: se arma con lo que sigue estando.
        lineas: c.reconstruida && c.estado === "aplicada" ? await lineasDe(c.registro ?? vacio()) : d.lineas,
      };
    }),
  );
}

async function obtenerCarga(id: number) {
  const [c] = await db.select().from(pagoCarga).where(and(eq(pagoCarga.id, id), inArray(pagoCarga.estado, VISIBLES)));
  if (!c) throw new ErrorUsuario("Esa carga ya no está.");
  return c;
}

export async function leerArchivoCarga(id: number) {
  const c = await obtenerCarga(id);
  const datos = c.archivo ? await archivos.leer(c.archivo) : null;
  if (!datos) throw new ErrorUsuario("Esa carga no tiene archivo (o ya pasaron 12 meses).");
  return { datos, mime: c.archivoMime ?? "image/webp" };
}

// ───────────── Deshacer ─────────────

/** Lo que no vuelve atrás. sigue: todavía está (lo cambiaste después); si no, ya no hay nada que hacer con eso. */
type Quedan = { nombre: string; motivo: string; sigue: boolean }[];
/** Lo que se va a hacer al deshacer: con ids para hacerlo y con nombres para mostrarlo antes. */
type Plan = {
  meses: FilaGuardada<FilaMes>[];
  cambiados: FilaGuardada<FilaFijo>[];
  /** Los conceptos que creó (se borran siempre) y los que editaste después (para no corregir encima). */
  creados: { id: number; nombre: string }[];
  editadosDespues: string[];
  /** Los pagos del mes que se borran: los de los conceptos que creó y los sueltos que anotó (sueltos: sus nombres). */
  filas: number[];
  sueltos: string[];
  /** Pagos que registraste después en lo que creó: quedan en el historial salvo que elijas borrarlos. */
  pagosDespues: { id: number; nombre: string }[];
  borrados: RegistroCarga["borrados"];
  quedan: Quedan;
  /** Lo que no vuelve atrás y sigue estando: si queda algo, la carga sigue en la lista («deshecha en parte»). */
  restan: Pick<RegistroCarga, "cambiados" | "meses" | "borrados">;
  lugares: Lugar[];
  categorias: string[];
  formas: Set<number>;
};

async function armarPlan(c: typeof pagoCarga.$inferSelect): Promise<Plan> {
  const r = c.registro ?? vacio();
  // Lo tocado después: lo que no quedó como lo dejó la carga (o, en las reconstruidas, lo cambiado después de aplicarla).
  const limite = (c.aplicadaEn?.getTime() ?? 0) + MARGEN_MS;
  const porFecha = (x: { actualizadoEn: Date }) => x.actualizadoEn.getTime() > limite;
  const fijoTocado = (f: FilaFijo) => (r.huellas ? ![huellaFijo(f), huellasViejas.fijo(f)].includes(r.huellas[`f:${f.id}`]) : porFecha(f));
  /** Un pago que no existía al aplicar (un mes que se armó después) es todo tuyo. */
  const filaTocada = (f: FilaMes) => (r.huellas ? ![huellaMes(f), huellasViejas.mes(f)].includes(r.huellas[`m:${f.id}`]) : porFecha(f));
  const idsCreados = r.creados.map((x) => x.id);
  const idsFijos = [...idsCreados, ...r.cambiados.map((f) => f.id), ...r.borrados.map((b) => b.fijo.id)];
  const [fijos, filasPropias, filasMeses, lugares, formas] = await Promise.all([
    idsFijos.length ? db.select().from(pagoFijo).where(inArray(pagoFijo.id, idsFijos)) : [],
    db
      .select()
      .from(pagoMes)
      .where(or(inArray(pagoMes.fijoId, idsCreados), inArray(pagoMes.id, r.sueltos ?? []))),
    r.meses.length ? db.select().from(pagoMes).where(inArray(pagoMes.id, r.meses.map((m) => m.antes.id))) : [],
    db.select().from(pagoLugar),
    db.select({ id: pagoForma.id }).from(pagoForma),
  ]);
  const hayLugar = (id: number | null) => !id || lugares.some((l) => l.id === id);
  const plan: Plan = {
    meses: [],
    cambiados: [],
    creados: [],
    editadosDespues: [],
    filas: [],
    sueltos: [],
    pagosDespues: [],
    borrados: [],
    quedan: [],
    restan: { cambiados: [], meses: [], borrados: [] },
    lugares: lugares.filter((l) => r.lugares.includes(l.id)),
    categorias: r.categorias,
    formas: new Set(formas.map((f) => f.id)),
  };

  // Los pagos del mes que tocó (los de los conceptos que creó se van con el concepto).
  for (const m of r.meses) {
    const { antes } = m;
    if (antes.fijoId && idsCreados.includes(antes.fijoId)) continue;
    const fila = filasMeses.find((x) => x.id === antes.id);
    const nombre = `${abrirMes(antes.datosCifrados).nombre} · ${mesTexto(antes.periodo)}`;
    if (!fila) plan.quedan.push({ nombre, motivo: "lo borraste después", sigue: false });
    else if (filaTocada(fila)) (plan.quedan.push({ nombre, motivo: "lo cambiaste o pagaste después", sigue: true }), plan.restan.meses.push(m));
    else plan.meses.push(antes);
  }
  for (const antes of r.cambiados) {
    const f = fijos.find((x) => x.id === antes.id);
    const nombre = abrirFijo(antes.datosCifrados).nombre;
    if (!f) plan.quedan.push({ nombre, motivo: "lo borraste después", sigue: false });
    else if (fijoTocado(f)) (plan.quedan.push({ nombre, motivo: "lo cambiaste después", sigue: true }), plan.restan.cambiados.push(antes));
    else if (!hayLugar(antes.lugarId)) plan.quedan.push({ nombre, motivo: "el lugar donde estaba ya no existe", sigue: false });
    else plan.cambiados.push(antes);
  }
  // Lo que creó la carga (conceptos y pagos sueltos) se borra siempre, aunque lo hayas editado después. Los pagos que
  // registraste vos después, no: quedan en el historial salvo que elijas borrarlos.
  for (const { id } of r.creados) {
    const f = fijos.find((x) => x.id === id);
    if (!f) continue;
    const nombre = abrirFijo(f.datosCifrados).nombre;
    plan.creados.push({ id, nombre });
    if (fijoTocado(f)) plan.editadosDespues.push(nombre);
  }
  for (const x of filasPropias) {
    const d = abrirMes(x.datosCifrados);
    const nombre = plan.creados.find((c) => c.id === x.fijoId)?.nombre ?? d.nombre;
    if (filaTocada(x) && (!!x.comprobante || d.pagos.length > 0)) {
      const ultimo = d.pagos.at(-1);
      const pago = ultimo ? ` · ${plata(totalPagado(d.pagos), x.moneda)} pagado el ${fechaCorta(ultimo.fecha)}` : " · con comprobante";
      plan.pagosDespues.push({ id: x.id, nombre: `${nombre} · ${mesTexto(x.periodo)}${pago}` });
    } else {
      plan.filas.push(x.id);
      if (!x.fijoId) plan.sueltos.push(nombre);
    }
  }
  for (const b of r.borrados) {
    if (fijos.some((x) => x.id === b.fijo.id)) continue;
    if (!hayLugar(b.fijo.lugarId)) (plan.quedan.push({ nombre: abrirFijo(b.fijo.datosCifrados).nombre, motivo: "no vuelve: su lugar ya no existe", sigue: true }), plan.restan.borrados.push(b));
    else plan.borrados.push(b);
  }
  return plan;
}

/** Lo que va a pasar si la deshacés, para confirmarlo antes. */
export async function verDeshacer(id: number) {
  const c = await obtenerCarga(id);
  const p = await armarPlan(c);
  return {
    borra: [...p.creados.map((x) => x.nombre), ...p.sueltos.map((n) => `${n} (pago suelto)`)],
    pagosDespues: p.pagosDespues,
    vuelve: p.cambiados.map((f) => abrirFijo(f.datosCifrados).nombre),
    recrea: p.borrados.map((b) => abrirFijo(b.fijo.datosCifrados).nombre),
    montos: p.meses.map((f) => `${abrirMes(f.datosCifrados).nombre} · ${mesTexto(f.periodo)}`),
    quedan: p.quedan,
    lugares: p.lugares.map((l) => l.nombre),
    categorias: p.categorias,
    reconstruida: c.reconstruida,
  };
}

/** borrarPagos: los pagos que registraste después (de pagosDespues) que elegiste borrar también. */
async function ejecutar(p: Plan, borrarPagos: number[] = []) {
  const forma = (id: number | null) => (id && p.formas.has(id) ? id : null);
  for (const antes of p.meses) {
    await db
      .update(pagoMes)
      .set({
        estado: antes.estado,
        mesPago: antes.mesPago,
        pagadoEn: antes.pagadoEn,
        formaId: forma(antes.formaId),
        vence: antes.vence,
        avisoPrevioEnviado: antes.avisoPrevioEnviado,
        avisoDiaEnviado: antes.avisoDiaEnviado,
        datosCifrados: antes.datosCifrados,
        actualizadoEn: new Date(),
      })
      .where(eq(pagoMes.id, antes.id));
    if (antes.tarjetaId) await marcarPago(antes.tarjetaId, totalPagado(abrirMes(antes.datosCifrados).pagos));
  }
  for (const antes of p.cambiados) await actualizarFijo(antes.id, entradaDe(antes, p.formas));
  const filas = [...p.filas, ...p.pagosDespues.filter((x) => borrarPagos.includes(x.id)).map((x) => x.id)];
  for (const f of await db.select().from(pagoMes).where(inArray(pagoMes.id, filas))) await borrarFila(f);
  // Lo que quedó en el historial pasa a no tener concepto.
  if (p.creados.length) await db.delete(pagoFijo).where(inArray(pagoFijo.id, p.creados.map((c) => c.id)));
  for (const b of p.borrados) {
    await asegurarCategoria(b.fijo.categoria);
    await db.insert(pagoFijo).values({ ...b.fijo, formaId: forma(b.fijo.formaId), creadoEn: new Date(b.fijo.creadoEn), actualizadoEn: new Date() });
    if (b.filas.length)
      await db
        .insert(pagoMes)
        .values(b.filas.map((f) => ({ ...f, formaId: forma(f.formaId), comprobante: null, comprobanteMime: null, creadoEn: new Date(f.creadoEn), actualizadoEn: new Date() })))
        .onConflictDoNothing();
    if (b.historial.length) await db.update(pagoMes).set({ fijoId: b.fijo.id }).where(and(inArray(pagoMes.id, b.historial), isNull(pagoMes.fijoId)));
  }
  // Los lugares y categorías que creó, si ya no los usa nada.
  for (const l of p.lugares) await borrarLugar(l.id).catch(siQueda);
  const categorias = await db.select().from(pagoCategoria);
  for (const nombre of p.categorias) {
    const c = categorias.find((x) => x.nombre === nombre);
    if (c) await borrarCategoria(c.id).catch(siQueda);
  }
  bus.avisar("pagos");
}

/**
 * Deshace todo lo que hizo la carga. Si algo no vuelve atrás (lo cambiaste después), la carga queda en la lista como
 * «deshecha en parte», con lo que quedó; si no, se borra.
 */
export async function deshacerCarga(id: number, borrarPagos: number[] = []) {
  const c = await obtenerCarga(id);
  const p = await armarPlan(c);
  await ejecutar(p, borrarPagos);
  const quedan = p.quedan.filter((q) => q.sigue);
  if (!quedan.length) return borrarCarga(c);
  await db
    .update(pagoCarga)
    .set({
      estado: "parcial",
      registro: { ...vacio(), ...p.restan, huellas: c.registro?.huellas },
      datosCifrados: sellar({ texto: abrirCarga(c.datosCifrados).texto, lineas: quedan.map((q) => ({ tipo: "queda" as const, nombre: q.nombre, detalle: q.motivo })) } satisfies DatosCarga),
    })
    .where(eq(pagoCarga.id, c.id));
  bus.avisar("pagos");
}

// ───────────── Corregir ─────────────

/** Para corregir hace falta que no hayas tocado nada de la carga después (si no, se pisaría). */
async function planParaCorregir(c: typeof pagoCarga.$inferSelect) {
  if (c.reconstruida) throw new ErrorUsuario("Esta carga se reconstruyó con lo que se creó junto: solo se puede deshacer.");
  if (c.estado === "parcial") throw new ErrorUsuario("Esta carga ya se deshizo en parte: no se puede corregir.");
  const p = await armarPlan(c);
  const tocadas = [...p.quedan.map((q) => q.nombre), ...p.editadosDespues, ...p.pagosDespues.map((x) => x.nombre)];
  if (tocadas.length) throw new ErrorUsuario(`Después de esta carga tocaste cosas que hizo (${tocadas.join(", ")}): deshacela o corregí cada concepto desde su ficha.`);
  return p;
}

/** Lo que aplicó una carga de antes de la IA general (conceptos o montos de un mes), armado como una carga general. */
async function propuestaVieja(c: typeof pagoCarga.$inferSelect, p: Plan): Promise<CargaPropuesta> {
  const r = c.registro ?? vacio();
  const [fijos, filas] = await Promise.all([
    db.select().from(pagoFijo).where(inArray(pagoFijo.id, [...r.creados.map((x) => x.id), ...r.cambiados.map((f) => f.id)])),
    db
      .select()
      .from(pagoMes)
      .where(or(inArray(pagoMes.id, r.meses.map((m) => m.antes.id)), and(inArray(pagoMes.fijoId, r.creados.map((x) => x.id)), eq(pagoMes.periodo, c.periodo ?? "")))),
  ]);
  // Un concepto en un lugar que creó la carga vuelve con ese lugar como nuevo (al corregir se vuelve a crear).
  const propuesta = (f: FilaFijo): FijoPropuesto => {
    const { desde: _, ...e } = entradaDe(f, p.formas);
    const nuevo = p.lugares.find((l) => l.id === f.lugarId);
    return nuevo ? { ...e, lugarId: null, lugarNuevo: { nombre: nuevo.nombre, tipo: nuevo.tipo } } : e;
  };
  const pagadoEl = (fila: FilaMes | undefined) => {
    const fecha = fila && abrirMes(fila.datosCifrados).pagos.at(-1)?.fecha;
    return fecha ? { fechaPago: fecha } : {};
  };
  return {
    nuevos: r.creados.flatMap((x) => {
      const f = fijos.find((y) => y.id === x.id);
      return f ? [{ ...propuesta(f), ref: `n${x.id}`, desde: f.desde }] : [];
    }),
    cambios: r.cambiados.flatMap((antes) => {
      const f = fijos.find((y) => y.id === antes.id);
      return f ? [{ ...propuesta(f), id: f.id }] : [];
    }),
    borrar: r.borrados.map((b) => b.fijo.id),
    montos: [
      ...r.meses.flatMap(({ antes, pagadoCon }) => {
        const fila = filas.find((f) => f.id === antes.id);
        if (!fila) return [];
        return [{ ...(fila.fijoId ? { fijoId: fila.fijoId } : { itemId: fila.id }), mes: fila.periodo, monto: montoDe(fila.datosCifrados), ...(pagadoCon ? { pagadoCon, ...pagadoEl(fila) } : {}) }];
      }),
      ...r.creados.flatMap((x) => {
        const f = fijos.find((y) => y.id === x.id);
        if (!x.pagadoCon || !f || !c.periodo) return [];
        return [{ ref: `n${x.id}`, mes: c.periodo, monto: abrirFijo(f.datosCifrados).monto, pagadoCon: x.pagadoCon, ...pagadoEl(filas.find((y) => y.fijoId === x.id)) }];
      }),
    ],
    sueltos: [],
  };
}

/**
 * Lo que aplicó la carga, como lo muestra la revisión de la IA, para corregirlo: lo propuesto tal cual, con cómo estaba
 * cada concepto que cambió, los que borró y, de cada monto, a qué pago va y lo que tenía antes.
 */
export async function paraCorregir(id: number) {
  const c = await obtenerCarga(id);
  const p = await planParaCorregir(c);
  const r = c.registro ?? vacio();
  const propuesta = abrirCarga(c.datosCifrados).propuesta ?? (await propuestaVieja(c, p));
  const [lugares, fijos] = await Promise.all([
    db.select().from(pagoLugar),
    db.select().from(pagoFijo).where(inArray(pagoFijo.id, propuesta.montos.flatMap((m) => ("fijoId" in m ? [m.fijoId] : [])))),
  ]);
  const comoFijoPago = (f: FilaGuardada<FilaFijo>) => {
    const e = entradaDe(f, p.formas);
    return { ...e, id: f.id, desde: f.desde, estimado: e.monto };
  };
  const montos = propuesta.montos.map((m) => {
    const antes = r.meses.find((x) => ("itemId" in m ? x.antes.id === m.itemId : "fijoId" in m && x.antes.fijoId === m.fijoId && x.antes.periodo === m.mes))?.antes;
    const fijo = "fijoId" in m ? fijos.find((f) => f.id === m.fijoId) : undefined;
    const nuevo = "ref" in m ? propuesta.nuevos.find((n) => n.ref === m.ref) : undefined;
    const info = fijo
      ? { nombre: abrirFijo(fijo.datosCifrados).nombre, lugar: dondeVa(fijo, lugares) }
      : nuevo
        ? { nombre: nuevo.nombre, lugar: nuevo.lugarNuevo?.nombre ?? dondeVa(nuevo, lugares) }
        : { nombre: antes ? abrirMes(antes.datosCifrados).nombre : "Pago borrado", lugar: antes ? dondeVa(antes, lugares) : "" };
    return { ...m, ...info, antes: antes ? montoDe(antes.datosCifrados) : null, pagado: antes?.estado === "pagado" };
  });
  return {
    id: c.id,
    propios: r.creados.map((x) => x.id),
    nuevos: propuesta.nuevos,
    cambios: propuesta.cambios.flatMap((e) => {
      const antes = r.cambiados.find((x) => x.id === e.id);
      return antes ? [{ antes: comoFijoPago(antes), despues: e }] : [];
    }),
    borrar: r.borrados.map((b) => comoFijoPago(b.fijo)),
    montos,
    sueltos: propuesta.sueltos,
  };
}

/** Corregir: se deshace lo que hizo y se aplica lo corregido, en la misma carga (con lo que le pasaste a la IA). */
export async function corregirCarga(id: number, nueva: CargaPropuesta) {
  const c = await obtenerCarga(id);
  revisar(nueva);
  await ejecutar(await planParaCorregir(c));
  return aplicarCarga(nueva, id);
}
