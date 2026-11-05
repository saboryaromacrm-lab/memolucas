import { useEffect, useMemo, useRef, useState } from "react";
import { Eye, EyeOff, Loader2, Pencil, Plus, Search, Trash2, X } from "lucide-react";
import { Boton, useAccion } from "../componentes/ui";
import { del, post, put } from "../lib/api";
import type { Compra } from "../lib/tipos";
import { BuscadorProducto } from "./BuscadorProducto";
import { atajosBloqueados, clave, fechaCorta, Hoja, plata, useVivo, Ventana, type Ancho } from "./comun";
import { Estado } from "./Facturas";
import { lineasDePrecio, type Precios, type Producto } from "./Productos";
import { SelectorFormaPago } from "./SelectorFormaPago";

type Proveedor = {
  id: number;
  nombre: string;
  notas: string;
  oculto: boolean;
  formaPagoId: number | null;
  compras: number;
  esteMes: number;
  mesAnterior: number;
  ultimaCompra: string | null;
};
type Ficha = Proveedor & {
  /** Lo que vende: cuántas veces y cuándo se le compró por última vez (null si todavía no). */
  productos: { id: number; nombre: string; categoria: string; compras: number; ultima: { fecha: string; unidadesPorBulto: number; precios: Precios } | null }[];
  /** Lo pagado este mes en cada forma de pago. */
  pagos: { forma: string | null; total: number }[];
  /** Las últimas 50 compras, para la ficha. */
  ultimas: Compra[];
};

