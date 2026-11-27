import { useEffect, useMemo, useRef, type ClipboardEvent, type DragEvent } from "react";
import { FileText, Paperclip, X } from "lucide-react";
import { useAviso } from "./ui";

/** Lo que lee la IA: foto, captura o PDF, hasta 15 MB. */
const MAX_MB = 15;
const sirve = (f: File) => f.type.startsWith("image/") || f.type === "application/pdf";

/** El archivo como lo recibe el servidor (base64, sin el encabezado "data:…"). */
export async function archivoParaIa(f: File) {
  const datos = await new Promise<string>((listo, falla) => {
    const r = new FileReader();
    r.onload = () => listo(String(r.result));
    r.onerror = () => falla(new Error("No se pudo leer el archivo."));
    r.readAsDataURL(f);
  });
  return { mime: f.type, base64: datos.slice(datos.indexOf(",") + 1) };
}

/**
 * Texto para la IA con una foto o un PDF: se pega (Ctrl+V), se arrastra o se elige (en el celular, también con la
 * cámara). Se ve una miniatura y se saca con la X.
 */
export function CampoIa({ texto, onTexto, archivo, onArchivo, placeholder }: { texto: string; onTexto: (t: string) => void; archivo: File | null; onArchivo: (f: File | null) => void; placeholder: string }) {
  const elegir = useRef<HTMLInputElement>(null);
  const avisar = useAviso();
  const vista = useMemo(() => (archivo?.type.startsWith("image/") ? URL.createObjectURL(archivo) : null), [archivo]);
  useEffect(() => () => void (vista && URL.revokeObjectURL(vista)), [vista]);

  const tomar = (archivos: File[]) => {
    const f = archivos.find(sirve);
    if (!f) return false;
    if (f.size > MAX_MB * 1024 * 1024) avisar(`Ese archivo pesa más de ${MAX_MB} MB.`, "error");
    else onArchivo(f);
    return true;
  };
  // Pegar una captura o una foto copiada la adjunta; si lo copiado es texto, se pega el texto.
  const alPegar = (e: ClipboardEvent) => {
    if (e.clipboardData.getData("text/plain")) return;
    if (tomar([...e.clipboardData.files])) e.preventDefault();
  };
  const alSoltar = (e: DragEvent) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    tomar([...e.dataTransfer.files]);
  };

  return (
    <div onDragOver={(e) => e.dataTransfer.types.includes("Files") && e.preventDefault()} onDrop={alSoltar}>
      <textarea className="campo min-h-24" value={texto} onChange={(e) => onTexto(e.target.value)} onPaste={alPegar} placeholder={placeholder} />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {archivo ? (
          <span className="flex max-w-full items-center gap-2 rounded-lg border border-slate-200 bg-white py-1 pl-1 pr-2 text-sm text-slate-700">
            {vista ? <img src={vista} alt="" className="size-10 rounded object-cover" /> : <FileText className="ml-1 size-6 text-red-500" />}
            <span className="min-w-0 truncate">{archivo.name || "Imagen pegada"}</span>
            <button type="button" onClick={() => onArchivo(null)} aria-label="Sacar el archivo" className="flex size-8 shrink-0 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100">
              <X className="size-4" />
            </button>
          </span>
        ) : (
          <button type="button" onClick={() => elegir.current?.click()} className="flex min-h-10 items-center gap-1.5 rounded-lg border border-dashed border-slate-300 bg-white px-3 text-sm text-slate-600 hover:border-slate-400">
            <Paperclip className="size-4" /> Foto o PDF
          </button>
        )}
        <span className="text-xs text-slate-500">También podés pegar una captura con Ctrl+V o arrastrar el archivo.</span>
      </div>
      <input ref={elegir} type="file" accept="image/*,application/pdf" hidden onChange={(e) => (tomar([...(e.target.files ?? [])]), (e.target.value = ""))} />
    </div>
  );
}
