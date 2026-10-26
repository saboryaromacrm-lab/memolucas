import rrulePkg from "rrule";
import { DateTime } from "luxon";
import { aLocal, formatearHora, zona } from "./fechas.js";

const { RRule } = rrulePkg;
type Opciones = ReturnType<typeof RRule.parseString>;

// rrule trabaja en "hora flotante": guardamos la hora local en los campos UTC de un Date.
const aFlotante = (d: DateTime) =>
  new Date(Date.UTC(d.year, d.month - 1, d.day, d.hour, d.minute, d.second));
const desdeFlotante = (d: Date) =>
  DateTime.fromObject(
    {
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      day: d.getUTCDate(),
      hour: d.getUTCHours(),
      minute: d.getUTCMinutes(),
      second: d.getUTCSeconds(),
    },
    { zone: zona() },
  );

/** Limpia una regla: saca "RRULE:", DTSTART y espacios. Devuelve null si no es válida. */
export function normalizarRrule(texto: string | null | undefined): string | null {
  if (!texto) return null;
  const partes = texto
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.toUpperCase().startsWith("DTSTART"))
    .map((l) => l.replace(/^RRULE:/i, ""));
  const regla = partes.join(";").replace(/\s+/g, "").replace(/;+$/, "");
  if (!regla) return null;
  try {
    const op = RRule.parseString(regla);
    if (op.freq === undefined || op.freq === null) return null;
    // UNTIL/COUNT se respetan; TZID no se usa (siempre hora local).
    delete (op as Partial<Opciones>).tzid;
    return RRule.optionsToString(op).replace(/^RRULE:/, "");
  } catch {
    return null;
  }
}

function crearRegla(regla: string, dtstart: Date) {
  const op = RRule.parseString(regla);
  return new RRule({ ...op, dtstart: aFlotante(aLocal(dtstart)), tzid: null });
}

/** Próxima instancia de la regla después de `despuesDe` (o igual si inclusive). */
export function siguienteInstancia(regla: string, dtstart: Date, despuesDe: Date, inclusive = false): Date | null {
  const r = crearRegla(regla, dtstart);
  const sig = r.after(aFlotante(aLocal(despuesDe)), inclusive);
  return sig ? desdeFlotante(sig).toJSDate() : null;
}

export function instanciasEntre(regla: string, dtstart: Date, desde: Date, hasta: Date, max = 500): Date[] {
  const r = crearRegla(regla, dtstart);
  return r
    .between(aFlotante(aLocal(desde)), aFlotante(aLocal(hasta)), true, (_d, i) => i < max)
    .map((d) => desdeFlotante(d).toJSDate());
}

const DIAS_RR = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
const DIAS_TXT = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábados", "domingos"];
const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

const lista = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} y ${xs.at(-1)}`);

/** Descripción en castellano: "todos los lunes a las 8:00", "el 10 de cada mes a las 9:00". */
export function describirRrule(regla: string, dtstart: Date): string {
  let op: Opciones;
  try {
    op = RRule.parseString(regla);
  } catch {
    return "con repetición personalizada";
  }
  const inicio = aLocal(dtstart);
  const h = op.byhour !== undefined && op.byhour !== null ? ([] as number[]).concat(op.byhour as number | number[]) : [];
  const m = op.byminute !== undefined && op.byminute !== null ? ([] as number[]).concat(op.byminute as number | number[]) : [];
  const hora = h.length
    ? `a las ${lista(h.map((x) => formatearHora(inicio.set({ hour: x, minute: m[0] ?? inicio.minute }))))}`
    : `a las ${formatearHora(inicio)}`;
  const n = op.interval && op.interval > 1 ? op.interval : 1;
  const dias = op.byweekday
    ? ([] as unknown[])
        .concat(op.byweekday)
        .map((d) => {
          const s = String(d);
          const i = typeof d === "number" ? d : DIAS_RR.indexOf(s.slice(-2));
          return DIAS_TXT[i] ?? s;
        })
    : [];
  const bymonthday = op.bymonthday !== undefined && op.bymonthday !== null ? ([] as number[]).concat(op.bymonthday as number | number[]) : [];
  let base: string;
  switch (op.freq) {
    case RRule.MINUTELY:
      base = n === 1 ? "cada minuto" : `cada ${n} minutos`;
      return base;
    case RRule.HOURLY:
      return n === 1 ? "cada hora" : `cada ${n} horas`;
    case RRule.DAILY:
      base = n === 1 ? "todos los días" : `cada ${n} días`;
      break;
    case RRule.WEEKLY: {
      const d = dias.length ? dias : [DIAS_TXT[inicio.weekday - 1]];
      const todos = d.length === 5 && !d.includes("sábados") && !d.includes("domingos");
      base = todos ? "de lunes a viernes" : n === 1 ? `todos los ${lista(d)}` : `cada ${n} semanas los ${lista(d)}`;
      if (todos && n > 1) base = `cada ${n} semanas de lunes a viernes`;
      break;
    }
    case RRule.MONTHLY: {
      const dia = bymonthday.length ? lista(bymonthday.map(String)) : String(inicio.day);
      base = n === 1 ? `el ${dia} de cada mes` : `el ${dia} cada ${n} meses`;
      if (dias.length) base = n === 1 ? `todos los meses (${lista(dias)})` : `cada ${n} meses (${lista(dias)})`;
      break;
    }
    case RRule.YEARLY: {
      const mes = op.bymonth ? ([] as number[]).concat(op.bymonth as number | number[])[0] : inicio.month;
      const dia = bymonthday[0] ?? inicio.day;
      base = `todos los años el ${dia} de ${MESES[mes - 1]}`;
      break;
    }
    default:
      return "con repetición personalizada";
  }
  let texto = `${base} ${hora}`;
  if (op.count) texto += ` (${op.count} veces)`;
  if (op.until) texto += ` hasta el ${desdeFlotante(op.until).toFormat("dd/MM/yyyy")}`;
  return texto;
}
