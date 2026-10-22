import { ahora, hoyIso, parseHora } from "../lib/fechas.js";
import { registrar } from "../lib/log.js";
import { actualizarConfig, obtenerConfig, plantillasDe, renderizar } from "./configuracion.js";
import { enviador } from "./enviador.js";
import { formatearEventos, rangoHoy, textoPendientes } from "./listados.js";
import { registrarMensaje } from "./mensajes.js";
import { eventosEntre } from "./recordatorios.js";

const VENTANA_MIN = 120;

export async function textoResumen(): Promise<string> {
  const cfg = await obtenerConfig();
  const r = rangoHoy();
  const eventos = await eventosEntre(r.desde, r.hasta);
  const lista = eventos.length ? formatearEventos(eventos, false) : "Nada programado 🙌";
  let texto = renderizar(plantillasDe(cfg).resumen, { nombre: cfg.nombreUsuario, lista, cantidad: eventos.length });
  if (cfg.resumenIncluirPendientes) texto += await textoPendientes();
  return texto;
}

/** Lo llama el barrido cada minuto: envía el resumen si es la hora y todavía no se mandó hoy. */
export async function revisarResumenDiario(): Promise<boolean> {
  const cfg = await obtenerConfig();
  if (!cfg.resumenActivo || !enviador().conectado()) return false;
  const t = ahora();
  if (!cfg.resumenDias.includes(t.weekday)) return false;
  if (cfg.resumenUltimoEnvio === hoyIso()) return false;
  const hora = t.set({ ...parseHora(cfg.resumenHora), second: 0, millisecond: 0 });
  const min = t.diff(hora, "minutes").minutes;
  if (min < 0 || min > VENTANA_MIN) return false;
  await actualizarConfig({ resumenUltimoEnvio: hoyIso() });
  try {
    const texto = await textoResumen();
    const id = await enviador().enviarTexto(texto);
    await registrarMensaje({ direccion: "saliente", texto, waMessageId: id, intencionDetectada: "resumen_diario" });
    return true;
  } catch (err) {
    await registrar("error", "resumen", "No se pudo enviar el resumen diario", err);
    return false;
  }
}
