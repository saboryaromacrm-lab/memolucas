import { useState } from "react";
import { ScrollText } from "lucide-react";
import { Cargando, Encabezado, Vacio } from "../componentes/ui";
import { fechaHora } from "../lib/fechas";
import type { Log } from "../lib/tipos";
import { useDatos } from "../lib/vivo";

const NIVELES = { info: ["Info", "bg-slate-100 text-slate-600"], aviso: ["Aviso", "bg-amber-50 text-amber-700"], error: ["Error", "bg-red-50 text-red-700"] } as const;

export function Logs() {
  const [nivel, setNivel] = useState<"" | Log["nivel"]>("");
  const { datos } = useDatos<Log[]>(`/api/logs${nivel ? `?nivel=${nivel}` : ""}`, ["logs"]);
  const [abierto, setAbierto] = useState<number | null>(null);

  return (
    <div>
      <Encabezado titulo="Logs del sistema" subtitulo="Errores, reconexiones y fallos de IA. Se guardan las últimas 500 entradas." />
      <div className="mb-4 flex gap-1.5">
        {(["", "error", "aviso", "info"] as const).map((n) => (
          <button
            key={n}
            onClick={() => setNivel(n)}
            className={`rounded-full border px-3 py-1 text-sm font-medium ${nivel === n ? "border-marca-oscuro bg-marca-oscuro text-white" : "border-slate-200 bg-white text-slate-600"}`}
          >
            {n ? NIVELES[n][0] : "Todos"}
          </button>
        ))}
      </div>
      {!datos ? (
        <Cargando />
      ) : !datos.length ? (
        <div className="tarjeta">
          <Vacio icono={<ScrollText className="size-10" />} titulo="Sin entradas" />
        </div>
      ) : (
        <div className="tarjeta divide-y divide-slate-100 font-mono text-xs">
          {datos.map((l) => (
            <div key={l.id} className="px-4 py-2.5">
              <button className="flex w-full flex-wrap items-start gap-x-3 gap-y-1 text-left" onClick={() => setAbierto(abierto === l.id ? null : l.id)}>
                <span className="w-32 shrink-0 text-slate-400">{fechaHora(l.creadoEn)}</span>
                <span className={`rounded px-1.5 font-sans font-medium ${NIVELES[l.nivel][1]}`}>{NIVELES[l.nivel][0]}</span>
                <span className="text-slate-500">{l.origen}</span>
                <span className="min-w-0 flex-1 basis-full break-words text-slate-800 sm:basis-auto">{l.mensaje}</span>
              </button>
              {abierto === l.id && l.detalle != null && (
                <pre className="mt-2 overflow-x-auto rounded-lg bg-slate-50 p-3 text-[11px] text-slate-600">{JSON.stringify(l.detalle, null, 2)}</pre>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
