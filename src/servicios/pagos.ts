import { and, asc, count, desc, eq, gte, inArray, isNotNull, lt, lte, ne, or, sql, type SQL } from "drizzle-orm";
import { DateTime } from "luxon";
import { db } from "../db/index.js";
import {
  pagoAnalisis,
  pagoFijo,
  pagoForma,
  pagoLugar,
  pagoMes,
  suscripcion,
  tarjeta,
  type AlcancePago,
  type FrecuenciaPago,
  type PagoMes,
  type RepartoPago,
  type Suscripcion,
  type TipoLugar,
} from "../db/schema.js";
import { abrir, cifrar, descifrar, sellar } from "../lib/cifrado.js";
import { bus } from "../lib/eventos.js";
import { hoyIso } from "../lib/fechas.js";
import { normalizar, plata } from "../lib/textos.js";
import { almacenCifrado, comoWebp } from "./archivos-cifrados.js";
import { actualizarConfig, obtenerConfig } from "./configuracion.js";
import { asegurarCategoria } from "./pagos-categorias.js";
import { formaActiva, formaDeTarjeta } from "./pagos-formas.js";
import {
  aCsv,
  alertasDelMes,
  errorDeReparto,
  esperadoDe,
  estadoDe,
  nombreMes,
  periodoDe,
  repartir,
  sumarMeses,
  tocaEnMes,
  totalPagado,
  venceEn,
  type FilaCsv,
  type Moneda,
  type ParteDePago,
} from "./pagos-reglas.js";
import { ErrorUsuario } from "./recordatorios.js";
import { PERIODOS, renovarSuscripcion } from "./suscripciones.js";
import { marcarPago } from "./tarjetas.js";

// Pagos: lugares (locales, casa…), lo que se paga siempre en cada uno (los fijos) y cada pago de cada mes. El mes se
// arma solo con los fijos que tocan, las suscripciones que vencen y los resúmenes de las tarjetas, sin cargarlos dos
// veces; se suman los pagos sueltos.

type DatosFijo = { nombre: string; monto: number; cuenta: string; nota: string };
type DatosMes = { nombre: string; esperado: number; boleta: number | null; pagos: ParteDePago[]; cuenta: string; nota: string };

const ILEGIBLE = "(no se pudo descifrar)";
const abrirFijo = (c: string) => abrir<DatosFijo>(c, { nombre: ILEGIBLE, monto: 0, cuenta: "", nota: "" });
const abrirMes = (c: string) => ({ boleta: null, pagos: [], cuenta: "", nota: "", ...abrir<Partial<DatosMes>>(c, { nombre: ILEGIBLE, esperado: 0 }) }) as DatosMes;

const comprobantes = almacenCifrado("pagos");
export const COMPROBANTE_MAX_BYTES = 15 * 1024 * 1024;

const avisar = () => bus.avisar("pagos");
const mesActual = () => periodoDe(hoyIso());

// ───────────── Lugares ─────────────

/** Los lugares, con cuántos pagos fijos tiene cada uno (también los repartidos en los que entra). */
export async function listarLugares() {
  const [lugares, fijos] = await Promise.all([
    db.select().from(pagoLugar).orderBy(asc(pagoLugar.orden), asc(pagoLugar.id)),
    db.select({ lugarId: pagoFijo.lugarId, reparto: pagoFijo.reparto }).from(pagoFijo),
  ]);
  const entra = (id: number) => fijos.filter((f) => f.lugarId === id || f.reparto?.some((r) => r.lugarId === id)).length;
  return lugares.map((l) => ({ ...l, fijos: entra(l.id) }));
}

export async function crearLugar(d: { nombre: string; tipo: TipoLugar }) {
  const nombre = d.nombre.trim();
  if (!nombre) throw new ErrorUsuario("Falta el nombre del lugar.");
  const [{ n }] = await db.select({ n: count() }).from(pagoLugar);
  const [l] = await db.insert(pagoLugar).values({ nombre, tipo: d.tipo, orden: n + 1 }).returning();
  avisar();
  return l;
}

export async function actualizarLugar(id: number, d: { nombre?: string; tipo?: TipoLugar }) {
  if (d.nombre !== undefined && !d.nombre.trim()) throw new ErrorUsuario("Falta el nombre del lugar.");
  await db
    .update(pagoLugar)
    .set({ ...(d.nombre !== undefined ? { nombre: d.nombre.trim() } : {}), ...(d.tipo ? { tipo: d.tipo } : {}) })
    .where(eq(pagoLugar.id, id));
  avisar();
}

export async function borrarLugar(id: number) {
  const enReparto = sql`@> ${JSON.stringify([{ lugarId: id }])}::jsonb`;
  const [[{ fijos }], [{ pagos }]] = await Promise.all([
    db.select({ fijos: count() }).from(pagoFijo).where(or(eq(pagoFijo.lugarId, id), sql`${pagoFijo.reparto} ${enReparto}`)),
    db.select({ pagos: count() }).from(pagoMes).where(or(eq(pagoMes.lugarId, id), sql`${pagoMes.reparto} ${enReparto}`)),
  ]);
  if (fijos || pagos) throw new ErrorUsuario("Ese lugar tiene pagos cargados: pasalos a otro lugar o borralos antes.");
  await db.delete(pagoLugar).where(eq(pagoLugar.id, id));
  avisar();
}

// ───────────── Lo que se paga siempre (los fijos) ─────────────

/** A qué corresponde: el lugar, el reparto o, si es general, de negocio o personal. */
export type Alcance = { alcance: AlcancePago; lugarId: number | null; tipo: TipoLugar | null; reparto: RepartoPago | null };

export type EntradaFijo = Alcance & {
  nombre: string;
  categoria: string;
  monto: number;
  variable: boolean;
  moneda: Moneda;
  /** null: sin vencimiento. */
  dia: number | null;
  frecuencia: FrecuenciaPago;
  desde?: string;
  /** Con qué se paga siempre; null: sin forma fija. */
  formaId: number | null;
  cuenta: string;
  avisoDias: number | null;
  nota: string;
};

