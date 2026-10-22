import { DateTime } from "luxon";

let ZONA = "America/Argentina/Buenos_Aires";
export const fijarZona = (z: string) => {
  if (DateTime.now().setZone(z).isValid) ZONA = z;
};
export const zona = () => ZONA;

export const enZona = (d: string | Date) => (typeof d === "string" ? DateTime.fromISO(d) : DateTime.fromJSDate(d)).setZone(ZONA).setLocale("es");
export const ahora = () => DateTime.now().setZone(ZONA).setLocale("es");

export const hora = (d: string | Date) => enZona(d).toFormat("H:mm");
export const fechaCorta = (d: string | Date) => enZona(d).toFormat("dd/MM");
export const fechaHora = (d: string | Date) => enZona(d).toFormat("dd/MM/yyyy H:mm");

/** "Hoy 9:00", "Mañana 18:30", "vie 24/10 9:00". */
export function cuandoCorto(d: string | Date): string {
  const f = enZona(d);
  const dias = Math.round(f.startOf("day").diff(ahora().startOf("day"), "days").days);
  if (dias === 0) return `Hoy ${f.toFormat("H:mm")}`;
  if (dias === 1) return `Mañana ${f.toFormat("H:mm")}`;
  if (dias === -1) return `Ayer ${f.toFormat("H:mm")}`;
  return f.toFormat(f.year === ahora().year ? "ccc dd/MM H:mm" : "dd/MM/yyyy H:mm");
}

export function haceCuanto(d: string | Date): string {
  const f = enZona(d);
  return f.toRelative({ locale: "es" }) ?? f.toFormat("dd/MM H:mm");
}

/** Para <input type="date"> y <input type="time"> en la zona de la app. */
export const aInputs = (d: string | Date) => {
  const f = enZona(d);
  return { fecha: f.toFormat("yyyy-MM-dd"), hora: f.toFormat("HH:mm") };
};
export const desdeInputs = (fecha: string, hora: string) => DateTime.fromISO(`${fecha}T${hora || "09:00"}`, { zone: ZONA });
