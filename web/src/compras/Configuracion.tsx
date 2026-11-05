import { useEffect } from "react";
import { CreditCard, Store } from "lucide-react";
import { useRecordado, type Ancho } from "./comun";
import { FormasPago } from "./FormasPago";
import { Proveedores } from "./Proveedores";

const SECCIONES = [
  ["proveedores", "Proveedores", Store],
  ["formas-pago", "Formas de pago", CreditCard],
] as const;

/** Lo que se carga una vez y se usa en cada compra: proveedores y formas de pago. */
/** proveedorId: abre Proveedores con la ficha de ese proveedor (desde Métricas). */
export function Configuracion({ ancho, proveedorId }: { ancho: Ancho; proveedorId?: number }) {
  const [seccion, elegir] = useRecordado("compras-configuracion", SECCIONES.map(([v]) => v));
  useEffect(() => {
    if (proveedorId) elegir("proveedores");
  }, [proveedorId, elegir]);
  const pc = ancho === "pc";
  return (
    <div className={pc ? "flex h-full min-h-0 flex-col gap-4" : "space-y-4"}>
      <nav className="flex gap-1.5">
        {SECCIONES.map(([v, t, Icono]) => (
          <button
            key={v}
            onClick={() => elegir(v)}
            className={`flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm font-medium transition ${seccion === v ? "bg-cafe text-beige" : "border border-stone-300 bg-white text-stone-600 hover:border-stone-400"}`}
          >
            <Icono className="size-4" /> {t}
          </button>
        ))}
      </nav>
      <div className={pc ? "min-h-0 flex-1" : ""}>{seccion === "proveedores" ? <Proveedores ancho={ancho} abrir={proveedorId} /> : <FormasPago />}</div>
    </div>
  );
}
