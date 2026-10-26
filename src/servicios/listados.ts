import { DateTime } from "luxon";
import { ahora, aLocal, formatearHora, nombreDia } from "../lib/fechas.js";
import { describirRrule } from "../lib/recurrencia.js";
import type { Recordatorio } from "../db/schema.js";
import { eventosEntre, pendientesSinConfirmar, recordatoriosActivos, type Evento } from "./recordatorios.js";

export type Rango = { desde: Date; hasta: Date; etiqueta: string };

export function rangoDia(dia: DateTime, etiqueta: string): Rango {
  return { desde: dia.startOf("day").toJSDate(), hasta: dia.endOf("day").toJSDate(), etiqueta };
}
export const rangoHoy = () => rangoDia(ahora(), "hoy");
export const rangoManana = () => rangoDia(ahora().plus({ days: 1 }), "mañana");
export const rangoSemana = (): Rango => ({
  desde: ahora().toJSDate(),
  hasta: ahora().plus({ days: 7 }).endOf("day").toJSDate(),
  etiqueta: "los próximos 7 días",
});

const icono = (r: Recordatorio) => (r.rrule ? "🔁" : r.adjuntoId ? "📎" : "•");

/** Lista agrupada por día, en formato WhatsApp. */
export function formatearEventos(eventos: Evento[], agruparPorDia: boolean): string {
  if (!agruparPorDia) return eventos.map((e) => `${icono(e.recordatorio)} ${formatearHora(aLocal(e.cuando))} — ${e.recordatorio.titulo}`).join("\n");
  const grupos = new Map<string, Evento[]>();
  for (const e of eventos) {
    const d = aLocal(e.cuando);
    const clave = d.toISODate()!;
    if (!grupos.has(clave)) grupos.set(clave, []);
    grupos.get(clave)!.push(e);
  }
  const hoy = ahora().toISODate();
  const manana = ahora().plus({ days: 1 }).toISODate();
  return [...grupos.entries()]
    .map(([clave, evs]) => {
      const d = DateTime.fromISO(clave);
      const nombre = clave === hoy ? "Hoy" : clave === manana ? "Mañana" : `${nombreDia(d.weekday)[0].toUpperCase()}${nombreDia(d.weekday).slice(1)} ${d.toFormat("dd/MM")}`;
      return `*${nombre}*\n${formatearEventos(evs, false)}`;
    })
    .join("\n\n");
}

export async function textoListado(rango: Rango): Promise<string> {
  const eventos = await eventosEntre(rango.desde, rango.hasta);
  const multiDia = aLocal(rango.desde).toISODate() !== aLocal(rango.hasta).toISODate();
  if (!eventos.length) return `No tenés nada para ${rango.etiqueta} 🙌`;
  return `📋 Para ${rango.etiqueta}:\n\n${formatearEventos(eventos, multiDia)}`;
}

export async function textoTodos(): Promise<string> {
  const recs = (await recordatoriosActivos()).filter((r) => r.estado === "activo" || r.estado === "pausado");
  if (!recs.length) return "No tenés recordatorios activos 🙌";
  const lineas = recs.slice(0, 40).map((r) => {
    const cuando = r.proximaInstancia ?? r.fechaHora;
    const d = aLocal(cuando);
    const repe = r.rrule ? ` (${describirRrule(r.rrule, r.fechaHora)})` : "";
    const pausa = r.estado === "pausado" ? " ⏸️ pausado" : "";
    return `${icono(r)} *${r.titulo}* — ${d.toFormat("dd/MM H:mm")}${repe}${pausa}`;
  });
  const extra = recs.length > 40 ? `\n…y ${recs.length - 40} más (los ves en el panel).` : "";
  return `📋 Tus recordatorios activos (${recs.length}):\n\n${lineas.join("\n")}${extra}`;
}

export async function textoPendientes(): Promise<string> {
  const ps = await pendientesSinConfirmar();
  if (!ps.length) return "";
  return `\n\n⚠️ Sin confirmar:\n${ps.map((p) => `• ${p.recordatorio.titulo}`).join("\n")}`;
}
