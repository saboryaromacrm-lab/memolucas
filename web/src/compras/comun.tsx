import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, X } from "lucide-react";
import { get } from "../lib/api";

export const plata = (n: number | string | null, moneda = "PES") =>
  n === null ? "—" : `${moneda === "DOL" ? "US$" : "$"} ${Number(n).toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** Números como se escriben en Argentina: "14.000" → 14000, "1.234,56" → 1234.56, "3,5" o "3.5" → 3.5 (0 si no es un número). */
export function aNumero(s: string): number {
  const t = s.replace(/[\s$]/g, "");
  if (!t) return 0;
  // Con coma, los puntos son de miles. Sin coma, "14.000" o "1.250.000" también (grupos de 3 cifras).
  const miles = t.includes(",") || /^[1-9]\d{0,2}(\.\d{3})+$/.test(t);
  const n = Number(miles ? t.replace(/\./g, "").replace(",", ".") : t);
  return Number.isFinite(n) ? n : 0;
}
export const fechaCorta = (iso: string | null | undefined) => (iso && /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso.split("-").reverse().join("/") : iso || "—");

// ───────────── Datos en vivo ─────────────

// Una sola conexión de avisos (SSE) para todo el panel, aunque haya varias pantallas abiertas.
const oyentes = new Set<() => void>();
let fuente: EventSource | null = null;
function escucharCambios(fn: () => void) {
  oyentes.add(fn);
  if (!fuente) {
    fuente = new EventSource("/api/c/eventos");
    fuente.addEventListener("cambio", () => oyentes.forEach((o) => o()));
    // Al reconectar, se recarga todo por si se perdió algún aviso.
    fuente.onopen = () => oyentes.forEach((o) => o());
  }
  return () => {
    oyentes.delete(fn);
    if (!oyentes.size) {
      fuente?.close();
      fuente = null;
    }
  };
}

/** Datos de la API que se recargan solos cuando cambia algo y al volver a la app. */
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
    setDatos(null);
    void recargar();
    if (!ruta) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    const dejar = escucharCambios(() => {
      clearTimeout(t);
      t = setTimeout(() => void recargar(), 300);
    });
    const visible = () => document.visibilityState === "visible" && void recargar();
    document.addEventListener("visibilitychange", visible);
    return () => {
      dejar();
      clearTimeout(t);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [ruta, recargar]);
  return { datos, recargar };
}

/** Una elección que se recuerda en este navegador (ej. la pestaña). Si lo guardado no es un valor posible, vale el primero. */
export function useRecordado<T extends string>(clave: string, posibles: readonly T[]): [T, (v: T) => void] {
  const [valor, setValor] = useState<T>(() => {
    try {
      const guardado = localStorage.getItem(clave);
      return posibles.find((p) => p === guardado) ?? posibles[0];
    } catch {
      return posibles[0];
    }
  });
  const elegir = useCallback(
    (v: T) => {
      setValor(v);
      try {
        localStorage.setItem(clave, v);
      } catch {
        // Sin almacenamiento: se recuerda solo mientras está abierta.
      }
    },
    [clave],
  );
  return [valor, elegir];
}

// ───────────── Tamaño de pantalla ─────────────

/** movil: menos de 768 px · tablet: hasta 1279 px (el detalle va encima) · pc: desde 1280 px (el detalle va al costado). */
export type Ancho = "movil" | "tablet" | "pc";
const consultas = { pc: "(min-width: 1280px)", tablet: "(min-width: 768px)" };
const medir = (): Ancho => (matchMedia(consultas.pc).matches ? "pc" : matchMedia(consultas.tablet).matches ? "tablet" : "movil");

export function useAncho(): Ancho {
  const [ancho, setAncho] = useState(medir);
  useEffect(() => {
    const listas = Object.values(consultas).map((q) => matchMedia(q));
    const cambio = () => setAncho(medir());
    listas.forEach((l) => l.addEventListener("change", cambio));
    return () => listas.forEach((l) => l.removeEventListener("change", cambio));
  }, []);
  return ancho;
}

// ───────────── Escape y atajos ─────────────

// Escape cierra solo lo que está más arriba (el visor antes que la factura, por ejemplo).
const pila: { current: () => void }[] = [];
if (typeof window !== "undefined")
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && pila.length) {
      e.preventDefault();
      pila.at(-1)!.current();
    }
  });

export function useEscape(fn: () => void) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    pila.push(ref);
    return () => void pila.splice(pila.indexOf(ref), 1);
  }, []);
}

/** ¿Se está escribiendo o hay una ventana arriba? Entonces los atajos de teclado no actúan. */
export const atajosBloqueados = (e: KeyboardEvent) =>
  !!(e.target as HTMLElement | null)?.closest("input, textarea, select, [contenteditable]") || !!document.querySelector("[data-modal]");

// ───────────── Detalle (al costado o encima) ─────────────

/**
 * Contenedor del detalle de una factura o un producto.
 * pc: panel al costado de la lista · tablet: hoja que entra desde la derecha · móvil: pantalla completa.
 */
export function Hoja({
  ancho,
  titulo,
  subtitulo,
  acciones,
  pie,
  onCerrar,
  children,
}: {
  ancho: Ancho;
  titulo: ReactNode;
  subtitulo?: ReactNode;
  acciones?: ReactNode;
  pie?: ReactNode;
  onCerrar: () => void;
  children: ReactNode;
}) {
  useEscape(onCerrar);
  const movil = ancho === "movil";
  const cuerpo = (
    <div className={`flex min-h-0 flex-col bg-[#faf5ee] ${movil ? "h-dvh" : "h-full"}`}>
      <header
        className={`flex shrink-0 items-center gap-2 ${movil ? "bg-cafe px-2 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))] text-beige shadow-md" : "border-b border-stone-200 bg-white px-4 py-3"}`}
      >
        {movil && (
          <button aria-label="Volver" onClick={onCerrar} className="rounded-lg p-1.5 hover:bg-white/10">
            <ChevronLeft className="size-6" />
          </button>
        )}
        <div className="min-w-0 flex-1">
          <div className={`truncate font-semibold ${movil ? "" : "text-stone-900"}`}>{titulo}</div>
          {subtitulo && <div className={`truncate text-xs ${movil ? "text-beige/70" : "text-stone-500"}`}>{subtitulo}</div>}
        </div>
        {acciones}
        {!movil && (
          <button aria-label="Cerrar" title="Cerrar (Esc)" onClick={onCerrar} className="rounded-lg p-1.5 text-stone-400 hover:bg-stone-100 hover:text-stone-700">
            <X className="size-5" />
          </button>
        )}
      </header>
      <div className="@container min-h-0 flex-1 overflow-y-auto">{children}</div>
      {pie && <div className="shrink-0 border-t border-stone-200 bg-white px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3">{pie}</div>}
    </div>
  );
  if (ancho === "pc") return <aside className="h-full min-h-0 overflow-hidden rounded-2xl border border-stone-200 shadow-sm">{cuerpo}</aside>;
  if (movil)
    return (
      <div data-superpuesto className="fixed inset-0 z-40">
        {cuerpo}
      </div>
    );
  return (
    <div data-superpuesto className="fixed inset-0 z-40 flex justify-end bg-stone-900/30" onMouseDown={onCerrar}>
      <div className="h-full w-full max-w-2xl shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        {cuerpo}
      </div>
    </div>
  );
}

