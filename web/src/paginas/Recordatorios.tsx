import { useEffect, useState } from "react";
import { BellRing, Camera, CheckCircle2, Copy, Pause, Pencil, Play, Plus, Repeat, Search, Send, Trash2, ListChecks } from "lucide-react";
import { useEditor } from "../componentes/Editor";
import { Boton, Cargando, Deslizable, Encabezado, InsigniaEstado, MenuAcciones, Modal, Vacio, useAccion } from "../componentes/ui";
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
        <Deslizable className="gap-1.5 sm:flex-wrap">
          {FILTROS.map(([v, t]) => (
            <button
              key={v}
              onClick={() => setFiltro(v)}
              className={`shrink-0 rounded-full border px-3.5 py-1.5 text-sm font-medium transition ${
                filtro === v ? "border-marca-oscuro bg-marca-oscuro text-white" : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"
              }`}
            >
              {t}
            </button>
          ))}
        </Deslizable>
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
  const [borrar, setBorrar] = useState(false);

  const hacer = (ruta: string, ok: string) => void accion(() => post(`/api/recordatorios/${r.id}/${ruta}`), ok);
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
          <span className="flex items-start gap-2">
            <span className="line-clamp-2 break-words text-sm font-semibold text-slate-800">{r.titulo}</span>
            {r.grupoNombre && <span className="shrink-0 rounded-full bg-sky-50 px-2 py-0.5 text-[11px] font-medium text-sky-700">👨‍👩‍👧 {r.grupoNombre}</span>}
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
      <MenuAcciones
        acciones={[
          { texto: "Editar", icono: <Pencil />, onClick: () => editor.abrir({ id: r.id }) },
          activo && { texto: "Enviar ahora", icono: <Send />, onClick: () => hacer("enviar-ahora", "Enviado por WhatsApp") },
          activo && { texto: "Marcar como hecho", icono: <CheckCircle2 />, onClick: () => hacer("hecho", "Marcado como hecho") },
          activo && { texto: "Pausar", icono: <Pause />, onClick: () => hacer("pausar", "Pausado") },
          r.estado === "pausado" && { texto: "Reanudar", icono: <Play />, onClick: () => hacer("reanudar", "Reanudado") },
          { texto: "Duplicar", icono: <Copy />, onClick: () => hacer("duplicar", "Duplicado") },
          { texto: "Borrar", icono: <Trash2 />, peligro: true, onClick: () => setBorrar(true) },
        ]}
      />
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
