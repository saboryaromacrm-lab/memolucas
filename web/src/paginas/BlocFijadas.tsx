import { useEffect, useState } from "react";
import { Pin, PinOff } from "lucide-react";
import { useRecordado } from "../lib/recordado";

// Las pestañas fijadas del Bloc. En la compu (Chrome o Edge) van en una ventanita que queda encima de todos los
// programas (Document Picture-in-Picture); donde no se puede (el celular), en una franja arriba del Bloc.

type VentanaFlotante = { requestWindow: (o: { width: number; height: number }) => Promise<Window>; window: Window | null };
const api = () => (window as unknown as { documentPictureInPicture?: VentanaFlotante }).documentPictureInPicture;

/** Se puede abrir una ventana encima de todo (Chrome o Edge en la compu). */
export const hayVentanaFlotante = () => typeof window !== "undefined" && !!api();

/** Copia los estilos de la página a la ventanita, así se ve igual. */
function copiarEstilos(destino: Document) {
  for (const hoja of [...document.styleSheets]) {
    if (hoja.href) {
      const link = destino.createElement("link");
      link.rel = "stylesheet";
      link.href = hoja.href;
      destino.head.append(link);
      continue;
    }
    try {
      const estilo = destino.createElement("style");
      estilo.textContent = [...hoja.cssRules].map((r) => r.cssText).join("\n");
      destino.head.append(estilo);
    } catch {
      // Una hoja de otro origen no se puede leer: se saltea.
    }
  }
}

/** La ventanita que queda encima de todo: se abre con un toque (el navegador lo exige) y recuerda su tamaño. */
export function useVentanaFlotante() {
  const [ventana, setVentana] = useState<Window | null>(null);
  const [tamano, setTamano] = useRecordado("bloc-fijadas-tamano", { ancho: 320, alto: 400 });

  useEffect(() => {
    if (!ventana) return;
    const alCerrar = () => {
      setTamano({ ancho: ventana.innerWidth, alto: ventana.innerHeight });
      setVentana(null);
    };
    ventana.addEventListener("pagehide", alCerrar);
    return () => ventana.removeEventListener("pagehide", alCerrar);
  }, [ventana, setTamano]);

  const abrir = async () => {
    const pip = api();
    if (!pip) return;
    if (pip.window) return setVentana(pip.window);
    const v = await pip.requestWindow({ width: tamano.ancho, height: tamano.alto });
    copiarEstilos(v.document);
    v.document.title = "Bloc · fijadas";
    v.document.body.className = "bg-slate-50 text-slate-900 antialiased";
    setVentana(v);
  };
  return { ventana, abrir, cerrar: () => ventana?.close() };
}

type Fijada = { id: number; titulo: string; texto: string };

/** Las fijadas, una debajo de la otra, cada una se escribe ahí mismo (se guarda igual que en el Bloc). */
export function Fijadas({ fijadas, letra, onTexto, onSoltar, enVentana }: { fijadas: Fijada[]; letra: number; onTexto: (id: number, texto: string) => void; onSoltar: (id: number) => void; enVentana: boolean }) {
  return (
    <div className={enVentana ? "flex h-screen flex-col gap-2 overflow-y-auto p-2" : "flex max-h-[40dvh] flex-col gap-2 overflow-y-auto"}>
      {fijadas.map((f) => (
        <section key={f.id} className="flex shrink-0 flex-col rounded-xl border border-amber-200 bg-amber-50/70 shadow-sm">
          <header className="flex items-center gap-1.5 px-3 pt-1.5">
            <Pin className="size-3.5 shrink-0 text-amber-600" />
            <h2 className="min-w-0 flex-1 truncate text-xs font-semibold text-slate-700">{f.titulo}</h2>
            <button onClick={() => onSoltar(f.id)} aria-label={`Soltar «${f.titulo}»`} title="Soltar (deja de estar fijada)" className="flex size-8 items-center justify-center rounded-lg text-slate-500 hover:bg-amber-100">
              <PinOff className="size-4" />
            </button>
          </header>
          <textarea
            value={f.texto}
            onChange={(e) => onTexto(f.id, e.target.value)}
            spellCheck
            rows={enVentana && fijadas.length === 1 ? 14 : 5}
            style={{ fontSize: letra }}
            className="w-full resize-y bg-transparent px-3 pb-2 pt-1 leading-relaxed text-slate-900 outline-none"
            aria-label={f.titulo}
          />
        </section>
      ))}
    </div>
  );
}
