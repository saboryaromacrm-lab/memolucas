import { useEffect, useState } from "react";

type EventoInstalar = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };

let guardado: EventoInstalar | null = null;
const oyentes = new Set<() => void>();
if (typeof window !== "undefined")
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    guardado = e as EventoInstalar;
    oyentes.forEach((o) => o());
  });

/** Abierta como app instalada (ventana propia, sin la barra del navegador). */
export const comoAppInstalada = () => typeof window !== "undefined" && window.matchMedia("(display-mode: standalone)").matches;

/**
 * Instalar como app de la compu o del celular (ícono propio, ventana propia): la del manifiesto de la página (el panel,
 * o el Bloc en /app/bloc). null si el navegador no lo ofrece o ya está instalada.
 */
export function useInstalar(): (() => Promise<void>) | null {
  const [, refrescar] = useState(0);
  useEffect(() => {
    const o = () => refrescar((n) => n + 1);
    oyentes.add(o);
    return () => void oyentes.delete(o);
  }, []);
  if (!guardado || comoAppInstalada()) return null;
  return async () => {
    const e = guardado!;
    guardado = null;
    await e.prompt();
    oyentes.forEach((o) => o());
  };
}
