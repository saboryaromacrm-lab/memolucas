import { useEffect, useMemo, useRef, useState } from "react";
import { Camera, Loader2, Plus, Trash2, X } from "lucide-react";
import { useAccion } from "../componentes/ui";
import { api, del, get } from "../lib/api";
import { ahora } from "../lib/fechas";
import { aNumero, plata, Ventana } from "./comun";
import { comprimir } from "./imagen";
import { SelectorProveedor } from "./SelectorProveedor";

type UnidadCompra = "bulto" | "unidad" | "kg" | "litro";
type Clase = "mercaderia" | "gasto";
/** Como lo devuelve el servidor (y como se manda al guardar). */
type CompraManual = {
  proveedorId: number | null;
  fecha: string;
  fotoId?: number | null;
  renglones: {
    nombre: string;
    categoria: string;
    clase: Clase;
    cantidad: number;
    unidadCompra: UnidadCompra;
    unidadesPorBulto: number;
    contenido: number | null;
    medida: "kg" | "l" | null;
    total: number;
  }[];
};
/** Un renglón mientras se escribe: los números como texto, para poder tipear "14.000,50". */
type Fila = {
  nombre: string;
  categoria: string;
  clase: Clase;
  cantidad: string;
  unidadCompra: UnidadCompra;
  unidadesPorBulto: string;
  contenido: string;
  medida: "kg" | "l";
  /** El precio se puede poner como total del producto o por cada unidad comprada. */
  modo: "total" | "unidad";
  precio: string;
};
type ProductoConocido = { nombre: string; categoria: string; clase: Clase; contenido: number | null; medida: "kg" | "l" | null };

const FILA_NUEVA: Fila = { nombre: "", categoria: "", clase: "mercaderia", cantidad: "1", unidadCompra: "unidad", unidadesPorBulto: "", contenido: "", medida: "l", modo: "total", precio: "" };
const COMO_VINO: Record<UnidadCompra, [string, string]> = { unidad: ["Unidades", "unidad"], bulto: ["Cajas o packs", "caja"], kg: ["Kilos", "kg"], litro: ["Litros", "litro"] };
const texto = (n: number | null) => (n ? String(n).replace(".", ",") : "");
const clave = (s: string) => s.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

/** Total del renglón según cómo se escribió el precio. */
const totalDe = (f: Fila) => (f.modo === "total" ? aNumero(f.precio) : aNumero(f.precio) * aNumero(f.cantidad));

/** Vista previa: "Unidad $ 7.000 · Litro $ 350" (la cuenta definitiva la hace el servidor). */
function preciosDe(f: Fila): [string, number][] {
  const total = totalDe(f);
  const cantidad = aNumero(f.cantidad);
  if (!total || !cantidad) return [];
  const porCompra = total / cantidad;
  const porBulto = aNumero(f.unidadesPorBulto);
  const unidad = f.unidadCompra === "unidad" ? porCompra : f.unidadCompra === "bulto" && porBulto ? porCompra / porBulto : null;
  const contenido = aNumero(f.contenido);
  const porMedida = f.unidadCompra === "kg" || f.unidadCompra === "litro" ? porCompra : unidad !== null && contenido ? unidad / contenido : null;
  const medida = f.unidadCompra === "kg" ? "Kg" : f.unidadCompra === "litro" ? "Litro" : f.medida === "kg" ? "Kg" : "Litro";
  return [
    ...(f.unidadCompra === "bulto" ? [[porBulto ? `Caja x ${porBulto}` : "Caja", porCompra] as [string, number]] : []),
    ...(unidad !== null ? [["Unidad", unidad] as [string, number]] : []),
    ...(porMedida !== null ? [[medida, porMedida] as [string, number]] : []),
  ];
}

