import { createContext, useCallback, useContext, useEffect, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { CheckCircle2, Loader2, X, XCircle } from "lucide-react";
import type { EstadoRecordatorio } from "../lib/tipos";

// ───────────── Botón ─────────────
type Variante = "primario" | "secundario" | "peligro" | "fantasma";
const VARIANTES: Record<Variante, string> = {
  primario: "bg-marca-oscuro text-white hover:bg-marca-profundo shadow-sm",
  secundario: "bg-white text-slate-700 border border-slate-300 hover:bg-slate-50 shadow-sm",
  peligro: "bg-white text-red-600 border border-red-200 hover:bg-red-50",
  fantasma: "text-slate-600 hover:bg-slate-100",
};

export function Boton({
  variante = "secundario",
  cargando,
  icono,
  chico,
  className = "",
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variante?: Variante; cargando?: boolean; icono?: ReactNode; chico?: boolean }) {
  return (
    <button
      {...props}
      disabled={props.disabled || cargando}
      className={`inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${
        chico ? "px-2.5 py-1.5 text-xs" : "px-3.5 py-2 text-sm"
      } ${VARIANTES[variante]} ${className}`}
    >
      {cargando ? <Loader2 className="size-4 animate-spin" /> : icono}
      {children}
    </button>
  );
}

// ───────────── Insignias ─────────────
const ESTADOS: Record<EstadoRecordatorio, [string, string]> = {
  activo: ["Activo", "bg-marca-suave text-marca-profundo"],
  pausado: ["Pausado", "bg-amber-50 text-amber-700"],
  cumplido: ["Cumplido", "bg-slate-100 text-slate-600"],
  no_confirmado: ["No confirmado", "bg-red-50 text-red-700"],
  borrado: ["Borrado", "bg-slate-100 text-slate-400"],
};
export function InsigniaEstado({ estado }: { estado: EstadoRecordatorio }) {
  const [txt, cls] = ESTADOS[estado];
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>{txt}</span>;
}

export function Insignia({ children, className = "bg-slate-100 text-slate-600" }: { children: ReactNode; className?: string }) {
  return <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${className}`}>{children}</span>;
}

// ───────────── Interruptor ─────────────
export function Interruptor({
  activo,
  onChange,
  etiqueta,
  ayuda,
}: {
  activo: boolean;
  onChange: (v: boolean) => void;
  etiqueta?: ReactNode;
  ayuda?: ReactNode;
}) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4 py-1">
      <span>
        {etiqueta && <span className="block text-sm font-medium text-slate-800">{etiqueta}</span>}
        {ayuda && <span className="block text-xs text-slate-500">{ayuda}</span>}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={activo}
        onClick={() => onChange(!activo)}
        className={`relative mt-0.5 inline-flex h-6 w-11 shrink-0 rounded-full transition ${activo ? "bg-marca-oscuro" : "bg-slate-300"}`}
      >
        <span className={`absolute top-0.5 size-5 rounded-full bg-white shadow transition ${activo ? "left-5.5" : "left-0.5"}`} />
      </button>
    </label>
  );
}

// ───────────── Modal ─────────────
export function Modal({
  abierto,
  onCerrar,
  titulo,
  children,
  pie,
  ancho = "max-w-2xl",
}: {
  abierto: boolean;
  onCerrar: () => void;
  titulo: ReactNode;
  children: ReactNode;
  pie?: ReactNode;
  ancho?: string;
}) {
  useEffect(() => {
    if (!abierto) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onCerrar();
    window.addEventListener("keydown", esc);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", esc);
      document.body.style.overflow = "";
    };
  }, [abierto, onCerrar]);
  if (!abierto) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 sm:items-center sm:p-4" onMouseDown={onCerrar}>
      <div
        className={`flex max-h-[92dvh] w-full ${ancho} flex-col rounded-t-2xl bg-white shadow-xl sm:rounded-2xl`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3.5">
          <h2 className="text-base font-semibold text-slate-900">{titulo}</h2>
          <button onClick={onCerrar} className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600" aria-label="Cerrar">
            <X className="size-5" />
          </button>
        </div>
        <div className="overflow-y-auto px-5 py-4">{children}</div>
        {pie && <div className="flex flex-wrap justify-end gap-2 border-t border-slate-200 px-5 py-3">{pie}</div>}
      </div>
    </div>
  );
}

// ───────────── Estados vacíos / cargando ─────────────
export function Cargando({ texto = "Cargando…" }: { texto?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-10 text-sm text-slate-500">
      <Loader2 className="size-4 animate-spin" /> {texto}
    </div>
  );
}

export function Vacio({ icono, titulo, texto, accion }: { icono?: ReactNode; titulo: string; texto?: string; accion?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-4 py-10 text-center">
      {icono && <div className="mb-3 text-slate-300">{icono}</div>}
      <p className="text-sm font-medium text-slate-700">{titulo}</p>
      {texto && <p className="mt-1 max-w-sm text-sm text-slate-500">{texto}</p>}
      {accion && <div className="mt-4">{accion}</div>}
    </div>
  );
}

export function Encabezado({ titulo, subtitulo, acciones }: { titulo: string; subtitulo?: ReactNode; acciones?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-slate-900 sm:text-2xl">{titulo}</h1>
        {subtitulo && <p className="mt-0.5 text-sm text-slate-500">{subtitulo}</p>}
      </div>
      {acciones && <div className="flex flex-wrap gap-2">{acciones}</div>}
    </div>
  );
}

// ───────────── Avisos (toasts) ─────────────
type Aviso = { id: number; texto: string; tipo: "ok" | "error" };
const CtxAvisos = createContext<(texto: string, tipo?: "ok" | "error") => void>(() => {});
export const useAviso = () => useContext(CtxAvisos);

export function ProveedorAvisos({ children }: { children: ReactNode }) {
  const [avisos, setAvisos] = useState<Aviso[]>([]);
  const avisar = useCallback((texto: string, tipo: "ok" | "error" = "ok") => {
    const id = Date.now() + Math.random();
    setAvisos((a) => [...a, { id, texto, tipo }]);
    setTimeout(() => setAvisos((a) => a.filter((x) => x.id !== id)), tipo === "error" ? 6000 : 3500);
  }, []);
  return (
    <CtxAvisos.Provider value={avisar}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-20 z-[60] flex flex-col items-center gap-2 px-4 md:bottom-6">
        {avisos.map((a) => (
          <div
            key={a.id}
            className={`pointer-events-auto flex max-w-md items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium shadow-lg ${
              a.tipo === "ok" ? "bg-slate-900 text-white" : "bg-red-600 text-white"
            }`}
          >
            {a.tipo === "ok" ? <CheckCircle2 className="size-4 text-marca" /> : <XCircle className="size-4" />}
            {a.texto}
          </div>
        ))}
      </div>
    </CtxAvisos.Provider>
  );
}

/** Ejecuta una acción mostrando el resultado en un aviso. */
export function useAccion() {
  const avisar = useAviso();
  return useCallback(
    async <T,>(fn: () => Promise<T>, ok?: string): Promise<T | undefined> => {
      try {
        const r = await fn();
        if (ok) avisar(ok);
        return r;
      } catch (e) {
        avisar(e instanceof Error ? e.message : "Algo salió mal", "error");
        return undefined;
      }
    },
    [avisar],
  );
}