/** Ventana arriba de todo (corregir, visor): pantalla completa en el celular, centrada en la compu. */
export function Ventana({ titulo, onCerrar, pie, children, ancho = "max-w-5xl" }: { titulo: ReactNode; onCerrar: () => void; pie?: ReactNode; children: ReactNode; ancho?: string }) {
  useEscape(onCerrar);
  return (
    <div data-modal data-superpuesto className="fixed inset-0 z-50 flex bg-stone-900/40 md:items-center md:justify-center md:p-6" onMouseDown={onCerrar}>
      <div className={`flex h-full w-full flex-col bg-[#faf5ee] md:h-auto md:max-h-[92dvh] md:rounded-2xl md:shadow-2xl ${ancho}`} onMouseDown={(e) => e.stopPropagation()}>
        <header className="flex shrink-0 items-center gap-2 bg-cafe px-2 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))] text-beige md:rounded-t-2xl md:px-4 md:pt-3">
          <span className="flex-1 truncate font-semibold">{titulo}</span>
          <button aria-label="Cerrar" title="Cerrar (Esc)" onClick={onCerrar} className="rounded-lg p-1.5 hover:bg-white/10">
            <X className="size-6 md:size-5" />
          </button>
        </header>
        <div className="@container min-h-0 flex-1 overflow-y-auto">{children}</div>
        {pie && <div className="shrink-0 border-t border-stone-200 bg-white px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 md:rounded-b-2xl md:pb-3">{pie}</div>}
      </div>
    </div>
  );
}
