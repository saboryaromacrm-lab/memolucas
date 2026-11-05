import { useCallback, useEffect, useState } from "react";
import { get } from "../lib/api";

export const plata = (n: number | string | null, moneda = "PES") =>
  n === null ? "—" : `${moneda === "DOL" ? "US$" : "$"} ${Number(n).toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const fechaCorta = (iso: string | null | undefined) => (iso && /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso.split("-").reverse().join("/") : iso || "—");

/** Datos en vivo: se recargan solos cuando cambia algo (SSE) y al volver a la app. */
export function useVivo<T>(ruta: string | null) {
  const [datos, setDatos] = useState<T | null>(null);
  const recargar = useCallback(async () => {
    if (!ruta) return;
    try {
      setDatos(await get<T>(ruta));
    } catch {
      // Sin señal: queda lo último que se vio.
    }
  }, [ruta]);
  useEffect(() => {
    void recargar();
    if (!ruta) return;
    const fuente = new EventSource("/api/c/eventos");
    let t: ReturnType<typeof setTimeout> | undefined;
    fuente.addEventListener("cambio", () => {
      clearTimeout(t);
      t = setTimeout(() => void recargar(), 300);
    });
    fuente.onopen = () => void recargar();
    const visible = () => document.visibilityState === "visible" && void recargar();
    document.addEventListener("visibilitychange", visible);
    return () => {
      fuente.close();
      clearTimeout(t);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [ruta, recargar]);
  return { datos, recargar };
}