/** Deja solo lo que corresponde al alcance, y frena lo que no cierra (sin lugar, reparto de un solo lugar…). */
export function alcanceValido(a: Alcance): Alcance {
  if (a.alcance === "lugar") {
    if (!a.lugarId) throw new ErrorUsuario("Elegí el lugar.");
    return { alcance: "lugar", lugarId: a.lugarId, tipo: null, reparto: null };
  }
  if (a.alcance === "repartido") {
    const error = errorDeReparto(a.reparto ?? []);
    if (error) throw new ErrorUsuario(error);
    return { alcance: "repartido", lugarId: null, tipo: null, reparto: a.reparto };
  }
  return { alcance: "general", lugarId: null, tipo: a.tipo ?? "personal", reparto: null };
}

const columnasFijo = (e: EntradaFijo) => ({
  ...alcanceValido(e),
  categoria: e.categoria,
  frecuencia: e.frecuencia,
  dia: e.dia === null ? null : Math.min(31, Math.max(1, Math.round(e.dia))),
  moneda: e.moneda,
  variable: e.variable,
  formaId: e.formaId,
  avisoDias: e.avisoDias,
  datosCifrados: sellar({ nombre: e.nombre.trim(), monto: Math.max(0, e.monto), cuenta: e.cuenta.trim(), nota: e.nota.trim() } satisfies DatosFijo),
});

export async function listarFijos() {
  const filas = await db.select().from(pagoFijo).orderBy(asc(pagoFijo.lugarId), asc(pagoFijo.dia), asc(pagoFijo.id));
  return filas.map(({ datosCifrados, ...f }) => ({ ...f, ...abrirFijo(datosCifrados) }));
}

export async function crearFijo(e: EntradaFijo) {
  if (!e.nombre.trim()) throw new ErrorUsuario("Falta el nombre del pago.");
  const categoria = await asegurarCategoria(e.categoria);
  const [f] = await db
    .insert(pagoFijo)
    .values({ ...columnasFijo({ ...e, categoria }), desde: e.desde ?? mesActual() })
    .returning({ id: pagoFijo.id });
  avisar();
  return f;
}

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

/** Lo que propuso la IA y revisaste: agrega, cambia y borra. */
export async function aplicarFijos(c: { nuevos: FijoPropuesto[]; cambios: (FijoPropuesto & { id: number })[]; borrar: number[] }) {
  validarPropuestos([...c.nuevos, ...c.cambios]);
  const ids = [...c.cambios.map((e) => e.id), ...c.borrar];
  if (ids.length) {
    const hay = new Set((await db.select({ id: pagoFijo.id }).from(pagoFijo).where(inArray(pagoFijo.id, ids))).map((f) => f.id));
    if (ids.some((id) => !hay.has(id))) throw new ErrorUsuario("Algún pago ya no existe: volvé a armar los cambios.");
  }
  const conLugar = creadorDeLugares();
  for (const e of c.nuevos) await crearFijo(await conLugar(e));
  for (const { id, ...e } of c.cambios) await actualizarFijo(id, await conLugar(e));
  for (const id of c.borrar) await borrarFijo(id);
  return { creados: c.nuevos.length, cambiados: c.cambios.length, borrados: c.borrar.length };
}

/**
 * Los montos de un mes que leyó la IA (el resumen de la contadora, por ejemplo) y revisaste: cada monto va al pago de
 * ese mes, y lo que no estaba se crea como pago fijo desde ese mes, con ese monto.
 */
/**
 * Un monto del mes: al pago de un concepto de todos los meses (fijoId) o a un pago puntual del mes (itemId).
 * pagadoCon: ya está pagado con esa forma (por ejemplo «Lo pagó: Contadora»).
 */
export type MontoDelMes = ({ fijoId: number } | { itemId: number }) & { monto: number; pagadoCon?: number };

export async function aplicarMes(periodo: string, c: { montos: MontoDelMes[]; nuevos: (FijoPropuesto & { pagadoCon?: number })[] }) {
  validarPropuestos(c.nuevos);
  const conLugar = creadorDeLugares();
  const creados: MontoDelMes[] = [];
  for (const e of c.nuevos) {
    const { id } = await crearFijo({ ...(await conLugar(e)), desde: periodo });
    if (e.pagadoCon) creados.push({ fijoId: id, monto: e.monto, pagadoCon: e.pagadoCon });
  }
  await prepararMes(periodo);
  // Cada monto va al pago de ese mes: el del concepto (lo de todos los meses) o, si no sale de uno, ese pago.
  const filas = await db.select().from(pagoMes).where(eq(pagoMes.periodo, periodo));
  const filaDe = (m: MontoDelMes) => {
    const fila = "fijoId" in m ? filas.find((r) => r.fijoId === m.fijoId) : filas.find((r) => r.id === m.itemId);
    if (!fila) throw new ErrorUsuario(`Un pago elegido no está en ${nombreMes(periodo).toLowerCase()} (no se paga ese mes o ya no existe): revisalo.`);
    return fila;
  };
  const destinos = c.montos.map((m) => ({ fila: filaDe(m), monto: m.monto, pagadoCon: m.pagadoCon }));
  for (const d of destinos) await actualizarPagoDelMes(d.fila.id, { monto: d.monto });
  // Lo que ya está pagado (por la contadora, por ejemplo) queda pagado con esa forma.
  for (const d of [...destinos, ...creados.map((m) => ({ fila: filaDe(m), pagadoCon: m.pagadoCon }))])
    if (d.pagadoCon && d.fila.estado !== "pagado") await registrarPago(d.fila.id, { formaId: d.pagadoCon });
  return { cambiados: destinos.length, creados: c.nuevos.length };
}

/**
 * Los cambios llegan a los pagos de este mes en adelante que todavía no se pagaron (con la boleta cargada, el monto
 * del mes queda); los meses que ya no tocan se sacan.
 */
