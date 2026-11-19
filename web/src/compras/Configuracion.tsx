import { useEffect } from "react";
import { CreditCard, Download, Store } from "lucide-react";
import { useRecordado, type Ancho } from "./comun";
import { FormasPago } from "./FormasPago";
import { Proveedores } from "./Proveedores";

const SECCIONES = [
  ["proveedores", "Proveedores", Store],
  ["formas-pago", "Formas de pago", CreditCard],
  ["exportar", "Exportar", Download],
] as const;

/** Lo que se carga una vez y se usa en cada compra: proveedores y formas de pago. Exportar, solo con Métricas. */
/** proveedorId: abre Proveedores con la ficha de ese proveedor (desde Métricas). */
export function Configuracion({ ancho, proveedorId, metricas }: { ancho: Ancho; proveedorId?: number; metricas: boolean }) {
  const secciones = SECCIONES.filter(([v]) => v !== "exportar" || metricas);
  const [seccion, elegir] = useRecordado("compras-configuracion", secciones.map(([v]) => v));
  useEffect(() => {
    if (proveedorId) elegir("proveedores");
  }, [proveedorId, elegir]);
  const pc = ancho === "pc";
  return (
    <div className={pc ? "flex h-full min-h-0 flex-col gap-4" : "space-y-4"}>
      <nav className="flex gap-1.5">
        {secciones.map(([v, t, Icono]) => (
          <button
            key={v}
            onClick={() => elegir(v)}
            className={`flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm font-medium transition ${seccion === v ? "bg-cafe text-beige" : "border border-stone-300 bg-white text-stone-600 hover:border-stone-400"}`}
          >
            <Icono className="size-4" /> {t}
          </button>
        ))}
      </nav>
      <div className={pc ? "min-h-0 flex-1" : ""}>
        {seccion === "proveedores" ? <Proveedores ancho={ancho} abrir={proveedorId} /> : seccion === "formas-pago" ? <FormasPago /> : <Exportar />}
      </div>
    </div>
  );
}

/** Descarga todo lo cargado desde el 1/11 (para llevarlo a otro sistema). */
function Exportar() {
  return (
    <section className="tarjeta max-w-2xl space-y-3 p-4">
      <h3 className="font-semibold text-stone-800">Exportar todo desde el 1/11/2026</h3>
      <p className="text-sm text-stone-600">
        Un .zip con las facturas y compras sin factura (sin las descartadas), sus renglones, proveedores y productos: un archivo para importar en otro sistema,
        planillas para Excel y las fotos y PDF de cada factura.
      </p>
      <p className="text-xs text-stone-500">Trae CUITs, importes y fotos de facturas: guardalo en un lugar seguro.</p>
      <a href="/api/c/exportar.zip" download className="inline-flex items-center gap-2 rounded-xl bg-naranja px-4 py-2.5 text-sm font-semibold text-white hover:opacity-90">
        <Download className="size-4" /> Descargar .zip
      </a>
    </section>
  );
}
