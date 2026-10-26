import { useCallback, useEffect, useRef, useState } from "react";
import { get } from "./api";

export type TipoCambio = "recordatorios" | "whatsapp" | "configuracion" | "mensajes" | "logs";
type Oyente = (tipo: TipoCambio, datos: unknown) => void;

// Una sola conexión SSE para toda la app; se reconecta sola.
const oyentes = new Set<Oyente>();
let fuente: EventSource | null = null;
let conectadoVivo = false;
const oyentesConexion = new Set<(v: boolean) => void>();

function abrir() {
  if (fuente) return;
  fuente = new EventSource("/api/eventos");
  fuente.addEventListener("cambio", (e) => {
    const { tipo, datos } = JSON.parse((e as MessageEvent).data);
    oyentes.forEach((o) => o(tipo, datos));
  });
  fuente.onopen = () => {
    conectadoVivo = true;
    oyentesConexion.forEach((o) => o(true));
    // Al reconectar, refrescar todo por si se perdió algún aviso.
    (["recordatorios", "whatsapp", "configuracion", "mensajes", "logs"] as TipoCambio[]).forEach((t) => oyentes.forEach((o) => o(t, null)));
  };
  fuente.onerror = () => {
    conectadoVivo = false;
    oyentesConexion.forEach((o) => o(false));
  };
}

export function cerrarVivo() {
  fuente?.close();
  fuente = null;
}

export function useCambios(tipos: TipoCambio[], fn: (tipo: TipoCambio, datos: unknown) => void) {
  const ref = useRef(fn);
  ref.current = fn;
  const clave = tipos.join(",");
  useEffect(() => {
    abrir();
    const o: Oyente = (t, d) => {
      if (clave.split(",").includes(t)) ref.current(t, d);
    };
    oyentes.add(o);
    return () => {
      oyentes.delete(o);
    };
  }, [clave]);
}

export function useConexionVivo() {
  const [v, setV] = useState(conectadoVivo);
  useEffect(() => {
    abrir();
    oyentesConexion.add(setV);
    return () => {
      oyentesConexion.delete(setV);
    };
  }, []);
  return v;
}

/** Carga datos de la API y los vuelve a cargar solos cuando cambian (sin recargar la página). */
export function useDatos<T>(ruta: string | null, tipos: TipoCambio[]) {
  const [datos, setDatos] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(true);
  const rutaRef = useRef(ruta);
  rutaRef.current = ruta;

  const recargar = useCallback(async () => {
    const r = rutaRef.current;
    if (!r) return;
    try {
      const d = await get<T>(r);
      if (rutaRef.current === r) {
        setDatos(d);
        setError(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error");
    } finally {
      setCargando(false);
    }
  }, []);

  useEffect(() => {
    setCargando(true);
    void recargar();
  }, [ruta, recargar]);

  // Agrupa varios avisos seguidos en una sola recarga.
  const t = useRef<ReturnType<typeof setTimeout> | null>(null);
  useCambios(tipos, () => {
    if (t.current) clearTimeout(t.current);
    t.current = setTimeout(() => void recargar(), 250);
  });

  useEffect(() => {
    const alVolver = () => document.visibilityState === "visible" && void recargar();
    document.addEventListener("visibilitychange", alVolver);
    return () => document.removeEventListener("visibilitychange", alVolver);
  }, [recargar]);

  return { datos, error, cargando, recargar, setDatos };
}