export async function actualizarFijo(id: number, e: EntradaFijo) {
  if (!e.nombre.trim()) throw new ErrorUsuario("Falta el nombre del pago.");
  const categoria = await asegurarCategoria(e.categoria);
  const [f] = await db
    .update(pagoFijo)
    .set({ ...columnasFijo({ ...e, categoria }), ...(e.desde ? { desde: e.desde } : {}), actualizadoEn: new Date() })
    .where(eq(pagoFijo.id, id))
    .returning();
  if (!f) throw new ErrorUsuario("Ese pago ya no existe.");
  for (const r of await pendientesDesdeHoy(id)) {
    const d = abrirMes(r.datosCifrados);
    if (!tocaEnMes(f, r.periodo) && d.boleta === null) {
      await borrarFila(r);
      continue;
    }
    const esperado = esperadoDe({ monto: e.monto, variable: e.variable }, await montosAnteriores(id, r.periodo));
    await db
      .update(pagoMes)
      .set({
        vence: f.dia ? venceEn(f.dia, r.periodo) : null,
        lugarId: f.lugarId,
        alcance: f.alcance,
        tipo: f.tipo,
        reparto: f.reparto,
        categoria: f.categoria,
        moneda: f.moneda,
        formaId: f.formaId ?? r.formaId,
        datosCifrados: sellar({ ...d, nombre: e.nombre.trim(), cuenta: e.cuenta.trim(), esperado } satisfies DatosMes),
        actualizadoEn: new Date(),
      })
      .where(eq(pagoMes.id, r.id));
  }
  avisar();
}

/** Se borra el fijo y sus pagos de acá en adelante sin pagar; lo pagado queda en el historial. */
export async function borrarFijo(id: number) {
  for (const r of await pendientesDesdeHoy(id)) await borrarFila(r);
  await db.delete(pagoFijo).where(eq(pagoFijo.id, id));
  avisar();
}

const pendientesDesdeHoy = (fijoId: number) =>
  db
    .select()
    .from(pagoMes)
    .where(and(eq(pagoMes.fijoId, fijoId), gte(pagoMes.periodo, mesActual()), inArray(pagoMes.estado, ["pendiente", "omitido"])));

/** Lo pagado en los meses anteriores de un fijo (para sugerir el monto de los variables). */
async function montosAnteriores(fijoId: number, periodo: string): Promise<number[]> {
  const filas = await db
    .select()
    .from(pagoMes)
    .where(and(eq(pagoMes.fijoId, fijoId), lt(pagoMes.periodo, periodo), inArray(pagoMes.estado, ["pagado", "parcial"])))
    .orderBy(asc(pagoMes.periodo));
  return filas.map((r) => totalPagado(abrirMes(r.datosCifrados).pagos));
}

// ───────────── El mes ─────────────

/** El primer mes que se arma solo: el de la primera vez que se abre Pagos (antes no hay nada que inventar). */
async function primerMes(): Promise<string> {
  const cfg = await obtenerConfig();
  if (cfg.pagosDesde) return cfg.pagosDesde;
  await actualizarConfig({ pagosDesde: mesActual() });
  return mesActual();
}

/** Los vencimientos de una suscripción en ese mes (para atrás y para adelante desde el que tiene ahora). */
export function vencimientosEnMes(s: Pick<Suscripcion, "fechaVto" | "frecuencia" | "fechaInicio">, periodo: string): string[] {
  const inicio = DateTime.fromISO(`${periodo}-01`);
  const fin = inicio.endOf("month");
  const paso = PERIODOS[s.frecuencia];
  const fechas: string[] = [];
  let d = DateTime.fromISO(s.fechaVto);
  while (d > fin) d = d.minus(paso);
  for (; d >= inicio; d = d.minus(paso)) fechas.push(d.toISODate()!);
  for (d = DateTime.fromISO(s.fechaVto).plus(paso); d <= fin; d = d.plus(paso)) if (d >= inicio) fechas.push(d.toISODate()!);
  return [...new Set(fechas)].filter((f) => !s.fechaInicio || f >= s.fechaInicio).sort();
}

/** La última forma con que se pagó (el mismo fijo, suscripción o tarjeta), si sigue activa: la que se sugiere. */
async function ultimaForma(deLoMismo: SQL) {
  const [r] = await db
    .select({ id: pagoMes.formaId })
    .from(pagoMes)
    .innerJoin(pagoForma, eq(pagoForma.id, pagoMes.formaId))
    .where(and(deLoMismo, inArray(pagoMes.estado, ["pagado", "parcial"]), eq(pagoForma.archivada, false)))
    .orderBy(desc(pagoMes.periodo), desc(pagoMes.id))
    .limit(1);
  return r?.id ?? null;
}

