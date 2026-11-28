import { useState } from "react";
import { Encabezado } from "../componentes/ui";
import { periodoActual } from "../lib/pagos";
import { useRecordado } from "../lib/recordado";
import { PagosCargas } from "./PagosCargas";
import { PagosConfig } from "./PagosConfig";
import { PagosCuentas } from "./PagosCuentas";
import { PagosIa } from "./PagosIa";
import { PagosMes } from "./PagosMes";
import { PagosResumen } from "./PagosResumen";

type Vista = "mes" | "resumen" | "cuentas" | "config" | "cargas";
const VISTAS: [Vista, string][] = [
  ["mes", "Este mes"],
  ["resumen", "Resumen"],
  ["cuentas", "Cuentas"],
  ["config", "Configuración"],
  ["cargas", "Cargas con IA"],
];

/** Pagos: todo lo que pagás mes a mes en tus locales, tu casa y tus cosas. Arriba de todo, la IA para cargar lo que sea. */
export function Pagos() {
  const [vista, setVista] = useRecordado<{ v: Vista }>("pagos-vista", { v: "mes" });
  const [periodo, setPeriodo] = useState(periodoActual);

  return (
    <div>
      <Encabezado titulo="Pagos" subtitulo="Todo lo que pagás, mes a mes. Se arma solo con lo que cargaste en Configuración." />
      <PagosIa />
      <div className="mb-5 flex gap-1 overflow-x-auto border-b border-slate-200">
        {VISTAS.map(([v, texto]) => (
          <button
            key={v}
            onClick={() => setVista({ v })}
            className={`-mb-px shrink-0 whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium ${vista.v === v ? "border-marca-oscuro text-marca-oscuro" : "border-transparent text-slate-500 hover:text-slate-800"}`}
          >
            {texto}
          </button>
        ))}
      </div>
      {vista.v === "mes" && <PagosMes periodo={periodo} onPeriodo={setPeriodo} onConfigurar={() => setVista({ v: "config" })} />}
      {vista.v === "resumen" && <PagosResumen periodo={periodo} onPeriodo={setPeriodo} />}
      {vista.v === "cuentas" && <PagosCuentas />}
      {vista.v === "config" && <PagosConfig />}
      {vista.v === "cargas" && <PagosCargas />}
    </div>
  );
}
