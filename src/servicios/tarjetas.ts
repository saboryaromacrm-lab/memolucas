import { asc, eq } from "drizzle-orm";
import type { DateTime } from "luxon";
import { db } from "../db/index.js";
import { suscripcion, tarjeta, tarjetaConsumo, tarjetaCuota, tarjetaGasto, tarjetaResumen, type Suscripcion, type Tarjeta, type TarjetaCuota } from "../db/schema.js";
import { abrir, sellar } from "../lib/cifrado.js";
import { bus } from "../lib/eventos.js";
import { ahora } from "../lib/fechas.js";
import { registrar } from "../lib/log.js";
import { pareceElMismo, plata } from "../lib/textos.js";
import { obtenerConfig } from "./configuracion.js";
import { enFila } from "./disparador.js";
import { enviador } from "./enviador.js";
import { registrarMensaje } from "./mensajes.js";
import { archivarFormaDeTarjeta } from "./pagos-formas.js";
import { ErrorUsuario } from "./recordatorios.js";
import { sumarPeriodo } from "./suscripciones.js";
import { cuandoVence, diaDe, diasParaVencer, momentoAviso, sePuedeAvisar } from "./vencimientos.js";

// ───────────── Datos (lo cifrado de cada fila) ─────────────

export type Saldos = { limiteCompra: number; limiteCuotas: number; disponibleCompra: number; disponibleCuotas: number; saldo: number; pagoMinimo: number };
/** negocio: sin el dato (al importar un resumen) no se cambia. */
export type DatosTarjeta = Saldos & { nombre: string; ultimos4: string; cierre: string | null; vencimiento: string | null; negocio?: boolean };
export type DatosCuota = { comercio: string; montoCuota: number; fechaCompra: string | null; cuotaActual: number; cuotaTotal: number };
export type DatosConsumo = { nombre: string; montos: Record<string, number> };
/** Cuánto pagaste del último resumen (null: no lo marcaste). Va con los saldos de la tarjeta. */
type ConPago = Saldos & { pagado?: number | null };
export type Moneda = "ARS" | "USD";
export type DatosGasto = { descripcion: string; monto: number; moneda: Moneda; fecha: string; cuotas: number };

export const SIN_SALDOS: Saldos = { limiteCompra: 0, limiteCuotas: 0, disponibleCompra: 0, disponibleCuotas: 0, saldo: 0, pagoMinimo: 0 };
const ILEGIBLE = "(no se pudo descifrar)";

const saldosDe = (d: Saldos): Saldos => ({
  limiteCompra: d.limiteCompra,
  limiteCuotas: d.limiteCuotas,
  disponibleCompra: d.disponibleCompra,
  disponibleCuotas: d.disponibleCuotas,
  saldo: d.saldo,
  pagoMinimo: d.pagoMinimo,
});

// ───────────── Cuotas: avanzan solas en cada cierre ─────────────

/** Cierres (uno por mes, el mismo día) que ya pasaron desde "base". El día del cierre todavía no cuenta. */
function cierresDesde(base: string, hoy: DateTime): number {
  const b = diaDe(base);
  const limite = hoy.startOf("day");
  let k = 0;
  while (k < 600 && b.plus({ months: k + 1 }) < limite) k++;
  return k;
}

/** El último cierre hasta hoy, contando desde un cierre conocido (o hoy, si no se sabe ninguno). */
export function ultimoCierreHasta(cierre: string | null, hoy: DateTime = ahora()): string {
  if (!cierre) return hoy.toISODate()!;
  let d = diaDe(cierre);
  for (let i = 0; i < 600 && d.startOf("day") >= hoy.startOf("day"); i++) d = d.minus({ months: 1 });
  return d.plus({ months: cierresDesde(d.toISODate()!, hoy) }).toISODate()!;
}

/** Cómo va una compra en cuotas hoy: la cuota que ya se cobró, cuántas faltan y en qué cierre se cobra la última. */
export function estadoCuota(c: Pick<TarjetaCuota, "cuotaActual" | "cuotaTotal" | "cierreBase">, hoy: DateTime = ahora()) {
  const actual = Math.min(c.cuotaTotal, c.cuotaActual + cierresDesde(c.cierreBase, hoy));
  return { actual, restantes: c.cuotaTotal - actual, finalizada: actual >= c.cuotaTotal, ultimoCierre: diaDe(c.cierreBase).plus({ months: c.cuotaTotal - c.cuotaActual }).toISODate()! };
}