/** Arma el mes (no repite lo que ya está) y pone al día lo que sale de las suscripciones y las tarjetas. */
export async function prepararMes(periodo: string) {
  if (periodo < (await primerMes())) return;
  const [existentes, fijos, suscripciones, tarjetas] = await Promise.all([
    db.select().from(pagoMes).where(eq(pagoMes.periodo, periodo)),
    db.select().from(pagoFijo),
    db.select().from(suscripcion),
    db.select().from(tarjeta),
  ]);
  const hoy = hoyIso();

  for (const f of fijos) {
    if (!tocaEnMes(f, periodo) || existentes.some((r) => r.fijoId === f.id)) continue;
    const d = abrirFijo(f.datosCifrados);
    await db
      .insert(pagoMes)
      .values({
        periodo,
        vence: f.dia ? venceEn(f.dia, periodo) : null,
        lugarId: f.lugarId,
        alcance: f.alcance,
        tipo: f.tipo,
        reparto: f.reparto,
        categoria: f.categoria,
        moneda: f.moneda,
        fijoId: f.id,
        formaId: f.formaId ?? (await ultimaForma(eq(pagoMes.fijoId, f.id))),
        datosCifrados: sellar({ nombre: d.nombre, esperado: esperadoDe({ monto: d.monto, variable: f.variable }, await montosAnteriores(f.id, periodo)), boleta: null, pagos: [], cuenta: d.cuenta, nota: "" } satisfies DatosMes),
      })
      .onConflictDoNothing();
  }

  // Suscripciones: lo que venció antes de su vencimiento actual ya se renovó (se pagó).
  for (const s of suscripciones) {
    for (const vence of vencimientosEnMes(s, periodo)) {
      const ya = existentes.find((r) => r.suscripcionId === s.id && r.vence === vence);
      const renovada = vence < s.fechaVto;
      if (!ya) {
        await db
          .insert(pagoMes)
          .values({
            periodo,
            vence,
            alcance: "general",
            tipo: s.negocio ? "negocio" : "personal",
            categoria: "Suscripciones",
            moneda: s.moneda,
            suscripcionId: s.id,
            formaId: (s.tarjetaId ? await formaDeTarjeta(s.tarjetaId) : null) ?? (await ultimaForma(eq(pagoMes.suscripcionId, s.id))),
            estado: renovada ? "pagado" : "pendiente",
            pagadoEn: renovada ? vence : null,
            datosCifrados: sellar({ nombre: s.nombre, esperado: s.monto, boleta: null, pagos: renovada ? [{ monto: s.monto, fecha: vence }] : [], cuenta: "", nota: "" } satisfies DatosMes),
          })
          .onConflictDoNothing();
      } else if (ya.tipo !== (s.negocio ? "negocio" : "personal")) {
        await db
          .update(pagoMes)
          .set({ tipo: s.negocio ? "negocio" : "personal" })
          .where(eq(pagoMes.id, ya.id));
      }
      if (ya && renovada && ya.estado === "pendiente") {
        const d = abrirMes(ya.datosCifrados);
        await db
          .update(pagoMes)
          .set({ estado: "pagado", pagadoEn: hoy, datosCifrados: sellar({ ...d, pagos: [{ monto: d.esperado, fecha: hoy }] }) })
          .where(eq(pagoMes.id, ya.id));
      }
    }
  }

  // Tarjetas: el resumen que vence este mes, con su saldo; si ya se marcó lo pagado en Tarjetas, queda pagado.
  for (const t of tarjetas) {
    if (!t.vencimiento || periodoDe(t.vencimiento) !== periodo) continue;
    const saldos = abrir<{ saldo: number; pagado?: number | null }>(t.datosCifrados, { saldo: 0 });
    const ya = existentes.find((r) => r.tarjetaId === t.id && r.vence === t.vencimiento);
    const pagos: ParteDePago[] = saldos.pagado != null ? [{ monto: saldos.pagado, fecha: hoy }] : [];
    if (!ya) {
      await db
        .insert(pagoMes)
        .values({
          periodo,
          vence: t.vencimiento,
          alcance: "general",
          tipo: t.negocio ? "negocio" : "personal",
          categoria: "Tarjetas",
          tarjetaId: t.id,
          formaId: await ultimaForma(eq(pagoMes.tarjetaId, t.id)),
          estado: pagos.length ? estadoDe(saldos.saldo, pagos) : "pendiente",
          pagadoEn: pagos.length ? hoy : null,
          datosCifrados: sellar({ nombre: `${t.nombre}${t.ultimos4 ? ` ···${t.ultimos4}` : ""}`, esperado: saldos.saldo, boleta: null, pagos, cuenta: "", nota: "" } satisfies DatosMes),
        })
        .onConflictDoNothing();
    } else {
      const d = abrirMes(ya.datosCifrados);
      const nuevosPagos = d.pagos.length || !pagos.length ? d.pagos : pagos;
      if (d.esperado !== saldos.saldo || nuevosPagos !== d.pagos || ya.tipo !== (t.negocio ? "negocio" : "personal"))
        await db
          .update(pagoMes)
          .set({
            tipo: t.negocio ? "negocio" : "personal",
            estado: ya.estado === "omitido" ? "omitido" : nuevosPagos.length ? estadoDe(saldos.saldo, nuevosPagos) : "pendiente",
            datosCifrados: sellar({ ...d, esperado: saldos.saldo, pagos: nuevosPagos }),
          })
          .where(eq(pagoMes.id, ya.id));
    }
  }
}

export type ItemPago = ReturnType<typeof aItem>;
type Lugar = typeof pagoLugar.$inferSelect;
/** Lo que hace falta para mostrar un pago: los lugares y el nombre de cada forma de pago. */
type Catalogos = { lugares: Lugar[]; formas: Map<number, string> };

async function catalogos(): Promise<Catalogos> {
  const [lugares, formas] = await Promise.all([db.select().from(pagoLugar).orderBy(asc(pagoLugar.orden), asc(pagoLugar.id)), db.select().from(pagoForma)]);
  return { lugares, formas: new Map(formas.map((f) => [f.id, f.nombre])) };
}

/** Lo que le toca a cada lugar: un solo lugar, cada uno con su parte si es repartido, o "General". */
export type Parte = { lugarId: number | null; lugar: string; tipo: TipoLugar; porcentaje: number; monto: number; pagado: number };

function partesDe(r: PagoMes, lugares: Lugar[], monto: number, pagado: number): Parte[] {
  if (r.alcance === "repartido" && r.reparto?.length) {
    const pagos = repartir(pagado, r.reparto);
    return repartir(monto, r.reparto).map((m, k) => {
      const l = lugares.find((x) => x.id === m.lugarId);
      return { lugarId: m.lugarId, lugar: l?.nombre ?? "Lugar borrado", tipo: l?.tipo ?? "negocio", porcentaje: m.porcentaje, monto: m.monto, pagado: pagos[k].monto };
    });
  }
  const l = r.alcance === "lugar" ? lugares.find((x) => x.id === r.lugarId) : undefined;
  if (l) return [{ lugarId: l.id, lugar: l.nombre, tipo: l.tipo, porcentaje: 100, monto, pagado }];
  return [{ lugarId: null, lugar: "General", tipo: r.tipo ?? "personal", porcentaje: 100, monto, pagado }];
}

