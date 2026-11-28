import { and, desc, eq, inArray, isNotNull, isNull, lt, or } from "drizzle-orm";
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
  pendientesDesdeHoy,
  prepararCorresponde,
  registrarPago,
  type Alcance,
  type EntradaFijo,
} from "./pagos.js";
import { nombreMes, totalPagado } from "./pagos-reglas.js";
import { ErrorUsuario } from "./recordatorios.js";
import { marcarPago } from "./tarjetas.js";

// Las cargas con IA de Pagos: cada vez que aplicás lo que propuso la IA (los conceptos de Configuración o los montos
// de un mes) queda lo que le pasaste, lo que hizo y cómo estaba todo antes, para verlo, deshacerlo entero o
// corregirlo. Lo que tocaste a mano después de la carga queda como lo dejaste.

type FilaFijo = typeof pagoFijo.$inferSelect;
type FilaMes = typeof pagoMes.$inferSelect;
type Lugar = typeof pagoLugar.$inferSelect;
type TipoCarga = "config" | "mes";

/** Un renglón de lo que hizo una carga. fijoId: el concepto, para abrirlo (si sigue estando). */
export type LineaCarga = { tipo: "nuevo" | "cambio" | "borrar" | "monto" | "lugar" | "categoria"; nombre: string; detalle: string; fijoId?: number };
type DatosCarga = { texto: string; lineas: LineaCarga[] };

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
/** Cómo está un concepto (sin la categoría: renombrarla no es tocarlo). */
const huellaFijo = (f: FilaFijo) => JSON.stringify([f.lugarId, f.alcance, f.tipo, f.reparto, f.frecuencia, f.dia, f.desde, f.desfase, f.moneda, f.variable, f.formaId, f.avisoDias, abrirFijo(f.datosCifrados)]);
const huellaMes = (f: FilaMes) => JSON.stringify([f.estado, f.formaId, f.pagadoEn, f.mesPago, f.vence, f.comprobante, abrirMes(f.datosCifrados)]);

/** Si no es un error para mostrarte (algo que quedó en uso, por ejemplo), sigue de largo. */
const siQueda = (e: unknown) => {
  if (!(e instanceof ErrorUsuario)) throw e;
};

