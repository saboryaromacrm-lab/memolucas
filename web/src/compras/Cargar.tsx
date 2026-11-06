import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { ahora, enZona, hora } from "../lib/fechas";
import type { Compra } from "../lib/tipos";
import { Cargador, EstadoCola, TarjetaLectura, type Lectura } from "./Cargador";
import { plata, useVivo, type Ancho, type Destino } from "./comun";
import { CompraManualForm } from "./CompraManual";
import { Estado } from "./Facturas";

/** Cargar facturas: las opciones, lo que se está leyendo o espera señal, y lo cargado hoy. */
export function Cargar({ ancho, archivos, ir }: { ancho: Ancho; archivos?: File[]; ir: (d: Destino) => void }) {
  const { datos } = useVivo<{ lecturas: Lectura[]; compras: Compra[] }>("/api/c/compras");
  const [sinFactura, setSinFactura] = useState(false);
  const hoy = ahora().toISODate();
  const deHoy = (datos?.compras ?? []).filter((c) => enZona(c.creadoEn).toISODate() === hoy);

  return (
    <div className={`@container mx-auto max-w-4xl space-y-4 ${ancho === "pc" ? "h-full overflow-y-auto pr-1" : ""}`}>
      <Cargador ancho={ancho} onSinFactura={() => setSinFactura(true)} iniciales={archivos} />
      <EstadoCola />
      {datos?.lecturas.map((l) => (
        <TarjetaLectura key={l.id} l={l} />
      ))}
      {deHoy.length > 0 && (
        <section className="tarjeta divide-y divide-stone-100">
          <h3 className="px-4 py-2.5 font-semibold text-stone-800">Cargadas hoy</h3>
          {deHoy.map((c) => (
            <button key={c.id} onClick={() => ir({ pestana: "facturas", abrir: c.id })} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-stone-50">
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-stone-800">{c.proveedor || "Proveedor sin datos"}</span>
                <span className="block truncate text-xs text-stone-500">
                  {c.titulo} · {hora(c.creadoEn)}
                  {c.autor && ` · ${c.autor}`}
                </span>
                <span className="mt-1 block">
                  <Estado c={c} />
                </span>
              </span>
              <span className="shrink-0 text-right font-semibold tabular-nums text-stone-800">{plata(c.total, c.moneda)}</span>
              <span className="flex shrink-0 items-center text-sm font-medium text-naranja">
                Ver <ChevronRight className="size-4" />
              </span>
            </button>
          ))}
        </section>
      )}
      {sinFactura && (
        <CompraManualForm
          id={null}
          onCerrar={() => setSinFactura(false)}
          onGuardada={(id) => {
            setSinFactura(false);
            if (id) ir({ pestana: "facturas", abrir: id });
          }}
        />
      )}
    </div>
  );
}