function aItem(r: PagoMes, { lugares, formas }: Catalogos, hoy: string) {
  const d = abrirMes(r.datosCifrados);
  const monto = d.boleta ?? d.esperado;
  const pagado = totalPagado(d.pagos);
  const partes = partesDe(r, lugares, monto, pagado);
  const repartido = partes.length > 1;
  return {
    id: r.id,
    periodo: r.periodo,
    vence: r.vence,
    nombre: d.nombre,
    lugarId: r.lugarId,
    alcance: repartido ? "repartido" : partes[0].lugarId ? "lugar" : "general",
    lugar: repartido ? `Repartido · ${partes.length} ${partes.every((p) => p.tipo === "negocio") ? "locales" : "lugares"}` : partes[0].lugar,
    tipo: (partes.some((p) => p.tipo === "negocio") ? "negocio" : "personal") as TipoLugar,
    partes,
    categoria: r.categoria,
    moneda: r.moneda,
    estado: r.estado,
    monto,
    esperado: d.esperado,
    boleta: d.boleta,
    pagado,
    falta: r.estado === "omitido" ? 0 : Math.max(0, monto - pagado),
    pagos: d.pagos,
    vencido: (r.estado === "pendiente" || r.estado === "parcial") && r.vence !== null && r.vence < hoy,
    /** Pagado: con qué se pagó. Sin pagar: la que se sugiere al tocar «Pagado». */
    formaId: r.formaId,
    forma: r.formaId ? (formas.get(r.formaId) ?? null) : null,
    pagadoEn: r.pagadoEn,
    cuenta: d.cuenta,
    nota: d.nota,
    origen: r.fijoId ? "fijo" : r.suscripcionId ? "suscripcion" : r.tarjetaId ? "tarjeta" : "suelto",
    fijoId: r.fijoId,
    comprobante: r.comprobante ? (r.comprobanteMime ?? "image/webp") : null,
  };
}

const sumaPorMoneda = (items: { moneda: Moneda; valor: number }[]) => ({
  ARS: items.filter((i) => i.moneda === "ARS").reduce((s, i) => s + i.valor, 0),
  USD: items.filter((i) => i.moneda === "USD").reduce((s, i) => s + i.valor, 0),
});

async function filasDe(desde: string, hasta: string) {
  return db
    .select()
    .from(pagoMes)
    .where(and(gte(pagoMes.periodo, desde), lte(pagoMes.periodo, hasta)))
    .orderBy(asc(pagoMes.vence), asc(pagoMes.id));
}

/** El mes: cada pago con su estado, los totales, las alertas y el análisis de la IA (si lo hay). */
export async function verMes(periodo: string) {
  await prepararMes(periodo);
  const hoy = hoyIso();
  const [filas, anteriores, cat, [analisis]] = await Promise.all([
    filasDe(periodo, periodo),
    filasDe(sumarMeses(periodo, -1), sumarMeses(periodo, -1)),
    catalogos(),
    db.select().from(pagoAnalisis).where(eq(pagoAnalisis.periodo, periodo)),
  ]);
  const items = filas.map((r) => aItem(r, cat, hoy));
  const vivos = items.filter((i) => i.estado !== "omitido");
  const anterior = anteriores.map((r) => aItem(r, cat, hoy)).filter((i) => i.estado !== "omitido");
  const promedios = await Promise.all(
    items.map(async (i) => {
      if (!i.fijoId) return null;
      const m = (await montosAnteriores(i.fijoId, periodo)).filter((x) => x > 0).slice(-3);
      return m.length ? m.reduce((s, x) => s + x, 0) / m.length : null;
    }),
  );
  return {
    periodo,
    nombre: nombreMes(periodo),
    items,
    totales: {
      total: sumaPorMoneda(vivos.map((i) => ({ moneda: i.moneda, valor: i.monto }))),
      pagado: sumaPorMoneda(vivos.map((i) => ({ moneda: i.moneda, valor: i.pagado }))),
      falta: sumaPorMoneda(vivos.map((i) => ({ moneda: i.moneda, valor: i.falta }))),
      cantidad: vivos.length,
      pendientes: vivos.filter((i) => i.estado === "pendiente" || i.estado === "parcial").length,
      vencidos: vivos.filter((i) => i.vencido).length,
    },
    alertas: alertasDelMes(
      items.map((i, k) => ({ ...i, promedioAnterior: promedios[k] })),
      hoy,
      anterior.length ? sumaPorMoneda(anterior.map((i) => ({ moneda: i.moneda, valor: i.monto }))) : null,
    ),
    analisis: analisis ? { texto: descifrar(analisis.textoCifrado) ?? "", creadoEn: analisis.creadoEn } : null,
    lugares: cat.lugares,
    primerMes: await primerMes(),
  };
}

async function obtener(id: number) {
  const [r] = await db.select().from(pagoMes).where(eq(pagoMes.id, id));
  if (!r) throw new ErrorUsuario("Ese pago ya no está.");
  return r;
}

async function itemDe(id: number) {
  return aItem(await obtener(id), await catalogos(), hoyIso());
}

/**
 * Pagar: sin monto, lo que falta (un toque). Con monto menor, queda pagado en parte. Si sale de una suscripción, se
 * renueva; si es el resumen de una tarjeta, queda marcado lo pagado en Tarjetas.
 */
export async function registrarPago(id: number, p: { monto?: number; fecha?: string; formaId?: number } = {}) {
  const r = await obtener(id);
  if (r.estado === "pagado") throw new ErrorUsuario("Ese pago ya está marcado como pagado.");
  const formaId = p.formaId ?? r.formaId;
  if (!formaId) throw new ErrorUsuario("Falta con qué lo pagaste.");
  if (p.formaId && p.formaId !== r.formaId) await formaActiva(p.formaId);
  const d = abrirMes(r.datosCifrados);
  const monto = d.boleta ?? d.esperado;
  const parte = p.monto ?? Math.max(0, monto - totalPagado(d.pagos));
  if (parte < 0 || (parte === 0 && monto > 0)) throw new ErrorUsuario("Falta el monto que pagaste.");
  const fecha = p.fecha ?? hoyIso();
  const pagos = [...d.pagos, { monto: parte, fecha, formaId }];
  const estado = estadoDe(monto, pagos);
  await db
    .update(pagoMes)
    .set({ estado, pagadoEn: fecha, formaId, datosCifrados: sellar({ ...d, pagos }), actualizadoEn: new Date() })
    .where(eq(pagoMes.id, id));
  if (estado === "pagado" && r.suscripcionId) {
    const [s] = await db.select().from(suscripcion).where(eq(suscripcion.id, r.suscripcionId));
    if (s && s.fechaVto === r.vence) await renovarSuscripcion(s.id);
  }
  if (r.tarjetaId) await marcarPago(r.tarjetaId, totalPagado(pagos));
  avisar();
  return itemDe(id);
}

