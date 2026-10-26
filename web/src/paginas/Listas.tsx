import { useState } from "react";
import { Check, MoreVertical, Pencil, Plus, ShoppingCart, Trash2, Eraser } from "lucide-react";
import { Boton, Cargando, Encabezado, Modal, Vacio, useAccion } from "../componentes/ui";
import { del, post, put } from "../lib/api";
import type { Lista } from "../lib/tipos";
import { useDatos } from "../lib/vivo";

export function Listas() {
  const { datos, recargar } = useDatos<Lista[]>("/api/listas", ["listas"]);
  const [nueva, setNueva] = useState(false);

  return (
    <div>
      <Encabezado
        titulo="Listas"
        subtitulo="Súper, farmacia, pendientes… Lo que agregás por WhatsApp aparece acá al instante."
        acciones={
          <Boton variante="primario" icono={<Plus className="size-4" />} onClick={() => setNueva(true)}>
            Nueva lista
          </Boton>
        }
      />
      {!datos ? (
        <Cargando />
      ) : !datos.length ? (
        <div className="tarjeta">
          <Vacio
            icono={<ShoppingCart className="size-10" />}
            titulo="Todavía no tenés listas"
            texto="Escribile al bot: “agregá leche y 2 kg de pan a la lista del súper”, o creá una acá."
          />
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {datos.map((l) => (
            <TarjetaLista key={l.id} lista={l} onCambio={recargar} />
          ))}
        </div>
      )}
      <NombreModal
        abierto={nueva}
        titulo="Nueva lista"
        inicial=""
        onCerrar={() => setNueva(false)}
        onGuardar={async (nombre) => {
          await post("/api/listas", { nombre });
          await recargar();
        }}
      />
    </div>
  );
}