// ───────────── Vista de cada tarjeta (lo que muestra el panel) ─────────────

type FilaResumen = typeof tarjetaResumen.$inferSelect;
type FilaConsumo = typeof tarjetaConsumo.$inferSelect;

type FilaGasto = typeof tarjetaGasto.$inferSelect;

export type LineaResumen = {
  tipo: "cuota" | "suscripcion" | "debito" | "compra" | "saldo";
  descripcion: string;
  detalle: string | null;
  monto: number;
  moneda: Moneda;
  /** De la cuota, suscripción, débito o compra (para editarla o borrarla). */
  id: number | null;
};

const fechaCorta = (iso: string) => diaDe(iso).toFormat("dd/MM");

/**
 * Lo que se estima que trae el próximo resumen: las cuotas que siguen, las suscripciones que se pagan con esta tarjeta
 * y se cobran en el período, los débitos que se repiten (sin contar dos veces los que son una suscripción), las
 * compras que cargaste y lo que quedó sin pagar del resumen anterior. Sin impuestos, percepciones ni intereses.
 */
function proximoResumen(
  t: Tarjeta,
  saldos: ConPago,
  activas: { id: number; comercio: string; montoCuota: number; actual: number; cuotaTotal: number }[],
  consumos: { id: number; nombre: string; periodo: string | null; monto: number }[],
  suscripciones: Suscripcion[],
  gastos: FilaGasto[],
  hoy: DateTime,
) {
  const ultimo = ultimoCierreHasta(t.cierre, hoy);
  const cierre = diaDe(ultimo).plus({ months: 1 }).toISODate()!;
  const vencimiento = t.cierre && t.vencimiento ? diaDe(cierre).plus({ days: Math.round(diaDe(t.vencimiento).diff(diaDe(t.cierre), "days").days) }).toISODate()! : null;
  const lineas: LineaResumen[] = activas.map((c) => ({ tipo: "cuota", descripcion: c.comercio, detalle: `Cuota ${c.actual + 1}/${c.cuotaTotal}`, monto: c.montoCuota, moneda: "ARS", id: c.id }));

  // Débitos del último resumen importado (los que dejaron de aparecer ya no se cobran).
  const debitos = consumos.filter((c) => t.cierre && c.periodo === t.cierre.slice(0, 7));
  const yaContados = new Set<number>();
  for (const s of suscripciones.filter((x) => x.tarjetaId === t.id)) {
    let f = s.fechaVto;
    for (let i = 0; i < 500 && f <= ultimo; i++) f = sumarPeriodo(f, s.frecuencia);
    let cobros = 0;
    for (; cobros < 10 && f <= cierre; cobros++) f = sumarPeriodo(f, s.frecuencia);
    if (!cobros) continue;
    const enResumen = debitos.find((d) => pareceElMismo(d.nombre, s.nombre));
    if (enResumen) yaContados.add(enResumen.id);
    const detalle = [cobros > 1 && `${cobros} cobros`, enResumen && `en el resumen figura como ${enResumen.nombre}`].filter(Boolean).join(" · ");
    lineas.push({ tipo: "suscripcion", descripcion: s.nombre, detalle: detalle || null, monto: s.monto * cobros, moneda: s.moneda, id: s.id });
  }
  for (const d of debitos.filter((x) => !yaContados.has(x.id)))
    lineas.push({ tipo: "debito", descripcion: d.nombre, detalle: "como en el último resumen", monto: d.monto, moneda: "ARS", id: d.id });

  for (const g of gastos.filter((x) => x.fecha > ultimo && x.fecha <= cierre)) {
    const d = abrir(g.datosCifrados, { descripcion: ILEGIBLE, monto: 0 });
    lineas.push({ tipo: "compra", descripcion: d.descripcion, detalle: fechaCorta(g.fecha), monto: d.monto, moneda: g.moneda, id: g.id });
  }

  // El resumen anterior es el último importado solo si no cerró otro después.
  const anteriorImportado = t.cierre === ultimo;
  const quedo = anteriorImportado && saldos.pagado != null ? saldos.saldo - saldos.pagado : 0;
  if (quedo > 0.009)
    lineas.push({ tipo: "saldo", descripcion: "Lo que quedó sin pagar", detalle: `pagaste ${plata(saldos.pagado!)} de ${plata(saldos.saldo)}`, monto: quedo, moneda: "ARS", id: null });

  const total = (m: Moneda) => lineas.filter((l) => l.moneda === m).reduce((s, l) => s + l.monto, 0);
  return {
    cierre,
    vencimiento,
    lineas,
    totalArs: total("ARS"),
    totalUsd: total("USD"),
    /** Cerró un resumen que todavía no se importó: las cuentas pueden no dar. */
    sinImportar: t.cierre && t.cierre < ultimo ? ultimo : null,
    /** Del último resumen (con saldo) no se marcó cuánto se pagó. */
    faltaPago: anteriorImportado && saldos.saldo > 0 && saldos.pagado == null ? t.cierre : null,
    pagado: anteriorImportado ? (saldos.pagado ?? null) : null,
  };
}
export type ProximoResumen = ReturnType<typeof proximoResumen>;

