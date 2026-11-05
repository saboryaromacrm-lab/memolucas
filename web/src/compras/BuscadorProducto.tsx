import { useMemo, useState, type MouseEvent } from "react";
import { Search } from "lucide-react";
import { clave, plata } from "./comun";
import { lineasDePrecio, type CompraProducto, type Producto } from "./Productos";

/** La última compra del producto a ese proveedor; si nunca se le compró (o no hay proveedor), la última de todas. */
export function ultimaPara(p: Producto, proveedorId: number | null): CompraProducto | null {
  return (proveedorId && p.proveedores.find((x) => x.proveedorId === proveedorId)?.ultima) || p.ultima;
}

/** "Última vez: Caja x 15 $ 12.499,93 · Unidad $ 833,33" (con el proveedor si fue otro). */
export function textoUltimaVez(u: CompraProducto, proveedorId: number | null) {
  const precios = lineasDePrecio(u)
    .map(([t, v]) => `${t} ${plata(v)}`)
    .join(" · ");
  return `Última vez: ${precios}${u.proveedorId !== proveedorId ? ` (${u.proveedor})` : ""}`;
}

/**
 * Con proveedor, los productos que vende (los más comprados primero).
 * Sin proveedor, todos, menos los que solo venden proveedores ocultos.
 */
function sugerencias(productos: Producto[], proveedorId: number | null, texto: string): Producto[] {
  const buscado = clave(texto);
  const coincide = (p: Producto) => clave(p.nombre).includes(buscado);
  if (!proveedorId) return productos.filter((p) => coincide(p) && (!p.proveedores.length || p.proveedores.some((x) => !x.oculto)));
  return productos
    .flatMap((p) => {
      const suyo = p.proveedores.find((x) => x.proveedorId === proveedorId);
      return suyo && coincide(p) ? [{ p, compras: suyo.compras }] : [];
    })
    .sort((a, b) => b.compras - a.compras || a.p.nombre.localeCompare(b.p.nombre))
    .map((x) => x.p);
}

/**
 * Buscar un producto mientras se escribe. Con proveedor, primero solo los suyos (con la opción de ver los de otros).
 * El texto es libre: si no se elige ninguno, queda lo escrito (para un producto nuevo).
 */
export function BuscadorProducto({
  productos,
  proveedorId,
  texto,
  onTexto,
  onElegir,
  excluir,
  placeholder = "Buscá un producto…",
  autoFocus,
}: {
  productos: Producto[];
  proveedorId: number | null;
  texto: string;
  onTexto: (texto: string) => void;
  onElegir: (p: Producto) => void;
  excluir?: Set<number>;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const [abierto, setAbierto] = useState(false);
  const [deOtros, setDeOtros] = useState(false);
  const soloSuyos = proveedorId !== null && !deOtros;
  const lista = useMemo(
    () =>
      sugerencias(productos, soloSuyos ? proveedorId : null, texto)
        .filter((p) => !excluir?.has(p.id))
        .slice(0, 30),
    [productos, soloSuyos, proveedorId, texto, excluir],
  );
  const elegir = (p: Producto) => {
    onElegir(p);
    setAbierto(false);
    setDeOtros(false);
  };
  // Para que el clic en una opción llegue antes de que se cierre la lista.
  const sinPerderFoco = (e: MouseEvent) => e.preventDefault();

  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-stone-400" />
      <input
        className="campo pl-9"
        placeholder={placeholder}
        autoFocus={autoFocus}
        value={texto}
        onChange={(e) => (onTexto(e.target.value), setAbierto(true))}
        onFocus={() => setAbierto(true)}
        onBlur={() => setTimeout(() => setAbierto(false), 150)}
      />
      {abierto && (lista.length > 0 || proveedorId !== null) && (
        <ul className="absolute inset-x-0 top-full z-20 mt-1 max-h-72 overflow-y-auto rounded-xl border border-stone-200 bg-white py-1 shadow-lg">
          {soloSuyos && <li className="px-3 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-stone-400">De este proveedor</li>}
          {lista.map((p) => {
            const u = ultimaPara(p, proveedorId);
            return (
              <li key={p.id}>
                <button onMouseDown={sinPerderFoco} onClick={() => elegir(p)} className="w-full px-3 py-2 text-left hover:bg-orange-50">
                  <span className="block text-sm text-stone-800">{p.nombre}</span>
                  {u && <span className="block truncate text-xs text-stone-500">{textoUltimaVez(u, proveedorId)}</span>}
                </button>
              </li>
            );
          })}
          {!lista.length && <li className="px-3 py-2 text-sm text-stone-500">{texto.trim() ? "Ninguno con ese nombre." : "Todavía no tiene productos."}</li>}
          {proveedorId !== null && (
            <li className="border-t border-stone-100">
              <button onMouseDown={sinPerderFoco} onClick={() => setDeOtros(!deOtros)} className="w-full px-3 py-2 text-left text-sm font-medium text-naranja hover:bg-orange-50">
                {deOtros ? "Ver solo los de este proveedor" : "Ver productos de otros proveedores"}
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