/**
 * Corregir un pago ya hecho (lo asentaste después, con otra forma, otro monto): cambia la última parte pagada y la
 * forma de pago, sin desmarcarlo.
 */
export async function corregirPago(id: number, c: { monto: number; fecha: string; formaId: number }) {
  const r = await obtener(id);
  const d = abrirMes(r.datosCifrados);
  if (!d.pagos.length || (r.estado !== "pagado" && r.estado !== "parcial")) throw new ErrorUsuario("Ese pago todavía no está pagado.");
  if (!(c.monto > 0)) throw new ErrorUsuario("Falta el monto que pagaste.");
  if (c.formaId !== r.formaId) await formaActiva(c.formaId);
  const pagos = [...d.pagos.slice(0, -1), { monto: c.monto, fecha: c.fecha, formaId: c.formaId }];
  await db
    .update(pagoMes)
    .set({ estado: estadoDe(d.boleta ?? d.esperado, pagos), pagadoEn: c.fecha, formaId: c.formaId, datosCifrados: sellar({ ...d, pagos }), actualizadoEn: new Date() })
    .where(eq(pagoMes.id, id));
  if (r.tarjetaId) await marcarPago(r.tarjetaId, totalPagado(pagos));
  avisar();
  return itemDe(id);
}

/** Desmarcar: vuelve a pendiente (sin las partes pagadas). */
export async function desmarcarPago(id: number) {
  const r = await obtener(id);
  await db
    .update(pagoMes)
    .set({ estado: "pendiente", pagadoEn: null, datosCifrados: sellar({ ...abrirMes(r.datosCifrados), pagos: [] }), actualizadoEn: new Date() })
    .where(eq(pagoMes.id, id));
  avisar();
}

/** "No se paga este mes" (o deshacerlo). */
export async function omitirPago(id: number, omitido: boolean) {
  const r = await obtener(id);
  const d = abrirMes(r.datosCifrados);
  await db
    .update(pagoMes)
    .set({ estado: omitido ? "omitido" : estadoDe(d.boleta ?? d.esperado, d.pagos), actualizadoEn: new Date() })
    .where(eq(pagoMes.id, id));
  avisar();
}

/** El monto y el vencimiento de este mes (los de la boleta), y la nota. Con una fecha nueva, los avisos vuelven a salir. */
/** vence null: sin vencimiento. */
export async function actualizarPagoDelMes(id: number, c: { monto?: number; vence?: string | null; nota?: string }) {
  const r = await obtener(id);
  const d = abrirMes(r.datosCifrados);
  const nuevo = { ...d, ...(c.monto !== undefined ? { boleta: Math.max(0, c.monto) } : {}), ...(c.nota !== undefined ? { nota: c.nota.trim() } : {}) };
  const venceCambia = c.vence !== undefined && c.vence !== r.vence;
  await db
    .update(pagoMes)
    .set({
      datosCifrados: sellar(nuevo),
      ...(venceCambia ? { vence: c.vence, avisoPrevioEnviado: false, avisoDiaEnviado: false } : {}),
      ...(r.estado !== "omitido" && nuevo.pagos.length ? { estado: estadoDe(nuevo.boleta ?? nuevo.esperado, nuevo.pagos) } : {}),
      actualizadoEn: new Date(),
    })
    .where(eq(pagoMes.id, id));
  avisar();
  return itemDe(id);
}

/** Sin lugar, es general (de negocio o personal). */
/** formaId: con qué se pagó (hace falta si ya está pagado). */
export type EntradaSuelto = { nombre: string; lugarId: number | null; tipo?: TipoLugar; categoria: string; monto: number; moneda: Moneda; fecha: string; formaId: number | null; nota: string; pagado: boolean };

/** Un pago que no está entre los fijos: ya pagado, o para pagar en esa fecha. */
export async function crearSuelto(e: EntradaSuelto) {
  if (!e.nombre.trim()) throw new ErrorUsuario("Falta qué pagaste.");
  if (!(e.monto > 0)) throw new ErrorUsuario("Falta el monto.");
  if (e.pagado && !e.formaId) throw new ErrorUsuario("Falta con qué lo pagaste.");
  if (e.formaId) await formaActiva(e.formaId);
  const categoria = await asegurarCategoria(e.categoria);
  const pagos = e.pagado ? [{ monto: e.monto, fecha: e.fecha, ...(e.formaId ? { formaId: e.formaId } : {}) }] : [];
  const [r] = await db
    .insert(pagoMes)
    .values({
      periodo: periodoDe(e.fecha),
      vence: e.fecha,
      ...alcanceValido({ alcance: e.lugarId ? "lugar" : "general", lugarId: e.lugarId, tipo: e.tipo ?? null, reparto: null }),
      categoria,
      moneda: e.moneda,
      estado: e.pagado ? "pagado" : "pendiente",
      pagadoEn: e.pagado ? e.fecha : null,
      formaId: e.formaId,
      datosCifrados: sellar({ nombre: e.nombre.trim(), esperado: e.monto, boleta: null, pagos, cuenta: "", nota: e.nota.trim() } satisfies DatosMes),
    })
    .returning({ id: pagoMes.id });
  avisar();
  return itemDe(r.id);
}

