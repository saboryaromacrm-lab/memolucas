import { useMemo, useState } from "react";
import { AlertTriangle, ChevronLeft, Download, Package, Pencil, Search, TrendingDown, TrendingUp, X } from "lucide-react";
import { Boton, useAccion } from "../componentes/ui";
import { post, put } from "../lib/api";
import { fechaCorta, plata, useVivo } from "./comun";

type Precios = { bulto: number | null; unidad: number | null; porMedida: { valor: number; medida: "kg" | "l" } | null };
type UnidadCompra = "bulto" | "unidad" | "kg" | "litro";
type CompraProducto = {
  id: number;
  proveedor: string;
  fecha: string;
  descripcion: string;
  cantidad: number;
  unidadCompra: UnidadCompra;
  unidadesPorBulto: number;
  precios: Precios;
  variacion: number | null;
};
type Producto = {
  id: number;
  nombre: string;
  categoria: string;
  clase: "mercaderia" | "gasto";
  contenido: number | null;
  medida: "kg" | "l" | null;
  ultima: CompraProducto | null;
  variacion: number | null;
  alerta: boolean;
  proveedores: { proveedor: string; ultima: CompraProducto }[];
  compras: number;
};
type DetalleProducto = Producto & { historial: CompraProducto[]; alias: { clave: string; proveedor: string }[] };

const MEDIDAS = { kg: "kg", l: "litro" } as const;
const ORDENES = [
  ["nombre", "Nombre"],
  ["suba", "Más subieron"],
  ["precio", "Precio"],
  ["reciente", "Última compra"],
] as const;

/** El precio con el que se compara: por kg o litro, si no por unidad, si no por bulto (igual que el servidor). */
const referencia = (p: Precios | undefined) => p?.porMedida?.valor ?? p?.unidad ?? p?.bulto ?? null;

/** "Caja x 15 $ 12.499,93 · Unidad $ 833,33 · Litro $ 1.666,66" */
function lineasDePrecio(c: CompraProducto): [string, number][] {
  const p = c.precios;
  return [
    ...(p.bulto !== null ? [[c.unidadesPorBulto ? `Caja x ${c.unidadesPorBulto}` : "Bulto", p.bulto] as [string, number]] : []),
    ...(p.unidad !== null ? [["Unidad", p.unidad] as [string, number]] : []),
    ...(p.porMedida ? [[MEDIDAS[p.porMedida.medida].replace(/^./, (l) => l.toUpperCase()), p.porMedida.valor] as [string, number]] : []),
  ];
}

function Variacion({ v }: { v: number | null }) {
  if (v === null || Math.abs(v) < 0.05) return null;
  const sube = v > 0;
  return (
    <span className={`inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[11px] font-semibold ${sube ? "bg-red-50 text-red-700" : "bg-emerald-50 text-emerald-700"}`}>
      {sube ? <TrendingUp className="size-3" /> : <TrendingDown className="size-3" />}
      {sube ? "+" : ""}
      {v.toFixed(1).replace(".", ",")} %
    </span>
  );
}

