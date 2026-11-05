import { useMemo, useState } from "react";
import { Plus, Search, X } from "lucide-react";
import { useAccion } from "../componentes/ui";
import { post } from "../lib/api";
import { clave, useVivo } from "./comun";

type Opcion = { id: number; nombre: string; oculto: boolean; formaPagoId: number | null };
/** Elegir un proveedor con buscador; si no está, se crea ahí mismo y queda guardado. Avisa también su forma de pago habitual. */
export function SelectorProveedor({ valor, onChange }: { valor: number | null; onChange: (id: number | null, formaPagoHabitual: number | null) => void }) {
  // Con los ocultos, para mostrar el elegido aunque esté oculto; para elegir se ofrecen solo los visibles.
  const { datos, recargar } = useVivo<Opcion[]>("/api/c/proveedores?ocultos=1");
  const [texto, setTexto] = useState("");
  const [abierto, setAbierto] = useState(false);
  const [creando, setCreando] = useState(false);
  const accion = useAccion();
  const elegido = datos?.find((p) => p.id === valor);

  const coincidencias = useMemo(() => {
    const buscado = clave(texto);
    return (datos ?? []).filter((p) => !p.oculto && clave(p.nombre).includes(buscado)).slice(0, 8);
  }, [datos, texto]);
  const exacto = coincidencias.some((p) => clave(p.nombre) === clave(texto));

  const elegir = (p: Opcion) => {
    onChange(p.id, p.formaPagoId);
    setTexto("");
    setAbierto(false);
  };
  const crear = async () => {
    setCreando(true);
    const nuevo = await accion(() => post<Opcion>("/api/c/proveedores", { nombre: texto.trim() }), `Proveedor “${texto.trim()}” creado`);
    setCreando(false);
    if (!nuevo) return;
    await recargar();
    elegir(nuevo);
  };

  if (valor && !datos) return <div className="campo text-stone-400">Cargando…</div>;
  if (valor && elegido)
    return (
      <div className="flex items-center justify-between gap-2 rounded-xl border border-stone-300 bg-white px-3 py-2.5">
        <span className="truncate font-medium text-stone-800">{elegido.nombre}</span>
        <button aria-label="Cambiar proveedor" title="Cambiar proveedor" onClick={() => onChange(null, null)} className="rounded-lg p-1 text-stone-400 hover:bg-stone-100 hover:text-stone-700">
          <X className="size-4" />
        </button>
      </div>
    );

  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-stone-400" />
      <input
        className="campo pl-9"
        placeholder="Buscá o creá un proveedor…"
        value={texto}
        onChange={(e) => (setTexto(e.target.value), setAbierto(true))}
        onFocus={() => setAbierto(true)}
        // Se cierra al salir, después de que el clic en una opción llegue.
        onBlur={() => setTimeout(() => setAbierto(false), 150)}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          if (coincidencias[0] && (exacto || !texto.trim())) elegir(coincidencias[0]);
          else if (texto.trim().length >= 2) void crear();
        }}
      />
      {abierto && (coincidencias.length > 0 || texto.trim().length >= 2) && (
        <ul className="absolute inset-x-0 top-full z-10 mt-1 max-h-64 overflow-y-auto rounded-xl border border-stone-200 bg-white py-1 shadow-lg">
          {coincidencias.map((p) => (
            <li key={p.id}>
              <button onMouseDown={(e) => e.preventDefault()} onClick={() => elegir(p)} className="w-full px-3 py-2 text-left text-sm text-stone-800 hover:bg-orange-50">
                {p.nombre}
              </button>
            </li>
          ))}
          {!exacto && texto.trim().length >= 2 && (
            <li className={coincidencias.length ? "border-t border-stone-100" : ""}>
              <button
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => void crear()}
                disabled={creando}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium text-naranja hover:bg-orange-50"
              >
                <Plus className="size-4" /> Crear proveedor “{texto.trim()}”
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