async function borrarFila(r: PagoMes) {
  await db.delete(pagoMes).where(eq(pagoMes.id, r.id));
  if (r.comprobante) await comprobantes.borrar([r.comprobante]);
}

/** Solo los sueltos: los que salen de un fijo, una suscripción o una tarjeta se marcan "No se paga este mes". */
export async function borrarPago(id: number) {
  const r = await obtener(id);
  if (r.fijoId || r.suscripcionId || r.tarjetaId) throw new ErrorUsuario("Este pago sale de lo que pagás siempre: usá «No se paga este mes».");
  await borrarFila(r);
  avisar();
}

// ───────────── Comprobantes ─────────────

/** Foto (se comprime como las del Bloc) o PDF, cifrado. Reemplaza al anterior. */
export async function guardarComprobante(id: number, datos: Buffer, mime: string) {
  const r = await obtener(id);
  let archivo: Buffer;
  let tipo: string;
  if (mime === "application/pdf") {
    if (!datos.subarray(0, 5).toString("latin1").startsWith("%PDF")) throw new ErrorUsuario("Ese archivo no es un PDF.");
    [archivo, tipo] = [datos, mime];
  } else {
    const webp = await comoWebp(datos, { ancho: 1600, alto: 1600 }).catch(() => {
      throw new ErrorUsuario("No pude leer ese comprobante: mandá una foto, una captura o un PDF.");
    });
    [archivo, tipo] = [webp.data, "image/webp"];
  }
  const nombre = comprobantes.nuevoNombre();
  await comprobantes.guardar(nombre, archivo);
  await db.update(pagoMes).set({ comprobante: nombre, comprobanteMime: tipo, actualizadoEn: new Date() }).where(eq(pagoMes.id, id));
  if (r.comprobante) await comprobantes.borrar([r.comprobante]);
  avisar();
}

export async function leerComprobante(id: number) {
  const r = await obtener(id);
  const datos = r.comprobante ? await comprobantes.leer(r.comprobante) : null;
  if (!datos) throw new ErrorUsuario("Ese pago no tiene comprobante.");
  return { datos, mime: r.comprobanteMime ?? "image/webp" };
}

export async function borrarComprobante(id: number) {
  const r = await obtener(id);
  if (r.comprobante) await comprobantes.borrar([r.comprobante]);
  await db.update(pagoMes).set({ comprobante: null, comprobanteMime: null }).where(eq(pagoMes.id, id));
  avisar();
}

// ───────────── Resumen y exportación ─────────────

type Totales = { ARS: number; USD: number };
type Porcion = { nombre: string; moneda: Moneda; monto: number; pagado: number };
const agrupar = (porciones: Porcion[]) => {
  const grupos = new Map<string, { nombre: string; total: Totales; pagado: Totales }>();
  for (const p of porciones) {
    const g = grupos.get(p.nombre) ?? { nombre: p.nombre, total: { ARS: 0, USD: 0 }, pagado: { ARS: 0, USD: 0 } };
    g.total[p.moneda] += p.monto;
    g.pagado[p.moneda] += p.pagado;
    grupos.set(p.nombre, g);
  }
  return [...grupos.values()].sort((a, b) => b.total.ARS - a.total.ARS || b.total.USD - a.total.USD);
};
/** Cada pago partido en lo que le toca a cada lugar (un repartido suma su parte en cada local). */
const porPartes = (lista: ItemPago[], nombre: (p: Parte) => string): Porcion[] =>
  lista.flatMap((i) => i.partes.map((p) => ({ nombre: nombre(p), moneda: i.moneda, monto: p.monto, pagado: p.pagado })));

/** Los últimos 12 meses (hasta "periodo"), y el mes y el año por lugar, por categoría y negocio / personal. */
export async function resumenPagos(periodo: string) {
  const desde = sumarMeses(periodo, -11);
  const hoy = hoyIso();
  // 11 meses para atrás siempre llegan al enero del año del mes: alcanzan para el año también.
  const [filas, cat] = await Promise.all([filasDe(desde, periodo), catalogos()]);
  const items = filas.map((r) => aItem(r, cat, hoy)).filter((i) => i.estado !== "omitido");
  const meses = Array.from({ length: 12 }, (_, k) => {
    const p = sumarMeses(desde, k);
    const delMes = items.filter((i) => i.periodo === p);
    return {
      periodo: p,
      total: sumaPorMoneda(delMes.map((i) => ({ moneda: i.moneda, valor: i.monto }))),
      pagado: sumaPorMoneda(delMes.map((i) => ({ moneda: i.moneda, valor: i.pagado }))),
    };
  });
  const corte = (lista: ItemPago[]) => ({
    total: sumaPorMoneda(lista.map((i) => ({ moneda: i.moneda, valor: i.monto }))),
    pagado: sumaPorMoneda(lista.map((i) => ({ moneda: i.moneda, valor: i.pagado }))),
    porLugar: agrupar(porPartes(lista, (p) => p.lugar)),
    porCategoria: agrupar(lista.map((i) => ({ nombre: i.categoria, moneda: i.moneda, monto: i.monto, pagado: i.pagado }))),
    porTipo: agrupar(porPartes(lista, (p) => (p.tipo === "negocio" ? "Negocio" : "Personal"))),
    // Solo lo pagado, cada parte con lo que se pagó (una parte la contadora y otra vos, por ejemplo).
    porForma: agrupar(
      lista.flatMap((i) =>
        i.pagos.map((p) => {
          const formaId = p.formaId ?? i.formaId;
          return { nombre: (formaId && cat.formas.get(formaId)) || "Sin forma de pago", moneda: i.moneda, monto: p.monto, pagado: p.monto };
        }),
      ),
    ),
  });
  return {
    periodo,
    meses,
    mes: corte(items.filter((i) => i.periodo === periodo)),
    anterior: corte(items.filter((i) => i.periodo === sumarMeses(periodo, -1))),
    anio: { desde: `${periodo.slice(0, 4)}-01`, ...corte(items.filter((i) => i.periodo >= `${periodo.slice(0, 4)}-01`)) },
  };
}

