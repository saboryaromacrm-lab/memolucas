import { useState } from "react";
import { Copy, Download, Loader2, Share2, Trash2 } from "lucide-react";
import { Boton, Deslizable, Modal, useAccion, useAviso } from "../componentes/ui";
import { del } from "../lib/api";

// Las imágenes de una pestaña del Bloc: una tira de miniaturas arriba del texto y, al tocar una, el visor con
// copiar, descargar, compartir (en el celular) y borrar.

export type ImagenBloc = { id: number; ancho: number; alto: number };

/** Lo que se acepta al pegar (el servidor la comprime). */
export const IMAGEN_MAX_MB = 15;
/** Alto de las miniaturas, en px. */
const ALTO_MINI = 80;

const url = (id: number, mini = false) => `/api/bloc/imagenes/${id}${mini ? "?mini=1" : ""}`;

/** La imagen como PNG: es lo que aceptan el portapapeles y cualquier programa donde la pegues. */
async function comoPng(id: number): Promise<Blob> {
  const r = await fetch(url(id), { credentials: "same-origin" });
  if (!r.ok) throw new Error("No se pudo abrir la imagen");
  const bitmap = await createImageBitmap(await r.blob());
  const lienzo = document.createElement("canvas");
  lienzo.width = bitmap.width;
  lienzo.height = bitmap.height;
  lienzo.getContext("2d")!.drawImage(bitmap, 0, 0);
  return new Promise((ok, mal) => lienzo.toBlob((b) => (b ? ok(b) : mal(new Error("No se pudo convertir la imagen"))), "image/png"));
}

/** Copiar al portapapeles (el PNG se arma mientras tanto: Safari pide crear el ClipboardItem en el mismo toque). */
function useCopiarImagen() {
  const avisar = useAviso();
  return async (id: number) => {
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": comoPng(id) })]);
      avisar("Imagen copiada: pegala donde quieras");
    } catch {
      avisar("Este navegador no deja copiar imágenes: usá Descargar o Compartir.", "error");
    }
  };
}

export function TiraImagenes({ imagenes, subiendo, onVer }: { imagenes: ImagenBloc[]; subiendo: number; onVer: (i: ImagenBloc) => void }) {
  const copiar = useCopiarImagen();
  if (!imagenes.length && !subiendo) return null;
  return (
    <div className="shrink-0 border-b border-slate-100 px-2 py-2">
      <Deslizable className="gap-2">
        {imagenes.map((i) => (
          <div key={i.id} className="group relative shrink-0">
            <button
              onClick={() => onVer(i)}
              title="Ver grande"
              className="block overflow-hidden rounded-lg border border-slate-200 bg-slate-50 hover:border-slate-400"
              style={{ height: ALTO_MINI, width: Math.min(ALTO_MINI * 3, Math.max(60, Math.round((ALTO_MINI * i.ancho) / i.alto))) }}
            >
              <img src={url(i.id, true)} alt="" loading="lazy" className="size-full object-cover" />
            </button>
            {/* En la compu: copiar sin abrirla (aparece al pasar el mouse). */}
            <button
              onClick={() => void copiar(i.id)}
              aria-label="Copiar imagen"
              title="Copiar imagen"
              className="absolute right-1 top-1 hidden size-7 items-center justify-center rounded-md bg-white/90 text-slate-700 shadow-sm hover:bg-white group-hover:flex focus-visible:flex"
            >
              <Copy className="size-4" />
            </button>
          </div>
        ))}
        {Array.from({ length: subiendo }, (_, k) => (
          <div key={`subiendo-${k}`} className="flex shrink-0 items-center justify-center rounded-lg border border-dashed border-slate-300 text-slate-400" style={{ height: ALTO_MINI, width: ALTO_MINI }}>
            <Loader2 className="size-5 animate-spin" />
          </div>
        ))}
      </Deslizable>
    </div>
  );
}

export function VisorImagen({ imagen, nombre, onCerrar }: { imagen: ImagenBloc; nombre: string; onCerrar: () => void }) {
  const copiar = useCopiarImagen();
  const accion = useAccion();
  const avisar = useAviso();
  const [ocupado, setOcupado] = useState(false);
  const archivo = `${nombre.replace(/[\\/:*?"<>|]+/g, "").trim() || "bloc"}-${imagen.id}.png`;
  const puedeCompartir = typeof navigator.canShare === "function" && navigator.canShare({ files: [new File([], archivo, { type: "image/png" })] });

  const descargar = async () => {
    setOcupado(true);
    try {
      const enlace = document.createElement("a");
      enlace.href = URL.createObjectURL(await comoPng(imagen.id));
      enlace.download = archivo;
      enlace.click();
      setTimeout(() => URL.revokeObjectURL(enlace.href), 10_000);
    } catch {
      avisar("No se pudo descargar la imagen.", "error");
    }
    setOcupado(false);
  };
  const compartir = async () => {
    try {
      await navigator.share({ files: [new File([await comoPng(imagen.id)], archivo, { type: "image/png" })] });
    } catch {
      // Cerró el menú de compartir: no es un error.
    }
  };
  const borrar = async () => {
    if (confirm("¿Borrar esta imagen?") && (await accion(() => del(`/api/bloc/imagenes/${imagen.id}`), "Imagen borrada"))) onCerrar();
  };

  return (
    <Modal
      abierto
      onCerrar={onCerrar}
      titulo="Imagen"
      ancho="max-w-4xl"
      pie={
        <div className="flex w-full flex-wrap gap-2">
          <Boton variante="primario" icono={<Copy className="size-4" />} onClick={() => void copiar(imagen.id)}>
            Copiar
          </Boton>
          {puedeCompartir && (
            <Boton icono={<Share2 className="size-4" />} onClick={() => void compartir()}>
              Compartir
            </Boton>
          )}
          <Boton icono={<Download className="size-4" />} cargando={ocupado} onClick={() => void descargar()}>
            Descargar
          </Boton>
          <Boton variante="peligro" icono={<Trash2 className="size-4" />} className="sm:ml-auto" onClick={() => void borrar()}>
            Borrar
          </Boton>
        </div>
      }
    >
      <img src={url(imagen.id)} alt="" className="mx-auto max-h-[65vh] w-auto max-w-full rounded-lg border border-slate-200" />
    </Modal>
  );
}
