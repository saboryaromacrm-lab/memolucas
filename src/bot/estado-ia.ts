import type { MotivoFallaIA } from "../db/schema.js";
import { registrar } from "../lib/log.js";
import { actualizarConfig, obtenerConfig } from "../servicios/configuracion.js";
import { CAUSA_FALLA_IA, fijarAlContestar, probarConexion } from "./ia.js";

// Cuando la IA no anda por algo que no depende del mensaje (sin crédito, la clave o Anthropic caído), el bot avisa una
// sola vez, guarda lo que le mandan (procesador.ts) y lo hace solo cuando vuelve. Vuelve cuando cualquier pedido a
// Claude contesta: uno tuyo, el "Probar" del panel o la prueba que hace el barrido cada 5 minutos.

const MINUTOS_ENTRE_PRUEBAS = 5;

/**
 * Anota que la IA no anda. true si recién empieza o cambió el motivo: hay que avisar (una sola vez, no en cada
 * mensaje).
 */
export async function anotarFallaIA(motivo: MotivoFallaIA): Promise<boolean> {
  const cfg = await obtenerConfig();
  if (cfg.iaFalla?.motivo === motivo) return false;
  await actualizarConfig({ iaFalla: { motivo, desde: cfg.iaFalla?.desde ?? new Date().toISOString() } });
  await registrar("error", "ia", `La IA dejó de andar: ${CAUSA_FALLA_IA[motivo]}`);
  return true;
}

let alVolver: () => Promise<void> = async () => {};
/** Lo que se hace cuando la IA vuelve: los mensajes guardados (lo fija index.ts con el procesador). */
export const alVolverLaIA = (fn: () => Promise<void>) => void (alVolver = fn);

let volviendo: Promise<void> | null = null;
/** La IA contestó: si estaba anotada como caída, se levanta la falla y se hace lo guardado. */
function iaAnda(): Promise<void> {
  volviendo ??= (async () => {
    if (!(await obtenerConfig()).iaFalla) return;
    await actualizarConfig({ iaFalla: null });
    await registrar("info", "ia", "La IA volvió a andar");
    await alVolver();
  })().finally(() => (volviendo = null));
  return volviendo;
}
fijarAlContestar(() => void iaAnda().catch((err) => registrar("error", "ia", "Falló lo que se hace al volver la IA", err)));

let ultimaPrueba = 0;
/**
 * Con la IA anotada como caída, prueba si volvió (un pedido mínimo). Sin forzar, como mucho cada 5 minutos (lo llama
 * el barrido). Si volvió, espera a que se haga lo guardado. true si la IA anda.
 */
export async function revisarIA(forzar = false): Promise<boolean> {
  const cfg = await obtenerConfig();
  if (!cfg.iaFalla) return true;
  if (!forzar && Date.now() - ultimaPrueba < MINUTOS_ENTRE_PRUEBAS * 60_000) return false;
  ultimaPrueba = Date.now();
  const r = await probarConexion(cfg);
  if (r.ok) await iaAnda();
  else if (r.motivo) await anotarFallaIA(r.motivo);
  return r.ok;
}

/** El aviso por WhatsApp. guardado: si lo que mandó queda para cuando vuelva. */
export function textoFallaIA(motivo: MotivoFallaIA, guardado: boolean): string {
  const pie = guardado
    ? "Lo que me mandes mientras tanto lo guardo (te lo marco con ⏳) y lo hago solo cuando vuelva. Los comandos rápidos (hoy, lista, listo…) andan igual."
    : "Mandámelo de nuevo cuando esté arreglado.";
  return `⚠️ Ahora no puedo usar la IA. ${CAUSA_FALLA_IA[motivo]}\n\n${pie}`;
}