function dondeVa(f: Alcance, lugares: Lugar[]) {
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

/** Antes de tocar nada se revisa todo lo propuesto (así no queda a medias). */
function validarPropuestos(lista: FijoPropuesto[]) {
  for (const e of lista) {
    if (!e.nombre.trim()) throw new ErrorUsuario("Falta el nombre de un pago.");
    if (e.alcance === "lugar" && !e.lugarId && !e.lugarNuevo?.nombre.trim()) throw new ErrorUsuario(`Falta el lugar de «${e.nombre}».`);
    if (e.alcance !== "lugar") alcanceValido(e);
  }
}

/** Crea los lugares nuevos que nombran los pagos propuestos, una sola vez aunque los nombren varios. */
function creadorDeLugares() {
  const creados = new Map<string, number>();
  return async (e: FijoPropuesto): Promise<EntradaFijo> => {
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
async function registrando<T>(cargaId: number | undefined, tipo: TipoCarga, periodo: string | null, hacer: (r: RegistroCarga) => Promise<T>): Promise<T> {
  const antes = await idsActuales();
  const r = vacio();
  try {
    return await hacer(r);
  } finally {
    const ahora = await idsActuales();
    r.lugares = ahora.lugares.filter((l) => !antes.lugares.some((x) => x.id === l.id)).map((l) => l.id);
    r.categorias = ahora.categorias.filter((c) => !antes.categorias.some((x) => x.id === c.id)).map((c) => c.nombre);
    r.huellas = await huellasDe(r);
    await guardarRegistro(cargaId, tipo, periodo, r);
  }
}

/** Cómo quedó todo lo que tocó: los conceptos que creó y cambió, sus pagos y los pagos del mes. */
async function huellasDe(r: RegistroCarga) {
  const idsCreados = r.creados.map((c) => c.id);
  const [fijos, filas] = await Promise.all([
    db.select().from(pagoFijo).where(inArray(pagoFijo.id, [...idsCreados, ...r.cambiados.map((f) => f.id)])),
    db.select().from(pagoMes).where(or(inArray(pagoMes.fijoId, idsCreados), inArray(pagoMes.id, r.meses.map((m) => m.antes.id)))),
  ]);
  return Object.fromEntries([...fijos.map((f) => [`f:${f.id}`, huellaFijo(f)]), ...filas.map((f) => [`m:${f.id}`, huellaMes(f)])]);
}

async function guardarRegistro(cargaId: number | undefined, tipo: TipoCarga, periodo: string | null, r: RegistroCarga) {
  const [previa] = cargaId ? await db.select().from(pagoCarga).where(eq(pagoCarga.id, cargaId)) : [];
  const hizoAlgo = [r.lugares, r.categorias, r.creados, r.cambiados, r.borrados, r.meses].some((lista) => lista.length);
  // Sin nada hecho: una lectura queda para volver a intentar; una carga corregida a nada, ya no está.
  if (!hizoAlgo) {
    if (previa?.estado === "aplicada") await borrarCarga(previa);
    return;
  }
  const valores = {
    tipo,
    periodo,
    estado: "aplicada" as const,
    reconstruida: false,
    registro: r,
    datosCifrados: sellar({ texto: previa ? abrirCarga(previa.datosCifrados).texto : "", lineas: await lineasDe(r) } satisfies DatosCarga),
    aplicadaEn: new Date(),
  };
  if (previa) await db.update(pagoCarga).set(valores).where(eq(pagoCarga.id, previa.id));
  else await db.insert(pagoCarga).values(valores);
  bus.avisar("pagos");
}

/** Lo que propuso la IA y revisaste: agrega, cambia y borra. cargaId: la lectura de la IA (con lo que le pasaste). */
export async function aplicarFijos(c: { nuevos: FijoPropuesto[]; cambios: (FijoPropuesto & { id: number })[]; borrar: number[] }, cargaId?: number) {
  validarPropuestos([...c.nuevos, ...c.cambios]);
  const ids = [...c.cambios.map((e) => e.id), ...c.borrar];
  if (ids.length) {
    const hay = new Set((await db.select({ id: pagoFijo.id }).from(pagoFijo).where(inArray(pagoFijo.id, ids))).map((f) => f.id));
    if (ids.some((id) => !hay.has(id))) throw new ErrorUsuario("Algún pago ya no existe: volvé a armar los cambios.");
  }
  return registrando(cargaId, "config", c.nuevos[0]?.desde ?? null, async (r) => {
    const conLugar = creadorDeLugares();
    for (const e of c.nuevos) r.creados.push({ id: (await crearFijo(await conLugar(e))).id });
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
    return { creados: c.nuevos.length, cambiados: c.cambios.length, borrados: c.borrar.length };
  });
}

/**
 * Un monto del mes: al pago de un concepto de todos los meses (fijoId) o a un pago puntual del mes (itemId).
 * pagadoCon: ya está pagado con esa forma (por ejemplo «Lo pagó: Contadora»).
 */
export type MontoDelMes = ({ fijoId: number } | { itemId: number }) & { monto: number; pagadoCon?: number };

/**
 * Los montos que corresponden a un mes, que leyó la IA (el resumen de la contadora, por ejemplo) y revisaste: cada
 * monto va al pago que corresponde a ese mes (aunque se pague el siguiente), y lo que no estaba se crea como pago fijo
 * desde ese mes, con ese monto. Lo que ya está pagado queda pagado en fechaPago (de entrada, hoy).
 */
export async function aplicarMes(periodo: string, c: { montos: MontoDelMes[]; nuevos: (FijoPropuesto & { pagadoCon?: number })[]; fechaPago?: string }, cargaId?: number) {
  validarPropuestos(c.nuevos);
  return registrando(cargaId, "mes", periodo, async (r) => {
    const conLugar = creadorDeLugares();
    const creados: MontoDelMes[] = [];
    for (const e of c.nuevos) {
      const { id } = await crearFijo({ ...(await conLugar(e)), desde: periodo });
      r.creados.push({ id, ...(e.pagadoCon ? { pagadoCon: e.pagadoCon } : {}) });
      if (e.pagadoCon) creados.push({ fijoId: id, monto: e.monto, pagadoCon: e.pagadoCon });
    }
    await prepararCorresponde(periodo);
    // Cada monto va al pago de ese mes: el del concepto (lo de todos los meses) o, si no sale de uno, ese pago.
    const filas = await db.select().from(pagoMes).where(eq(pagoMes.periodo, periodo));
    const filaDe = (m: MontoDelMes) => {
      const fila = "fijoId" in m ? filas.find((x) => x.fijoId === m.fijoId) : filas.find((x) => x.id === m.itemId);
      if (!fila) throw new ErrorUsuario(`Un pago elegido no está en ${nombreMes(periodo).toLowerCase()} (no se paga ese mes o ya no existe): revisalo.`);
      return fila;
    };
    const destinos = c.montos.map((m) => ({ fila: filaDe(m), monto: m.monto, pagadoCon: m.pagadoCon }));
    for (const d of destinos) {
      if (r.meses.some((m) => m.antes.id === d.fila.id)) continue;
      r.meses.push({ antes: guardar(d.fila), ...(d.pagadoCon && d.fila.estado !== "pagado" ? { pagadoCon: d.pagadoCon } : {}) });
    }
    for (const d of destinos) await actualizarPagoDelMes(d.fila.id, { monto: d.monto });
    // Lo que ya está pagado (por la contadora, por ejemplo) queda pagado con esa forma.
    for (const d of [...destinos, ...creados.map((m) => ({ fila: filaDe(m), pagadoCon: m.pagadoCon }))])
      if (d.pagadoCon && d.fila.estado !== "pagado") await registrarPago(d.fila.id, { formaId: d.pagadoCon, ...(c.fechaPago ? { fecha: c.fechaPago } : {}) });
    return { cambiados: destinos.length, creados: c.nuevos.length };
  });
}

// ───────────── Lo que le pasaste a la IA ─────────────

/**
 * Lo que leyó la IA, antes de aplicarlo: lo que escribiste y el archivo (la foto como la leyó, el PDF tal cual).
 * Devuelve el id que va con lo que aplicás.
 */
export async function crearBorrador(tipo: TipoCarga, periodo: string | null, texto: string, archivo?: { datos: Buffer; mime: string }) {
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
    .values({ tipo, periodo, datosCifrados: sellar({ texto: texto.trim(), lineas: [] } satisfies DatosCarga), archivo: guardado?.nombre, archivoMime: guardado?.mime })
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

/** El detalle de lo que hizo, con los nombres de ese momento (se calcula al aplicar y se guarda). */
async function lineasDe(r: RegistroCarga): Promise<LineaCarga[]> {
  const idsFijos = [...r.creados.map((c) => c.id), ...r.cambiados.map((f) => f.id)];
  const [fijos, lugares, listaFormas, filas] = await Promise.all([
    idsFijos.length ? db.select().from(pagoFijo).where(inArray(pagoFijo.id, idsFijos)) : [],
    db.select().from(pagoLugar),
    db.select().from(pagoForma),
    r.meses.length ? db.select().from(pagoMes).where(inArray(pagoMes.id, r.meses.map((m) => m.antes.id))) : [],
  ]);
  const formas = new Map(listaFormas.map((f) => [f.id, f.nombre]));
  const pagadoCon = (id?: number) => (id ? `pagado con ${formas.get(id) ?? "una forma borrada"}` : "");
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
      const detalle = [dondeVa(f, lugares), f.categoria, d.monto ? plata(d.monto, f.moneda) : "sin monto", pagadoCon(c.pagadoCon)].filter(Boolean).join(" · ");
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
      const detalle = [mesTexto(m.antes.periodo), dondeVa(m.antes, lugares), monto, pagadoCon(m.pagadoCon)].filter(Boolean).join(" · ");
      return { tipo: "monto" as const, nombre: abrirMes(m.antes.datosCifrados).nombre, detalle, ...(m.antes.fijoId ? { fijoId: m.antes.fijoId } : {}) };
    }),
  ];
}

/** Las cargas aplicadas, de la más nueva a la más vieja. */
export async function listarCargas() {
  const filas = await db.select().from(pagoCarga).where(eq(pagoCarga.estado, "aplicada")).orderBy(desc(pagoCarga.aplicadaEn), desc(pagoCarga.id));
  return Promise.all(
    filas.map(async (c) => {
      const d = abrirCarga(c.datosCifrados);
      return {
        id: c.id,
        tipo: c.tipo,
        periodo: c.periodo,
        reconstruida: c.reconstruida,
        aplicadaEn: c.aplicadaEn,
        texto: d.texto,
        archivo: c.archivo ? c.archivoMime : null,
        // Las de antes del registro no guardaron el detalle: se arma con lo que sigue estando.
        lineas: c.reconstruida ? await lineasDe(c.registro ?? vacio()) : d.lineas,
      };
    }),
  );
}

async function obtenerCarga(id: number) {
  const [c] = await db.select().from(pagoCarga).where(and(eq(pagoCarga.id, id), eq(pagoCarga.estado, "aplicada")));
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

type Quedan = { nombre: string; motivo: string }[];
/** Lo que se va a hacer al deshacer: con ids para hacerlo y con nombres para mostrarlo antes. */
type Plan = {
  meses: FilaGuardada<FilaMes>[];
  cambiados: FilaGuardada<FilaFijo>[];
  creados: { id: number; nombre: string; filas: number[] }[];
  borrados: RegistroCarga["borrados"];
  quedan: Quedan;
  lugares: Lugar[];
  categorias: string[];
  formas: Set<number>;
};

async function armarPlan(c: typeof pagoCarga.$inferSelect): Promise<Plan> {
  const r = c.registro ?? vacio();
  // Lo tocado después: lo que no quedó como lo dejó la carga (o, en las reconstruidas, lo cambiado después de aplicarla).
  const limite = (c.aplicadaEn?.getTime() ?? 0) + MARGEN_MS;
  const porFecha = (x: { actualizadoEn: Date }) => x.actualizadoEn.getTime() > limite;
  const fijoTocado = (f: FilaFijo) => (r.huellas ? r.huellas[`f:${f.id}`] !== huellaFijo(f) : porFecha(f));
  /** Un pago que no existía al aplicar (un mes que se armó después) es todo tuyo. */
  const filaTocada = (f: FilaMes) => (r.huellas ? r.huellas[`m:${f.id}`] !== huellaMes(f) : porFecha(f));
  const idsCreados = r.creados.map((x) => x.id);
  const idsFijos = [...idsCreados, ...r.cambiados.map((f) => f.id), ...r.borrados.map((b) => b.fijo.id)];
  const [fijos, filasCreados, filasMeses, lugares, formas] = await Promise.all([
    idsFijos.length ? db.select().from(pagoFijo).where(inArray(pagoFijo.id, idsFijos)) : [],
    idsCreados.length ? db.select().from(pagoMes).where(inArray(pagoMes.fijoId, idsCreados)) : [],
    r.meses.length ? db.select().from(pagoMes).where(inArray(pagoMes.id, r.meses.map((m) => m.antes.id))) : [],
    db.select().from(pagoLugar),
    db.select({ id: pagoForma.id }).from(pagoForma),
  ]);
  const hayLugar = (id: number | null) => !id || lugares.some((l) => l.id === id);
  const plan: Plan = { meses: [], cambiados: [], creados: [], borrados: [], quedan: [], lugares: lugares.filter((l) => r.lugares.includes(l.id)), categorias: r.categorias, formas: new Set(formas.map((f) => f.id)) };

  // Los pagos del mes que tocó (los de los conceptos que creó se van con el concepto).
  for (const { antes } of r.meses) {
    if (antes.fijoId && idsCreados.includes(antes.fijoId)) continue;
    const fila = filasMeses.find((x) => x.id === antes.id);
    const nombre = `${abrirMes(antes.datosCifrados).nombre} · ${mesTexto(antes.periodo)}`;
    if (!fila) plan.quedan.push({ nombre, motivo: "lo borraste después" });
    else if (filaTocada(fila)) plan.quedan.push({ nombre, motivo: "lo cambiaste o pagaste después" });
    else plan.meses.push(antes);
  }
  for (const antes of r.cambiados) {
    const f = fijos.find((x) => x.id === antes.id);
    const nombre = abrirFijo(antes.datosCifrados).nombre;
    if (!f) plan.quedan.push({ nombre, motivo: "lo borraste después" });
    else if (fijoTocado(f)) plan.quedan.push({ nombre, motivo: "lo cambiaste después" });
    else if (!hayLugar(antes.lugarId)) plan.quedan.push({ nombre, motivo: "el lugar donde estaba ya no existe" });
    else plan.cambiados.push(antes);
  }
  for (const { id } of r.creados) {
    const f = fijos.find((x) => x.id === id);
    if (!f) continue;
    const nombre = abrirFijo(f.datosCifrados).nombre;
    if (fijoTocado(f)) {
      plan.quedan.push({ nombre, motivo: "lo cambiaste después" });
      continue;
    }
    // Lo que pagaste vos después queda en el historial (sin el concepto); lo demás se va con él.
    const filas = filasCreados.filter((x) => x.fijoId === id);
    const pagadas = filas.filter((x) => filaTocada(x) && (!!x.comprobante || abrirMes(x.datosCifrados).pagos.length > 0));
    for (const x of pagadas) plan.quedan.push({ nombre: `${nombre} · ${mesTexto(x.periodo)}`, motivo: "lo pagaste después: queda en el historial" });
    plan.creados.push({ id, nombre, filas: filas.filter((x) => !pagadas.includes(x)).map((x) => x.id) });
  }
  for (const b of r.borrados) {
    if (fijos.some((x) => x.id === b.fijo.id)) continue;
    if (!hayLugar(b.fijo.lugarId)) plan.quedan.push({ nombre: abrirFijo(b.fijo.datosCifrados).nombre, motivo: "no vuelve: su lugar ya no existe" });
    else plan.borrados.push(b);
  }
  return plan;
}

/** Lo que va a pasar si la deshacés, para confirmarlo antes. */
export async function verDeshacer(id: number) {
  const c = await obtenerCarga(id);
  const p = await armarPlan(c);
  return {
    borra: p.creados.map((x) => x.nombre),
    vuelve: p.cambiados.map((f) => abrirFijo(f.datosCifrados).nombre),
    recrea: p.borrados.map((b) => abrirFijo(b.fijo.datosCifrados).nombre),
    montos: p.meses.map((f) => `${abrirMes(f.datosCifrados).nombre} · ${mesTexto(f.periodo)}`),
    quedan: p.quedan,
    lugares: p.lugares.map((l) => l.nombre),
    categorias: p.categorias,
    reconstruida: c.reconstruida,
  };
}

async function ejecutar(p: Plan) {
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
  for (const c of p.creados) {
    if (c.filas.length) for (const f of await db.select().from(pagoMes).where(inArray(pagoMes.id, c.filas))) await borrarFila(f);
    // Lo que quedó en el historial pasa a no tener concepto.
    await db.delete(pagoFijo).where(eq(pagoFijo.id, c.id));
  }
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

/** Deshace todo lo que hizo la carga (menos lo que tocaste después) y la borra. */
export async function deshacerCarga(id: number) {
  const c = await obtenerCarga(id);
  await ejecutar(await armarPlan(c));
  await borrarCarga(c);
}

// ───────────── Corregir ─────────────

/** Para corregir hace falta que no hayas tocado nada de la carga después (si no, se pisaría). */
async function planParaCorregir(c: typeof pagoCarga.$inferSelect) {
  if (c.reconstruida) throw new ErrorUsuario("Esta carga es de antes de que se guardaran: solo se puede deshacer.");
  const p = await armarPlan(c);
  if (p.quedan.length)
    throw new ErrorUsuario(`Después de esta carga tocaste cosas que hizo (${p.quedan.map((q) => q.nombre).join(", ")}): deshacela o corregí cada concepto desde su ficha.`);
  return p;
}

/**
 * Lo que hizo la carga, como lo muestra la revisión de la IA, para corregirlo: los conceptos que creó y cambió como
 * están ahora (los de un lugar que creó la carga vuelven a traer ese lugar como nuevo), los que borró y los montos.
 */
export async function paraCorregir(id: number) {
  const c = await obtenerCarga(id);
  const p = await planParaCorregir(c);
  const r = c.registro ?? vacio();
  const idsCreados = r.creados.map((x) => x.id);
  const [fijos, filas] = await Promise.all([
    db.select().from(pagoFijo).where(inArray(pagoFijo.id, [...idsCreados, ...r.cambiados.map((f) => f.id)])),
    db.select().from(pagoMes).where(inArray(pagoMes.id, r.meses.map((m) => m.antes.id))),
  ]);
  const propuesta = (f: FilaFijo): FijoPropuesto => {
    const { desde: _, ...e } = entradaDe(f, p.formas);
    const nuevo = p.lugares.find((l) => l.id === f.lugarId);
    return nuevo ? { ...e, lugarId: null, lugarNuevo: { nombre: nuevo.nombre, tipo: nuevo.tipo } } : e;
  };
  const comoFijoPago = (f: FilaGuardada<FilaFijo>) => {
    const e = entradaDe(f, p.formas);
    return { ...e, id: f.id, desde: f.desde, estimado: e.monto };
  };
  const creados = r.creados.flatMap((x) => {
    const f = fijos.find((y) => y.id === x.id);
    return f ? [{ ...propuesta(f), ...(x.pagadoCon ? { pagadoCon: x.pagadoCon } : {}) }] : [];
  });
  const base = { id: c.id, tipo: c.tipo, periodo: c.periodo, propios: idsCreados };
  if (c.tipo === "config")
    return {
      ...base,
      nuevos: creados,
      cambios: r.cambiados.map((antes) => ({ antes: comoFijoPago(antes), despues: propuesta(fijos.find((f) => f.id === antes.id)!) })),
      borrar: r.borrados.map((b) => comoFijoPago(b.fijo)),
      montos: [],
      fechaPago: null,
    };
  const lugares = await db.select().from(pagoLugar);
  const montos = r.meses.flatMap(({ antes, pagadoCon }) => {
    const fila = filas.find((f) => f.id === antes.id);
    if (!fila || (antes.fijoId && idsCreados.includes(antes.fijoId))) return [];
    const destino = fila.fijoId ? { fijoId: fila.fijoId } : { itemId: fila.id };
    return [{ ...destino, monto: montoDe(fila.datosCifrados), antes: montoDe(antes.datosCifrados), nombre: abrirMes(fila.datosCifrados).nombre, lugar: dondeVa(fila, lugares), pagado: antes.estado === "pagado", ...(pagadoCon ? { pagadoCon } : {}) }];
  });
  // La fecha en que quedó pagado lo que la carga dejó pagado («Ya lo pagó: …»).
  const pagadas = await db
    .select()
    .from(pagoMes)
    .where(
      or(
        inArray(pagoMes.id, r.meses.filter((m) => m.pagadoCon).map((m) => m.antes.id)),
        and(inArray(pagoMes.fijoId, r.creados.filter((x) => x.pagadoCon).map((x) => x.id)), eq(pagoMes.periodo, c.periodo ?? "")),
      ),
    );
  const fechaPago = pagadas.map((f) => abrirMes(f.datosCifrados).pagos.at(-1)?.fecha).find(Boolean) ?? null;
  return { ...base, nuevos: creados, cambios: [], borrar: [], montos, fechaPago };
}

/** Corregir: se deshace lo que hizo y se aplica lo corregido, en la misma carga (con lo que le pasaste a la IA). */
export async function corregirCarga(id: number, nueva: Parameters<typeof aplicarFijos>[0] | ({ periodo: string } & Parameters<typeof aplicarMes>[1])) {
  const c = await obtenerCarga(id);
  if ("periodo" in nueva !== (c.tipo === "mes")) throw new ErrorUsuario("Lo corregido no es de esta carga: volvé a abrirla.");
  validarPropuestos([...nueva.nuevos, ...("cambios" in nueva ? nueva.cambios : [])]);
  await ejecutar(await planParaCorregir(c));
  return "periodo" in nueva ? aplicarMes(nueva.periodo, nueva, id) : aplicarFijos(nueva, id);
}
