import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowDown, ArrowUp, Download, Loader2, Package, Pencil, Search, TrendingDown, TrendingUp, X } from "lucide-react";
import { Boton, useAccion } from "../componentes/ui";
import { post, put } from "../lib/api";
import { atajosBloqueados, fechaCorta, Hoja, plata, useVivo, Ventana, type Ancho } from "./comun";

export type Precios = { bulto: number | null; unidad: number | null; porMedida: { valor: number; medida: "kg" | "l" } | null };
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
const UNIDADES: Record<UnidadCompra, string> = { bulto: "Bulto o caja", unidad: "Unidad", kg: "Kilo", litro: "Litro" };

/** El precio con el que se comparan las compras: por kg o litro, si no por unidad, si no por bulto (igual que el servidor). */
const referencia = (p: Precios | undefined) => p?.porMedida?.valor ?? p?.unidad ?? p?.bulto ?? null;

// ───────────── Orden ─────────────

type Campo = "nombre" | "proveedor" | "fecha" | "bulto" | "unidad" | "medida" | "precio" | "suba";
type Orden = { campo: Campo; asc: boolean };
const sinDato = (n: number | null | undefined) => n ?? -Infinity;
const COMPARAR: Record<Campo, (a: Producto, b: Producto) => number> = {
  nombre: (a, b) => a.nombre.localeCompare(b.nombre),
  proveedor: (a, b) => (a.ultima?.proveedor ?? "").localeCompare(b.ultima?.proveedor ?? ""),
  fecha: (a, b) => (a.ultima?.fecha ?? "").localeCompare(b.ultima?.fecha ?? ""),
  bulto: (a, b) => sinDato(a.ultima?.precios.bulto) - sinDato(b.ultima?.precios.bulto),
  unidad: (a, b) => sinDato(a.ultima?.precios.unidad) - sinDato(b.ultima?.precios.unidad),
  medida: (a, b) => sinDato(a.ultima?.precios.porMedida?.valor) - sinDato(b.ultima?.precios.porMedida?.valor),
  precio: (a, b) => sinDato(referencia(a.ultima?.precios)) - sinDato(referencia(b.ultima?.precios)),
  suba: (a, b) => sinDato(a.variacion) - sinDato(b.variacion),
};
/** Para el celular, los órdenes más usados. */
const ORDENES_MOVIL: [string, Orden][] = [
  ["Nombre", { campo: "nombre", asc: true }],
  ["Más subieron", { campo: "suba", asc: false }],
  ["Precio", { campo: "precio", asc: false }],
  ["Última compra", { campo: "fecha", asc: false }],
];

/** "Caja x 15 $ 12.499,93 · Unidad $ 833,33 · Litro $ 1.666,66" */
export function lineasDePrecio(c: Pick<CompraProducto, "precios" | "unidadesPorBulto">): [string, number][] {
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
    <span className={`inline-flex items-center gap-0.5 whitespace-nowrap rounded-full px-1.5 py-0.5 text-[11px] font-semibold ${sube ? "bg-red-50 text-red-700" : "bg-emerald-50 text-emerald-700"}`}>
      {sube ? <TrendingUp className="size-3" /> : <TrendingDown className="size-3" />}
      {sube ? "+" : ""}
      {v.toFixed(1).replace(".", ",")} %
    </span>
  );
}

const precio = (n: number | null | undefined) => (n === null || n === undefined ? <span className="text-stone-300">—</span> : plata(n));

