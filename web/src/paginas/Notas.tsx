import { useMemo, useRef, useState } from "react";
import { Camera, Copy, ImageOff, Lock, Plus, Search, StickyNote, Trash2 } from "lucide-react";
import { Boton, Cargando, Encabezado, Modal, Vacio, useAccion, useAviso } from "../componentes/ui";
import { api, del, post, put } from "../lib/api";
import { fechaHora } from "../lib/fechas";
import type { Nota } from "../lib/tipos";
import { useDatos } from "../lib/vivo";

type Respuesta = { notas: Nota[]; categorias: string[] };

const sinTildes = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

export function Notas() {
  const { datos, recargar } = useDatos<Respuesta>("/api/notas", ["notas"]);
  const [q, setQ] = useState("");
  const [categoria, setCategoria] = useState<string | null>(null);
  const [editando, setEditando] = useState<Nota | "nueva" | null>(null);

  const filtradas = useMemo(() => {
    if (!datos) return [];
    const busca = sinTildes(q.trim());
    return datos.notas.filter(
      (n) => (!categoria || n.categoria === categoria) && (!busca || sinTildes(`${n.titulo} ${n.contenido} ${n.categoria}`).includes(busca)),
    );
  }, [datos, q, categoria]);
  const usadas = useMemo(() => [...new Set(datos?.notas.map((n) => n.categoria) ?? [])].sort(), [datos]);

  return (
    <div>
      <Encabezado
        titulo="Notas"
        subtitulo={
          <span className="inline-flex items-center gap-1">
            <Lock className="size-3.5" /> Se guardan cifradas. Preguntale al bot: “¿cuál era la clave del wifi?”
          </span>
        }
        acciones={
          <Boton variante="primario" icono={<Plus className="size-4" />} onClick={() => setEditando("nueva")}>
            Nueva nota
          </Boton>
        }
      />
      <div className="mb-4 space-y-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
          <input className="campo pl-9" placeholder="Buscar en tus notas…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {usadas.length > 1 && (
          <div className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:px-0">
            {[null, ...usadas].map((c) => (
              <button
                key={c ?? "todas"}
                onClick={() => setCategoria(c)}
                className={`shrink-0 rounded-full border px-3 py-1 text-sm font-medium capitalize ${
                  categoria === c ? "border-marca-oscuro bg-marca-oscuro text-white" : "border-slate-200 bg-white text-slate-600"
                }`}
              >
                {c ?? "Todas"}
              </button>
            ))}
          </div>
        )}
      </div>

      {!datos ? (
        <Cargando />
      ) : !filtradas.length ? (
        <div className="tarjeta">
          <Vacio
            icono={<StickyNote className="size-10" />}
            titulo={datos.notas.length ? "No hay resultados" : "Todavía no tenés notas"}
            texto="Escribile al bot: “anotá que la clave del wifi es…”, o mandale una foto con “guardala como nota”."
          />
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {filtradas.map((n) => (
            <button key={n.id} onClick={() => setEditando(n)} className="tarjeta flex flex-col overflow-hidden text-left transition hover:border-slate-300 hover:shadow-md">
              {n.adjuntoUrl && <img src={n.adjuntoUrl} alt="" className="h-32 w-full object-cover" />}
              <div className="flex flex-1 flex-col p-4">
                <div className="mb-1 flex items-start justify-between gap-2">
                  <span className="font-semibold text-slate-800">{n.titulo}</span>
                  <span className="shrink-0 rounded-full bg-marca-suave px-2 py-0.5 text-[11px] font-medium capitalize text-marca-profundo">{n.categoria}</span>
                </div>
                <p className="line-clamp-4 whitespace-pre-wrap text-sm text-slate-600">{n.contenido}</p>
                <p className="mt-auto pt-2 text-[11px] text-slate-400">{fechaHora(n.actualizadoEn)}</p>
              </div>
            </button>
          ))}
        </div>
      )}

      {editando && (
        <EditorNota
          nota={editando === "nueva" ? null : editando}
          categorias={datos?.categorias ?? []}
          onCerrar={() => setEditando(null)}
          onCambio={recargar}
        />
      )}
    </div>
  );
}