function vista(t: Tarjeta, cuotas: TarjetaCuota[], resumenes: FilaResumen[], consumos: FilaConsumo[], suscripciones: Suscripcion[], gastos: FilaGasto[], hoy: DateTime) {
  const saldos: ConPago = abrir(t.datosCifrados, SIN_SALDOS);
  const compras = cuotas.map((c) => {
    const d = abrir(c.datosCifrados, { comercio: ILEGIBLE, montoCuota: 0 });
    return { id: c.id, comercio: d.comercio, montoCuota: d.montoCuota, montoTotal: d.montoCuota * c.cuotaTotal, fechaCompra: c.fechaCompra, cuotaTotal: c.cuotaTotal, ...estadoCuota(c, hoy) };
  });
  const activas = compras.filter((c) => !c.finalizada).sort((a, b) => a.restantes - b.restantes);
  const finalizadas = compras
    .filter((c) => c.finalizada)
    .sort((a, b) => b.ultimoCierre.localeCompare(a.ultimoCierre))
    .slice(0, 10);
  const ultimo = resumenes.reduce<FilaResumen | null>((m, r) => (!m || r.cierre > m.cierre ? r : m), null);
  const listaConsumos = consumos.map((c) => {
    const d = abrir<DatosConsumo>(c.datosCifrados, { nombre: ILEGIBLE, montos: {} });
    const [ultimoMes, anteriorMes] = Object.keys(d.montos).sort().reverse();
    const actual = ultimoMes ? d.montos[ultimoMes] : 0;
    const anterior = anteriorMes ? d.montos[anteriorMes] : null;
    return { id: c.id, nombre: d.nombre, periodo: ultimoMes ?? null, monto: actual, anterior, variacion: anterior ? ((actual - anterior) / anterior) * 100 : null };
  });

  // Proyección de 12 cierres: lo que se paga de cuotas y lo que se libera cuando terminan.
  const proximo = diaDe(ultimoCierreHasta(t.cierre, hoy));
  let liberado = 0;
  const proyeccion = Array.from({ length: 12 }, (_, i) => {
    const terminan = activas.filter((c) => c.restantes === i + 1);
    const libera = terminan.reduce((s, c) => s + c.montoCuota, 0);
    liberado += libera;
    return {
      mes: proximo.plus({ months: i + 1 }).toFormat("LLL yyyy"),
      cuotas: activas.filter((c) => c.restantes > i).reduce((s, c) => s + c.montoCuota, 0),
      libera,
      disponible: saldos.disponibleCompra + liberado,
      terminan: terminan.map((c) => c.comercio),
    };
  });

  return {
    id: t.id,
    nombre: t.nombre,
    ultimos4: t.ultimos4,
    cierre: t.cierre,
    vencimiento: t.vencimiento,
    negocio: t.negocio,
    ...saldosDe(saldos),
    usoLimite: saldos.limiteCompra > 0 ? ((saldos.limiteCompra - saldos.disponibleCompra) / saldos.limiteCompra) * 100 : null,
    proximoResumen: proximoResumen(t, saldos, activas, listaConsumos, suscripciones, gastos, hoy),
    avisoCierrePara: t.avisoCierrePara,
    totalAdeudado: activas.reduce((s, c) => s + c.montoCuota * c.restantes, 0),
    ultimoResumen: ultimo && { cierre: ultimo.cierre, vencimiento: ultimo.vencimiento },
    cantidadResumenes: resumenes.length,
    cuotas: activas,
    finalizadas,
    proyeccion,
    consumos: listaConsumos,
  };
}
export type VistaTarjeta = ReturnType<typeof vista>;

