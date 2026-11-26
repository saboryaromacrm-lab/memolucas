import { useState } from "react";
import { Download } from "lucide-react";
import { Cargando } from "../componentes/ui";
import { plata } from "../lib/numeros";
import { mesCorto, nombreMes, plataTotales, sumarMeses } from "../lib/pagos";
import type { GrupoPagos, ResumenPagos } from "../lib/tipos";
import { useDatos } from "../lib/vivo";

/** Resumen: los últimos 12 meses, el mes y el año por lugar y por categoría, y el CSV para el contador. */
export function PagosResumen({ periodo }: { periodo: string }) {
  const { datos } = useDatos<ResumenPagos>(`/api/pagos/resumen?periodo=${periodo}`, ["pagos"]);
  const [desde, setDesde] = useState(sumarMeses(periodo, -2));
  const [hasta, setHasta] = useState(periodo);
  if (!datos) return <Cargando />;
  const maximo = Math.max(1, ...datos.meses.map((m) => m.total.ARS));
  const dif = datos.anterior.total.ARS ? ((datos.mes.total.ARS - datos.anterior.total.ARS) / datos.anterior.total.ARS) * 100 : null;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="tarjeta p-4">
          <div className="text-xs font-medium text-slate-500">{nombreMes(periodo)}</div>
          <div className="mt-1 text-xl font-semibold text-slate-900">{plataTotales(datos.mes.total)}</div>
          <div className="text-xs text-slate-400">
            {dif === null ? "Sin mes anterior para comparar" : `${dif >= 0 ? "+" : ""}${Math.round(dif)} % contra ${nombreMes(sumarMeses(periodo, -1)).toLowerCase()}`}
          </div>
        </div>
        <div className="tarjeta p-4">
          <div className="text-xs font-medium text-slate-500">Pagado en el mes</div>
          <div className="mt-1 text-xl font-semibold text-marca-oscuro">{plataTotales(datos.mes.pagado)}</div>
        </div>
        <div className="tarjeta p-4">
          <div className="text-xs font-medium text-slate-500">En el año ({periodo.slice(0, 4)})</div>
          <div className="mt-1 text-xl font-semibold text-slate-900">{plataTotales(datos.anio.total)}</div>
        </div>
      </div>

      <section className="tarjeta p-4">
        <h2 className="mb-3 text-sm font-semibold text-slate-800">Últimos 12 meses</h2>
        <div className="flex h-44 items-end gap-1.5 sm:gap-2">
          {datos.meses.map((m) => (
            <div key={m.periodo} className="flex h-full min-w-0 flex-1 flex-col items-center gap-1" title={`${nombreMes(m.periodo)}: ${plata(m.total.ARS)} (pagado ${plata(m.pagado.ARS)})`}>
              <div className="relative w-full flex-1">
                <div className="absolute inset-x-0 bottom-0 rounded-t bg-slate-200" style={{ height: `${(m.total.ARS / maximo) * 100}%` }} />
                <div className="absolute inset-x-0 bottom-0 rounded-t bg-marca-oscuro" style={{ height: `${(m.pagado.ARS / maximo) * 100}%` }} />
              </div>
              <span className={`text-[10px] capitalize ${m.periodo === periodo ? "font-semibold text-slate-900" : "text-slate-500"}`}>{mesCorto(m.periodo)}</span>
            </div>
          ))}
        </div>
        <p className="mt-2 flex gap-4 text-xs text-slate-500">
          <span className="flex items-center gap-1">
            <span className="size-2.5 rounded-sm bg-marca-oscuro" /> Pagado
          </span>
          <span className="flex items-center gap-1">
            <span className="size-2.5 rounded-sm bg-slate-200" /> Total del mes
          </span>
          <span>(en pesos)</span>
        </p>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Tabla titulo="Por lugar" mes={datos.mes.porLugar} anio={datos.anio.porLugar} />
        <Tabla titulo="Por categoría" mes={datos.mes.porCategoria} anio={datos.anio.porCategoria} />
        <Tabla titulo="Negocio y personal" mes={datos.mes.porTipo} anio={datos.anio.porTipo} />
        <section className="tarjeta p-4">
          <h2 className="text-sm font-semibold text-slate-800">Exportar para el contador</h2>
          <p className="mt-1 text-xs text-slate-500">Un archivo CSV que se abre directo con Excel: cada pago con su lugar, categoría, monto, si se pagó, cuándo y cómo.</p>
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <label className="block">
              <span className="etiqueta">Desde</span>
              <input className="campo" type="month" value={desde} onChange={(e) => setDesde(e.target.value)} />
            </label>
            <label className="block">
              <span className="etiqueta">Hasta</span>
              <input className="campo" type="month" value={hasta} onChange={(e) => setHasta(e.target.value)} />
            </label>
            <a
              href={`/api/pagos/exportar?desde=${desde}&hasta=${hasta}`}
              className={`inline-flex min-h-10 items-center gap-1.5 rounded-lg bg-marca-oscuro px-3.5 text-sm font-medium text-white hover:bg-marca-profundo ${!desde || !hasta || desde > hasta ? "pointer-events-none opacity-50" : ""}`}
            >
              <Download className="size-4" /> Descargar CSV
            </a>
          </div>
        </section>
      </div>
    </div>
  );
}

function Tabla({ titulo, mes, anio }: { titulo: string; mes: GrupoPagos[]; anio: GrupoPagos[] }) {
  const nombres = [...new Set([...mes, ...anio].map((g) => g.nombre))];
  return (
    <section className="tarjeta overflow-hidden">
      <h2 className="px-4 pt-4 text-sm font-semibold text-slate-800">{titulo}</h2>
      {nombres.length ? (
        <table className="mt-2 w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-[11px] uppercase tracking-wide text-slate-500">
              <th className="px-4 py-2 font-semibold" />
              <th className="px-4 py-2 text-right font-semibold">Este mes</th>
              <th className="px-4 py-2 text-right font-semibold">En el año</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {nombres.map((n) => {
              const m = mes.find((g) => g.nombre === n);
              const a = anio.find((g) => g.nombre === n);
              return (
                <tr key={n}>
                  <td className="px-4 py-2 text-slate-700">{n}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-slate-900">{m ? plataTotales(m.total) : "—"}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-slate-500">{a ? plataTotales(a.total) : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <p className="px-4 pb-4 pt-2 text-sm text-slate-500">Todavía no hay pagos.</p>
      )}
    </section>
  );
}
