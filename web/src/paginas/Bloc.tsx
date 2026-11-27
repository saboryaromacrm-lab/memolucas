import { useEffect, useMemo, useRef, useState, type ClipboardEvent as EventoPegar, type DragEvent as EventoArrastre, type KeyboardEvent as EventoTecla } from "react";
import {
  AArrowDown,
  AArrowUp,
  ArchiveRestore,
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  ChevronUp,
  ClipboardCopy,
  History,
  ImagePlus,
  MonitorDown,
  NotebookPen,
  Pencil,
  Plus,
  Replace,
  Search,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { Boton, Cargando, Deslizable, Encabezado, MenuAcciones, Modal, Vacio, useAccion, useAviso } from "../componentes/ui";
import { api, del, get, post, put } from "../lib/api";
import { fechaHora, haceCuanto } from "../lib/fechas";
import { comoAppInstalada, useInstalar } from "../lib/instalar";
import { useRecordado } from "../lib/recordado";
import type { Configuracion } from "../lib/tipos";
import { useDatos } from "../lib/vivo";
import { IMAGEN_MAX_MB, TiraImagenes, VisorImagen, type ImagenBloc } from "./BlocImagenes";

type Pestana = { id: number; titulo: string; texto: string; orden: number; version: number; actualizadoEn: string; imagenes: ImagenBloc[] };
type Local = { texto: string; version: number };

/** Mientras escribís, se guarda a los 0,7 s de la última tecla. */
const ESPERA_GUARDAR_MS = 700;
const TAMANOS = [12, 14, 16, 18, 20, 24];

/**
 * El Bloc: pestañas de texto que se guardan solas, como el Bloc de notas de la compu. Lo que escribís en un
 * dispositivo aparece solo en el otro; si escribís en los dos a la vez, nada se pierde (va al historial).
 */
/** comoApp: el Bloc como app aparte (en su propia dirección), a pantalla completa y sin el menú del panel. */
export function Bloc({ comoApp = false }: { comoApp?: boolean }) {
  const { datos } = useDatos<Pestana[]>("/api/bloc", ["bloc"]);
  const [activa, setActiva] = useRecordado("bloc-activa", { id: 0 });
  const [letra, setLetra] = useRecordado("bloc-letra", { px: 16 });
  const [locales, setLocales] = useState<Record<number, Local>>({});
  const [estado, setEstado] = useState<"guardado" | "guardando" | "error">("guardado");
  const [buscando, setBuscando] = useState<null | "buscar" | "reemplazar">(null);
  const [renombrar, setRenombrar] = useState<Pestana | null>(null);
  const [historial, setHistorial] = useState<Pestana | null>(null);
  const [papelera, setPapelera] = useState(false);
  const [arrastrando, setArrastrando] = useState<number | null>(null);
  const [subiendo, setSubiendo] = useState(0);
  const [viendo, setViendo] = useState<ImagenBloc | null>(null);
  const accion = useAccion();
  const avisar = useAviso();
  const instalar = useInstalar();
  // Donde se instala como app aparte (solo lo usa el botón del panel).
  const urlBloc = useDatos<Pick<Configuracion, "urlBloc">>(comoApp ? null : "/api/configuracion", []).datos?.urlBloc;
  const archivo = useRef<HTMLInputElement>(null);
  const imagen = useRef<HTMLInputElement>(null);

  // Estado de guardado, en refs para que los temporizadores vean lo último.
  const localesRef = useRef(locales);
  localesRef.current = locales;
  const sucias = useRef(new Set<number>());
  const enVuelo = useRef(new Set<number>());
  const temporizadores = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const pestanas = datos ?? [];
  const actual = pestanas.find((p) => p.id === activa.id) ?? pestanas[0];
  const local = actual ? (locales[actual.id] ?? { texto: actual.texto, version: actual.version }) : null;

  // Lo que llega del servidor (otro dispositivo, el asistente) reemplaza lo local solo si acá no hay nada sin guardar.
  useEffect(() => {
    if (!datos) return;
    setLocales((ls) => {
      const n = { ...ls };
      for (const p of datos) if (!sucias.current.has(p.id) && !enVuelo.current.has(p.id)) n[p.id] = { texto: p.texto, version: p.version };
      return n;
    });
  }, [datos]);

  const actualizarEstado = () => setEstado(sucias.current.size || enVuelo.current.size ? "guardando" : "guardado");

  const guardar = async (id: number) => {
    clearTimeout(temporizadores.current.get(id));
    if (enVuelo.current.has(id)) return; // Al terminar el guardado en curso se vuelve a mirar.
    const l = localesRef.current[id];
    if (!l || !sucias.current.has(id)) return;
    sucias.current.delete(id);
    enVuelo.current.add(id);
    actualizarEstado();
    try {
      const r = await put<{ version: number; conflicto: boolean }>(`/api/bloc/${id}`, { texto: l.texto, version: l.version });
      setLocales((ls) => ({ ...ls, [id]: { ...(ls[id] ?? l), version: r.version } }));
      localesRef.current = { ...localesRef.current, [id]: { ...(localesRef.current[id] ?? l), version: r.version } };
      if (r.conflicto) avisar("También se escribió en otro dispositivo: esa versión quedó en el historial de la pestaña.", "error");
    } catch (e) {
      sucias.current.add(id);
      setEstado("error");
      avisar(e instanceof Error ? e.message : "No se pudo guardar", "error");
      enVuelo.current.delete(id);
      return;
    }
    enVuelo.current.delete(id);
    if (sucias.current.has(id)) void guardar(id);
    actualizarEstado();
  };

  const escribir = (id: number, texto: string) => {
    setLocales((ls) => ({ ...ls, [id]: { texto, version: ls[id]?.version ?? pestanas.find((p) => p.id === id)!.version } }));
    sucias.current.add(id);
    setEstado("guardando");
    clearTimeout(temporizadores.current.get(id));
    temporizadores.current.set(id, setTimeout(() => void guardar(id), ESPERA_GUARDAR_MS));
  };
  const guardarTodo = () => [...sucias.current].forEach((id) => void guardar(id));

  // Si cerrás la ventana con algo sin guardar, se manda igual (y el navegador avisa).
  useEffect(() => {
    const alSalir = (e: BeforeUnloadEvent) => {
      if (!sucias.current.size) return;
      for (const id of sucias.current) {
        const l = localesRef.current[id];
        if (l) void fetch(`/api/bloc/${id}`, { method: "PUT", keepalive: true, headers: { "content-type": "application/json" }, body: JSON.stringify(l) });
      }
      e.preventDefault();
    };
    window.addEventListener("beforeunload", alSalir);
    return () => window.removeEventListener("beforeunload", alSalir);
  }, []);

  const elegir = (id: number) => {
    guardarTodo();
    setActiva({ id });
  };
  const nueva = async (d: { titulo?: string; texto?: string } = {}) => {
    const p = await accion(() => post<Pestana>("/api/bloc", d));
    if (p) setActiva({ id: p.id });
    return p;
  };
  const cerrar = (p: Pestana) =>
    accion(async () => {
      await guardar(p.id);
      await del(`/api/bloc/${p.id}`);
    }, `«${p.titulo}» fue a la papelera`);
  const mover = (id: number, a: number) => {
    const ids = pestanas.map((p) => p.id).filter((x) => x !== id);
    ids.splice(Math.max(0, Math.min(ids.length, a)), 0, id);
    void accion(() => post("/api/bloc/orden", { ids }));
  };
  const importar = async (archivos: FileList | null) => {
    if (!archivos?.length) return;
    let ultima: Pestana | undefined;
    for (const a of [...archivos]) ultima = (await nueva({ titulo: a.name.replace(/\.[^.]+$/, "").slice(0, 120), texto: await a.text() })) ?? ultima;
    if (ultima) avisar(archivos.length === 1 ? "Pestaña importada" : `${archivos.length} pestañas importadas`);
  };
  /** Imágenes pegadas (Ctrl+V), arrastradas o elegidas con el botón: van a la pestaña que está abierta. */
  const agregarImagenes = async (archivos: File[]) => {
    const id = actual?.id;
    const imagenes = archivos.filter((a) => a.type.startsWith("image/"));
    if (!id || !imagenes.length) return false;
    for (const a of imagenes) {
      if (a.size > IMAGEN_MAX_MB * 1024 * 1024) {
        avisar(`Esa imagen pesa más de ${IMAGEN_MAX_MB} MB.`, "error");
        continue;
      }
      setSubiendo((n) => n + 1);
      await accion(() => api(`/api/bloc/${id}/imagenes`, { archivo: a }));
      setSubiendo((n) => n - 1);
    }
    return true;
  };
  // Pegar: si lo copiado es solo una imagen (una captura, una foto), va a la tira; si también trae texto, se pega el texto.
  const alPegar = (e: EventoPegar) => {
    const imagenes = [...e.clipboardData.files].filter((f) => f.type.startsWith("image/"));
    if (!imagenes.length || e.clipboardData.getData("text/plain")) return;
    e.preventDefault();
    void agregarImagenes(imagenes);
  };
  const conArchivos = (e: EventoArrastre) => e.dataTransfer.types.includes("Files");

  const copiar = async (texto: string) => {
    try {
      await navigator.clipboard.writeText(texto);
      avisar("Texto copiado");
    } catch {
      avisar("No se pudo copiar: seleccioná el texto y copialo a mano.", "error");
    }
  };

  // Atajos: Ctrl+F buscar, Ctrl+H reemplazar, Ctrl+S guardar ya, Esc cierra la búsqueda.
  const alTeclear = (e: EventoTecla) => {
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.key.toLowerCase() === "f") (e.preventDefault(), setBuscando("buscar"));
    else if (ctrl && e.key.toLowerCase() === "h") (e.preventDefault(), setBuscando("reemplazar"));
    else if (ctrl && e.key.toLowerCase() === "s") (e.preventDefault(), guardarTodo());
    else if (e.key === "Escape" && buscando) setBuscando(null);
  };

  if (!datos) return <Cargando />;

  const acciones = (
    <>
      <Boton chico={comoApp} icono={<Upload className="size-4" />} onClick={() => archivo.current?.click()}>
        Importar .txt
      </Boton>
      <Boton chico={comoApp} icono={<ArchiveRestore className="size-4" />} onClick={() => setPapelera(true)}>
        Papelera
      </Boton>
    </>
  );

  return (
    <div onKeyDown={alTeclear} className={comoApp ? "flex h-dvh flex-col bg-slate-50 p-2 pt-[max(0.5rem,env(safe-area-inset-top))] md:p-4" : undefined}>
      {comoApp ? (
        <header className="mb-3 flex shrink-0 flex-wrap items-center gap-2 px-1">
          <img src="/bloc.svg" alt="" className="size-7" />
          <h1 className="text-lg font-semibold text-slate-900">Bloc</h1>
          <div className="ml-auto flex flex-wrap gap-2">
            {instalar && (
              <Boton chico variante="primario" icono={<MonitorDown className="size-4" />} onClick={() => void instalar()}>
                Instalar
              </Boton>
            )}
            {acciones}
          </div>
          {!instalar && !comoAppInstalada() && (
            <p className="w-full text-xs text-slate-500">
              Para tenerlo como app: en Chrome o Edge, menú ⋮ → <b>Instalar «Bloc»</b> (o Transmitir, guardar y compartir → Instalar página como
              app). En el iPhone: Compartir → <b>Agregar a inicio</b>.
            </p>
          )}
        </header>
      ) : (
        <Encabezado
          titulo="Bloc"
          subtitulo="Se guarda solo. Lo ves igual en la compu y en el celular."
          acciones={
            <>
              <Boton icono={<MonitorDown className="size-4" />} disabled={!urlBloc} onClick={() => window.open(urlBloc, "_blank", "noopener")}>
                Instalar como app
              </Boton>
              {acciones}
            </>
          }
        />
      )}
      <input ref={archivo} type="file" accept=".txt,.md,text/plain" multiple hidden onChange={(e) => (void importar(e.target.files), (e.target.value = ""))} />

      {!actual || !local ? (
        <div className="tarjeta">
          <Vacio
            icono={<NotebookPen className="size-10" />}
            titulo="Tu Bloc está vacío"
            texto="Creá una pestaña y escribí, o importá los .txt que ya tenés en la compu."
            accion={
              <Boton variante="primario" icono={<Plus className="size-4" />} onClick={() => void nueva()}>
                Nueva pestaña
              </Boton>
            }
          />
        </div>
      ) : (
        <div
          className={comoApp ? "tarjeta flex min-h-0 flex-1 flex-col" : "tarjeta"}
          onPaste={alPegar}
          onDragOver={(e) => conArchivos(e) && e.preventDefault()}
          onDrop={(e) => {
            if (!conArchivos(e)) return;
            e.preventDefault();
            void agregarImagenes([...e.dataTransfer.files]);
          }}
        >
          {/* Pestañas: se eligen, se arrastran para ordenar y con + (pegado a la última, como en el navegador) se crea otra */}
          <div className="flex items-end gap-1 rounded-t-xl border-b border-slate-200 bg-slate-50 px-2 pt-2">
            <div className="min-w-0">
              <Deslizable className="gap-1">
                {pestanas.map((p) => (
                  <button
                    key={p.id}
                    draggable
                    onDragStart={() => setArrastrando(p.id)}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={() => arrastrando !== null && arrastrando !== p.id && mover(arrastrando, pestanas.findIndex((x) => x.id === p.id))}
                    onDragEnd={() => setArrastrando(null)}
                    onClick={() => elegir(p.id)}
                    onDoubleClick={() => setRenombrar(p)}
                    title={p.titulo}
                    className={`flex h-10 max-w-48 shrink-0 items-center gap-1.5 rounded-t-lg border border-b-0 px-3 text-sm font-medium ${
                      p.id === actual.id ? "border-slate-200 bg-white text-slate-900" : "border-transparent text-slate-500 hover:bg-white/70"
                    } ${arrastrando === p.id ? "opacity-50" : ""}`}
                  >
                    <span className="truncate">{p.titulo}</span>
                    {sucias.current.has(p.id) && <span className="size-1.5 shrink-0 rounded-full bg-amber-400" aria-label="Sin guardar" />}
                  </button>
                ))}
              </Deslizable>
            </div>
            <button onClick={() => void nueva()} aria-label="Nueva pestaña" title="Nueva pestaña" className="mb-1 flex size-9 shrink-0 items-center justify-center rounded-lg text-slate-600 hover:bg-white">
              <Plus className="size-5" />
            </button>
          </div>

          {/* Barra de la pestaña */}
          <div className="flex flex-wrap items-center gap-1 border-b border-slate-100 px-2 py-1.5">
            <MenuAcciones
              abreHacia="derecha"
              etiqueta={`Acciones de «${actual.titulo}»`}
              acciones={[
                { texto: "Renombrar", icono: <Pencil />, onClick: () => setRenombrar(actual) },
                { texto: "Historial", icono: <History />, onClick: () => (guardarTodo(), setHistorial(actual)) },
                { texto: "Copiar todo", icono: <ClipboardCopy />, onClick: () => void copiar(local.texto) },
                pestanas[0]?.id !== actual.id && { texto: "Mover a la izquierda", icono: <ArrowLeft />, onClick: () => mover(actual.id, pestanas.findIndex((x) => x.id === actual.id) - 1) },
                pestanas.at(-1)?.id !== actual.id && { texto: "Mover a la derecha", icono: <ArrowRight />, onClick: () => mover(actual.id, pestanas.findIndex((x) => x.id === actual.id) + 1) },
                { texto: "Cerrar pestaña", icono: <Trash2 />, peligro: true, onClick: () => void cerrar(actual) },
              ]}
            />
            <button onClick={() => setBuscando(buscando ? null : "buscar")} aria-label="Buscar (Ctrl+F)" title="Buscar y reemplazar (Ctrl+F / Ctrl+H)" className={`flex size-10 items-center justify-center rounded-lg hover:bg-slate-100 ${buscando ? "bg-slate-100 text-slate-900" : "text-slate-500"}`}>
              <Search className="size-5" />
            </button>
            <button onClick={() => void copiar(local.texto)} aria-label="Copiar todo" title="Copiar todo" className="flex size-10 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100">
              <ClipboardCopy className="size-5" />
            </button>
            <button
              onClick={() => imagen.current?.click()}
              aria-label="Agregar imagen"
              title="Agregar imagen (también Ctrl+V o arrastrándola)"
              className="flex size-10 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100"
            >
              <ImagePlus className="size-5" />
            </button>
            <button onClick={() => setLetra({ px: TAMANOS[Math.max(0, TAMANOS.indexOf(letra.px) - 1)] ?? 16 })} aria-label="Letra más chica" className="flex size-10 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100">
              <AArrowDown className="size-5" />
            </button>
            <button onClick={() => setLetra({ px: TAMANOS[Math.min(TAMANOS.length - 1, TAMANOS.indexOf(letra.px) + 1)] ?? 16 })} aria-label="Letra más grande" className="flex size-10 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100">
              <AArrowUp className="size-5" />
            </button>
            <span className="ml-auto px-2 text-xs text-slate-500">
              {contar(local.texto)} ·{" "}
              <span className={estado === "error" ? "text-red-600" : estado === "guardando" ? "text-amber-600" : "text-marca-oscuro"}>
                {estado === "error" ? "Sin guardar" : estado === "guardando" ? "Guardando…" : "Guardado"}
              </span>
            </span>
          </div>

          <TiraImagenes imagenes={actual.imagenes} subiendo={subiendo} onVer={setViendo} />

          <Hoja
            key={actual.id}
            texto={local.texto}
            onTexto={(t) => escribir(actual.id, t)}
            letra={letra.px}
            buscando={buscando}
            onCerrarBusqueda={() => setBuscando(null)}
            onModo={setBuscando}
            pantallaCompleta={comoApp}
          />
        </div>
      )}

      {renombrar && <Renombrar p={renombrar} version={locales[renombrar.id]?.version ?? renombrar.version} onCerrar={() => setRenombrar(null)} />}
      {historial && <ModalHistorial p={historial} onCerrar={() => setHistorial(null)} />}
      <input ref={imagen} type="file" accept="image/*" multiple hidden onChange={(e) => (void agregarImagenes([...(e.target.files ?? [])]), (e.target.value = ""))} />
      {viendo && actual && <VisorImagen imagen={viendo} nombre={actual.titulo} onCerrar={() => setViendo(null)} />}
      {papelera && <ModalPapelera onCerrar={() => setPapelera(false)} onRestaurada={(id) => setActiva({ id })} />}
    </div>
  );
}