export async function listarTarjetas(): Promise<VistaTarjeta[]> {
  const [tarjetas, cuotas, resumenes, consumos, suscripciones, gastos] = await Promise.all([
    db.select().from(tarjeta).orderBy(asc(tarjeta.id)),
    db.select().from(tarjetaCuota).orderBy(asc(tarjetaCuota.id)),
    db.select().from(tarjetaResumen),
    db.select().from(tarjetaConsumo).orderBy(asc(tarjetaConsumo.id)),
    db.select().from(suscripcion).orderBy(asc(suscripcion.fechaVto)),
    db.select().from(tarjetaGasto).orderBy(asc(tarjetaGasto.fecha), asc(tarjetaGasto.id)),
  ]);
  const hoy = ahora();
  const de = <T extends { tarjetaId: number }>(filas: T[], id: number) => filas.filter((f) => f.tarjetaId === id);
  return tarjetas.map((t) => vista(t, de(cuotas, t.id), de(resumenes, t.id), de(consumos, t.id), suscripciones, de(gastos, t.id), hoy));
}

/**
 * Para cada suscripción sin medio de pago definido, la tarjeta en cuyos débitos aparece (Netflix → NETFLIX.COM en la
 * Visa). El panel la sugiere y vos confirmás.
 */
export async function sugerirTarjetas(suscripciones: Suscripcion[]) {
  const sinDefinir = suscripciones.filter((s) => !s.tarjetaId && !s.sinTarjeta);
  if (!sinDefinir.length) return {};
  const [tarjetas, consumos] = await Promise.all([db.select().from(tarjeta), db.select().from(tarjetaConsumo)]);
  const debitos = consumos.map((c) => ({ tarjetaId: c.tarjetaId, nombre: abrir<DatosConsumo>(c.datosCifrados, { nombre: "", montos: {} }).nombre }));
  const sugerencias: Record<number, { tarjetaId: number; tarjeta: string; comoAparece: string }> = {};
  for (const s of sinDefinir) {
    const d = debitos.find((x) => pareceElMismo(x.nombre, s.nombre));
    const t = d && tarjetas.find((x) => x.id === d.tarjetaId);
    if (d && t) sugerencias[s.id] = { tarjetaId: t.id, tarjeta: `${t.nombre}${t.ultimos4 ? ` ···${t.ultimos4}` : ""}`, comoAparece: d.nombre };
  }
  return sugerencias;
}

// ───────────── Cambios ─────────────

async function obtener(id: number): Promise<Tarjeta> {
  const [t] = await db.select().from(tarjeta).where(eq(tarjeta.id, id));
  if (!t) throw new ErrorUsuario("Esa tarjeta ya no existe.");
  return t;
}

/** Un vencimiento cuyo aviso ya debería haber salido no se avisa de golpe (se ve en el panel). */
export async function avisoVtoPara(vencimiento: string | null) {
  if (!vencimiento) return null;
  const cfg = await obtenerConfig();
  return momentoAviso(vencimiento, cfg.tarjetasDiasAviso, cfg) <= new Date() ? vencimiento : null;
}

const filaTarjeta = (d: DatosTarjeta) => ({
  nombre: d.nombre,
  ultimos4: d.ultimos4,
  cierre: d.cierre,
  vencimiento: d.vencimiento,
  datosCifrados: sellar(saldosDe(d)),
  ...(d.negocio !== undefined ? { negocio: d.negocio } : {}),
});

export async function crearTarjeta(d: DatosTarjeta) {
  const [t] = await db
    .insert(tarjeta)
    .values({ ...filaTarjeta(d), avisoVtoPara: await avisoVtoPara(d.vencimiento) })
    .returning({ id: tarjeta.id });
  bus.avisar("tarjetas");
  return t;
}

export async function actualizarTarjeta(id: number, d: DatosTarjeta) {
  const actual = await obtener(id);
  const aviso = d.vencimiento !== actual.vencimiento ? { avisoVtoPara: await avisoVtoPara(d.vencimiento) } : {};
  // Lo que marcaste como pagado sigue valiendo mientras sea el mismo resumen.
  const antes: ConPago = abrir(actual.datosCifrados, SIN_SALDOS);
  const pagado = d.cierre === actual.cierre ? (antes.pagado ?? null) : null;
  await db
    .update(tarjeta)
    .set({ ...filaTarjeta(d), datosCifrados: sellar({ ...saldosDe(d), pagado }), ...aviso, actualizadoEn: new Date() })
    .where(eq(tarjeta.id, id));
  bus.avisar("tarjetas");
}

