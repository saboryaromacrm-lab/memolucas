import { useState } from "react";
import { ArrowDown, ArrowUp, Check, Eye, EyeOff, Loader2, Pencil, Plus, Trash2, X } from "lucide-react";
import { useAccion } from "../componentes/ui";
import { del, post, put } from "../lib/api";
import type { FormaPago } from "../lib/tipos";
import { useVivo } from "./comun";

const botonIcono = "rounded-lg p-1.5 text-stone-500 hover:bg-stone-100 hover:text-stone-800 disabled:opacity-30 disabled:hover:bg-transparent";

/** Las formas de pago que se ofrecen al cargar cada compra, en este orden. Cada cambio se guarda al instante. */
export function FormasPago() {
  const { datos, recargar } = useVivo<FormaPago[]>("/api/c/formas-pago?ocultas=1");
  const [nueva, setNueva] = useState("");
  const [editando, setEditando] = useState<{ id: number; nombre: string } | null>(null);
  const accion = useAccion();

  const hacer = async (pedido: () => Promise<unknown>, aviso?: string) => {
    const r = await accion(pedido, aviso);
    await recargar();
    return r !== undefined;
  };
  const agregar = async () => {
    if (nueva.trim().length >= 2 && (await hacer(() => post("/api/c/formas-pago", { nombre: nueva.trim() }), `“${nueva.trim()}” agregada`))) setNueva("");
  };
  const renombrar = async () => {
    if (editando && (await hacer(() => put(`/api/c/formas-pago/${editando.id}`, { nombre: editando.nombre.trim() }), "Nombre guardado"))) setEditando(null);
  };

  return (
    <section className="tarjeta mx-auto max-w-2xl overflow-hidden">
      <div className="border-b border-stone-100 px-4 py-3">
        <h2 className="font-semibold text-stone-800">Formas de pago</h2>
        <p className="text-sm text-stone-500">Se eligen al cargar cada compra, en este orden. Las que dejás de usar se ocultan; las que nunca se usaron se pueden borrar.</p>
      </div>
      {!datos ? (
        <div className="flex justify-center py-10">
          <Loader2 className="size-6 animate-spin text-naranja" />
        </div>
      ) : (
        <ul className="divide-y divide-stone-100">
          {datos.map((f, i) => (
            <li key={f.id} className="flex items-center gap-2 px-3 py-2">
              <span className="flex shrink-0 flex-col">
                <button aria-label={`Subir ${f.nombre}`} title="Subir" disabled={i === 0} onClick={() => void hacer(() => post(`/api/c/formas-pago/${f.id}/mover`, { paso: -1 }))} className={botonIcono}>
                  <ArrowUp className="size-4" />
                </button>
                <button
                  aria-label={`Bajar ${f.nombre}`}
                  title="Bajar"
                  disabled={i === datos.length - 1}
                  onClick={() => void hacer(() => post(`/api/c/formas-pago/${f.id}/mover`, { paso: 1 }))}
                  className={botonIcono}
                >
                  <ArrowDown className="size-4" />
                </button>
              </span>
              {editando?.id === f.id ? (
                <>
                  <input
                    className="campo min-w-0 flex-1 py-2"
                    autoFocus
                    value={editando.nombre}
                    onChange={(e) => setEditando({ ...editando, nombre: e.target.value })}
                    onKeyDown={(e) => (e.key === "Enter" ? void renombrar() : e.key === "Escape" && setEditando(null))}
                  />
                  <button aria-label="Guardar nombre" title="Guardar" disabled={editando.nombre.trim().length < 2} onClick={() => void renombrar()} className={botonIcono}>
                    <Check className="size-4" />
                  </button>
                  <button aria-label="Cancelar" title="Cancelar" onClick={() => setEditando(null)} className={botonIcono}>
                    <X className="size-4" />
                  </button>
                </>
              ) : (
                <>
                  <span className="min-w-0 flex-1">
                    <span className={`block truncate font-medium ${f.oculta ? "text-stone-400" : "text-stone-800"}`}>
                      {f.nombre}
                      {f.oculta && <span className="ml-2 text-xs font-normal">(oculta)</span>}
                    </span>
                    <span className="block text-xs text-stone-500">{f.compras ? `${f.compras} ${f.compras === 1 ? "compra" : "compras"}` : "Sin usar"}</span>
                  </span>
                  <button aria-label={`Cambiar el nombre de ${f.nombre}`} title="Cambiar el nombre" onClick={() => setEditando({ id: f.id, nombre: f.nombre })} className={botonIcono}>
                    <Pencil className="size-4" />
                  </button>
                  <button
                    aria-label={`${f.oculta ? "Mostrar" : "Ocultar"} ${f.nombre}`}
                    title={f.oculta ? "Mostrar para elegir" : "Ocultar: no aparece para elegir"}
                    onClick={() => void hacer(() => put(`/api/c/formas-pago/${f.id}`, { oculta: !f.oculta }), f.oculta ? "Se muestra otra vez" : "Oculta")}
                    className={botonIcono}
                  >
                    {f.oculta ? <Eye className="size-4" /> : <EyeOff className="size-4" />}
                  </button>
                  {f.compras === 0 && (
                    <button
                      aria-label={`Borrar ${f.nombre}`}
                      title="Borrar"
                      onClick={() => confirm(`¿Borrar “${f.nombre}”?`) && void hacer(() => del(`/api/c/formas-pago/${f.id}`), "Forma de pago borrada")}
                      className={`${botonIcono} hover:bg-red-50! hover:text-red-600!`}
                    >
                      <Trash2 className="size-4" />
                    </button>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      <form
        className="flex gap-2 border-t border-stone-100 bg-stone-50 px-4 py-3"
        onSubmit={(e) => {
          e.preventDefault();
          void agregar();
        }}
      >
        <input className="campo min-w-0 flex-1 py-2" placeholder="Otra forma de pago (ej. Cuenta DNI)" value={nueva} onChange={(e) => setNueva(e.target.value)} maxLength={60} />
        <button
          type="submit"
          disabled={nueva.trim().length < 2}
          className="flex shrink-0 items-center gap-1.5 rounded-xl bg-naranja px-4 py-2 text-sm font-semibold text-white shadow-sm hover:brightness-95 disabled:opacity-50"
        >
          <Plus className="size-4" /> Agregar
        </button>
      </form>
    </section>
  );
}
