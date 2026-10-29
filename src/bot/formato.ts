import type { Recordatorio } from "../db/schema.js";
import { ahora, aLocal, formatearCuando } from "../lib/fechas.js";
import { describirRrule } from "../lib/recurrencia.js";
import { describirMinutos } from "../lib/textos.js";

const mayuscula = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "Hoy · 18:30", "Mañana · 9:00", "Viernes 30/10 · 9:00", o "Todos los lunes a las 8:00". */
export function cuandoBonito(r: Pick<Recordatorio, "rrule" | "fechaHora" | "proximaInstancia">): string {
  if (r.rrule) return mayuscula(describirRrule(r.rrule, r.fechaHora));
  const d = aLocal(r.proximaInstancia ?? r.fechaHora).setLocale("es");
  const dias = Math.round(d.startOf("day").diff(ahora().startOf("day"), "days").days);
  const hora = d.toFormat("H:mm");
  if (dias === 0) return `Hoy · ${hora}`;
  if (dias === 1) return `Mañana · ${hora}`;
  const anio = d.year !== ahora().year ? `/${d.year}` : "";
  return `${mayuscula(d.toFormat("cccc dd/MM"))}${anio} · ${hora}`;
}

/** "\n🔔 También te aviso 1 día antes y 1 hora antes" (o vacío). */
export function textoPrevios(r: Pick<Recordatorio, "avisosPreviosMin">): string {
  const previos = [...new Set(r.avisosPreviosMin.filter((m) => m > 0))].sort((a, b) => b - a);
  if (!previos.length) return "";
  const partes = previos.map((m) => `${describirMinutos(m)} antes`);
  const lista = partes.length > 1 ? `${partes.slice(0, -1).join(", ")} y ${partes.at(-1)}` : partes[0];
  return `\n🔔 También te aviso ${lista}`;
}

/** "el viernes 30/10 a las 9:00 (con aviso 1 hora antes)": para listados y el panel. */
export function describirCuando(r: Pick<Recordatorio, "rrule" | "fechaHora" | "proximaInstancia" | "avisosPreviosMin">): string {
  let texto = r.rrule ? describirRrule(r.rrule, r.fechaHora) : formatearCuando(r.proximaInstancia ?? r.fechaHora);
  const previos = r.avisosPreviosMin.filter((m) => m > 0).sort((a, b) => a - b);
  if (previos.length) texto += ` (con aviso ${previos.map((m) => `${describirMinutos(m)} antes`).join(" y ")})`;
  return texto;
}
