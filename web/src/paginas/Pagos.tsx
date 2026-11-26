import { useState } from "react";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { Boton, Encabezado } from "../componentes/ui";
import { nombreMes, periodoActual, sumarMeses } from "../lib/pagos";
import { useRecordado } from "../lib/recordado";
import { PagosConfig } from "./PagosConfig";
import { PagosMes } from "./PagosMes";
import { PagosResumen } from "./PagosResumen";

type Vista = "mes" | "resumen" | "config";
const VISTAS: [Vista, string][] = [
  ["mes", "Este mes"],
  ["resumen", "Resumen"],
  ["config", "Configuración"],
];

/** Pagos: todo lo que pagás mes a mes en tus locales, tu casa y tus cosas. */
export function Pagos() {
  const [vista, setVista] = useRecordado<{ v: Vista }>("pagos-vista", { v: "mes" });
  const [periodo, setPeriodo] = useState(periodoActual);
  const [nuevo, setNuevo] = useState(false);

  return (
    <div>
      <Encabezado
        titulo="Pagos"
        subtitulo="Todo lo que pagás, mes a mes. Se arma solo con lo que cargaste en Configuración."
        acciones={
          vista.v !== "config" && (
            <>
              <div className="flex items-center gap-1">
                <Boton chico aria-label="Mes anterior" onClick={() => setPeriodo(sumarMeses(periodo, -1))}>
                  <ChevronLeft className="size-4" />
                </Boton>
                <button onClick={() => setPeriodo(periodoActual())} title="Volver a este mes" className="min-w-36 px-2 text-center text-sm font-semibold text-slate-900">
                  {nombreMes(periodo)}
                </button>
                <Boton chico aria-label="Mes siguiente" onClick={() => setPeriodo(sumarMeses(periodo, 1))}>
                  <ChevronRight className="size-4" />
                </Boton>
              </div>
              {vista.v === "mes" && (
                <Boton variante="primario" icono={<Plus className="size-4" />} onClick={() => setNuevo(true)}>
                  Pago
                </Boton>
              )}
            </>
          )
        }
      />
      <div className="mb-5 flex gap-1 border-b border-slate-200">
        {VISTAS.map(([v, texto]) => (
          <button
            key={v}
            onClick={() => setVista({ v })}
            className={`-mb-px border-b-2 px-3 py-2.5 text-sm font-medium ${vista.v === v ? "border-marca-oscuro text-marca-oscuro" : "border-transparent text-slate-500 hover:text-slate-800"}`}
          >
            {texto}
          </button>
        ))}
      </div>
      {vista.v === "mes" && <PagosMes periodo={periodo} nuevo={nuevo} onCerrarNuevo={() => setNuevo(false)} onConfigurar={() => setVista({ v: "config" })} />}
      {vista.v === "resumen" && <PagosResumen periodo={periodo} />}
      {vista.v === "config" && <PagosConfig />}
    </div>
  );
}