export function Proveedores({ ancho }: { ancho: Ancho }) {
  const [ocultos, setOcultos] = useState(false);
  const { datos } = useVivo<Proveedor[]>(`/api/c/proveedores${ocultos ? "?ocultos=1" : ""}`);
  const [q, setQ] = useState("");
  const [abierto, setAbierto] = useState<number | null>(null);
  const [editando, setEditando] = useState<Proveedor | "nuevo" | null>(null);

  const lista = useMemo(() => (datos ?? []).filter((p) => !q.trim() || clave(`${p.nombre} ${p.notas}`).includes(clave(q))), [datos, q]);

  // ↑ ↓ para pasar de proveedor en la compu y la tablet.
  const actual = useRef({ lista, abierto });
  actual.current = { lista, abierto };
  useEffect(() => {
    if (ancho === "movil") return;
    const tecla = (e: KeyboardEvent) => {
      if (atajosBloqueados(e) || (e.key !== "ArrowDown" && e.key !== "ArrowUp")) return;
      e.preventDefault();
      const { lista, abierto } = actual.current;
      const i = lista.findIndex((p) => p.id === abierto);
      const prox = lista[e.key === "ArrowDown" ? i + 1 : Math.max(0, i - 1)] ?? lista[i];
      if (prox) setAbierto(prox.id);
    };
    window.addEventListener("keydown", tecla);
    return () => window.removeEventListener("keydown", tecla);
  }, [ancho]);
  useEffect(() => {
    if (abierto) document.querySelector(`[data-proveedor="${abierto}"]`)?.scrollIntoView({ block: "nearest" });
  }, [abierto]);

  const barra = (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative min-w-48 flex-1">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-stone-400" />
        <input className="campo py-2 pl-9 text-sm" placeholder="Buscar proveedor…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <button
        onClick={() => setOcultos(!ocultos)}
        className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium ${ocultos ? "bg-cafe text-beige" : "border border-stone-300 bg-white text-stone-600 hover:border-stone-400"}`}
      >
        {ocultos ? <Eye className="size-4" /> : <EyeOff className="size-4" />} {ocultos ? "Con ocultos" : "Ver ocultos"}
      </button>
      <button onClick={() => setEditando("nuevo")} className="flex items-center gap-1.5 rounded-full bg-naranja px-3.5 py-1.5 text-sm font-semibold text-white shadow-sm hover:brightness-95">
        <Plus className="size-4" /> Nuevo proveedor
      </button>
    </div>
  );
  const vacio = <p className="px-4 py-10 text-center text-sm text-stone-500">{datos?.length ? "No hay proveedores con esa búsqueda." : "Todavía no hay proveedores. Se crean solos con las facturas, o tocá “Nuevo proveedor”."}</p>;
  const resumen = (p: Proveedor) => `${p.compras} ${p.compras === 1 ? "compra" : "compras"}${p.ultimaCompra ? ` · última ${fechaCorta(p.ultimaCompra)}` : ""}`;
  const extras = (
    <>
      {abierto && <FichaProveedor key={abierto} id={abierto} ancho={ancho} proveedores={datos ?? []} onEditar={setEditando} onCerrar={() => setAbierto(null)} />}
      {editando && <EditarProveedor p={editando === "nuevo" ? null : editando} onCerrar={() => setEditando(null)} onListo={(id) => (setEditando(null), setAbierto(id))} />}
    </>
  );

  // ───── Celular: tarjetas ─────
  if (ancho === "movil")
    return (
      <div className="space-y-3">
        {barra}
        {!datos ? null : !lista.length ? (
          <div className="tarjeta">{vacio}</div>
        ) : (
          <div className="space-y-2">
            {lista.map((p) => (
              <button key={p.id} onClick={() => setAbierto(p.id)} className="tarjeta flex w-full items-center gap-3 px-4 py-3 text-left active:bg-stone-50">
                <span className="min-w-0 flex-1">
                  <span className={`block truncate font-semibold ${p.oculto ? "text-stone-400" : "text-stone-800"}`}>{p.nombre}</span>
                  <span className="block truncate text-xs text-stone-500">{p.notas || resumen(p)}</span>
                </span>
                <span className="shrink-0 text-right">
                  <span className="block font-semibold tabular-nums text-stone-800">{plata(p.esteMes)}</span>
                  <span className="text-xs text-stone-500">este mes</span>
                </span>
              </button>
            ))}
          </div>
        )}
        {extras}
      </div>
    );

  // ───── Compu y tablet: tabla ─────
  const tabla = (
    <section className="tarjeta flex min-h-0 flex-col overflow-hidden">
      <div className="border-b border-stone-100 px-4 py-3">{barra}</div>
      <div className="@container min-h-0 flex-1 overflow-y-auto">
        {!datos ? (
          <div className="flex justify-center py-10">
            <Loader2 className="size-6 animate-spin text-naranja" />
          </div>
        ) : !lista.length ? (
          vacio
        ) : (
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10 whitespace-nowrap bg-stone-50 text-left text-xs font-semibold uppercase tracking-wide text-stone-500 shadow-[0_1px_0_#e7e5e4]">
              <tr>
                <th className="w-full py-2.5 pl-4 pr-3">Proveedor</th>
                <th className="hidden px-3 py-2.5 text-right @xl:table-cell">Compras</th>
                <th className="hidden px-3 py-2.5 @2xl:table-cell">Última</th>
                <th className="hidden px-3 py-2.5 text-right @lg:table-cell">Mes anterior</th>
                <th className="py-2.5 pl-3 pr-4 text-right">Este mes</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {lista.map((p) => (
                <tr
                  key={p.id}
                  data-proveedor={p.id}
                  onClick={() => setAbierto(p.id)}
                  className={`cursor-pointer ${abierto === p.id ? "bg-orange-50 shadow-[inset_3px_0_0_var(--color-naranja)]" : "hover:bg-stone-50"}`}
                >
                  <td className="max-w-0 py-2.5 pl-4 pr-3">
                    <div className={`truncate font-medium ${p.oculto ? "text-stone-400" : "text-stone-800"}`}>
                      {p.nombre}
                      {p.oculto && <span className="ml-2 text-xs font-normal">(oculto)</span>}
                    </div>
                    {p.notas && <div className="truncate text-xs text-stone-500">{p.notas}</div>}
                  </td>
                  <td className="hidden px-3 py-2.5 text-right tabular-nums text-stone-600 @xl:table-cell">{p.compras}</td>
                  <td className="hidden whitespace-nowrap px-3 py-2.5 text-stone-600 @2xl:table-cell">{fechaCorta(p.ultimaCompra)}</td>
                  <td className="hidden whitespace-nowrap px-3 py-2.5 text-right tabular-nums text-stone-600 @lg:table-cell">{plata(p.mesAnterior)}</td>
                  <td className="whitespace-nowrap py-2.5 pl-3 pr-4 text-right font-semibold tabular-nums text-stone-800">{plata(p.esteMes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
  if (ancho === "tablet")
    return (
      <>
        {tabla}
        {extras}
      </>
    );
  return (
    <div className={`grid h-full min-h-0 gap-4 ${abierto ? "grid-cols-[minmax(0,5fr)_minmax(0,6fr)]" : "grid-cols-1"}`}>
      {tabla}
      {extras}
    </div>
  );
}

function FichaProveedor({
  id,
  ancho,
  proveedores,
  onEditar,
  onCerrar,
}: {
  id: number;
  ancho: Ancho;
  proveedores: Proveedor[];
  onEditar: (p: Proveedor) => void;
  onCerrar: () => void;
}) {
  const { datos: p, recargar } = useVivo<Ficha>(`/api/c/proveedores/${id}`);
  const [juntarCon, setJuntarCon] = useState("");
  const accion = useAccion();

  return (
    <Hoja
      ancho={ancho}
      onCerrar={onCerrar}
      titulo={p?.nombre ?? "Proveedor"}
      subtitulo={p?.oculto ? "Oculto: no aparece para elegir" : undefined}
      acciones={
        p && (
          <button aria-label="Editar proveedor" title="Editar proveedor" onClick={() => onEditar(p)} className={`rounded-lg p-1.5 ${ancho === "movil" ? "hover:bg-white/10" : "text-stone-500 hover:bg-stone-100"}`}>
            <Pencil className="size-5" />
          </button>
        )
      }
    >
      {!p ? (
        <div className="flex justify-center py-16">
          <Loader2 className="size-6 animate-spin text-naranja" />
        </div>
      ) : (
        <div className="space-y-4 p-4">
          <div className="grid grid-cols-3 gap-2">
            {(
              [
                ["Este mes", plata(p.esteMes)],
                ["Mes anterior", plata(p.mesAnterior)],
                ["Compras", String(p.compras)],
              ] as const
            ).map(([t, v]) => (
              <div key={t} className="rounded-xl bg-marca-suave px-2 py-2.5 text-center">
                <div className="text-[11px] font-medium uppercase tracking-wide text-stone-500">{t}</div>
                <div className="whitespace-nowrap text-sm font-bold tabular-nums text-cafe @md:text-lg">{v}</div>
              </div>
            ))}
          </div>
          {p.notas && <p className="tarjeta whitespace-pre-wrap px-4 py-3 text-sm text-stone-700">{p.notas}</p>}

          <section className="tarjeta space-y-3 px-4 py-3">
            <label className="block">
              <span className="etiqueta">Forma de pago habitual</span>
              <SelectorFormaPago
                className="py-2"
                valor={p.formaPagoId}
                onChange={(formaPagoId) => void accion(() => put(`/api/c/proveedores/${id}`, { formaPagoId }), "Forma de pago guardada").then(recargar)}
              />
              <span className="mt-1 block text-xs text-stone-500">Se pone sola al elegirlo en una compra, si la factura no dice cómo se pagó.</span>
            </label>
            {p.pagos.length > 0 && (
              <div>
                <span className="etiqueta">Este mes, por forma de pago</span>
                <div className="divide-y divide-stone-100 text-sm">
                  {p.pagos.map((x) => (
                    <div key={x.forma ?? ""} className="flex justify-between gap-3 py-1.5">
                      <span className={x.forma ? "text-stone-800" : "text-stone-500"}>{x.forma ?? "Sin especificar"}</span>
                      <span className="font-medium tabular-nums">{plata(x.total)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>

          <ProductosDelProveedor proveedorId={id} productos={p.productos} onCambio={recargar} />

          <section className="tarjeta divide-y divide-stone-100">
            <h3 className="px-4 py-2.5 text-sm font-semibold text-stone-800">Últimas compras</h3>
            {p.ultimas.length ? (
              p.ultimas.map((c) => (
                <div key={c.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-stone-800">{c.titulo}</span>
                    <span className="block text-xs text-stone-500">{fechaCorta(c.fecha)}</span>
                  </span>
                  <Estado c={c} />
                  <span className="shrink-0 text-right font-medium tabular-nums">{plata(c.total, c.moneda)}</span>
                </div>
              ))
            ) : (
              <p className="px-4 py-4 text-sm text-stone-500">Sin compras todavía.</p>
            )}
          </section>

          <div className="grid gap-4 @2xl:grid-cols-2">
            <section className="tarjeta space-y-2 p-4 text-sm">
              <h3 className="font-semibold text-stone-800">¿Es el mismo que otro proveedor?</h3>
              <p className="text-xs text-stone-500">Sus compras pasan al que elijas y este se borra.</p>
              <div className="flex gap-2">
                <select className="campo py-2 text-sm" value={juntarCon} onChange={(e) => setJuntarCon(e.target.value)}>
                  <option value="">Elegí el proveedor…</option>
                  {proveedores
                    .filter((x) => x.id !== id)
                    .map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.nombre}
                      </option>
                    ))}
                </select>
                <Boton
                  disabled={!juntarCon}
                  onClick={async () => {
                    if (await accion(() => post(`/api/c/proveedores/${id}/juntar`, { conId: Number(juntarCon) }), "Proveedores juntados")) onCerrar();
                  }}
                >
                  Juntar
                </Boton>
              </div>
            </section>
            <section className="tarjeta flex flex-wrap items-center gap-2 p-4 text-sm">
              <Boton
                icono={p.oculto ? <Eye className="size-4" /> : <EyeOff className="size-4" />}
                onClick={() => void accion(() => put(`/api/c/proveedores/${id}`, { oculto: !p.oculto }), p.oculto ? "Se muestra otra vez" : "Oculto").then(recargar)}
              >
                {p.oculto ? "Mostrar" : "Ocultar"}
              </Boton>
              {p.compras === 0 && (
                <Boton
                  variante="peligro"
                  icono={<Trash2 className="size-4" />}
                  onClick={async () => confirm(`¿Borrar a ${p.nombre}?`) && (await accion(() => del(`/api/c/proveedores/${id}`), "Proveedor borrado")) && onCerrar()}
                >
                  Borrar
                </Boton>
              )}
              <span className="w-full text-xs text-stone-500">
                {p.compras ? "Tiene compras: no se puede borrar, pero se puede ocultar para que no aparezca al elegir." : "Sin compras: se puede borrar."}
              </span>
            </section>
          </div>
        </div>
      )}
    </Hoja>
  );
}

/** Lo que vende el proveedor: se suma solo con cada compra, y se puede agregar o quitar a mano. */
function ProductosDelProveedor({ proveedorId, productos, onCambio }: { proveedorId: number; productos: Ficha["productos"]; onCambio: () => Promise<void> }) {
  const [agregando, setAgregando] = useState(false);
  const [texto, setTexto] = useState("");
  const { datos } = useVivo<{ productos: Producto[] }>(agregando ? "/api/c/productos" : null);
  const enlazados = useMemo(() => new Set(productos.map((x) => x.id)), [productos]);
  const accion = useAccion();
  const hacer = async (pedido: () => Promise<unknown>, aviso: string) => {
    if ((await accion(pedido, aviso)) !== undefined) await onCambio();
  };
  const agregar = async (x: Producto) => {
    setTexto("");
    await hacer(() => post(`/api/c/proveedores/${proveedorId}/productos`, { productoId: x.id }), `“${x.nombre}” agregado`);
  };

  return (
    <section className="tarjeta divide-y divide-stone-100">
      <div className="flex items-center justify-between gap-2 px-4 py-2.5">
        <h3 className="text-sm font-semibold text-stone-800">Lo que le comprás</h3>
        {!agregando && (
          <button onClick={() => (setTexto(""), setAgregando(true))} className="flex items-center gap-1 text-sm font-medium text-naranja hover:underline">
            <Plus className="size-4" /> Agregar producto
          </button>
        )}
      </div>
      {agregando && (
        <div className="flex items-start gap-1 px-4 py-3">
          <div className="min-w-0 flex-1">
            <BuscadorProducto productos={datos?.productos ?? []} proveedorId={null} texto={texto} onTexto={setTexto} onElegir={(x) => void agregar(x)} excluir={enlazados} autoFocus />
          </div>
          <button aria-label="Terminar de agregar" title="Listo" onClick={() => setAgregando(false)} className="mt-1.5 rounded-lg p-1.5 text-stone-400 hover:bg-stone-100 hover:text-stone-700">
            <X className="size-4" />
          </button>
        </div>
      )}
      {productos.length ? (
        productos.map((x) => (
          <div key={x.id} className="flex items-start gap-3 px-4 py-2.5 text-sm">
            <span className="min-w-0 flex-1">
              <span className="block truncate text-stone-800">{x.nombre}</span>
              <span className="text-xs text-stone-500">
                {x.categoria} · {x.ultima ? `${x.compras} ${x.compras === 1 ? "compra" : "compras"} · última ${fechaCorta(x.ultima.fecha)}` : "Todavía no se le compró"}
              </span>
            </span>
            {x.ultima && (
              <span className="flex shrink-0 flex-col items-end text-xs text-stone-500">
                {lineasDePrecio(x.ultima).map(([t, v]) => (
                  <span key={t}>
                    {t} <b className="tabular-nums text-stone-800">{plata(v)}</b>
                  </span>
                ))}
              </span>
            )}
            <button
              aria-label={`Quitar ${x.nombre}`}
              title="Ya no se lo vende: quitarlo de su lista"
              onClick={() => void hacer(() => del(`/api/c/proveedores/${proveedorId}/productos/${x.id}`), `“${x.nombre}” quitado`)}
              className="shrink-0 rounded-lg p-1 text-stone-400 hover:bg-red-50 hover:text-red-600"
            >
              <X className="size-4" />
            </button>
          </div>
        ))
      ) : (
        <p className="px-4 py-4 text-sm text-stone-500">Todavía no tiene productos: se suman solos con cada compra, o agregalos acá.</p>
      )}
    </section>
  );
}

/** Nuevo proveedor o editar uno: nombre y notas. */
function EditarProveedor({ p, onCerrar, onListo }: { p: Proveedor | null; onCerrar: () => void; onListo: (id: number) => void }) {
  const [nombre, setNombre] = useState(p?.nombre ?? "");
  const [notas, setNotas] = useState(p?.notas ?? "");
  const [guardando, setGuardando] = useState(false);
  const accion = useAccion();
  const guardar = async () => {
    setGuardando(true);
    const r = p
      ? await accion(() => put(`/api/c/proveedores/${p.id}`, { nombre, notas }).then(() => ({ id: p.id })), "Proveedor guardado")
      : await accion(() => post<{ id: number }>("/api/c/proveedores", { nombre, notas }), "Proveedor creado");
    setGuardando(false);
    if (r) onListo(r.id);
  };
  return (
    <Ventana
      titulo={p ? "Editar proveedor" : "Nuevo proveedor"}
      ancho="max-w-lg"
      onCerrar={onCerrar}
      pie={
        <button
          onClick={() => void guardar()}
          disabled={nombre.trim().length < 2 || guardando}
          className="flex w-full items-center justify-center gap-2 rounded-2xl bg-cafe py-4 font-semibold text-beige hover:bg-marca-profundo disabled:opacity-50 md:rounded-xl md:py-3"
        >
          {guardando && <Loader2 className="size-5 animate-spin" />} Guardar
        </button>
      }
    >
      <div className="space-y-3 px-4 py-4 md:px-6">
        <label className="block">
          <span className="etiqueta">Nombre</span>
          <input className="campo" autoFocus value={nombre} onChange={(e) => setNombre(e.target.value)} placeholder="Ej. Verdulería Don José" />
        </label>
        <label className="block">
          <span className="etiqueta">Notas</span>
          <textarea className="campo min-h-28" value={notas} onChange={(e) => setNotas(e.target.value)} placeholder="Ej. Entrega martes y jueves · pedir por WhatsApp" />
        </label>
        {p && <p className="text-xs text-stone-500">Si cambiás el nombre, se cambia también en todas sus compras y en Productos.</p>}
      </div>
    </Ventana>
  );
}