/** Se borra con sus cuotas, resúmenes y consumos. */
export async function borrarTarjeta(id: number) {
  await archivarFormaDeTarjeta(id);
  await db.delete(tarjeta).where(eq(tarjeta.id, id));
  bus.avisar("tarjetas");
}

/** La cuota que se carga a mano es la de hoy: cuenta desde el último cierre. */
async function filaCuota(tarjetaId: number, d: DatosCuota) {
  if (d.cuotaActual > d.cuotaTotal) throw new ErrorUsuario("La cuota actual no puede ser mayor que el total de cuotas.");
  const t = await obtener(tarjetaId);
  return {
    fechaCompra: d.fechaCompra,
    cuotaActual: d.cuotaActual,
    cuotaTotal: d.cuotaTotal,
    cierreBase: ultimoCierreHasta(t.cierre),
    datosCifrados: sellar({ comercio: d.comercio, montoCuota: d.montoCuota }),
  };
}

export async function crearCuota(tarjetaId: number, d: DatosCuota) {
  const [c] = await db
    .insert(tarjetaCuota)
    .values({ tarjetaId, ...(await filaCuota(tarjetaId, d)) })
    .returning({ id: tarjetaCuota.id });
  bus.avisar("tarjetas");
  return c;
}

export async function actualizarCuota(id: number, d: DatosCuota) {
  const [c] = await db.select().from(tarjetaCuota).where(eq(tarjetaCuota.id, id));
  if (!c) throw new ErrorUsuario("Esa cuota ya no existe.");
  await db
    .update(tarjetaCuota)
    .set({ ...(await filaCuota(c.tarjetaId, d)), actualizadoEn: new Date() })
    .where(eq(tarjetaCuota.id, id));
  bus.avisar("tarjetas");
}

export async function borrarCuota(id: number) {
  await db.delete(tarjetaCuota).where(eq(tarjetaCuota.id, id));
  bus.avisar("tarjetas");
}

/** Cuánto pagaste del último resumen: si quedó algo, va al próximo. */
export async function marcarPago(tarjetaId: number, monto: number) {
  if (monto < 0) throw new ErrorUsuario("El pago no puede ser negativo.");
  const t = await obtener(tarjetaId);
  await db
    .update(tarjeta)
    .set({ datosCifrados: sellar({ ...abrir(t.datosCifrados, SIN_SALDOS), pagado: monto }), actualizadoEn: new Date() })
    .where(eq(tarjeta.id, tarjetaId));
  bus.avisar("tarjetas");
}

/** Una compra que hiciste con la tarjeta: en un pago va al próximo resumen; en cuotas, a las cuotas en curso. */
export async function cargarCompra(tarjetaId: number, d: DatosGasto) {
  await obtener(tarjetaId);
  if (!(d.monto > 0)) throw new ErrorUsuario("Falta el monto de la compra.");
  if (d.cuotas > 1) {
    if (d.moneda !== "ARS") throw new ErrorUsuario("Las compras en cuotas van en pesos.");
    // Recién compradas: la primera cuota viene en el próximo resumen.
    return crearCuota(tarjetaId, { comercio: d.descripcion, montoCuota: d.monto / d.cuotas, fechaCompra: d.fecha, cuotaActual: 0, cuotaTotal: d.cuotas });
  }
  const [g] = await db
    .insert(tarjetaGasto)
    .values({ tarjetaId, fecha: d.fecha, moneda: d.moneda, datosCifrados: sellar({ descripcion: d.descripcion, monto: d.monto }) })
    .returning({ id: tarjetaGasto.id });
  bus.avisar("tarjetas");
  return g;
}

export async function borrarCompra(id: number) {
  await db.delete(tarjetaGasto).where(eq(tarjetaGasto.id, id));
  bus.avisar("tarjetas");
}

export async function borrarConsumo(id: number) {
  await db.delete(tarjetaConsumo).where(eq(tarjetaConsumo.id, id));
  bus.avisar("tarjetas");
}

// ───────────── Aviso del vencimiento por WhatsApp ─────────────

