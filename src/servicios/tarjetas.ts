import { asc, eq } from "drizzle-orm";
import type { DateTime } from "luxon";
import { db } from "../db/index.js";
import { tarjeta, tarjetaConsumo, tarjetaCuota, tarjetaResumen, type Tarjeta, type TarjetaCuota } from "../db/schema.js";
import { cifrar, descifrar } from "../lib/cifrado.js";
import { bus } from "../lib/eventos.js";
import { ahora } from "../lib/fechas.js";
import { registrar } from "../lib/log.js";
import { plata } from "../lib/textos.js";
import { obtenerConfig } from "./configuracion.js";
import { enFila } from "./disparador.js";
import { enviador } from "./enviador.js";
import { registrarMensaje } from "./mensajes.js";
import { ErrorUsuario } from "./recordatorios.js";
import { cuandoVence, diaDe, diasParaVencer, momentoAviso, sePuedeAvisar } from "./vencimientos.js";

// ───────────── Datos (lo cifrado de cada fila) ─────────────

export type Saldos = { limiteCompra: number; limiteCuotas: number; disponibleCompra: number; disponibleCuotas: number; saldo: number; pagoMinimo: number };
export type DatosTarjeta = Saldos & { nombre: string; ultimos4: string; cierre: string | null; vencimiento: string | null };
export type DatosCuota = { comercio: string; montoCuota: number; fechaCompra: string | null; cuotaActual: number; cuotaTotal: number };
export type DatosConsumo = { nombre: string; montos: Record<string, number> };

export const SIN_SALDOS: Saldos = { limiteCompra: 0, limiteCuotas: 0, disponibleCompra: 0, disponibleCuotas: 0, saldo: 0, pagoMinimo: 0 };
const ILEGIBLE = "(no se pudo descifrar)";

export const sellar = (datos: object) => cifrar(JSON.stringify(datos));
/** Lo cifrado de una fila; si no se puede descifrar (¿cambió el APP_SECRET?), "vacio". */
export function abrir<T>(cifrado: string, vacio: T): T {
  const texto = descifrar(cifrado);
  return texto ? (JSON.parse(texto) as T) : vacio;
}

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

function vista(t: Tarjeta, cuotas: TarjetaCuota[], resumenes: FilaResumen[], consumos: FilaConsumo[], hoy: DateTime) {
  const saldos = abrir(t.datosCifrados, SIN_SALDOS);
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
    ...saldos,
    usoLimite: saldos.limiteCompra > 0 ? ((saldos.limiteCompra - saldos.disponibleCompra) / saldos.limiteCompra) * 100 : null,
    proximoResumenCuotas: activas.reduce((s, c) => s + c.montoCuota, 0),
    totalAdeudado: activas.reduce((s, c) => s + c.montoCuota * c.restantes, 0),
    ultimoResumen: ultimo && { cierre: ultimo.cierre, vencimiento: ultimo.vencimiento },
    cantidadResumenes: resumenes.length,
    cuotas: activas,
    finalizadas,
    proyeccion,
    consumos: consumos.map((c) => {
      const d = abrir<DatosConsumo>(c.datosCifrados, { nombre: ILEGIBLE, montos: {} });
      const [ultimoMes, anteriorMes] = Object.keys(d.montos).sort().reverse();
      const actual = ultimoMes ? d.montos[ultimoMes] : 0;
      const anterior = anteriorMes ? d.montos[anteriorMes] : null;
      return { id: c.id, nombre: d.nombre, periodo: ultimoMes ?? null, monto: actual, anterior, variacion: anterior ? ((actual - anterior) / anterior) * 100 : null };
    }),
  };
}
export type VistaTarjeta = ReturnType<typeof vista>;

export async function listarTarjetas(): Promise<VistaTarjeta[]> {
  const [tarjetas, cuotas, resumenes, consumos] = await Promise.all([
    db.select().from(tarjeta).orderBy(asc(tarjeta.id)),
    db.select().from(tarjetaCuota).orderBy(asc(tarjetaCuota.id)),
    db.select().from(tarjetaResumen),
    db.select().from(tarjetaConsumo).orderBy(asc(tarjetaConsumo.id)),
  ]);
  const hoy = ahora();
  const de = <T extends { tarjetaId: number }>(filas: T[], id: number) => filas.filter((f) => f.tarjetaId === id);
  return tarjetas.map((t) => vista(t, de(cuotas, t.id), de(resumenes, t.id), de(consumos, t.id), hoy));
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

const filaTarjeta = (d: DatosTarjeta) => ({ nombre: d.nombre, ultimos4: d.ultimos4, cierre: d.cierre, vencimiento: d.vencimiento, datosCifrados: sellar(saldosDe(d)) });

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
  await db
    .update(tarjeta)
    .set({ ...filaTarjeta(d), ...aviso, actualizadoEn: new Date() })
    .where(eq(tarjeta.id, id));
  bus.avisar("tarjetas");
}

/** Se borra con sus cuotas, resúmenes y consumos. */
export async function borrarTarjeta(id: number) {
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
