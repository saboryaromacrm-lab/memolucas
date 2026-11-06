import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Camera, ClipboardPaste, CloudUpload, FileText, Images, Loader2, PenLine, Plus, RotateCcw, Sparkles, WifiOff, X } from "lucide-react";
import { Boton, useAccion, useAviso } from "../componentes/ui";
import { post } from "../lib/api";
import { haceCuanto } from "../lib/fechas";
import { encolar, escuchar, quitar, subirTodo, type Pendiente } from "./cola";
import type { Ancho } from "./comun";
import { comprimir } from "./imagen";

export type Lectura = { id: number; estado: "leyendo" | "lista" | "error" | "repetido" | "vacia"; autor: string | null; mensaje: string | null; hojas: number; creadoEn: string };

const botonSecundario = "flex items-center justify-center gap-2 rounded-xl border border-stone-300 bg-white px-3 py-2.5 text-sm font-medium text-stone-700 hover:bg-stone-50 active:bg-stone-100";

/**
 * Cargar una factura: cámara, galería, PDF, pegar (Ctrl+V o botón), arrastrar y soltar, o una compra sin factura.
 * Las fotos se juntan como hojas de la misma factura hasta tocar "Leer factura"; cada PDF se manda directo.
 */
export function Cargador({ ancho, onSinFactura, iniciales }: { ancho: Ancho; onSinFactura: () => void; iniciales?: File[] }) {
  const [hojas, setHojas] = useState<{ archivo: File; url: string }[]>([]);
  const [preparando, setPreparando] = useState(false);
  const camara = useRef<HTMLInputElement>(null);
  const galeria = useRef<HTMLInputElement>(null);
  const pdf = useRef<HTMLInputElement>(null);
  const avisar = useAviso();
  // En la compu "otra hoja" abre el selector de archivos; en el celular y la tablet, la cámara.
  const otraHoja = () => (ancho === "pc" ? galeria : camara).current?.click();

  const agregar = async (lista: FileList | File[] | null) => {
    if (!lista?.length) return;
    setPreparando(true);
    const nuevas = await Promise.all(
      [...lista].map(async (f) => {
        const archivo = await comprimir(f);
        return { archivo, url: URL.createObjectURL(archivo) };
      }),
    );
    setHojas((h) => [...h, ...nuevas]);
    setPreparando(false);
  };
  const limpiar = () => {
    hojas.forEach((h) => URL.revokeObjectURL(h.url));
    setHojas([]);
  };
  const leer = async () => {
    await encolar(hojas.map((h) => h.archivo));
    limpiar();
    avisar("Factura enviada: se está leyendo");
  };

  /** Lo que llega pegado o arrastrado: las fotos van como hojas y cada PDF se manda a leer directo. */
  const recibir = useRef<(archivos: File[]) => Promise<void>>(async () => {});
  recibir.current = async (archivos) => {
    const pdfs = archivos.filter((f) => f.type === "application/pdf");
    const fotos = archivos.filter((f) => f.type.startsWith("image/"));
    if (!pdfs.length && !fotos.length) return avisar("Eso no es una foto ni un PDF", "error");
    for (const f of pdfs) await encolar([f]);
    if (pdfs.length) avisar(pdfs.length === 1 ? "PDF enviado: se está leyendo" : `${pdfs.length} PDF enviados: se están leyendo`);
    if (fotos.length) await agregar(fotos);
  };

  const arrastrando = useArchivosDeAfuera((archivos) => void recibir.current(archivos));
  // Lo que llegó pegado o arrastrado en Facturas.
  useEffect(() => {
    if (iniciales?.length) void recibir.current(iniciales);
  }, [iniciales]);

  /** Botón Pegar: lee lo copiado (en el celular puede pedir permiso). */
  const pegarDelPortapapeles = async () => {
    try {
      const archivos: File[] = [];
      for (const item of await navigator.clipboard.read()) {
        const tipo = item.types.find((t) => t.startsWith("image/") || t === "application/pdf");
        if (!tipo) continue;
        const blob = await item.getType(tipo);
        archivos.push(new File([blob], tipo === "application/pdf" ? "pegado.pdf" : `pegada.${tipo.split("/")[1]}`, { type: tipo }));
      }
      if (!archivos.length) return avisar("No hay ninguna foto copiada. Copiá la foto y volvé a tocar Pegar.", "error");
      await recibir.current(archivos);
    } catch {
      avisar("El navegador no dejó leer lo copiado. Probá con Ctrl+V, o mantené apretado en la pantalla y elegí Pegar.", "error");
    }
  };

  const entradas = (
    <>
      <input ref={camara} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => (void agregar(e.target.files), (e.target.value = ""))} />
      <input ref={galeria} type="file" accept="image/*" multiple className="hidden" onChange={(e) => (void agregar(e.target.files), (e.target.value = ""))} />
      <input
        ref={pdf}
        type="file"
        accept="application/pdf"
        multiple
        className="hidden"
        onChange={(e) => {
          const archivos = [...(e.target.files ?? [])];
          e.target.value = "";
          void recibir.current(archivos);
        }}
      />
      {arrastrando && <SoltarAca />}
    </>
  );

  // Hojas listas para leer.
  if (hojas.length)
    return (
      <section className="tarjeta p-4">
        {entradas}
        <div className="flex flex-col gap-4 md:flex-row md:items-center">
          <div className="min-w-0 flex-1">
            <div className="mb-2 flex items-center justify-between">
              <span className="font-semibold text-stone-800">
                {hojas.length} {hojas.length === 1 ? "hoja" : "hojas"} de la misma factura
              </span>
              <button onClick={limpiar} className="text-sm text-stone-500 hover:text-stone-800 md:hidden">
                Cancelar
              </button>
            </div>
            <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 pt-1.5">
              {hojas.map((h, i) => (
                <div key={h.url} className="relative shrink-0">
                  <img src={h.url} alt={`Hoja ${i + 1}`} className="h-28 w-20 rounded-lg border border-stone-200 object-cover md:h-24 md:w-[4.5rem]" />
                  <button
                    aria-label="Quitar hoja"
                    className="absolute -right-1.5 -top-1.5 rounded-full bg-cafe p-1 text-white shadow"
                    onClick={() => {
                      URL.revokeObjectURL(h.url);
                      setHojas((x) => x.filter((y) => y.url !== h.url));
                    }}
                  >
                    <X className="size-3" />
                  </button>
                </div>
              ))}
              <button
                onClick={otraHoja}
                className="flex h-28 w-20 shrink-0 flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed border-naranja/60 text-xs font-medium text-naranja hover:bg-orange-50 md:h-24 md:w-[4.5rem]"
              >
                {preparando ? <Loader2 className="size-5 animate-spin" /> : <Plus className="size-5" />} Otra hoja
              </button>
            </div>
          </div>
          <div className="flex gap-2 md:w-56 md:flex-col">
            <button onClick={() => void leer()} disabled={preparando} className="flex flex-1 items-center justify-center gap-2 rounded-2xl bg-cafe py-4 text-lg font-semibold text-beige shadow-md hover:bg-marca-profundo disabled:opacity-50 md:py-3 md:text-base">
              <Sparkles className="size-5 text-naranja" /> Leer factura
            </button>
            <button onClick={limpiar} className={`${botonSecundario} hidden md:flex`}>
              Cancelar
            </button>
          </div>
        </div>
      </section>
    );

  // Las opciones, una debajo de la otra; la primera (la más usada) en naranja.
  const opciones = [
    ...(ancho === "pc" ? [] : [{ icono: Camera, titulo: "Sacar foto", detalle: "Con la cámara. Si tiene varias hojas, sacá una por una.", hacer: () => camara.current?.click() }]),
    { icono: Images, titulo: "Elegir fotos", detalle: "De la galería o de una carpeta: podés elegir varias hojas juntas.", hacer: () => galeria.current?.click() },
    { icono: FileText, titulo: "Subir PDF", detalle: "La factura electrónica en PDF.", hacer: () => pdf.current?.click() },
    {
      icono: ClipboardPaste,
      titulo: "Pegar",
      detalle: ancho === "pc" ? "Una foto o un PDF que copiaste (también con Ctrl+V)." : "Una foto o un PDF que copiaste.",
      hacer: () => void pegarDelPortapapeles(),
    },
    { icono: PenLine, titulo: "Compra sin factura", detalle: "Lo que se compró sin comprobante, cargado a mano.", hacer: onSinFactura },
  ];
  return (
    <section className="space-y-3">
      {entradas}
      {ancho === "pc" && (
        <button
          onClick={() => galeria.current?.click()}
          className="flex w-full items-center gap-4 rounded-2xl border-2 border-dashed border-stone-300 bg-white/70 px-5 py-6 text-left transition hover:border-naranja/60"
        >
          <span className="flex size-12 shrink-0 items-center justify-center rounded-full bg-orange-50 text-naranja">
            {preparando ? <Loader2 className="size-6 animate-spin" /> : <CloudUpload className="size-6" />}
          </span>
          <span>
            <span className="block font-semibold text-stone-800">Arrastrá acá la foto o el PDF de la factura</span>
            <span className="block text-sm text-stone-500">O pegala con Ctrl+V. Las fotos seguidas se juntan como hojas de la misma factura.</span>
          </span>
        </button>
      )}
      <div className="grid gap-3 @xl:grid-cols-2">
        {opciones.map(({ icono: Icono, titulo, detalle, hacer }, i) => (
          <button
            key={titulo}
            onClick={hacer}
            className={`flex items-center gap-4 rounded-2xl px-4 py-4 text-left shadow-sm transition active:scale-[0.99] ${i === 0 ? "bg-naranja text-white hover:brightness-95" : "tarjeta hover:border-naranja/50"}`}
          >
            <span className={`flex size-11 shrink-0 items-center justify-center rounded-full ${i === 0 ? "bg-white/20" : "bg-orange-50 text-naranja"}`}>
              {i === 0 && preparando ? <Loader2 className="size-5 animate-spin" /> : <Icono className="size-5" />}
            </span>
            <span className="min-w-0">
              <span className="block font-semibold">{titulo}</span>
              <span className={`block text-sm ${i === 0 ? "text-white/85" : "text-stone-500"}`}>{detalle}</span>
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}

/**
 * Ctrl+V y arrastrar archivos en cualquier parte del panel (salvo escribiendo en un campo o con algo abierto encima).
 * Devuelve si se está arrastrando algo, para mostrar dónde soltarlo.
 */
export function useArchivosDeAfuera(recibir: (archivos: File[]) => void): boolean {
  const [arrastrando, setArrastrando] = useState(false);
  const fn = useRef(recibir);
  fn.current = recibir;
  useEffect(() => {
    const tapado = () => !!document.querySelector("[data-superpuesto]");
    const pegar = (e: ClipboardEvent) => {
      if ((e.target instanceof Element && e.target.closest("input, textarea, [contenteditable]")) || tapado()) return;
      const archivos = [...(e.clipboardData?.files ?? [])];
      if (!archivos.length) return;
      e.preventDefault();
      fn.current(archivos);
    };
    const conArchivos = (e: DragEvent) => !!e.dataTransfer?.types.includes("Files") && !tapado();
    const entra = (e: DragEvent) => {
      if (!conArchivos(e)) return;
      e.preventDefault();
      setArrastrando(true);
    };
    const sale = (e: DragEvent) => !e.relatedTarget && setArrastrando(false);
    const suelta = (e: DragEvent) => {
      if (!conArchivos(e)) return;
      e.preventDefault();
      setArrastrando(false);
      fn.current([...(e.dataTransfer?.files ?? [])]);
    };
    document.addEventListener("paste", pegar);
    window.addEventListener("dragenter", entra);
    window.addEventListener("dragover", entra);
    window.addEventListener("dragleave", sale);
    window.addEventListener("drop", suelta);
    return () => {
      document.removeEventListener("paste", pegar);
      window.removeEventListener("dragenter", entra);
      window.removeEventListener("dragover", entra);
      window.removeEventListener("dragleave", sale);
      window.removeEventListener("drop", suelta);
    };
  }, []);
  return arrastrando;
}

/** Mientras se arrastra un archivo sobre el panel. */
export function SoltarAca() {
  return (
    <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-cafe/80 p-6">
      <div className="rounded-3xl border-4 border-dashed border-naranja px-10 py-14 text-center text-xl font-semibold text-beige">
        <CloudUpload className="mx-auto mb-3 size-10 text-naranja" />
        Soltá acá la foto o el PDF de la factura
      </div>
    </div>
  );
}

/** Lo que espera subirse (sin señal o con error). */
export function EstadoCola() {
  const [lista, setLista] = useState<Pendiente[]>([]);
  const [subiendo, setSubiendo] = useState(false);
  const [enLinea, setEnLinea] = useState(navigator.onLine);
  useEffect(() => escuchar((p, s) => (setLista(p), setSubiendo(s))), []);
  useEffect(() => {
    const cambio = () => setEnLinea(navigator.onLine);
    window.addEventListener("online", cambio);
    window.addEventListener("offline", cambio);
    return () => {
      window.removeEventListener("online", cambio);
      window.removeEventListener("offline", cambio);
    };
  }, []);
  if (!lista.length) return null;
  const conError = lista.filter((p) => p.error);
  const esperando = lista.length - conError.length;
  return (
    <div className="space-y-2">
      {esperando > 0 && (
        <div className="flex items-center gap-3 rounded-2xl border border-naranja/40 bg-orange-50 px-4 py-3 text-sm text-stone-700">
          {enLinea ? <CloudUpload className="size-5 shrink-0 text-naranja" /> : <WifiOff className="size-5 shrink-0 text-naranja" />}
          <span className="flex-1">
            {enLinea ? (subiendo ? "Subiendo" : "Por subir") : "Sin señal:"} {esperando} {esperando === 1 ? "factura" : "facturas"}
            {!enLinea && " guardadas en este dispositivo. Se suben solas cuando vuelva la conexión."}
          </span>
          {enLinea && !subiendo && (
            <button className="font-semibold text-naranja" onClick={() => void subirTodo()}>
              Reintentar
            </button>
          )}
        </div>
      )}
      {conError.map((p) => (
        <div key={p.clienteId} className="flex items-center gap-3 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <AlertTriangle className="size-5 shrink-0" />
          <span className="flex-1">No se pudo subir: {p.error}</span>
          <button className="font-semibold" onClick={() => void quitar(p.clienteId)}>
            Quitar
          </button>
        </div>
      ))}
    </div>
  );
}

/** Factura que se está leyendo, o el aviso de una que falló, estaba repetida o no tenía comprobante. */
export function TarjetaLectura({ l }: { l: Lectura }) {
  const accion = useAccion();
  if (l.estado === "leyendo")
    return (
      <div className="tarjeta flex items-center gap-3 px-4 py-3">
        <Loader2 className="size-5 shrink-0 animate-spin text-naranja" />
        <span className="flex-1 text-sm text-stone-700">
          <b>Leyendo factura…</b> ({l.hojas} {l.hojas === 1 ? "hoja" : "hojas"})
          <span className="block text-xs text-stone-500">
            {l.autor && `Cargó ${l.autor} · `}
            {haceCuanto(l.creadoEn)}. Podés seguir cargando otras.
          </span>
        </span>
      </div>
    );
  const error = l.estado === "error";
  return (
    <div className={`flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border px-4 py-3 text-sm ${error ? "border-red-200 bg-red-50 text-red-800" : "border-amber-200 bg-amber-50 text-amber-900"}`}>
      <div className="flex min-w-60 flex-1 gap-2">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" />
        <span>{l.mensaje}</span>
      </div>
      <div className="ml-auto flex gap-2">
        {error && (
          <Boton chico icono={<RotateCcw className="size-3.5" />} onClick={() => void accion(() => post(`/api/c/lecturas/${l.id}/reintentar`))}>
            Reintentar
          </Boton>
        )}
        <Boton chico variante="fantasma" onClick={() => void accion(() => post(`/api/c/lecturas/${l.id}/cerrar`))}>
          {error ? "Descartar" : "Entendido"}
        </Boton>
      </div>
    </div>
  );
}
