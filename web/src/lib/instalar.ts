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

/**
 * Instalar el panel como app de la compu (ícono en la barra de tareas, ventana propia). null si el navegador no lo
 * ofrece o ya está instalado.
 */
export function useInstalar(): (() => Promise<void>) | null {
  const [, refrescar] = useState(0);
  useEffect(() => {
    const o = () => refrescar((n) => n + 1);
    oyentes.add(o);
    return () => void oyentes.delete(o);
  }, []);
  const instalada = typeof window !== "undefined" && window.matchMedia("(display-mode: standalone)").matches;
  if (!guardado || instalada) return null;
  return async () => {
    const e = guardado!;
    guardado = null;
    await e.prompt();
    oyentes.forEach((o) => o());
  };
}
