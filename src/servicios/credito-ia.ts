import { gte, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { usoIa } from "../db/schema.js";
import { registrar } from "../lib/log.js";
import { plata } from "../lib/textos.js";
import { actualizarConfig, obtenerConfig } from "./configuracion.js";
import { postergarPorSilencio } from "./disparador.js";
import { enviador } from "./enviador.js";
import { registrarMensaje } from "./mensajes.js";

// El crédito de la cuenta de Claude. Anthropic no deja consultarlo, así que el usuario dice cuánto cargó y acá se
// descuenta lo que gasta cada consulta (uso_ia). Con el ritmo de los últimos días se calcula para cuántos días alcanza
// y se avisa por WhatsApp cuando quedan menos de 7 y menos de 2.

/** Avisos: cuando alcanza para menos de estos días. */
export const DIAS_AVISO = 7;
const DIAS_URGENTE = 2;
/** El ritmo de gasto sale de los últimos días (o de los que haya, si la app es más nueva). */
const DIAS_RITMO = 14;
const DIA_MS = 86_400_000;

export const CONSOLA_BILLING = "console.anthropic.com → Settings → Billing";

export type Credito = { saldoUsd: number; porDiaUsd: number; dias: number | null };

async function gastoDesde(desde: Date) {
  const [f] = await db
    .select({ costo: sql<string>`coalesce(sum(${usoIa.costoUsd}), 0)`, primero: sql<Date | null>`min(${usoIa.creadoEn})` })
    .from(usoIa)
    .where(gte(usoIa.creadoEn, desde));
  return { costo: Number(f.costo), primero: f.primero ? new Date(f.primero) : null };
}

/** Saldo aproximado, gasto por día y para cuántos días alcanza (null si no gasta). null si nunca dijo cuánto tiene. */
export async function creditoIA(): Promise<Credito | null> {
  const cfg = await obtenerConfig();
  if (cfg.iaSaldoUsd === null || !cfg.iaSaldoDesde) return null;
  const saldoUsd = Math.max(0, cfg.iaSaldoUsd - (await gastoDesde(cfg.iaSaldoDesde)).costo);
  const ritmo = await gastoDesde(new Date(Date.now() - DIAS_RITMO * DIA_MS));
  const diasConUso = ritmo.primero ? Math.min(DIAS_RITMO, Math.max(1, (Date.now() - ritmo.primero.getTime()) / DIA_MS)) : 0;
  const porDiaUsd = diasConUso ? ritmo.costo / diasConUso : 0;
  return { saldoUsd, porDiaUsd, dias: porDiaUsd > 0 ? saldoUsd / porDiaUsd : saldoUsd > 0 ? null : 0 };
}

/** El saldo que ve en la consola (o 0 cuando Anthropic dice que se terminó). Vuelve a habilitar los avisos. */
export async function fijarSaldoIA(usd: number) {
  await actualizarConfig({ iaSaldoUsd: Math.max(0, usd), iaSaldoDesde: new Date(), iaSaldoAvisado: null });
  return creditoIA();
}

/** Cargó crédito: se suma a lo que queda. */
export async function cargarSaldoIA(usd: number) {
  return fijarSaldoIA(((await creditoIA())?.saldoUsd ?? 0) + usd);
}

/** "menos de 1 día", "1 día", "6 días". */
export function textoDias(dias: number): string {
  const n = Math.floor(dias);
  return n < 1 ? "menos de 1 día" : n === 1 ? "1 día" : `${n} días`;
}

/** "unos US$ 0,85, que te alcanzan para 6 días" (sin ritmo: solo el saldo). */
export function textoSaldo(c: Credito): string {
  return `unos *${plata(c.saldoUsd, "USD")}*${c.dias === null ? "" : `, que al ritmo de ahora te alcanzan para *${textoDias(c.dias)}*`}`;
}

/** Línea para el resumen de la mañana, solo cuando queda poco. */
export async function lineaCreditoResumen(): Promise<string> {
  const c = await creditoIA();
  if (!c || c.dias === null || c.dias >= DIAS_AVISO) return "";
  return `\n\n🪫 Crédito de Claude: ${textoSaldo(c)}. Cargá en ${CONSOLA_BILLING}.`;
}

/**
 * Lo llama el barrido: si el saldo alcanza para menos de 7 días (y después para menos de 2), avisa por WhatsApp una
 * vez cada uno, fuera del horario de silencio. Si la IA ya no anda, el aviso de la falla dice lo mismo.
 */
export async function revisarCreditoIA(): Promise<void> {
  const cfg = await obtenerConfig();
  const c = await creditoIA();
  if (!c || c.dias === null || cfg.iaFalla) return;
  const nivel = c.dias < DIAS_URGENTE ? "2" : c.dias < DIAS_AVISO ? "7" : null;
  if (!nivel || cfg.iaSaldoAvisado === nivel || (nivel === "7" && cfg.iaSaldoAvisado === "2")) return;
  if (postergarPorSilencio(new Date(), cfg) || !enviador().conectado()) return;
  const texto =
    `🪫 Te queda poco crédito de Claude (la IA del bot): ${textoSaldo(c)}.\n` +
    `Cargá en ${CONSOLA_BILLING} y después decime cuánto, por ejemplo «cargué 10 dólares».\n\n` +
    "_Ahí mismo podés activar la recarga automática (Auto reload): carga sola cuando baja de un monto y no te quedás nunca sin crédito._";
  try {
    const id = await enviador().enviarTexto(texto);
    await registrarMensaje({ direccion: "saliente", texto, waMessageId: id, intencionDetectada: "credito_ia" });
    await actualizarConfig({ iaSaldoAvisado: nivel });
  } catch (err) {
    await registrar("error", "ia", "No se pudo avisar que queda poco crédito de Claude", err);
  }
}