export async function exportarCsv(desde: string, hasta: string) {
  const [filas, cat] = await Promise.all([filasDe(desde, hasta), catalogos()]);
  const hoy = hoyIso();
  // Un renglón por lugar: el repartido sale en cada local con su parte, así cada uno cierra sus números.
  return aCsv(
    filas.flatMap((r) => {
      const i = aItem(r, cat, hoy);
      return i.partes.map(
        (p): FilaCsv => ({
          ...i,
          forma: i.pagado > 0 ? (i.forma ?? "") : "",
          lugar: p.lugar,
          tipo: p.tipo === "negocio" ? "Negocio" : "Personal",
          esperado: p.monto,
          pagado: p.pagado,
          reparto: i.partes.length > 1 ? `${Math.round(p.porcentaje * 100) / 100} % de ${plata(i.monto, i.moneda)} repartido` : "",
        }),
      );
    }),
  );
}

// ───────────── Para el asistente, las fotos y los mensajes ─────────────

/** Lo que falta pagar de este mes y del anterior (para reconocer un comprobante o una boleta). */
export async function pagosPendientes() {
  const hasta = mesActual();
  await prepararMes(hasta);
  const [filas, cat] = await Promise.all([
    db
      .select()
      .from(pagoMes)
      .where(and(gte(pagoMes.periodo, sumarMeses(hasta, -1)), lte(pagoMes.periodo, sumarMeses(hasta, 1)), inArray(pagoMes.estado, ["pendiente", "parcial"]))),
    catalogos(),
  ]);
  return filas.map((r) => aItem(r, cat, hoyIso()));
}

/** Los pendientes que coinciden con lo que dijo ("la luz del express 1"): primero los que tienen todas las palabras. */
export async function buscarPendientes(texto: string) {
  const palabras = normalizar(texto)
    .split(/\s+/)
    .filter((p) => p.length > 1 && !["de", "del", "la", "el", "los", "las", "en", "y", "pague", "pago"].includes(p));
  const puntaje = (i: ItemPago) => {
    const donde = normalizar(`${i.nombre} ${i.lugar} ${i.partes.map((p) => p.lugar).join(" ")} ${i.categoria} ${i.cuenta}`);
    return palabras.filter((p) => donde.includes(p)).length;
  };
  const candidatos = (await pagosPendientes()).map((i) => ({ i, n: puntaje(i) })).filter((c) => c.n > 0);
  const mejor = Math.max(0, ...candidatos.map((c) => c.n));
  return candidatos.filter((c) => c.n === mejor).map((c) => c.i);
}

/** Lo pagado en un rango (para "¿cuánto pagué de luz este año?"), con el total. */
export async function historialPagos(desde: string, hasta: string, buscar?: string) {
  const [filas, cat] = await Promise.all([filasDe(desde, hasta), catalogos()]);
  const filtro = buscar ? normalizar(buscar) : "";
  const items = filas
    .map((r) => aItem(r, cat, hoyIso()))
    .filter((i) => i.pagado > 0 && (!filtro || filtro.split(/\s+/).every((p) => normalizar(`${i.nombre} ${i.lugar} ${i.categoria}`).includes(p))));
  return { items, total: sumaPorMoneda(items.map((i) => ({ moneda: i.moneda, valor: i.pagado }))) };
}

/**
 * Las partes pagadas con esas formas (lo que otra persona pagó por vos: «Lo pagó: …»), con su pago. Solo pesos: las
 * cuentas con personas son en pesos.
 */
export async function partesPagadasCon(formaIds: number[]) {
  if (!formaIds.length) return [];
  const [filas, cat] = await Promise.all([
    db
      .select()
      .from(pagoMes)
      .where(and(inArray(pagoMes.estado, ["pagado", "parcial"]), eq(pagoMes.moneda, "ARS"))),
    catalogos(),
  ]);
  const hoy = hoyIso();
  return filas.flatMap((r) => {
    const partes = abrirMes(r.datosCifrados).pagos.flatMap((p) => {
      const formaId = p.formaId ?? r.formaId;
      return formaId && formaIds.includes(formaId) ? [{ ...p, formaId }] : [];
    });
    if (!partes.length) return [];
    const i = aItem(r, cat, hoy);
    return partes.map((p) => ({ formaId: p.formaId, fecha: p.fecha, monto: p.monto, pagoId: r.id, periodo: r.periodo, nombre: i.nombre, lugar: i.lugar }));
  });
}

export async function guardarAnalisis(periodo: string, texto: string) {
  await db
    .insert(pagoAnalisis)
    .values({ periodo, textoCifrado: cifrar(texto) })
    .onConflictDoUpdate({ target: pagoAnalisis.periodo, set: { textoCifrado: cifrar(texto), creadoEn: new Date() } });
  avisar();
}

/** Los pagos de los fijos que hay que avisar (de este mes y el que viene, sin pagar). */
export async function pagosParaAvisar() {
  const hasta = sumarMeses(mesActual(), 1);
  await prepararMes(mesActual());
  const [filas, fijos, cat] = await Promise.all([
    db
      .select()
      .from(pagoMes)
      .where(and(isNotNull(pagoMes.fijoId), lte(pagoMes.periodo, hasta), inArray(pagoMes.estado, ["pendiente", "parcial"]), or(eq(pagoMes.avisoPrevioEnviado, false), eq(pagoMes.avisoDiaEnviado, false)))),
    db.select().from(pagoFijo),
    catalogos(),
  ]);
  return filas.map((r) => ({ fila: r, item: aItem(r, cat, hoyIso()), avisoDias: fijos.find((f) => f.id === r.fijoId)?.avisoDias ?? null }));
}

export async function marcarAvisado(id: number, cual: "previo" | "dia") {
  await db
    .update(pagoMes)
    .set(cual === "previo" ? { avisoPrevioEnviado: true } : { avisoPrevioEnviado: true, avisoDiaEnviado: true })
    .where(and(eq(pagoMes.id, id), ne(pagoMes.estado, "pagado")));
}
