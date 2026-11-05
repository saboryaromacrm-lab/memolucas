import { useEffect, useRef, useState } from "react";
import { ExternalLink, Maximize, RotateCw, X, ZoomIn, ZoomOut } from "lucide-react";
import { useEscape } from "./comun";

const MIN = 1;
const MAX = 6;
const limitar = (n: number) => Math.min(MAX, Math.max(MIN, n));

/**
 * Foto a pantalla completa. Compu: rueda para zoom, arrastrar para moverla, R para rotar, 0 para volver.
 * Celular: pellizcar para zoom y arrastrar con un dedo.
 */
export function Visor({ url, onCerrar }: { url: string; onCerrar: () => void }) {
  useEscape(onCerrar);
  const [escala, setEscala] = useState(1);
  const [giro, setGiro] = useState(0);
  const [mov, setMov] = useState({ x: 0, y: 0 });
  const zona = useRef<HTMLDivElement>(null);
  const punteros = useRef(new Map<number, { x: number; y: number }>());
  const pellizco = useRef<{ distancia: number; escala: number } | null>(null);

  const zoom = (factor: number) =>
    setEscala((e) => {
      const nueva = limitar(e * factor);
      if (nueva === MIN) setMov({ x: 0, y: 0 });
      return nueva;
    });
  const restablecer = () => {
    setEscala(1);
    setMov({ x: 0, y: 0 });
  };
  const rotar = () => setGiro((g) => (g + 90) % 360);

  // La rueda necesita un oyente no pasivo para que no se mueva la página.
  useEffect(() => {
    const el = zona.current;
    if (!el) return;
    const rueda = (e: WheelEvent) => {
      e.preventDefault();
      zoom(e.deltaY < 0 ? 1.15 : 1 / 1.15);
    };
    el.addEventListener("wheel", rueda, { passive: false });
    return () => el.removeEventListener("wheel", rueda);
  }, []);

  useEffect(() => {
    const tecla = (e: KeyboardEvent) => {
      if (e.key === "+" || e.key === "=") zoom(1.25);
      else if (e.key === "-") zoom(0.8);
      else if (e.key.toLowerCase() === "r") rotar();
      else if (e.key === "0") restablecer();
    };
    window.addEventListener("keydown", tecla);
    return () => window.removeEventListener("keydown", tecla);
  }, []);

  const distancia = () => {
    const [a, b] = [...punteros.current.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };

  const girada = giro % 180 !== 0;
  return (
    <div data-modal className="fixed inset-0 z-[60] flex flex-col bg-black/95 text-white">
      <div
        ref={zona}
        className="relative flex min-h-0 flex-1 cursor-grab touch-none items-center justify-center overflow-hidden active:cursor-grabbing"
        onDoubleClick={() => (escala > 1 ? restablecer() : setEscala(2.5))}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          punteros.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
          if (punteros.current.size === 2) pellizco.current = { distancia: distancia(), escala };
        }}
        onPointerMove={(e) => {
          const antes = punteros.current.get(e.pointerId);
          if (!antes) return;
          punteros.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
          if (punteros.current.size === 2 && pellizco.current) setEscala(limitar((pellizco.current.escala * distancia()) / pellizco.current.distancia));
          else if (punteros.current.size === 1 && escala > 1) setMov((m) => ({ x: m.x + e.clientX - antes.x, y: m.y + e.clientY - antes.y }));
        }}
        onPointerUp={(e) => {
          punteros.current.delete(e.pointerId);
          if (punteros.current.size < 2) pellizco.current = null;
        }}
        onPointerCancel={(e) => punteros.current.delete(e.pointerId)}
      >
        <img
          src={url}
          alt="Factura"
          draggable={false}
          className={`select-none object-contain transition-transform duration-75 ${girada ? "max-h-[96vw] max-w-[86dvh]" : "max-h-full max-w-full"}`}
          style={{ transform: `translate(${mov.x}px, ${mov.y}px) scale(${escala}) rotate(${giro}deg)` }}
        />
      </div>
      <div className="flex shrink-0 items-center justify-center gap-1 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2">
        <Boton titulo="Alejar (−)" onClick={() => zoom(0.8)}>
          <ZoomOut className="size-5" />
        </Boton>
        <span className="w-14 text-center text-sm tabular-nums text-white/70">{Math.round(escala * 100)} %</span>
        <Boton titulo="Acercar (+)" onClick={() => zoom(1.25)}>
          <ZoomIn className="size-5" />
        </Boton>
        <Boton titulo="Rotar (R)" onClick={rotar}>
          <RotateCw className="size-5" />
        </Boton>
        <Boton titulo="Ver entera (0)" onClick={restablecer}>
          <Maximize className="size-5" />
        </Boton>
        <a href={url} target="_blank" rel="noreferrer" title="Abrir el original" className="rounded-full p-2.5 hover:bg-white/15">
          <ExternalLink className="size-5" />
        </a>
        <Boton titulo="Cerrar (Esc)" onClick={onCerrar}>
          <X className="size-5" />
        </Boton>
      </div>
    </div>
  );
}

function Boton({ titulo, onClick, children }: { titulo: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button aria-label={titulo} title={titulo} onClick={onClick} className="rounded-full p-2.5 hover:bg-white/15">
      {children}
    </button>
  );
}