function TarjetaLista({ lista, onCambio }: { lista: Lista; onCambio: () => Promise<void> }) {
  const accion = useAccion();
  const [texto, setTexto] = useState("");
  const [cantidad, setCantidad] = useState("");
  const [menu, setMenu] = useState(false);
  const [renombrar, setRenombrar] = useState(false);
  const [borrar, setBorrar] = useState(false);
  const [saliendo, setSaliendo] = useState<number[]>([]);

  const agregar = async () => {
    if (!texto.trim()) return;
    const ok = await accion(() => post(`/api/listas/${lista.id}/items`, { texto, cantidad: cantidad || null }));
    if (ok) {
      setTexto("");
      setCantidad("");
      await onCambio();
    }
  };

  const tachar = async (id: number) => {
    setSaliendo((s) => [...s, id]);
    await accion(() => del(`/api/listas/items/${id}`));
    await onCambio();
  };

  return (
    <section className="tarjeta flex flex-col">
      <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-800">
          <ShoppingCart className="size-4 text-marca-oscuro" />
          {lista.nombre}
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500">{lista.items.length}</span>
        </h2>
        <div className="relative">
          <button onClick={() => setMenu(!menu)} className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700" aria-label="Opciones">
            <MoreVertical className="size-4" />
          </button>
          {menu && (
            <div className="absolute right-0 top-8 z-20 w-40 overflow-hidden rounded-xl border border-slate-200 bg-white py-1 text-sm shadow-lg" onMouseLeave={() => setMenu(false)}>
              <button className="flex w-full items-center gap-2 px-3 py-2 hover:bg-slate-50" onClick={() => (setMenu(false), setRenombrar(true))}>
                <Pencil className="size-4 text-slate-400" /> Renombrar
              </button>
              <button
                className="flex w-full items-center gap-2 px-3 py-2 hover:bg-slate-50"
                onClick={async () => {
                  setMenu(false);
                  await accion(() => post(`/api/listas/${lista.id}/vaciar`), "Lista vaciada");
                  await onCambio();
                }}
              >
                <Eraser className="size-4 text-slate-400" /> Vaciar
              </button>
              <button className="flex w-full items-center gap-2 px-3 py-2 text-red-600 hover:bg-red-50" onClick={() => (setMenu(false), setBorrar(true))}>
                <Trash2 className="size-4" /> Borrar lista
              </button>
            </div>
          )}
        </div>
      </div>

      <ul className="flex-1 divide-y divide-slate-100">
        {lista.items.map((i) => (
          <li key={i.id} className={`flex items-center gap-3 px-4 py-2.5 transition ${saliendo.includes(i.id) ? "opacity-30 line-through" : ""}`}>
            <button
              onClick={() => tachar(i.id)}
              className="flex size-5 shrink-0 items-center justify-center rounded-full border-2 border-slate-300 text-transparent hover:border-marca-oscuro hover:text-marca-oscuro"
              aria-label={`Ya está: ${i.texto}`}
              title="Ya está (se borra)"
            >
              <Check className="size-3" />
            </button>
            <span className="min-w-0 flex-1 text-sm text-slate-800">{i.texto}</span>
            {i.cantidad && <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">{i.cantidad}</span>}
          </li>
        ))}
        {!lista.items.length && <li className="px-4 py-6 text-center text-sm text-slate-500">Vacía 🙌</li>}
      </ul>

      <form
        className="flex gap-2 border-t border-slate-100 p-3"
        onSubmit={(e) => {
          e.preventDefault();
          void agregar();
        }}
      >
        <input className="campo" placeholder="Agregar…" value={texto} onChange={(e) => setTexto(e.target.value)} />
        <input className="campo w-20" placeholder="Cant." value={cantidad} onChange={(e) => setCantidad(e.target.value)} />
        <Boton type="submit" variante="primario" icono={<Plus className="size-4" />} disabled={!texto.trim()} aria-label="Agregar" />
      </form>

      <NombreModal
        abierto={renombrar}
        titulo="Renombrar lista"
        inicial={lista.nombre}
        onCerrar={() => setRenombrar(false)}
        onGuardar={async (nombre) => {
          await put(`/api/listas/${lista.id}`, { nombre });
          await onCambio();
        }}
      />
      <Modal
        abierto={borrar}
        onCerrar={() => setBorrar(false)}
        titulo="Borrar lista"
        ancho="max-w-md"
        pie={
          <>
            <Boton variante="fantasma" onClick={() => setBorrar(false)}>
              Cancelar
            </Boton>
            <Boton
              variante="peligro"
              onClick={async () => {
                setBorrar(false);
                await accion(() => del(`/api/listas/${lista.id}`), "Lista borrada");
                await onCambio();
              }}
            >
              Borrar
            </Boton>
          </>
        }
      >
        <p className="text-sm text-slate-600">
          ¿Borrar la lista <b>{lista.nombre}</b> con sus {lista.items.length} ítems?
        </p>
      </Modal>
    </section>
  );
}

function NombreModal({
  abierto,
  titulo,
  inicial,
  onCerrar,
  onGuardar,
}: {
  abierto: boolean;
  titulo: string;
  inicial: string;
  onCerrar: () => void;
  onGuardar: (nombre: string) => Promise<void>;
}) {
  const [nombre, setNombre] = useState(inicial);
  const accion = useAccion();
  return (
    <Modal
      abierto={abierto}
      onCerrar={onCerrar}
      titulo={titulo}
      ancho="max-w-md"
      pie={
        <>
          <Boton variante="fantasma" onClick={onCerrar}>
            Cancelar
          </Boton>
          <Boton
            variante="primario"
            disabled={!nombre.trim()}
            onClick={async () => {
              if (await accion(() => onGuardar(nombre).then(() => true))) {
                setNombre("");
                onCerrar();
              }
            }}
          >
            Guardar
          </Boton>
        </>
      }
    >
      <label className="etiqueta">Nombre</label>
      <input className="campo" autoFocus value={nombre} onChange={(e) => setNombre(e.target.value)} placeholder="Ej. Súper, Farmacia, Ferretería" />
    </Modal>
  );
}
