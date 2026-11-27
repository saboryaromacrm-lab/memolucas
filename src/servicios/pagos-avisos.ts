import { analizarMesPagos } from "../bot/ia-pagos.js";
import { ahora, hoyIso } from "../lib/fechas.js";
import { registrar } from "../lib/log.js";
import { plata } from "../lib/textos.js";
import { actualizarConfig, obtenerConfig } from "./configuracion.js";
import { enFila } from "./disparador.js";
import { enviador } from "./enviador.js";
import { registrarMensaje } from "./mensajes.js";
import { marcarAvisado, pagosParaAvisar, verMes, type ItemPago } from "./pagos.js";
import { nombreMes, periodoDe, sumarMeses } from "./pagos-reglas.js";
import { cuandoVence, diaDe, diasParaVencer, momentoAviso, sePuedeAvisar } from "./vencimientos.js";

// Los mensajes de Pagos por WhatsApp: lo que vence (de los fijos: las suscripciones y las tarjetas ya avisan solas),
// el resumen del día 1 (con el análisis de la IA del mes que cerró) y lo que falta a mitad de mes.

/** El mensaje del día 1 sale hasta el 5 (si la app estuvo apagada); el de mitad de mes, del 15 al 20. */
const DIAS_INICIO = 5;
const DIAS_MITAD = [15, 20];

const montos = (t: { ARS: number; USD: number }) => [t.ARS || !t.USD ? plata(t.ARS) : "", t.USD ? plata(t.USD, "USD") : ""].filter(Boolean).join(" + ");
const vto = (vence: string | null) => (vence ? cuandoVence(vence) : "sin vencimiento");
const linea = (i: ItemPago) => `• ${i.nombre} · ${i.lugar} — ${plata(i.falta || i.monto, i.moneda)}`;

async function mandar(texto: string, intencion: string) {
  const id = await enFila(() => enviador().enviarTexto(texto));
  await registrarMensaje({ direccion: "saliente", texto, waMessageId: id, chat: null, intencionDetectada: intencion });
}

/** Lo llama el barrido: avisa N días antes y el día que vence, todo junto en un mensaje. */
export async function avisarPagos(): Promise<void> {
  const cfg = await obtenerConfig();
  if (!sePuedeAvisar(cfg)) return;
  const ya = new Date();
  const hoyVencen: ItemPago[] = [];
  const pronto: ItemPago[] = [];
  const marcar: [number, "previo" | "dia"][] = [];
  for (const { fila, item, avisoDias } of await pagosParaAvisar()) {
    const dias = avisoDias ?? cfg.pagosDiasAviso;
    const vence = item.vence;
    if (dias < 0 || !vence) continue; // Sin vencimiento no hay "vence en 3 días".
    const faltan = diasParaVencer(vence);
    if (!fila.avisoDiaEnviado && momentoAviso(vence, 0, cfg) <= ya) {
      // Lo que venció hace más de un día (un pago que se cargó tarde) no se avisa: se ve en el panel.
      if (faltan >= -1) hoyVencen.push(item);
      marcar.push([fila.id, "dia"]);
    } else if (!fila.avisoPrevioEnviado && dias > 0 && faltan > 0 && momentoAviso(vence, dias, cfg) <= ya) {
      pronto.push(item);
      marcar.push([fila.id, "previo"]);
    }
  }
  if (hoyVencen.length || pronto.length) {
    const partes = [
      hoyVencen.length && `💸 *${hoyVencen.length === 1 ? "Vence hoy" : "Vencen hoy"}:*\n${hoyVencen.map((i) => `${linea(i)}${i.vence && diasParaVencer(i.vence) < 0 ? " (venció ayer)" : ""}`).join("\n")}`,
      pronto.length && `🗓️ *${pronto.length === 1 ? "Vence pronto" : "Vencen pronto"}:*\n${pronto.map((i) => `${linea(i)} · ${vto(i.vence)}`).join("\n")}`,
      "_Cuando pagues, decime «pagué la luz del Express 1» o mandame el comprobante._",
    ];
    try {
      await mandar(partes.filter(Boolean).join("\n\n"), "aviso_pago");
    } catch (err) {
      return void (await registrar("error", "pagos", "No se pudo avisar lo que vence", err));
    }
  }
  for (const [id, cual] of marcar) await marcarAvisado(id, cual);
}

/** Lo llama el barrido: el resumen del día 1 y lo que falta a mitad de mes (una vez por mes cada uno). */
export async function mensajesDelMesPagos(): Promise<void> {
  const cfg = await obtenerConfig();
  if (!cfg.pagosMensajes || !sePuedeAvisar(cfg)) return;
  const t = ahora();
  const periodo = periodoDe(hoyIso());
  if (momentoAviso(hoyIso(), 0, cfg) > new Date()) return; // Antes de la hora por defecto, nada.

  if (t.day <= DIAS_INICIO && cfg.pagosMensajeInicio !== periodo) {
    await actualizarConfig({ pagosMensajeInicio: periodo });
    const mes = await verMes(periodo);
    if (!mes.items.length) return;
    const anterior = sumarMeses(periodo, -1);
    let cierre = "";
    try {
      if ((await verMes(anterior)).items.length) cierre = `🧾 *Cómo cerró ${nombreMes(anterior)}:*\n${await analizarMesPagos(anterior)}\n\n`;
    } catch (err) {
      await registrar("aviso", "pagos", "No se pudo hacer el análisis del mes con IA", err);
    }
    const vivos = mes.items.filter((i) => i.estado !== "omitido");
    const grandes = [...vivos].sort((a, b) => b.monto - a.monto).slice(0, 3);
    const primeros = vivos.filter((i) => i.estado !== "pagado").slice(0, 5);
    const texto =
      `${cierre}📅 *Pagos de ${mes.nombre}:* ${vivos.length} por ${montos(mes.totales.total)}.\n` +
      `Los más grandes: ${grandes.map((i) => `${i.nombre} · ${i.lugar} (${plata(i.monto, i.moneda)})`).join(", ")}.\n\n` +
      `*Para pagar:*\n${primeros.map((i) => `• ${i.vence ? diaDe(i.vence).toFormat("dd/MM") : "Sin vto."} ${i.nombre} · ${i.lugar} — ${plata(i.monto, i.moneda)}`).join("\n")}`;
    return mandar(texto, "pagos_mes").catch((err) => registrar("error", "pagos", "No se pudo mandar el resumen del mes", err));
  }

  if (t.day >= DIAS_MITAD[0] && t.day <= DIAS_MITAD[1] && cfg.pagosMensajeMitad !== periodo) {
    await actualizarConfig({ pagosMensajeMitad: periodo });
    const mes = await verMes(periodo);
    if (!mes.items.length) return;
    const faltan = mes.items.filter((i) => i.estado === "pendiente" || i.estado === "parcial");
    const texto = faltan.length
      ? `🧾 *A mitad de mes te falta pagar ${montos(mes.totales.falta)}:*\n${faltan.map((i) => `${linea(i)} · ${vto(i.vence)}`).join("\n")}`
      : `✅ Vas al día: ya pagaste todo lo de ${mes.nombre}.`;
    return mandar(texto, "pagos_mitad").catch((err) => registrar("error", "pagos", "No se pudo mandar lo que falta del mes", err));
  }
}