function contar(texto: string) {
  const palabras = texto.trim() ? texto.trim().split(/\s+/).length : 0;
  return `${palabras.toLocaleString("es-AR")} ${palabras === 1 ? "palabra" : "palabras"} · ${texto.length.toLocaleString("es-AR")} caracteres`;
}

// ───────────── La hoja, con buscar y reemplazar ─────────────

/** Dónde aparece lo buscado (sin distinguir mayúsculas). */
function coincidencias(texto: string, buscado: string): number[] {
  if (!buscado) return [];
  const t = texto.toLowerCase();
  const b = buscado.toLowerCase();
  const r: number[] = [];
  for (let i = t.indexOf(b); i !== -1 && r.length < 5000; i = t.indexOf(b, i + b.length)) r.push(i);
  return r;
}

const ESTILO_HOJA = "block w-full whitespace-pre-wrap break-words p-4 leading-relaxed [overflow-wrap:anywhere]";

function Hoja({
  texto,
  onTexto,
  letra,
  buscando,
  onCerrarBusqueda,
  onModo,
  pantallaCompleta,
}: {
  texto: string;
  onTexto: (t: string) => void;
  letra: number;
  buscando: null | "buscar" | "reemplazar";
  onCerrarBusqueda: () => void;
  onModo: (m: "buscar" | "reemplazar") => void;
  /** En la app del Bloc la hoja ocupa el resto de la ventana. */
  pantallaCompleta: boolean;
}) {
  const [buscado, setBuscado] = useState("");
  const [reemplazo, setReemplazo] = useState("");
  const [n, setN] = useState(0);
  const area = useRef<HTMLTextAreaElement>(null);
  const fondo = useRef<HTMLDivElement>(null);
  const encontradas = useMemo(() => (buscando ? coincidencias(texto, buscado) : []), [texto, buscado, buscando]);
  const i = encontradas.length ? n % encontradas.length : 0;

  // Lleva la coincidencia elegida a la vista (a un tercio de la altura).
  useEffect(() => {
    const marca = fondo.current?.querySelector<HTMLElement>("mark[data-actual]");
    if (marca && area.current) {
      area.current.scrollTop = Math.max(0, marca.offsetTop - area.current.clientHeight / 3);
      fondo.current!.scrollTop = area.current.scrollTop;
    }
  }, [i, buscado, encontradas.length]);

  const reemplazar = (todas: boolean) => {
    if (!encontradas.length) return;
    if (todas) {
      let r = "";
      let desde = 0;
      for (const p of encontradas) (r += texto.slice(desde, p) + reemplazo), (desde = p + buscado.length);
      onTexto(r + texto.slice(desde));
    } else {
      const p = encontradas[i];
      onTexto(texto.slice(0, p) + reemplazo + texto.slice(p + buscado.length));
    }
  };

  // El fondo pinta las coincidencias detrás del texto (el área de texto es transparente encima).
  const pintado = useMemo(() => {
    if (!buscando || !encontradas.length) return null;
    const partes: React.ReactNode[] = [];
    let desde = 0;
    encontradas.forEach((p, k) => {
      partes.push(texto.slice(desde, p));
      partes.push(
        <mark key={p} data-actual={k === i ? "" : undefined} className={`rounded-sm text-transparent ${k === i ? "bg-orange-300" : "bg-yellow-200"}`}>
          {texto.slice(p, p + buscado.length)}
        </mark>,
      );
      desde = p + buscado.length;
    });
    partes.push(texto.slice(desde) + "\n");
    return partes;
  }, [texto, encontradas, i, buscado, buscando]);

  const teclaBuscar = (e: EventoTecla<HTMLInputElement>) => {
    if (e.key === "Enter") (e.preventDefault(), setN((x) => x + (e.shiftKey ? -1 + (encontradas.length || 1) : 1)));
  };

  return (
    <>
      {buscando && (
        <div className="grid gap-2 border-b border-slate-100 bg-slate-50 px-3 py-2 sm:flex sm:flex-wrap sm:items-center">
          <div className="flex items-center gap-1">
            <input className="campo h-10 min-w-0 flex-1 sm:w-56" placeholder="Buscar…" autoFocus value={buscado} onChange={(e) => (setBuscado(e.target.value), setN(0))} onKeyDown={teclaBuscar} />
            <span className="w-16 shrink-0 text-center text-xs text-slate-500">{buscado ? (encontradas.length ? `${i + 1} de ${encontradas.length}` : "0 de 0") : ""}</span>
            <button onClick={() => setN((x) => x - 1 + (encontradas.length || 1))} aria-label="Anterior" className="flex size-10 items-center justify-center rounded-lg text-slate-500 hover:bg-white">
              <ChevronUp className="size-5" />
            </button>
            <button onClick={() => setN((x) => x + 1)} aria-label="Siguiente" className="flex size-10 items-center justify-center rounded-lg text-slate-500 hover:bg-white">
              <ChevronDown className="size-5" />
            </button>
            {buscando === "buscar" && (
              <button onClick={() => onModo("reemplazar")} aria-label="Reemplazar" title="Reemplazar (Ctrl+H)" className="flex size-10 items-center justify-center rounded-lg text-slate-500 hover:bg-white">
                <Replace className="size-5" />
              </button>
            )}
            <button onClick={onCerrarBusqueda} aria-label="Cerrar búsqueda" className="flex size-10 items-center justify-center rounded-lg text-slate-500 hover:bg-white sm:hidden">
              <X className="size-5" />
            </button>
          </div>
          {buscando === "reemplazar" && (
            <div className="flex items-center gap-1">
              <input className="campo h-10 min-w-0 flex-1 sm:w-56" placeholder="Reemplazar por…" value={reemplazo} onChange={(e) => setReemplazo(e.target.value)} />
              <Boton chico disabled={!encontradas.length} onClick={() => reemplazar(false)}>
                Reemplazar
              </Boton>
              <Boton chico disabled={!encontradas.length} onClick={() => reemplazar(true)}>
                Todas
              </Boton>
            </div>
          )}
          <button onClick={onCerrarBusqueda} aria-label="Cerrar búsqueda" className="ml-auto hidden size-10 items-center justify-center rounded-lg text-slate-500 hover:bg-white sm:flex">
            <X className="size-5" />
          </button>
        </div>
      )}
      <div className={pantallaCompleta ? "relative min-h-0 flex-1" : "relative"}>
        {pintado && (
          <div ref={fondo} aria-hidden="true" className={`${ESTILO_HOJA} pointer-events-none absolute inset-0 overflow-y-scroll text-transparent`} style={{ fontSize: letra }}>
            {pintado}
          </div>
        )}
        <textarea
          ref={area}
          value={texto}
          onChange={(e) => onTexto(e.target.value)}
          onScroll={(e) => fondo.current && (fondo.current.scrollTop = e.currentTarget.scrollTop)}
          spellCheck={false}
          placeholder="Escribí acá…"
          aria-label="Texto de la pestaña"
          className={`${ESTILO_HOJA} relative rounded-b-xl resize-none overflow-y-scroll bg-transparent text-slate-800 outline-none ${
            pantallaCompleta ? "h-full" : "h-[calc(100dvh-19rem)] min-h-80 md:h-[calc(100dvh-17rem)]"
          }`}
          style={{ fontSize: letra }}
        />
      </div>
    </>
  );
}

