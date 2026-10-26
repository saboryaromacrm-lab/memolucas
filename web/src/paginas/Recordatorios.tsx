import { useEffect, useRef, useState } from "react";
import { BellRing, Camera, CheckCircle2, Copy, MoreVertical, Pause, Pencil, Play, Plus, Repeat, Search, Send, Trash2, ListChecks } from "lucide-react";
import { useEditor } from "../componentes/Editor";
import { Boton, Cargando, Encabezado, InsigniaEstado, Modal, Vacio, useAccion } from "../componentes/ui";
import { del, post } from "../lib/api";
import { cuandoCorto } from "../lib/fechas";
import type { Recordatorio } from "../lib/tipos";
import { useDatos } from "../lib/vivo";

const FILTROS = [
  ["activos", "Activos"],
  ["pausados", "Pausados"],
  ["cumplidos", "Cumplidos"],
  ["no_confirmados", "No confirmados"],
  ["recurrentes", "Recurrentes"],
  ["con_foto", "Con foto"],
  ["todos", "Todos"],
] as const;

export function Recordatorios() {
  const [filtro, setFiltro] = useState<string>("activos");
  const [q, setQ] = useState("");
  const [busqueda, setBusqueda] = useState("");
  const editor = useEditor();
  useEffect(() => {
    const t = setTimeout(() => setBusqueda(q), 300);
    return () => clearTimeout(t);
  }, [q]);
  const ruta = `/api/recordatorios?filtro=${filtro}${busqueda ? `&q=${encodeURIComponent(busqueda)}` : ""}`;
  const { datos, cargando } = useDatos<Recordatorio[]>(ruta, ["recordatorios"]);

  return (
    <div>
      <Encabezado
        titulo="Recordatorios"
        subtitulo="Todo lo que creaste por WhatsApp o desde el panel."
        acciones={
          <Boton variante="primario" icono={<Plus className="size-4" />} onClick={() => editor.abrir({})}>
            Nuevo
          </Boton>
        }
      />
      <div className="mb-4 space-y-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
          <input className="campo pl-9" placeholder="Buscar por título o descripción…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:px-0">
          {FILTROS.map(([v, t]) => (
            <button
              key={v}
              onClick={() => setFiltro(v)}
              className={`shrink-0 rounded-full border px-3 py-1 text-sm font-medium transition ${
                filtro === v ? "border-marca-oscuro bg-marca-oscuro text-white" : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"
              }`}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      {cargando && !datos ? (
        <Cargando />
      ) : !datos?.length ? (
        <div className="tarjeta">
          <Vacio
            icono={<ListChecks className="size-10" />}
            titulo={busqueda ? "No hay resultados" : "No hay recordatorios acá"}
            texto="Creá uno desde el panel o escribile al bot por WhatsApp."
          />
        </div>
      ) : (
        <div className="tarjeta divide-y divide-slate-100">
          {datos.map((r) => (
            <Fila key={r.id} r={r} />
          ))}
        </div>
      )}
    </div>
  );
}

function Fila({ r }: { r: Recordatorio }) {
  const editor = useEditor();
  const accion = useAccion();
  const [menu, setMenu] = useState(false);
  const [borrar, setBorrar] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const fuera = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setMenu(false);
    document.addEventListener("mousedown", fuera);
    return () => document.removeEventListener("mousedown", fuera);
  }, [menu]);

  const hacer = (ruta: string, ok: string) => {
    setMenu(false);
    void accion(() => post(`/api/recordatorios/${r.id}/${ruta}`), ok);
  };
  const activo = r.estado === "activo";

  return (
    <div className="flex items-center gap-3 px-4 py-3 hover:bg-slate-50/60">
      <button onClick={() => editor.abrir({ id: r.id })} className="flex min-w-0 flex-1 items-center gap-3 text-left">
        {r.adjuntoUrl ? (
          <img src={r.adjuntoUrl} alt="" className="size-11 shrink-0 rounded-lg border border-slate-200 object-cover" />
        ) : (
          <span className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-400">
            {r.rrule ? <Repeat className="size-5" /> : <BellRing className="size-5" />}
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold text-slate-800">{r.titulo}</span>
            {r.estado !== "activo" && <InsigniaEstado estado={r.estado} />}
          </span>
          <span className="mt-0.5 block truncate text-xs text-slate-500">
            {r.estado === "activo" || r.estado === "pausado" ? cuandoCorto(r.proxima) : `Era ${cuandoCorto(r.proxima)}`}
            {r.repeticion && ` · ${r.repeticion}`}
            {r.avisosPreviosMin.length > 0 && ` · ${r.avisosPreviosMin.length} aviso${r.avisosPreviosMin.length > 1 ? "s" : ""} previo${r.avisosPreviosMin.length > 1 ? "s" : ""}`}
          </span>
        </span>
        <span className="hidden shrink-0 items-center gap-1.5 text-slate-400 sm:flex">
          {r.adjuntoId && <Camera className="size-4" />}
          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-500">{r.origen === "panel" ? "Panel" : r.origen === "foto" ? "Foto" : r.origen === "enlace" ? "Link" : "WhatsApp"}</span>
        </span>
      </button>
      <div className="relative" ref={ref}>
        <button onClick={() => setMenu(!menu)} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700" aria-label="Acciones">
          <MoreVertical className="size-5" />
        </button>
        {menu && (
          <div className="absolute right-0 top-9 z-20 w-48 overflow-hidden rounded-xl border border-slate-200 bg-white py-1 text-sm shadow-lg">
            <Item icono={<Pencil />} onClick={() => (setMenu(false), editor.abrir({ id: r.id }))}>
              Editar
            </Item>
            {activo && (
              <Item icono={<Send />} onClick={() => hacer("enviar-ahora", "Enviado por WhatsApp")}>
                Enviar ahora
              </Item>
            )}
            {activo && (
              <Item icono={<CheckCircle2 />} onClick={() => hacer("hecho", "Marcado como hecho")}>
                Marcar como hecho
              </Item>
            )}
            {activo && (
              <Item icono={<Pause />} onClick={() => hacer("pausar", "Pausado")}>
                Pausar
              </Item>
            )}
            {r.estado === "pausado" && (
              <Item icono={<Play />} onClick={() => hacer("reanudar", "Reanudado")}>
                Reanudar
              </Item>
            )}
            <Item icono={<Copy />} onClick={() => hacer("duplicar", "Duplicado")}>
              Duplicar
            </Item>
            <Item icono={<Trash2 />} peligro onClick={() => (setMenu(false), setBorrar(true))}>
              Borrar
            </Item>
          </div>
        )}
      </div>
      <Modal
        abierto={borrar}
        onCerrar={() => setBorrar(false)}
        titulo="Borrar recordatorio"
        ancho="max-w-md"
        pie={
          <>
            <Boton variante="fantasma" onClick={() => setBorrar(false)}>
              Cancelar
            </Boton>
            <Boton
              variante="peligro"
              icono={<Trash2 className="size-4" />}
              onClick={async () => {
                setBorrar(false);
                await accion(() => del(`/api/recordatorios/${r.id}`), "Recordatorio borrado");
              }}
            >
              Borrar
            </Boton>
          </>
        }
      >
        <p className="text-sm text-slate-600">
          ¿Borrar <b>{r.titulo}</b>? Deja de avisarte y desaparece de la lista.
        </p>
      </Modal>
    </div>
  );
}

function Item({ icono, children, onClick, peligro }: { icono: React.ReactNode; children: React.ReactNode; onClick: () => void; peligro?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-slate-50 [&>svg]:size-4 ${peligro ? "text-red-600" : "text-slate-700 [&>svg]:text-slate-400"}`}
    >
      {icono}
      {children}
    </button>
  );
}