export function Productos({ ancho }: { ancho: Ancho }) {
  const { datos } = useVivo<{ productos: Producto[]; alertaPct: number }>("/api/c/productos");
  const [q, setQ] = useState("");
  const [categoria, setCategoria] = useState("");
  const [clase, setClase] = useState("");
  const [proveedor, setProveedor] = useState("");
  const [orden, setOrden] = useState<Orden>({ campo: "nombre", asc: true });
  const [soloSubas, setSoloSubas] = useState(false);
  const [abierto, setAbierto] = useState<number | null>(null);

  const productos = useMemo(() => datos?.productos ?? [], [datos]);
  const categorias = useMemo(() => [...new Set(productos.map((p) => p.categoria))].sort(), [productos]);
  const proveedores = useMemo(() => [...new Set(productos.flatMap((p) => p.proveedores.map((x) => x.proveedor)))].sort(), [productos]);
  const alertas = productos.filter((p) => p.alerta).length;

  const lista = useMemo(() => {
    const buscado = q.trim().toLowerCase();
    const comparar = COMPARAR[orden.campo];
    return productos
      .filter(
        (p) =>
          (!buscado || p.nombre.toLowerCase().includes(buscado)) &&
          (!categoria || p.categoria === categoria) &&
          (!clase || p.clase === clase) &&
          (!proveedor || p.proveedores.some((x) => x.proveedor === proveedor)) &&
          (!soloSubas || p.alerta),
      )
      .sort((a, b) => (orden.asc ? comparar(a, b) : comparar(b, a)));
  }, [productos, q, categoria, clase, proveedor, soloSubas, orden]);

  // ↑ ↓ para pasar de producto en la compu y la tablet.
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
    if (abierto) document.querySelector(`[data-producto="${abierto}"]`)?.scrollIntoView({ block: "nearest" });
  }, [abierto]);

  const filtros = (
    <>
      <div className="relative min-w-48 flex-1">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-stone-400" />
        <input className="campo py-2 pl-9 text-sm" placeholder="Buscar producto…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <select className="campo w-auto py-2 text-sm" value={categoria} onChange={(e) => setCategoria(e.target.value)}>
        <option value="">Todas las categorías</option>
        {categorias.map((c) => (
          <option key={c}>{c}</option>
        ))}
      </select>
      <select className="campo w-auto py-2 text-sm" value={proveedor} onChange={(e) => setProveedor(e.target.value)}>
        <option value="">Todos los proveedores</option>
        {proveedores.map((p) => (
          <option key={p}>{p}</option>
        ))}
      </select>
      <select className="campo w-auto py-2 text-sm" value={clase} onChange={(e) => setClase(e.target.value)}>
        <option value="">Mercadería y gastos</option>
        <option value="mercaderia">Solo mercadería</option>
        <option value="gasto">Solo gastos</option>
      </select>
    </>
  );
  const extras = (
    <>
      {alertas > 0 && (
        <button
          onClick={() => setSoloSubas(!soloSubas)}
          className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium ${soloSubas ? "bg-red-600 text-white" : "border border-red-200 bg-red-50 text-red-700 hover:bg-red-100"}`}
        >
          <AlertTriangle className="size-4" /> {alertas} {alertas === 1 ? "subió" : "subieron"} más de {datos?.alertaPct} %
        </button>
      )}
      <a href="/api/c/productos.csv" className="ml-auto flex items-center gap-1.5 rounded-full border border-stone-300 bg-white px-3 py-1.5 text-sm font-medium text-stone-700 hover:bg-stone-50">
        <Download className="size-4" /> Excel
      </a>
    </>
  );
  const vacio = (
    <p className="px-4 py-10 text-center text-sm text-stone-500">
      {productos.length ? "No hay productos con esos filtros." : "Todavía no hay productos: aparecen cuando se confirma una factura."}
    </p>
  );
  const ficha = abierto && <FichaProducto key={abierto} id={abierto} ancho={ancho} productos={productos} categorias={categorias} onCerrar={() => setAbierto(null)} />;

  // ───── Celular: tarjetas ─────
  if (ancho === "movil")
    return (
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2 [&>*]:w-full [&>div]:col-span-2">{filtros}</div>
        <select
          className="campo py-2 text-sm"
          value={ORDENES_MOVIL.findIndex(([, o]) => o.campo === orden.campo && o.asc === orden.asc)}
          onChange={(e) => setOrden(ORDENES_MOVIL[Number(e.target.value)][1])}
        >
          {ORDENES_MOVIL.map(([t], i) => (
            <option key={t} value={i}>
              Ordenar: {t}
            </option>
          ))}
        </select>
        <div className="flex flex-wrap items-center gap-2">{extras}</div>
        {!datos ? null : !lista.length ? (
          <div className="tarjeta">{vacio}</div>
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
        {ficha}
      </div>
    );

  // ───── Compu y tablet: tabla con columnas que se ordenan ─────
  const titulo = (campo: Campo, texto: string, derecha = false) => (
    <button
      onClick={() => setOrden((o) => ({ campo, asc: o.campo === campo ? !o.asc : campo === "nombre" || campo === "proveedor" }))}
      className={`inline-flex items-center gap-1 uppercase hover:text-stone-800 ${derecha ? "flex-row-reverse" : ""} ${orden.campo === campo ? "text-stone-800" : ""}`}
    >
      {texto}
      {orden.campo === campo && (orden.asc ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}
    </button>
  );
  const tabla = (
    <section className="tarjeta flex min-h-0 flex-col overflow-hidden">
      <div className="space-y-2 border-b border-stone-100 px-4 py-3">
        <div className="flex flex-wrap gap-2">{filtros}</div>
        <div className="flex flex-wrap items-center gap-2">{extras}</div>
      </div>
      <div className="@container min-h-0 flex-1 overflow-y-auto">
        {!datos ? (
          <div className="flex justify-center py-10">
            <Loader2 className="size-6 animate-spin text-naranja" />
          </div>
        ) : !lista.length ? (
          vacio
        ) : (
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10 bg-stone-50 text-left text-xs font-semibold tracking-wide text-stone-500 shadow-[0_1px_0_#e7e5e4]">
              <tr>
                <th className="py-2.5 pl-4 pr-3">
                  {titulo("nombre", "Producto")}
                </th>
                <th className="hidden px-3 py-2.5 @4xl:table-cell">
                  {titulo("proveedor", "Último proveedor")}
                </th>
                <th className="hidden px-3 py-2.5 @3xl:table-cell">
                  {titulo("fecha", "Fecha")}
                </th>
                <th className="hidden px-3 py-2.5 text-right @2xl:table-cell">
                  {titulo("bulto", "Caja", true)}
                </th>
                <th className="px-3 py-2.5 text-right">
                  {titulo("unidad", "Unidad", true)}
                </th>
                <th className="hidden px-3 py-2.5 text-right @lg:table-cell">
                  {titulo("medida", "Kg / litro", true)}
                </th>
                <th className="py-2.5 pl-3 pr-4 text-right">
                  {titulo("suba", "Variación", true)}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {lista.map((p) => {
                const u = p.ultima;
                return (
                  <tr
                    key={p.id}
                    data-producto={p.id}
                    onClick={() => setAbierto(p.id)}
                    className={`cursor-pointer ${abierto === p.id ? "bg-orange-50 shadow-[inset_3px_0_0_var(--color-naranja)]" : "hover:bg-stone-50"}`}
                  >
                    <td className="max-w-0 py-2.5 pl-4 pr-3">
                      <div className="flex items-center gap-1.5 font-medium text-stone-800">
                        {p.alerta && <AlertTriangle className="size-3.5 shrink-0 text-red-600" />}
                        <span className="truncate">{p.nombre}</span>
                      </div>
                      <div className="truncate text-xs text-stone-500">
                        {p.categoria}
                        {p.proveedores.length > 1 && ` · ${p.proveedores.length} proveedores`}
                      </div>
                    </td>
                    <td className="hidden max-w-48 truncate px-3 py-2.5 text-stone-600 @4xl:table-cell">{u?.proveedor ?? "—"}</td>
                    <td className="hidden whitespace-nowrap px-3 py-2.5 text-stone-600 @3xl:table-cell">{fechaCorta(u?.fecha)}</td>
                    <td className="hidden whitespace-nowrap px-3 py-2.5 text-right tabular-nums @2xl:table-cell">{precio(u?.precios.bulto)}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-right font-medium tabular-nums">{precio(u?.precios.unidad)}</td>
                    <td className="hidden whitespace-nowrap px-3 py-2.5 text-right tabular-nums @lg:table-cell">
                      {u?.precios.porMedida ? (
                        <>
                          {plata(u.precios.porMedida.valor)} <span className="text-xs text-stone-400">/{u.precios.porMedida.medida}</span>
                        </>
                      ) : (
                        precio(null)
                      )}
                    </td>
                    <td className="py-2.5 pl-3 pr-4 text-right">
                      <Variacion v={p.variacion} />
                    </td>
                  </tr>
                );
              })}
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
        {ficha}
      </>
    );
  return <div className={`grid h-full min-h-0 gap-4 ${abierto ? "grid-cols-[minmax(0,6fr)_minmax(0,5fr)]" : "grid-cols-1"}`}>{tabla}{ficha}</div>;
}

/** Gráfico con el precio de referencia de cada compra. */
function Grafico({ valores }: { valores: number[] }) {
  if (valores.length < 2) return null;
  const min = Math.min(...valores);
  const max = Math.max(...valores);
  const puntos = valores.map((v, i) => `${(i / (valores.length - 1)) * 300},${max === min ? 30 : 56 - ((v - min) / (max - min)) * 52}`).join(" ");
  return (
    <svg viewBox="0 0 300 60" className="h-16 w-full @2xl:h-24" preserveAspectRatio="none" aria-label="Evolución del precio">
      <polyline points={puntos} fill="none" stroke="var(--color-naranja)" strokeWidth="2.5" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function FichaProducto({ id, ancho, productos, categorias, onCerrar }: { id: number; ancho: Ancho; productos: Producto[]; categorias: string[]; onCerrar: () => void }) {
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
  const masBarato =
    p && p.proveedores.length > 1 ? [...p.proveedores].sort((a, b) => (referencia(a.ultima.precios) ?? Infinity) - (referencia(b.ultima.precios) ?? Infinity))[0].proveedor : null;

  return (
    <Hoja
      ancho={ancho}
      onCerrar={onCerrar}
      titulo={p?.nombre ?? "Producto"}
      subtitulo={p && `${p.categoria} · ${p.clase === "gasto" ? "Gasto" : "Mercadería"}${p.contenido && p.medida ? ` · ${String(p.contenido).replace(".", ",")} ${MEDIDAS[p.medida]} por unidad` : ""}`}
      acciones={
        p && (
          <button aria-label="Editar producto" title="Editar producto" onClick={() => setEditando(true)} className={`rounded-lg p-1.5 ${ancho === "movil" ? "hover:bg-white/10" : "text-stone-500 hover:bg-stone-100"}`}>
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
          {ultima && (
            <section className="tarjeta p-4">
              <div className="mb-3 flex items-center justify-between gap-2 text-xs text-stone-500">
                <span>
                  Última compra: {ultima.proveedor} · {fechaCorta(ultima.fecha)} · {p.compras} {p.compras === 1 ? "compra" : "compras"}
                </span>
                <Variacion v={ultima.variacion} />
              </div>
              <div className="grid grid-cols-3 gap-2">
                {lineasDePrecio(ultima).map(([t, v]) => (
                  <div key={t} className="rounded-xl bg-marca-suave px-2 py-2.5 text-center">
                    <div className="text-[11px] font-medium uppercase tracking-wide text-stone-500">{t}</div>
                    <div className="whitespace-nowrap text-sm font-bold tabular-nums text-cafe @md:text-lg">{plata(v)}</div>
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

          <section className="tarjeta overflow-hidden">
            <h3 className="px-4 py-2.5 text-sm font-semibold text-stone-800">Historial de compras</h3>
            {/* Encabezado de la tabla: solo cuando hay lugar (en angosto cada compra es una tarjeta). */}
            <div className="hidden grid-cols-[5.5rem_minmax(0,1fr)_7rem_7rem_7rem_4.5rem_2rem] gap-3 border-y border-stone-100 bg-stone-50 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-stone-500 @2xl:grid">
              <span>Fecha</span>
              <span>Proveedor</span>
              <span className="text-right">Caja</span>
              <span className="text-right">Unidad</span>
              <span className="text-right">Kg / litro</span>
              <span className="text-right">Var.</span>
              <span />
            </div>
            <div className="divide-y divide-stone-100 border-t border-stone-100 @2xl:border-t-0">
              {[...p.historial].reverse().map((h) => (
                <CompraFila key={h.id} h={h} onCambio={recargar} />
              ))}
            </div>
          </section>

          <div className="grid gap-4 @2xl:grid-cols-2">
            {p.alias.length > 1 && (
              <section className="tarjeta space-y-2 p-4 text-sm">
                <h3 className="font-semibold text-stone-800">¿No es el mismo producto?</h3>
                <p className="text-xs text-stone-500">Separá lo que se compró a un proveedor en un producto aparte.</p>
                <div className="flex flex-wrap gap-2">
                  {p.alias.map((a) => (
                    <Boton key={a.clave} chico onClick={() => void accion(() => post(`/api/c/productos/${id}/separar`, { alias: a.clave }), `Separado: ${a.proveedor}`).then(recargar)}>
                      Separar {a.proveedor}
                    </Boton>
                  ))}
                </div>
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
        </div>
      )}
      {editando && p && <EditarProducto p={p} categorias={categorias} onCerrar={() => setEditando(false)} onListo={() => (setEditando(false), void recargar())} />}
    </Hoja>
  );
}

/** Una compra del historial: tarjeta en angosto, fila de tabla en ancho. Si la IA se equivocó en cómo vino (ej. la caja trae 12), se corrige acá. */
function CompraFila({ h, onCambio }: { h: CompraProducto; onCambio: () => Promise<void> }) {
  const [corrigiendo, setCorrigiendo] = useState(false);
  const [unidad, setUnidad] = useState(h.unidadCompra);
  const [porBulto, setPorBulto] = useState(String(h.unidadesPorBulto || ""));
  const accion = useAccion();
  const p = h.precios;
  const comoVino = `${h.cantidad} ${UNIDADES[h.unidadCompra].toLowerCase()}${h.unidadCompra === "bulto" && h.unidadesPorBulto ? ` x ${h.unidadesPorBulto}` : ""}`;
  // En ancho cada precio va en su columna; en angosto, uno al lado del otro con su nombre.
  const celdaPrecio = (etiqueta: string, valor: number | null, sufijo = "") => (
    <span className={`text-right tabular-nums ${valor === null ? "hidden @2xl:block" : ""}`}>
      <span className="text-stone-500 @2xl:hidden">{etiqueta} </span>
      {valor === null ? <span className="text-stone-300">—</span> : <b className="@2xl:font-normal">{plata(valor)}</b>}
      {valor !== null && sufijo && <span className="text-xs text-stone-400">{sufijo}</span>}
    </span>
  );
  return (
    <div className="px-4 py-2.5 text-sm">
      <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-start gap-x-3 gap-y-1 @2xl:grid-cols-[5.5rem_minmax(0,1fr)_7rem_7rem_7rem_4.5rem_2rem] @2xl:items-center">
        <span className="hidden text-stone-700 @2xl:block">{fechaCorta(h.fecha)}</span>
        <span className="min-w-0">
          <span className="block truncate text-stone-800">
            <span className="@2xl:hidden">{fechaCorta(h.fecha)} · </span>
            {h.proveedor}
          </span>
          <span className="block truncate text-xs text-stone-500" title={h.descripcion}>
            {h.descripcion} · {comoVino}
          </span>
        </span>
        <span className="col-span-3 row-start-2 flex flex-wrap gap-x-3 text-xs text-stone-600 @2xl:contents @2xl:text-sm">
          {celdaPrecio(h.unidadesPorBulto ? `Caja x ${h.unidadesPorBulto}` : "Bulto", p.bulto)}
          {celdaPrecio("Unidad", p.unidad)}
          {celdaPrecio(p.porMedida ? MEDIDAS[p.porMedida.medida].replace(/^./, (l) => l.toUpperCase()) : "Kg/l", p.porMedida?.valor ?? null, p.porMedida ? ` /${p.porMedida.medida}` : "")}
        </span>
        <span className="text-right">
          <Variacion v={h.variacion} />
        </span>
        <button aria-label="Corregir cómo vino" title="Corregir cómo vino" onClick={() => setCorrigiendo(!corrigiendo)} className="justify-self-end rounded p-1 text-stone-400 hover:bg-stone-100 hover:text-stone-700">
          {corrigiendo ? <X className="size-4" /> : <Pencil className="size-4" />}
        </button>
      </div>
      {corrigiendo && (
        <div className="mt-2 flex flex-wrap items-end gap-2 rounded-xl bg-stone-50 p-3">
          <label className="min-w-40 flex-1">
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
    <Ventana
      titulo="Editar producto"
      ancho="max-w-lg"
      onCerrar={onCerrar}
      pie={
        <button onClick={() => void guardar()} disabled={nombre.trim().length < 2} className="flex w-full items-center justify-center gap-2 rounded-2xl bg-cafe py-4 font-semibold text-beige hover:bg-marca-profundo disabled:opacity-50 md:rounded-xl md:py-3">
          <Package className="size-5 text-naranja" /> Guardar
        </button>
      }
    >
      <div className="space-y-3 px-4 py-4 md:px-6">
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
    </Ventana>
  );
}