/** Lo llama el barrido: avisa unos días antes del vencimiento del resumen, con el saldo y el pago mínimo. */
export async function avisarTarjetas(): Promise<void> {
  const cfg = await obtenerConfig();
  if (!sePuedeAvisar(cfg)) return;
  const ya = new Date();
  for (const t of await db.select().from(tarjeta)) {
    if (!t.vencimiento || t.avisoVtoPara === t.vencimiento || momentoAviso(t.vencimiento, cfg.tarjetasDiasAviso, cfg) > ya) continue;
    const s = abrir(t.datosCifrados, SIN_SALDOS);
    // Sin saldo (o ya vencido) no hay nada para pagar: solo se marca.
    if (s.saldo > 0 && diasParaVencer(t.vencimiento) >= 0) {
      const texto = `💳 *${t.nombre}${t.ultimos4 ? ` ···${t.ultimos4}` : ""}* ${cuandoVence(t.vencimiento)}\nSaldo ${plata(s.saldo)} · Pago mínimo ${plata(s.pagoMinimo)}`;
      try {
        const waId = await enFila(() => enviador().enviarTexto(texto));
        await registrarMensaje({ direccion: "saliente", texto, waMessageId: waId, chat: null, intencionDetectada: "aviso_tarjeta" });
      } catch (err) {
        await registrar("error", "tarjetas", `No se pudo avisar el vencimiento de "${t.nombre}"`, err);
        continue;
      }
    }
    await db.update(tarjeta).set({ avisoVtoPara: t.vencimiento }).where(eq(tarjeta.id, t.id));
  }
}

// ───────────── Aviso del cierre: "esto te viene en el resumen" ─────────────

const sumaDe = (lineas: LineaResumen[]) => {
  const ars = lineas.filter((l) => l.moneda === "ARS").reduce((s, l) => s + l.monto, 0);
  const usd = lineas.filter((l) => l.moneda === "USD").reduce((s, l) => s + l.monto, 0);
  return [ars && plata(ars), usd && plata(usd, "USD")].filter(Boolean).join(" + ");
};

/** El mensaje de WhatsApp con lo que se estima del próximo resumen, por grupo. */
export function textoProximoResumen(t: Pick<VistaTarjeta, "nombre" | "ultimos4" | "proximoResumen">): string {
  const p = t.proximoResumen;
  const grupos: [string, LineaResumen["tipo"][]][] = [
    ["Cuotas", ["cuota"]],
    ["Suscripciones y débitos", ["suscripcion", "debito"]],
    ["Compras que cargaste", ["compra"]],
    ["Saldo sin pagar del anterior", ["saldo"]],
  ];
  const renglones = grupos.flatMap(([nombre, tipos]) => {
    const ls = p.lineas.filter((l) => tipos.includes(l.tipo));
    return ls.length ? [`• ${nombre}${ls.length > 1 ? ` (${ls.length})` : ""}: ${sumaDe(ls)}`] : [];
  });
  const cuando = `cierra ${diaDe(p.cierre).setLocale("es").toFormat("ccc dd/MM")}${p.vencimiento ? ` y vence ${fechaCorta(p.vencimiento)}` : ""}`;
  return [
    `🧾 *${t.nombre}${t.ultimos4 ? ` ···${t.ultimos4}` : ""}* ${cuando}`,
    `Te viene aprox. *${sumaDe(p.lineas)}*`,
    ...renglones,
    "_Sin impuestos, percepciones ni intereses. El detalle, en el panel._",
  ].join("\n");
}

/** Lo llama el barrido: unos días antes de cada cierre, te manda lo que se estima del resumen. */
export async function avisarCierres(): Promise<void> {
  const cfg = await obtenerConfig();
  if (!sePuedeAvisar(cfg)) return;
  const ya = new Date();
  for (const t of await listarTarjetas()) {
    const { cierre, lineas } = t.proximoResumen;
    if (t.avisoCierrePara === cierre || momentoAviso(cierre, cfg.tarjetasDiasAviso, cfg) > ya) continue;
    if (lineas.length) {
      const texto = textoProximoResumen(t);
      try {
        const waId = await enFila(() => enviador().enviarTexto(texto));
        await registrarMensaje({ direccion: "saliente", texto, waMessageId: waId, chat: null, intencionDetectada: "aviso_cierre_tarjeta" });
      } catch (err) {
        await registrar("error", "tarjetas", `No se pudo avisar el cierre de "${t.nombre}"`, err);
        continue;
      }
    }
    await db.update(tarjeta).set({ avisoCierrePara: cierre }).where(eq(tarjeta.id, t.id));
  }
}