function EditorNota({ nota, categorias, onCerrar, onCambio }: { nota: Nota | null; categorias: string[]; onCerrar: () => void; onCambio: () => Promise<void> }) {
  const accion = useAccion();
  const avisar = useAviso();
  const [titulo, setTitulo] = useState(nota?.titulo ?? "");
  const [contenido, setContenido] = useState(nota?.contenido ?? "");
  const [categoria, setCategoria] = useState(nota?.categoria ?? "otros");
  const [adjunto, setAdjunto] = useState<{ id: number; url: string } | null>(nota?.adjuntoId && nota.adjuntoUrl ? { id: nota.adjuntoId, url: nota.adjuntoUrl } : null);
  const [subiendo, setSubiendo] = useState(false);
  const [guardando, setGuardando] = useState(false);
  const [borrar, setBorrar] = useState(false);
  const archivo = useRef<HTMLInputElement>(null);

  const guardar = async () => {
    setGuardando(true);
    const cuerpo = { titulo, contenido, categoria, adjuntoId: adjunto?.id ?? null };
    const ok = await accion(() => (nota ? put(`/api/notas/${nota.id}`, cuerpo) : post("/api/notas", cuerpo)), nota ? "Nota guardada" : "Nota creada");
    setGuardando(false);
    if (ok) {
      await onCambio();
      onCerrar();
    }
  };

  return (
    <Modal
      abierto
      onCerrar={onCerrar}
      titulo={nota ? "Editar nota" : "Nueva nota"}
      pie={
        <>
          {nota && (
            <Boton variante="peligro" className="mr-auto" icono={<Trash2 className="size-4" />} onClick={() => setBorrar(true)}>
              Borrar
            </Boton>
          )}
          <Boton variante="fantasma" onClick={onCerrar}>
            Cancelar
          </Boton>
          <Boton variante="primario" cargando={guardando} disabled={!titulo.trim() && !contenido.trim()} onClick={guardar}>
            Guardar
          </Boton>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-[1fr_180px]">
          <div>
            <label className="etiqueta">Título</label>
            <input className="campo" value={titulo} onChange={(e) => setTitulo(e.target.value)} placeholder="Ej. Clave wifi oficina" autoFocus={!nota} />
          </div>
          <div>
            <label className="etiqueta">Categoría</label>
            <input className="campo" list="categorias-notas" value={categoria} onChange={(e) => setCategoria(e.target.value)} />
            <datalist id="categorias-notas">
              {categorias.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </div>
        </div>
        <div>
          <div className="mb-1 flex items-center justify-between">
            <label className="etiqueta mb-0">Contenido</label>
            {contenido && (
              <button
                className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-800"
                onClick={() => navigator.clipboard?.writeText(contenido).then(() => avisar("Copiado"))}
              >
                <Copy className="size-3.5" /> Copiar
              </button>
            )}
          </div>
          <textarea className="campo min-h-40 font-mono text-sm" value={contenido} onChange={(e) => setContenido(e.target.value)} />
        </div>
        <div>
          <label className="etiqueta">Foto</label>
          {adjunto ? (
            <div className="flex items-start gap-3">
              <a href={adjunto.url} target="_blank" rel="noreferrer">
                <img src={adjunto.url} alt="" className="h-28 w-28 rounded-lg border border-slate-200 object-cover" />
              </a>
              <Boton chico variante="peligro" icono={<ImageOff className="size-3.5" />} onClick={() => setAdjunto(null)}>
                Quitar foto
              </Boton>
            </div>
          ) : (
            <Boton chico cargando={subiendo} icono={<Camera className="size-3.5" />} onClick={() => archivo.current?.click()}>
              Adjuntar foto
            </Boton>
          )}
          <input
            ref={archivo}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (!f) return;
              setSubiendo(true);
              const fd = new FormData();
              fd.append("archivo", f);
              const r = await accion(() => api<{ id: number; url: string }>("/api/adjuntos", { formulario: fd }));
              if (r) setAdjunto(r);
              setSubiendo(false);
            }}
          />
        </div>
      </div>
      <Modal
        abierto={borrar}
        onCerrar={() => setBorrar(false)}
        titulo="Borrar nota"
        ancho="max-w-md"
        pie={
          <>
            <Boton variante="fantasma" onClick={() => setBorrar(false)}>
              Cancelar
            </Boton>
            <Boton
              variante="peligro"
              onClick={async () => {
                if (await accion(() => del(`/api/notas/${nota!.id}`), "Nota borrada")) {
                  await onCambio();
                  onCerrar();
                }
              }}
            >
              Borrar
            </Boton>
          </>
        }
      >
        <p className="text-sm text-slate-600">
          ¿Borrar la nota <b>{nota?.titulo}</b>? No se puede deshacer.
        </p>
      </Modal>
    </Modal>
  );
}