/** Cargar (o editar) una compra sin factura: ej. 2 bidones de agua de 20 l por $ 14.000. */
export function CompraManualForm({ id, onCerrar, onGuardada }: { id: number | null; onCerrar: () => void; onGuardada: (id: number | null) => void }) {
  const [proveedorId, setProveedorId] = useState<number | null>(null);
  const [fecha, setFecha] = useState(() => ahora().toISODate()!);
  const [filas, setFilas] = useState<Fila[]>([{ ...FILA_NUEVA }]);
  const [foto, setFoto] = useState<{ archivo: File; url: string } | null>(null);
  const [fotoActual, setFotoActual] = useState<number | null>(null);
  const [conocidos, setConocidos] = useState<ProductoConocido[]>([]);
  const [cargando, setCargando] = useState(!!id);
  const [guardando, setGuardando] = useState(false);
  const elegirFoto = useRef<HTMLInputElement>(null);
  const accion = useAccion();

  useEffect(() => {
    void get<{ productos: ProductoConocido[] }>("/api/c/productos").then((r) => setConocidos(r.productos)).catch(() => {});
    if (!id) return;
    void get<CompraManual>(`/api/c/manuales/${id}`)
      .then((c) => {
        setProveedorId(c.proveedorId);
        setFecha(c.fecha);
        setFotoActual(c.fotoId ?? null);
        setFilas(
          c.renglones.map((r) => ({
            nombre: r.nombre,
            categoria: r.categoria,
            clase: r.clase,
            cantidad: texto(r.cantidad),
            unidadCompra: r.unidadCompra,
            unidadesPorBulto: texto(r.unidadesPorBulto),
            contenido: texto(r.contenido),
            medida: r.medida ?? "l",
            modo: "total",
            precio: texto(r.total),
          })),
        );
      })
      .finally(() => setCargando(false));
  }, [id]);
  useEffect(
    () => () => {
      if (foto) URL.revokeObjectURL(foto.url);
    },
    [foto],
  );

  const porNombre = useMemo(() => new Map(conocidos.map((p) => [clave(p.nombre), p])), [conocidos]);
  const categorias = useMemo(() => [...new Set(conocidos.map((p) => p.categoria))].sort(), [conocidos]);

  const cambiar = (i: number, cambios: Partial<Fila>) => setFilas((fs) => fs.map((f, j) => (j === i ? { ...f, ...cambios } : f)));
  /** Al elegir un producto que ya existe, se completan su categoría, clase y contenido. */
  const elegirNombre = (i: number, nombre: string) => {
    const p = porNombre.get(clave(nombre));
    cambiar(i, p ? { nombre, categoria: p.categoria, clase: p.clase, ...(p.contenido && p.medida ? { contenido: texto(p.contenido), medida: p.medida } : {}) } : { nombre });
  };

  const total = filas.reduce((t, f) => t + totalDe(f), 0);
  const completa = filas.every((f) => f.nombre.trim().length >= 2 && aNumero(f.cantidad) > 0 && totalDe(f) > 0);

  const guardar = async () => {
    const datos: CompraManual = {
      proveedorId,
      fecha,
      renglones: filas.map((f) => {
        const contenido = f.unidadCompra === "unidad" || f.unidadCompra === "bulto" ? aNumero(f.contenido) : 0;
        return {
          nombre: f.nombre.trim(),
          categoria: f.categoria.trim(),
          clase: f.clase,
          cantidad: aNumero(f.cantidad),
          unidadCompra: f.unidadCompra,
          unidadesPorBulto: f.unidadCompra === "bulto" ? aNumero(f.unidadesPorBulto) : 0,
          contenido: contenido || null,
          medida: contenido ? f.medida : null,
          total: totalDe(f),
        };
      }),
    };
    const formulario = new FormData();
    formulario.append("datos", JSON.stringify(datos));
    if (foto) formulario.append("foto", foto.archivo);
    else if (id && !fotoActual) formulario.append("quitarFoto", "1");
    setGuardando(true);
    const r = await accion(() => api<{ id: number }>(id ? `/api/c/manuales/${id}` : "/api/c/manuales", { metodo: id ? "PUT" : "POST", formulario }), id ? "Compra actualizada" : "Compra guardada: ya está en Productos");
    setGuardando(false);
    if (r) onGuardada(r.id);
  };

  return (
    <Ventana
      titulo={id ? "Editar compra sin factura" : "Compra sin factura"}
      ancho="max-w-3xl"
      onCerrar={onCerrar}
      pie={
        <div className="flex items-center gap-3">
          {id && (
            <button
              aria-label="Borrar compra"
              title="Borrar compra"
              onClick={async () => confirm("¿Borrar esta compra? También se saca de Productos.") && (await accion(() => del(`/api/c/manuales/${id}`), "Compra borrada")) && onGuardada(null)}
              className="rounded-xl border border-red-200 p-3 text-red-600 hover:bg-red-50"
            >
              <Trash2 className="size-5" />
            </button>
          )}
          <div className="mr-auto text-sm text-stone-500">
            Total <b className="block text-lg tabular-nums text-stone-900 md:inline md:text-base">{plata(total)}</b>
          </div>
          <button
            onClick={() => void guardar()}
            disabled={!completa || guardando || cargando}
            className="flex items-center gap-2 rounded-2xl bg-cafe px-6 py-3.5 font-semibold text-beige hover:bg-marca-profundo disabled:opacity-50 md:rounded-xl md:py-3"
          >
            {guardando && <Loader2 className="size-5 animate-spin" />} Guardar
          </button>
        </div>
      }
    >
      {cargando ? (
        <div className="flex justify-center py-16">
          <Loader2 className="size-6 animate-spin text-naranja" />
        </div>
      ) : (
        <div className="space-y-4 px-4 py-4 md:px-6">
          <section className="tarjeta grid gap-3 p-4 @lg:grid-cols-[minmax(0,1fr)_11rem]">
            <div className="min-w-0">
              <span className="etiqueta">Proveedor (opcional)</span>
              <SelectorProveedor valor={proveedorId} onChange={setProveedorId} />
            </div>
            <label className="block">
              <span className="etiqueta">Fecha</span>
              <input className="campo" type="date" value={fecha} max={ahora().toISODate()!} onChange={(e) => setFecha(e.target.value)} />
            </label>
            <div className="@lg:col-span-2">
              <span className="etiqueta">Foto del ticket o remito (opcional)</span>
              <input
                ref={elegirFoto}
                type="file"
                accept="image/*,application/pdf"
                className="hidden"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (!f) return;
                  const archivo = await comprimir(f);
                  setFoto({ archivo, url: URL.createObjectURL(archivo) });
                }}
              />
              {foto || fotoActual ? (
                <div className="flex items-center gap-3">
                  {foto?.archivo.type.startsWith("image/") ? (
                    <img src={foto.url} alt="Foto" className="h-16 w-12 rounded-lg border border-stone-200 object-cover" />
                  ) : fotoActual && !foto ? (
                    <img src={`/api/c/adjuntos/${fotoActual}`} alt="Foto" className="h-16 w-12 rounded-lg border border-stone-200 object-cover" />
                  ) : (
                    <span className="text-sm text-stone-600">{foto?.archivo.name}</span>
                  )}
                  <button onClick={() => elegirFoto.current?.click()} className="text-sm font-medium text-naranja">
                    Cambiar
                  </button>
                  <button onClick={() => (setFoto(null), setFotoActual(null))} className="flex items-center gap-1 text-sm text-stone-500 hover:text-red-600">
                    <X className="size-4" /> Quitar
                  </button>
                </div>
              ) : (
                <button onClick={() => elegirFoto.current?.click()} className="flex items-center gap-2 rounded-xl border border-dashed border-stone-300 px-3 py-2 text-sm text-stone-600 hover:border-naranja hover:text-naranja">
                  <Camera className="size-4" /> Agregar foto
                </button>
              )}
            </div>
          </section>

          {filas.map((f, i) => {
            const existente = porNombre.get(clave(f.nombre));
            const precios = preciosDe(f);
            const conContenido = f.unidadCompra === "unidad" || f.unidadCompra === "bulto";
            return (
              <section key={i} className="tarjeta space-y-3 p-4">
                <div className="flex items-start gap-2">
                  <label className="block min-w-0 flex-1">
                    <span className="etiqueta">Producto</span>
                    <input className="campo" list="productos-manual" placeholder="Ej. Bidón de agua 20 l" value={f.nombre} onChange={(e) => elegirNombre(i, e.target.value)} />
                    {f.nombre.trim().length >= 2 && (
                      <span className={`mt-1 block text-xs ${existente ? "text-emerald-700" : "text-stone-500"}`}>
                        {existente ? "Ya está en Productos: se suma a su historial." : "Producto nuevo."}
                      </span>
                    )}
                  </label>
                  {filas.length > 1 && (
                    <button aria-label="Quitar producto" title="Quitar producto" onClick={() => setFilas((fs) => fs.filter((_, j) => j !== i))} className="mt-6 rounded-lg p-2 text-stone-400 hover:bg-red-50 hover:text-red-600">
                      <Trash2 className="size-4" />
                    </button>
                  )}
                </div>

                {!existente && (
                  <div className="grid grid-cols-2 gap-3">
                    <label className="block min-w-0">
                      <span className="etiqueta">Categoría</span>
                      <input className="campo" list="categorias-manual" placeholder="Ej. Bebidas" value={f.categoria} onChange={(e) => cambiar(i, { categoria: e.target.value })} />
                    </label>
                    <label className="block">
                      <span className="etiqueta">Tipo</span>
                      <select className="campo" value={f.clase} onChange={(e) => cambiar(i, { clase: e.target.value as Clase })}>
                        <option value="mercaderia">Mercadería</option>
                        <option value="gasto">Gasto</option>
                      </select>
                    </label>
                  </div>
                )}

                <div className="grid grid-cols-2 gap-3 @lg:grid-cols-4">
                  <label className="block">
                    <span className="etiqueta">Cantidad</span>
                    <input className="campo tabular-nums" inputMode="decimal" value={f.cantidad} onChange={(e) => cambiar(i, { cantidad: e.target.value })} />
                  </label>
                  <label className="block">
                    <span className="etiqueta">En</span>
                    <select className="campo" value={f.unidadCompra} onChange={(e) => cambiar(i, { unidadCompra: e.target.value as UnidadCompra })}>
                      {Object.entries(COMO_VINO).map(([v, [t]]) => (
                        <option key={v} value={v}>
                          {t}
                        </option>
                      ))}
                    </select>
                  </label>
                  {f.unidadCompra === "bulto" && (
                    <label className="block">
                      <span className="etiqueta">Unidades por caja</span>
                      <input className="campo tabular-nums" inputMode="numeric" placeholder="Ej. 12" value={f.unidadesPorBulto} onChange={(e) => cambiar(i, { unidadesPorBulto: e.target.value })} />
                    </label>
                  )}
                  {conContenido && (
                    <div>
                      <span className="etiqueta">Cada unidad trae</span>
                      <div className="flex gap-1.5">
                        <input className="campo min-w-0 tabular-nums" inputMode="decimal" placeholder="Ej. 20" value={f.contenido} onChange={(e) => cambiar(i, { contenido: e.target.value })} />
                        <select className="campo w-20 shrink-0 px-2" value={f.medida} onChange={(e) => cambiar(i, { medida: e.target.value as "kg" | "l" })}>
                          <option value="l">l</option>
                          <option value="kg">kg</option>
                        </select>
                      </div>
                    </div>
                  )}
                </div>

                <div>
                  <div className="mb-1 flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-stone-500">
                    {(["total", "unidad"] as const).map((m) => (
                      <button key={m} onClick={() => cambiar(i, { modo: m })} className={`rounded-full px-2.5 py-1 ${f.modo === m ? "bg-cafe text-beige" : "bg-stone-100 hover:bg-stone-200"}`}>
                        {m === "total" ? "Precio total" : `Precio por ${COMO_VINO[f.unidadCompra][1]}`}
                      </button>
                    ))}
                  </div>
                  <input className="campo text-lg font-semibold tabular-nums" inputMode="decimal" placeholder="$ 0" value={f.precio} onChange={(e) => cambiar(i, { precio: e.target.value })} />
                </div>

                {precios.length > 0 && (
                  <div className="flex flex-wrap gap-2 rounded-xl bg-marca-suave px-3 py-2 text-sm">
                    {f.modo === "unidad" && <span className="text-stone-600">Total <b className="tabular-nums text-cafe">{plata(totalDe(f))}</b></span>}
                    {precios.map(([t, v]) => (
                      <span key={t} className="text-stone-600">
                        {t} <b className="tabular-nums text-cafe">{plata(v)}</b>
                      </span>
                    ))}
                  </div>
                )}
              </section>
            );
          })}
          <datalist id="productos-manual">
            {conocidos.map((p) => (
              <option key={p.nombre} value={p.nombre} />
            ))}
          </datalist>
          <datalist id="categorias-manual">
            {categorias.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
          <button
            onClick={() => setFilas((fs) => [...fs, { ...FILA_NUEVA }])}
            className="flex w-full items-center justify-center gap-1.5 rounded-xl border-2 border-dashed border-stone-300 py-3 text-sm font-medium text-stone-600 hover:border-naranja hover:text-naranja"
          >
            <Plus className="size-4" /> Agregar otro producto
          </button>
        </div>
      )}
    </Ventana>
  );
}