export function Productos() {
  const { datos } = useVivo<{ productos: Producto[]; alertaPct: number }>("/api/c/productos");
  const [q, setQ] = useState("");
  const [categoria, setCategoria] = useState("");
  const [clase, setClase] = useState("");
  const [proveedor, setProveedor] = useState("");
  const [orden, setOrden] = useState<(typeof ORDENES)[number][0]>("nombre");
  const [soloSubas, setSoloSubas] = useState(false);
  const [abierto, setAbierto] = useState<number | null>(null);

  const productos = datos?.productos ?? [];
  const categorias = useMemo(() => [...new Set(productos.map((p) => p.categoria))].sort(), [productos]);
  const proveedores = useMemo(() => [...new Set(productos.flatMap((p) => p.proveedores.map((x) => x.proveedor)))].sort(), [productos]);
  const alertas = productos.filter((p) => p.alerta).length;

  const lista = useMemo(() => {
    const buscado = q.trim().toLowerCase();
    const filtrados = productos.filter(
      (p) =>
        (!buscado || p.nombre.toLowerCase().includes(buscado)) &&
        (!categoria || p.categoria === categoria) &&
        (!clase || p.clase === clase) &&
        (!proveedor || p.proveedores.some((x) => x.proveedor === proveedor)) &&
        (!soloSubas || p.alerta),
    );
    const porOrden: Record<typeof orden, (a: Producto, b: Producto) => number> = {
      nombre: (a, b) => a.nombre.localeCompare(b.nombre),
      suba: (a, b) => (b.variacion ?? -Infinity) - (a.variacion ?? -Infinity),
      precio: (a, b) => (referencia(b.ultima?.precios) ?? 0) - (referencia(a.ultima?.precios) ?? 0),
      reciente: (a, b) => (b.ultima?.fecha ?? "").localeCompare(a.ultima?.fecha ?? ""),
    };
    return filtrados.sort(porOrden[orden]);
  }, [productos, q, categoria, clase, proveedor, soloSubas, orden]);

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-stone-400" />
        <input className="campo pl-9" placeholder="Buscar producto…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="grid grid-cols-2 gap-2 text-sm">
        <select className="campo py-2 text-sm" value={categoria} onChange={(e) => setCategoria(e.target.value)}>
          <option value="">Todas las categorías</option>
          {categorias.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
        <select className="campo py-2 text-sm" value={proveedor} onChange={(e) => setProveedor(e.target.value)}>
          <option value="">Todos los proveedores</option>
          {proveedores.map((p) => (
            <option key={p}>{p}</option>
          ))}
        </select>
        <select className="campo py-2 text-sm" value={clase} onChange={(e) => setClase(e.target.value)}>
          <option value="">Mercadería y gastos</option>
          <option value="mercaderia">Solo mercadería</option>
          <option value="gasto">Solo gastos</option>
        </select>
        <select className="campo py-2 text-sm" value={orden} onChange={(e) => setOrden(e.target.value as typeof orden)}>
          {ORDENES.map(([v, t]) => (
            <option key={v} value={v}>
              Ordenar: {t}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {alertas > 0 && (
          <button
            onClick={() => setSoloSubas(!soloSubas)}
            className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium ${soloSubas ? "bg-red-600 text-white" : "border border-red-200 bg-red-50 text-red-700"}`}
          >
            <AlertTriangle className="size-4" /> {alertas} {alertas === 1 ? "subió" : "subieron"} más de {datos?.alertaPct} %
          </button>
        )}
        <a href="/api/c/productos.csv" className="ml-auto flex items-center gap-1.5 rounded-full border border-stone-300 bg-white px-3 py-1.5 text-sm font-medium text-stone-700">
          <Download className="size-4" /> Excel
        </a>
      </div>

      {!datos ? null : !lista.length ? (
        <p className="tarjeta px-4 py-8 text-center text-sm text-stone-500">
          {productos.length ? "No hay productos con esos filtros." : "Todavía no hay productos: aparecen cuando se confirma una factura."}
        </p>
      ) : (
        <div className="space-y-2">
          {lista.map((p) => (
            <button key={p.id} onClick={() => setAbierto(p.id)} className="tarjeta block w-full px-4 py-3 text-left active:bg-stone-50">
              <span className="flex items-start gap-2">
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 font-semibold text-stone-800">
                    {p.alerta && <AlertTriangle className="size-4 shrink-0 text-red-600" />}
                    <span className="truncate">{p.nombre}</span>
                  </span>
                  <span className="block truncate text-xs text-stone-500">
                    {p.categoria}
                    {p.ultima && ` · ${p.ultima.proveedor} · ${fechaCorta(p.ultima.fecha)}`}
                    {p.proveedores.length > 1 && ` · ${p.proveedores.length} proveedores`}
                  </span>
                </span>
                <Variacion v={p.variacion} />
              </span>
              {p.ultima && (
                <span className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm">
                  {lineasDePrecio(p.ultima).map(([t, v]) => (
                    <span key={t} className="text-stone-500">
                      {t} <b className="tabular-nums text-stone-800">{plata(v)}</b>
                    </span>
                  ))}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
      {abierto && <FichaProducto id={abierto} productos={productos} categorias={categorias} onCerrar={() => setAbierto(null)} />}
    </div>
  );
}

/** Gráfico chico con el precio de referencia de cada compra. */
function Grafico({ valores }: { valores: number[] }) {
  if (valores.length < 2) return null;
  const min = Math.min(...valores);
  const max = Math.max(...valores);
  const puntos = valores.map((v, i) => `${(i / (valores.length - 1)) * 300},${max === min ? 30 : 56 - ((v - min) / (max - min)) * 52}`).join(" ");
  return (
    <svg viewBox="0 0 300 60" className="h-16 w-full" preserveAspectRatio="none" aria-label="Evolución del precio">
      <polyline points={puntos} fill="none" stroke="var(--color-naranja)" strokeWidth="2.5" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function FichaProducto({ id, productos, categorias, onCerrar }: { id: number; productos: Producto[]; categorias: string[]; onCerrar: () => void }) {
  const { datos: p, recargar } = useVivo<DetalleProducto>(`/api/c/productos/${id}`);
  const [editando, setEditando] = useState(false);
  const [juntarCon, setJuntarCon] = useState("");
  const accion = useAccion();

  const ultima = p?.ultima;
  const base = ultima?.precios.porMedida ? "medida" : ultima?.precios.unidad !== null ? "unidad" : "bulto";
  // El gráfico usa solo las compras comparables con la última.
  const serie = (p?.historial ?? [])
    .filter((h) => (base === "medida" ? h.precios.porMedida : base === "unidad" ? h.precios.unidad !== null : h.precios.bulto !== null))
    .map((h) => referencia(h.precios)!);
  const masBarato = p?.proveedores.length && p.proveedores.length > 1 ? [...p.proveedores].sort((a, b) => (referencia(a.ultima.precios) ?? Infinity) - (referencia(b.ultima.precios) ?? Infinity))[0].proveedor : null;

  return (
    <div data-superpuesto className="fixed inset-0 z-40 overflow-y-auto bg-[#faf5ee]">
      <div className="mx-auto max-w-xl pb-10">
        <header className="sticky top-0 z-10 flex items-center gap-2 bg-cafe px-2 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))] text-beige shadow-md">
          <button aria-label="Volver" onClick={onCerrar} className="rounded-lg p-1.5 hover:bg-white/10">
            <ChevronLeft className="size-6" />
          </button>
          <span className="min-w-0 flex-1 truncate font-semibold">{p?.nombre ?? "Producto"}</span>
          {p && (
            <button aria-label="Editar" onClick={() => setEditando(true)} className="rounded-lg p-1.5 hover:bg-white/10">
              <Pencil className="size-5" />
            </button>
          )}
        </header>
        {p && (
          <div className="space-y-4 px-4 pt-4">
            <p className="text-sm text-stone-500">
              {p.categoria} · {p.clase === "gasto" ? "Gasto" : "Mercadería"}
              {p.contenido && p.medida ? ` · ${String(p.contenido).replace(".", ",")} ${MEDIDAS[p.medida]} por unidad` : ""} · {p.compras} {p.compras === 1 ? "compra" : "compras"}
            </p>
            {ultima && (
              <section className="tarjeta p-4">
                <div className="mb-2 flex items-center justify-between text-xs text-stone-500">
                  <span>
                    Última compra: {ultima.proveedor} · {fechaCorta(ultima.fecha)}
                  </span>
                  <Variacion v={ultima.variacion} />
                </div>
                <div className="grid grid-cols-3 gap-2">
                  {lineasDePrecio(ultima).map(([t, v]) => (
                    <div key={t} className="rounded-xl bg-marca-suave px-2 py-2 text-center">
                      <div className="text-[11px] font-medium uppercase tracking-wide text-stone-500">{t}</div>
                      <div className="whitespace-nowrap text-sm font-bold tabular-nums text-cafe sm:text-base">{plata(v)}</div>
                    </div>
                  ))}
                </div>
                <p className="mt-2 text-[11px] text-stone-500">Precio final con IVA e impuestos internos, con descuentos aplicados.</p>
                <Grafico valores={serie} />
              </section>
            )}

            {p.proveedores.length > 1 && (
              <section className="tarjeta divide-y divide-stone-100">
                <h3 className="px-4 py-2.5 text-sm font-semibold text-stone-800">Por proveedor</h3>
                {p.proveedores.map((x) => (
                  <div key={x.proveedor} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-stone-800">
                        {x.proveedor}
                        {x.proveedor === masBarato && <span className="ml-1.5 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[11px] font-semibold text-emerald-700">Más barato</span>}
                      </span>
                      <span className="text-xs text-stone-500">{fechaCorta(x.ultima.fecha)}</span>
                    </span>
                    <span className="text-right tabular-nums">
                      {lineasDePrecio(x.ultima)
                        .slice(-1)
                        .map(([t, v]) => (
                          <span key={t}>
                            <b>{plata(v)}</b> <span className="text-xs text-stone-500">/ {t.toLowerCase()}</span>
                          </span>
                        ))}
                    </span>
                  </div>
                ))}
              </section>
            )}

            <section className="tarjeta divide-y divide-stone-100">
              <h3 className="px-4 py-2.5 text-sm font-semibold text-stone-800">Historial de compras</h3>
              {[...p.historial].reverse().map((h) => (
                <CompraFila key={h.id} h={h} onCambio={recargar} />
              ))}
            </section>

            {p.alias.length > 1 && (
              <section className="tarjeta space-y-2 p-4 text-sm">
                <h3 className="font-semibold text-stone-800">¿No es el mismo producto?</h3>
                <p className="text-xs text-stone-500">Separá lo que se compró a un proveedor en un producto aparte.</p>
                {p.alias.map((a) => (
                  <Boton key={a.clave} chico className="mr-2" onClick={() => void accion(() => post(`/api/c/productos/${id}/separar`, { alias: a.clave }), `Separado: ${a.proveedor}`).then(recargar)}>
                    Separar {a.proveedor}
                  </Boton>
                ))}
              </section>
            )}

            <section className="tarjeta space-y-2 p-4 text-sm">
              <h3 className="font-semibold text-stone-800">¿Es el mismo que otro producto?</h3>
              <div className="flex gap-2">
                <select className="campo py-2 text-sm" value={juntarCon} onChange={(e) => setJuntarCon(e.target.value)}>
                  <option value="">Elegí el producto…</option>
                  {productos
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
                    if (await accion(() => post(`/api/c/productos/${id}/juntar`, { conId: Number(juntarCon) }), "Productos juntados")) onCerrar();
                  }}
                >
                  Juntar
                </Boton>
              </div>
            </section>
          </div>
        )}
      </div>
      {editando && p && <EditarProducto p={p} categorias={categorias} onCerrar={() => setEditando(false)} onListo={() => (setEditando(false), void recargar())} />}
    </div>
  );
}

const UNIDADES: Record<UnidadCompra, string> = { bulto: "Bulto o caja", unidad: "Unidad", kg: "Kilo", litro: "Litro" };

/** Una compra del historial. Si la IA se equivocó en cómo vino (ej. la caja trae 12), se corrige acá. */
function CompraFila({ h, onCambio }: { h: CompraProducto; onCambio: () => Promise<void> }) {
  const [corrigiendo, setCorrigiendo] = useState(false);
  const [unidad, setUnidad] = useState(h.unidadCompra);
  const [porBulto, setPorBulto] = useState(String(h.unidadesPorBulto || ""));
  const accion = useAccion();
  return (
    <div className="px-4 py-2.5 text-sm">
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1">
          <span className="block text-stone-800">
            {fechaCorta(h.fecha)} · {h.proveedor}
          </span>
          <span className="block truncate text-xs text-stone-500">
            {h.descripcion} · {h.cantidad} {UNIDADES[h.unidadCompra].toLowerCase()}
            {h.unidadCompra === "bulto" && h.unidadesPorBulto ? ` x ${h.unidadesPorBulto}` : ""}
          </span>
        </span>
        <Variacion v={h.variacion} />
        <button aria-label="Corregir cómo vino" onClick={() => setCorrigiendo(!corrigiendo)} className="rounded p-1 text-stone-400">
          {corrigiendo ? <X className="size-4" /> : <Pencil className="size-4" />}
        </button>
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-stone-600">
        {lineasDePrecio(h).map(([t, v]) => (
          <span key={t}>
            {t} <b className="tabular-nums">{plata(v)}</b>
          </span>
        ))}
      </div>
      {corrigiendo && (
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <label className="min-w-0 flex-1">
            <span className="etiqueta">Se compró por</span>
            <select className="campo py-2 text-sm" value={unidad} onChange={(e) => setUnidad(e.target.value as UnidadCompra)}>
              {Object.entries(UNIDADES).map(([v, t]) => (
                <option key={v} value={v}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          {unidad === "bulto" && (
            <label className="w-28">
              <span className="etiqueta">Unidades</span>
              <input className="campo py-2 text-sm" inputMode="numeric" value={porBulto} onChange={(e) => setPorBulto(e.target.value.replace(/\D/g, ""))} />
            </label>
          )}
          <Boton
            variante="primario"
            onClick={async () => {
              if (await accion(() => put(`/api/c/productos/compras/${h.id}`, { unidadCompra: unidad, unidadesPorBulto: unidad === "bulto" ? Number(porBulto) || 0 : 0 }), "Corregido")) {
                setCorrigiendo(false);
                await onCambio();
              }
            }}
          >
            Guardar
          </Boton>
        </div>
      )}
    </div>
  );
}

function EditarProducto({ p, categorias, onCerrar, onListo }: { p: DetalleProducto; categorias: string[]; onCerrar: () => void; onListo: () => void }) {
  const [nombre, setNombre] = useState(p.nombre);
  const [categoria, setCategoria] = useState(p.categoria);
  const [clase, setClase] = useState(p.clase);
  const [contenido, setContenido] = useState(p.contenido ? String(p.contenido).replace(".", ",") : "");
  const [medida, setMedida] = useState<"kg" | "l">(p.medida ?? "kg");
  const accion = useAccion();
  const guardar = async () => {
    const n = Number(contenido.replace(",", "."));
    const ok = await accion(
      () => put(`/api/c/productos/${p.id}`, { nombre, categoria, clase, contenido: n > 0 ? n : null, medida: n > 0 ? medida : null }),
      "Producto guardado: se recalcularon sus precios",
    );
    if (ok) onListo();
  };
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-[#faf5ee]">
      <header className="flex items-center gap-2 bg-cafe px-2 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))] text-beige">
        <button aria-label="Cerrar" onClick={onCerrar} className="rounded-lg p-1.5">
          <X className="size-6" />
        </button>
        <span className="flex-1 font-semibold">Editar producto</span>
      </header>
      <div className="mx-auto w-full max-w-xl flex-1 space-y-3 overflow-y-auto px-4 py-4">
        <label className="block">
          <span className="etiqueta">Nombre</span>
          <input className="campo" value={nombre} onChange={(e) => setNombre(e.target.value)} />
        </label>
        <label className="block">
          <span className="etiqueta">Categoría</span>
          <input className="campo" list="categorias" value={categoria} onChange={(e) => setCategoria(e.target.value)} />
          <datalist id="categorias">
            {categorias.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </label>
        <label className="block">
          <span className="etiqueta">Clase</span>
          <select className="campo" value={clase} onChange={(e) => setClase(e.target.value as typeof clase)}>
            <option value="mercaderia">Mercadería</option>
            <option value="gasto">Gasto</option>
          </select>
        </label>
        <div>
          <span className="etiqueta">Contenido de cada unidad</span>
          <div className="flex gap-2">
            <input className="campo" inputMode="decimal" placeholder="Ej. 0,5" value={contenido} onChange={(e) => setContenido(e.target.value)} />
            <select className="campo w-32" value={medida} onChange={(e) => setMedida(e.target.value as "kg" | "l")}>
              <option value="kg">kg</option>
              <option value="l">litros</option>
            </select>
          </div>
          <p className="mt-1 text-xs text-stone-500">Para el precio por kg o litro. 500 ml = 0,5 litros; 250 g = 0,25 kg. Vacío si no aplica.</p>
        </div>
      </div>
      <div className="border-t border-stone-200 bg-white px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3">
        <button onClick={() => void guardar()} disabled={nombre.trim().length < 2} className="mx-auto flex w-full max-w-xl items-center justify-center gap-2 rounded-2xl bg-cafe py-4 font-semibold text-beige disabled:opacity-50">
          <Package className="size-5 text-naranja" /> Guardar
        </button>
      </div>
    </div>
  );
}
