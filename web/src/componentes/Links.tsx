import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Copy, Link2, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { Boton, Cargando, Modal, Vacio, useAccion, useAviso } from "./ui";
import { del, post, put } from "../lib/api";
import { sinTildes } from "../lib/textos";
import type { Link } from "../lib/tipos";
import { useDatos } from "../lib/vivo";

const dominio = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

/** El ícono lo da el propio sitio (no un servicio de terceros); si no tiene, la inicial. */
function Icono({ l }: { l: Link }) {
  const [sinIcono, setSinIcono] = useState(false);
  if (sinIcono) return <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-marca-suave text-sm font-bold uppercase text-marca-profundo">{l.concepto.charAt(0)}</span>;
  let origen = "";
  try {
    origen = new URL(l.url).origin;
  } catch {
    // Sin dirección válida: la inicial.
  }
  return <img src={`${origen}/favicon.ico`} alt="" className="size-8 shrink-0 rounded-lg border border-slate-100 bg-white object-contain p-1" onError={() => setSinIcono(true)} />;
}

/** "Mis links": los accesos que más usás. Un toque abre el link; en "Editar" se cambian, ordenan y borran. */
export function Links({ onCerrar }: { onCerrar: () => void }) {
  const { datos: links } = useDatos<Link[]>("/api/links", ["links"]);
  const [q, setQ] = useState("");
  const [editando, setEditando] = useState(false);
  const [form, setForm] = useState<{ id: number | null; concepto: string; url: string } | null>(null);
  const accion = useAccion();
  const avisar = useAviso();

  const filtrados = useMemo(() => {
    const busca = sinTildes(q.trim());
    return (links ?? []).filter((l) => !busca || sinTildes(`${l.concepto} ${l.url}`).includes(busca));
  }, [links, q]);

  const guardar = async () => {
    if (!form) return;
    const datos = { concepto: form.concepto, url: form.url };
    const ok = await accion(() => (form.id ? put(`/api/links/${form.id}`, datos) : post("/api/links", datos)), form.id ? "Link guardado" : "Link agregado");
    if (ok) setForm(null);
  };
  const copiar = (l: Link) =>
    navigator.clipboard.writeText(l.url).then(
      () => avisar("Link copiado"),
      () => avisar("No se pudo copiar", "error"),
    );

  return (
    <Modal
      abierto
      onCerrar={onCerrar}
      titulo="Mis links"
      ancho="max-w-lg"
      pie={
        <>
          <Boton className="mr-auto" icono={<Plus className="size-4" />} onClick={() => setForm({ id: null, concepto: "", url: "" })}>
            Agregar
          </Boton>
          {!!links?.length && (
            <Boton variante={editando ? "primario" : "secundario"} icono={editando ? undefined : <Pencil className="size-4" />} onClick={() => setEditando(!editando)}>
              {editando ? "Listo" : "Editar"}
            </Boton>
          )}
        </>
      }
    >
      {form && (
        <div className="mb-4 space-y-2 rounded-xl border border-slate-200 bg-slate-50 p-3">
          <input className="campo" placeholder="Concepto (ej. Home banking)" autoFocus value={form.concepto} onChange={(e) => setForm({ ...form, concepto: e.target.value })} />
          <input
            className="campo"
            type="url"
            inputMode="url"
            placeholder="https://…"
            value={form.url}
            onChange={(e) => setForm({ ...form, url: e.target.value })}
            onKeyDown={(e) => e.key === "Enter" && void guardar()}
          />
          <div className="flex justify-end gap-2">
            <Boton chico onClick={() => setForm(null)}>
              Cancelar
            </Boton>
            <Boton chico variante="primario" disabled={!form.concepto.trim() || !form.url.trim()} onClick={() => void guardar()}>
              Guardar
            </Boton>
          </div>
        </div>
      )}
      {!links ? (
        <Cargando />
      ) : !links.length ? (
        <Vacio icono={<Link2 className="size-10" />} titulo="Todavía no guardaste links" texto="Agregá los que más usás, o mandale al bot: “guardá en mis links el home banking: https://…”." />
      ) : (
        <>
          <div className="relative mb-3">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
            <input
              className="campo pl-9"
              placeholder="Buscar… (Enter abre el primero)"
              // En la compu se escribe directo; en el celular no, para que el teclado no tape la lista.
              autoFocus={!form && matchMedia("(pointer: fine)").matches}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && filtrados[0] && window.open(filtrados[0].url, "_blank", "noopener")}
            />
          </div>
          {!filtrados.length && <p className="py-6 text-center text-sm text-slate-500">No hay links con esa búsqueda.</p>}
          <ul className="space-y-1">
            {filtrados.map((l) => (
              <li key={l.id} className="flex items-center gap-1 rounded-xl hover:bg-slate-50">
                <a href={l.url} target="_blank" rel="noreferrer" className="flex min-w-0 flex-1 items-center gap-3 px-2 py-2">
                  <Icono l={l} />
                  <span className="min-w-0">
                    <span className="block truncate font-medium text-slate-900">{l.concepto}</span>
                    <span className="block truncate text-xs text-slate-500">{dominio(l.url)}</span>
                  </span>
                </a>
                {editando ? (
                  <span className="flex shrink-0">
                    {/* Ordenar solo con la lista completa (sin búsqueda), para que "subir" sea subir de verdad. */}
                    {!q && (
                      <>
                        <button aria-label="Subir" onClick={() => void accion(() => post(`/api/links/${l.id}/mover`, { paso: -1 }))} className="rounded-lg p-2 text-slate-500 hover:bg-slate-100">
                          <ArrowUp className="size-4" />
                        </button>
                        <button aria-label="Bajar" onClick={() => void accion(() => post(`/api/links/${l.id}/mover`, { paso: 1 }))} className="rounded-lg p-2 text-slate-500 hover:bg-slate-100">
                          <ArrowDown className="size-4" />
                        </button>
                      </>
                    )}
                    <button aria-label="Editar" onClick={() => setForm({ id: l.id, concepto: l.concepto, url: l.url })} className="rounded-lg p-2 text-slate-500 hover:bg-slate-100">
                      <Pencil className="size-4" />
                    </button>
                    <button
                      aria-label="Borrar"
                      onClick={() => confirm(`¿Borrar ${l.concepto}?`) && void accion(() => del(`/api/links/${l.id}`), "Link borrado")}
                      className="rounded-lg p-2 text-slate-400 hover:bg-red-50 hover:text-red-600"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  </span>
                ) : (
                  <button aria-label={`Copiar ${l.concepto}`} title="Copiar el link" onClick={() => void copiar(l)} className="mr-1 shrink-0 rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700">
                    <Copy className="size-4" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </Modal>
  );
}