// ───────────── Modales ─────────────

function Renombrar({ p, version, onCerrar }: { p: Pestana; version: number; onCerrar: () => void }) {
  const [titulo, setTitulo] = useState(p.titulo);
  const accion = useAccion();
  const guardar = async () => {
    if (await accion(() => put(`/api/bloc/${p.id}`, { titulo, version }))) onCerrar();
  };
  return (
    <Modal
      abierto
      onCerrar={onCerrar}
      titulo="Renombrar pestaña"
      ancho="max-w-md"
      pie={
        <>
          <Boton onClick={onCerrar}>Cancelar</Boton>
          <Boton variante="primario" onClick={() => void guardar()}>
            Guardar
          </Boton>
        </>
      }
    >
      <input className="campo" autoFocus maxLength={120} value={titulo} onChange={(e) => setTitulo(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void guardar()} />
    </Modal>
  );
}

type Version = { id: number; creadoEn: string; motivo: "guardado" | "otro_dispositivo" | "antes_de_restaurar"; caracteres: number; texto: string };
const MOTIVO: Record<Version["motivo"], string> = {
  guardado: "Mientras escribías",
  otro_dispositivo: "Pisada por otro dispositivo",
  antes_de_restaurar: "Antes de restaurar otra",
};

function ModalHistorial({ p, onCerrar }: { p: Pestana; onCerrar: () => void }) {
  const [versiones, setVersiones] = useState<Version[] | null>(null);
  const [vista, setVista] = useState<Version | null>(null);
  const accion = useAccion();
  useEffect(() => {
    void get<Version[]>(`/api/bloc/${p.id}/versiones`).then((v) => (setVersiones(v), setVista(v[0] ?? null)));
  }, [p.id]);
  const restaurar = async (v: Version) => {
    if (await accion(() => post(`/api/bloc/${p.id}/versiones/${v.id}/restaurar`), "Versión restaurada (lo de antes quedó en el historial)")) onCerrar();
  };
  return (
    <Modal abierto onCerrar={onCerrar} titulo={`Historial de «${p.titulo}»`} ancho="max-w-4xl">
      {!versiones ? (
        <Cargando />
      ) : !versiones.length ? (
        <p className="py-6 text-center text-sm text-slate-500">Todavía no hay versiones anteriores. Se guarda una cada 5 minutos de escritura (las últimas 30).</p>
      ) : (
        <div className="grid gap-3 md:grid-cols-[240px_1fr]">
          <ul className="max-h-80 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200 md:max-h-[60vh]">
            {versiones.map((v) => (
              <li key={v.id}>
                <button onClick={() => setVista(v)} className={`w-full px-3 py-2.5 text-left text-sm ${vista?.id === v.id ? "bg-marca-suave" : "hover:bg-slate-50"}`}>
                  <div className="font-medium text-slate-800">{haceCuanto(v.creadoEn)}</div>
                  <div className="text-xs text-slate-500">
                    {fechaHora(v.creadoEn)} · {MOTIVO[v.motivo]} · {v.caracteres.toLocaleString("es-AR")} caracteres
                  </div>
                </button>
              </li>
            ))}
          </ul>
          {vista && (
            <div className="grid gap-2">
              <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-slate-200 bg-slate-50 p-3 font-sans text-sm text-slate-700">{vista.texto || "(vacía)"}</pre>
              <Boton variante="primario" className="justify-self-end" onClick={() => void restaurar(vista)}>
                Volver a esta versión
              </Boton>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

type Cerrada = { id: number; titulo: string; caracteres: number; cerradaEn: string };

function ModalPapelera({ onCerrar, onRestaurada }: { onCerrar: () => void; onRestaurada: (id: number) => void }) {
  const { datos } = useDatos<Cerrada[]>("/api/bloc/papelera", ["bloc"]);
  const accion = useAccion();
  return (
    <Modal abierto onCerrar={onCerrar} titulo="Papelera del Bloc" ancho="max-w-lg">
      <p className="mb-3 text-sm text-slate-500">Las pestañas cerradas quedan acá 30 días y después se borran solas.</p>
      {!datos ? (
        <Cargando />
      ) : !datos.length ? (
        <p className="py-6 text-center text-sm text-slate-500">La papelera está vacía.</p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {datos.map((c) => (
            <li key={c.id} className="flex items-center gap-2 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium text-slate-800">{c.titulo}</div>
                <div className="text-xs text-slate-500">
                  Cerrada {haceCuanto(c.cerradaEn)} · {c.caracteres.toLocaleString("es-AR")} caracteres
                </div>
              </div>
              <Boton chico onClick={() => void accion(() => post(`/api/bloc/${c.id}/restaurar`), "Pestaña restaurada").then((r) => r && (onRestaurada(c.id), onCerrar()))}>
                Restaurar
              </Boton>
              <button
                onClick={() => confirm(`¿Borrar «${c.titulo}» para siempre?`) && void accion(() => api(`/api/bloc/${c.id}/definitivo`, { metodo: "DELETE" }), "Borrada")}
                aria-label={`Borrar «${c.titulo}» para siempre`}
                className="flex size-10 items-center justify-center rounded-lg text-slate-400 hover:bg-red-50 hover:text-red-600"
              >
                <Trash2 className="size-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
