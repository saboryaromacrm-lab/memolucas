import { useState, type ReactNode } from "react";
import { Download, Loader2 } from "lucide-react";
import { ahora } from "../lib/fechas";
import { nombrePeriodo, plata, useRecordado, useVivo, type Ancho, type Destino } from "./comun";
import { Variacion } from "./Productos";

type Periodo = { desde: string; hasta: string };
type Grupo = { id: number | null; nombre: string; total: number; compras: number };
type Resumen = { total: number; compras: number; promedio: number; proveedores: number; mercaderia: number; gasto: number };
type CambioDePrecio = { id: number; nombre: string; variacion: number; gasto: number };
type Datos = {
  periodo: Periodo;
  anterior: Periodo;
  resumen: Resumen & { inflacion: number | null };
  resumenAnterior: Resumen;
  remitos: number;
  dolares: { total: number; compras: number };
  evolucion: { porDia: boolean; barras: { clave: string; mercaderia: number; gasto: number }[] };
  proveedores: (Grupo & { variacion: number | null })[];
  categorias: Grupo[];
  productos: Grupo[];
  subas: CambioDePrecio[];
  bajas: CambioDePrecio[];
  inflacionPorMes: { mes: string; variacion: number | null }[];
  formasPago: Grupo[];
  impuestos: { ivas: { alicuota: number; importe: number }[]; percepciones: { nombre: string; importe: number }[]; internos: number; otros: number };
  autores: Grupo[];
  origen: Grupo[];
  tipos: Grupo[];
};

const PERIODOS = [
  ["mes", "Este mes"],
  ["anterior", "Mes anterior"],
  ["3m", "Últimos 3 meses"],
  ["6m", "Últimos 6 meses"],
  ["12m", "Últimos 12 meses"],
  ["anio", "Este año"],
  ["elegir", "Elegir fechas"],
] as const;
type ClavePeriodo = (typeof PERIODOS)[number][0];

/** Las fechas de cada opción: meses enteros, para que se comparen con los mismos meses de antes. */
function fechasDe(clave: Exclude<ClavePeriodo, "elegir">): Periodo {
  const hoy = ahora();
  const meses = (atras: number, hasta = hoy) => ({ desde: hasta.minus({ months: atras }).startOf("month").toISODate()!, hasta: hasta.endOf("month").toISODate()! });
  if (clave === "anio") return { desde: hoy.startOf("year").toISODate()!, hasta: hoy.endOf("year").toISODate()! };
  if (clave === "anterior") return meses(0, hoy.minus({ months: 1 }));
  return meses({ mes: 0, "3m": 2, "6m": 5, "12m": 11 }[clave]);
}

const porcentaje = (actual: number, anterior: number) => (anterior > 0 ? ((actual - anterior) / anterior) * 100 : null);
const textoPeriodo = (p: Periodo) =>
  p.desde.slice(0, 7) === p.hasta.slice(0, 7) && p.desde.endsWith("-01") ? nombrePeriodo(p.desde.slice(0, 7)) : `${nombrePeriodo(p.desde)} al ${nombrePeriodo(p.hasta)}`;

export function Metricas({ ancho, ir }: { ancho: Ancho; ir: (d: Destino) => void }) {
  const [clave, elegir] = useRecordado("compras-metricas-periodo", PERIODOS.map(([v]) => v));
  const [elegidas, setElegidas] = useState<Periodo>(() => fechasDe("mes"));
  const [soloConfirmadas, setSoloConfirmadas] = useState(false);
  const periodo = clave === "elegir" ? elegidas : fechasDe(clave);
  const consulta = `desde=${periodo.desde}&hasta=${periodo.hasta}${soloConfirmadas ? "&confirmadas=1" : ""}`;
  const { datos: m } = useVivo<Datos>(periodo.desde <= periodo.hasta ? `/api/c/metricas?${consulta}` : null);

  const controles = (
    <div className="flex flex-wrap items-center gap-2">
      <select aria-label="Período" className="campo w-auto py-2 text-sm" value={clave} onChange={(e) => elegir(e.target.value as ClavePeriodo)}>
        {PERIODOS.map(([v, t]) => (
          <option key={v} value={v}>
            {t}
          </option>
        ))}
      </select>
      {clave === "elegir" && (
        <>
          <input aria-label="Desde" type="date" className="campo w-auto py-2 text-sm" value={elegidas.desde} onChange={(e) => setElegidas({ ...elegidas, desde: e.target.value })} />
          <input aria-label="Hasta" type="date" className="campo w-auto py-2 text-sm" value={elegidas.hasta} onChange={(e) => setElegidas({ ...elegidas, hasta: e.target.value })} />
        </>
      )}
      <button
        onClick={() => setSoloConfirmadas(!soloConfirmadas)}
        className={`rounded-full px-3.5 py-1.5 text-sm font-medium transition ${soloConfirmadas ? "bg-cafe text-beige" : "border border-stone-300 bg-white text-stone-600 hover:border-stone-400"}`}
      >
        Solo confirmadas
      </button>
      <a
        href={`/api/c/metricas.csv?${consulta}`}
        download
        className="ml-auto flex items-center gap-1.5 rounded-xl border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-stone-700 hover:border-stone-400"
      >
        <Download className="size-4" /> Excel
      </a>
    </div>
  );

  return (
    <div className={`@container space-y-4 ${ancho === "pc" ? "h-full overflow-y-auto pr-1" : ""}`}>
      {controles}
      {!m ? (
        <div className="flex justify-center py-16">
          <Loader2 className="size-6 animate-spin text-naranja" />
        </div>
      ) : (
        <Tablero m={m} ir={ir} />
      )}
    </div>
  );
}

function Tablero({ m, ir }: { m: Datos; ir: (d: Destino) => void }) {
  const r = m.resumen;
  const a = m.resumenAnterior;
  const impuestos = (
    [
      ...m.impuestos.ivas.map((x): [string, number] => [`IVA ${String(x.alicuota).replace(".", ",")} %`, x.importe]),
      ...m.impuestos.percepciones.map((x): [string, number] => [x.nombre, x.importe]),
      ["Impuestos internos", m.impuestos.internos],
      ["Otros impuestos", m.impuestos.otros],
    ] as [string, number][]
  ).filter(([, v]) => Math.abs(v) >= 0.005);
  return (
    <>
      <p className="text-sm text-stone-500">
        <b className="font-semibold capitalize text-stone-800">{textoPeriodo(m.periodo)}</b> · comparado con {textoPeriodo(m.anterior)}
        {m.remitos > 0 && ` · ${m.remitos} ${m.remitos === 1 ? "remito" : "remitos"} (no suman)`}
        {m.dolares.compras > 0 && ` · en dólares aparte: ${plata(m.dolares.total, "DOL")}`}
      </p>

      <div className="grid grid-cols-2 gap-2 @2xl:grid-cols-4">
        <Cifra titulo="Total comprado" valor={plata(r.total)} cambio={porcentaje(r.total, a.total)} grande />
        <Cifra titulo="Compras" valor={String(r.compras)} cambio={porcentaje(r.compras, a.compras)} />
        <Cifra titulo="Compra promedio" valor={plata(r.promedio)} cambio={porcentaje(r.promedio, a.promedio)} />
        <Cifra titulo="Proveedores" valor={String(r.proveedores)} cambio={porcentaje(r.proveedores, a.proveedores)} />
        <Cifra titulo="Mercadería" valor={plata(r.mercaderia)} cambio={porcentaje(r.mercaderia, a.mercaderia)} />
        <Cifra titulo="Gastos" valor={plata(r.gasto)} cambio={porcentaje(r.gasto, a.gasto)} />
        <Cifra
          titulo="Tus precios"
          valor={r.inflacion === null ? "—" : `${r.inflacion > 0 ? "+" : ""}${r.inflacion.toFixed(1).replace(".", ",")} %`}
          ayuda="Cuánto subió lo que comprás, pesado por lo que gastás en cada producto"
        />
      </div>

      <Seccion titulo="Evolución" ayuda="Tocá una barra para ver esas facturas.">
        <Barras evolucion={m.evolucion} onElegir={(clave) => ir({ pestana: "facturas", periodo: clave })} />
      </Seccion>

      <div className="grid gap-4 @3xl:grid-cols-2">
        <Seccion titulo="Por proveedor">
          <Ranking
            grupos={m.proveedores}
            accion={(g) => (g.id ? () => ir({ pestana: "configuracion", proveedorId: g.id! }) : null)}
            extra={(g) => <Variacion v={g.variacion} />}
          />
        </Seccion>
        <Seccion titulo="Por categoría" ayuda="Según los productos de las compras confirmadas, sin percepciones.">
          <Ranking grupos={m.categorias} accion={(g) => () => ir({ pestana: "productos", categoria: g.nombre })} />
        </Seccion>
        <Seccion titulo="Productos con más gasto">
          <Ranking grupos={m.productos} accion={(g) => () => ir({ pestana: "productos", productoId: g.id! })} sinResto />
        </Seccion>
        <Seccion titulo="Cambios de precio" ayuda="Su última compra contra la del período anterior.">
          <CambiosDePrecio titulo="Más subieron" lista={m.subas} ir={ir} />
          <CambiosDePrecio titulo="Bajaron" lista={m.bajas} ir={ir} />
        </Seccion>
        <Seccion titulo="Tus precios, mes a mes" ayuda="Cuánto subió lo que comprás contra el mes anterior.">
          <ul className="divide-y divide-stone-100 text-sm">
            {m.inflacionPorMes.map((x) => (
              <li key={x.mes} className="flex items-center justify-between gap-3 py-2">
                <span className="capitalize text-stone-700">{nombrePeriodo(x.mes)}</span>
                {x.variacion === null ? <span className="text-xs text-stone-400">Sin compras para comparar</span> : <Variacion v={x.variacion} />}
              </li>
            ))}
          </ul>
        </Seccion>
        <Seccion titulo="Por forma de pago">
          <Ranking grupos={m.formasPago} accion={(g) => (g.id ? () => ir({ pestana: "facturas", formaPagoId: g.id! }) : null)} />
        </Seccion>
        <Seccion titulo="Impuestos" ayuda="Lo que figura en las facturas: el IVA es crédito fiscal.">
          {!impuestos.length && <p className="text-sm text-stone-500">Sin impuestos en el período.</p>}
          <ul className="divide-y divide-stone-100 text-sm">
            {impuestos.map(([t, v]) => (
              <li key={t} className="flex justify-between gap-3 py-2">
                <span className="text-stone-700">{t}</span>
                <span className="font-medium tabular-nums">{plata(v)}</span>
              </li>
            ))}
            {impuestos.length > 1 && (
              <li className="flex justify-between gap-3 py-2 font-semibold">
                <span>Total</span>
                <span className="tabular-nums">{plata(impuestos.reduce((t, [, v]) => t + v, 0))}</span>
              </li>
            )}
          </ul>
        </Seccion>
        <Seccion titulo="Más detalles">
          <h4 className="etiqueta">Por persona que cargó</h4>
          <Ranking grupos={m.autores} />
          <h4 className="etiqueta mt-4">Con y sin factura</h4>
          <Ranking grupos={m.origen} />
          <h4 className="etiqueta mt-4">Por tipo de comprobante</h4>
          <Ranking grupos={m.tipos} />
        </Seccion>
      </div>
    </>
  );
}

function Seccion({ titulo, ayuda, children }: { titulo: string; ayuda?: string; children: ReactNode }) {
  return (
    <section className="tarjeta p-4">
      <h3 className="font-semibold text-stone-800">{titulo}</h3>
      {ayuda && <p className="text-xs text-stone-500">{ayuda}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Cifra({ titulo, valor, cambio, ayuda, grande }: { titulo: string; valor: string; cambio?: number | null; ayuda?: string; grande?: boolean }) {
  return (
    <div title={ayuda} className={`rounded-xl px-3 py-3 ${grande ? "bg-cafe text-beige" : "bg-marca-suave"}`}>
      <div className={`text-[11px] font-medium uppercase tracking-wide ${grande ? "text-beige/70" : "text-stone-500"}`}>{titulo}</div>
      <div className={`mt-0.5 truncate text-lg font-bold tabular-nums ${grande ? "" : "text-cafe"}`}>{valor}</div>
      <div className="mt-1 min-h-5">
        {cambio !== undefined && cambio !== null ? <Variacion v={cambio} /> : ayuda && <span className="text-[11px] leading-tight text-stone-500">{ayuda}</span>}
      </div>
    </div>
  );
}

const LIMITE = 10;

/** Barras horizontales con el total y el % de cada uno. Más de 10: los demás van juntos en "Resto". */
function Ranking<G extends Grupo>({
  grupos,
  accion,
  extra,
  sinResto,
}: {
  grupos: G[];
  /** Qué hacer al tocar uno (null: no se toca). */
  accion?: (g: G) => (() => void) | null;
  extra?: (g: G) => ReactNode;
  /** Mostrar solo los primeros 10, sin sumar el resto. */
  sinResto?: boolean;
}) {
  if (!grupos.length) return <p className="text-sm text-stone-500">Sin compras en el período.</p>;
  const total = grupos.reduce((t, g) => t + g.total, 0);
  const mayor = Math.max(...grupos.map((g) => g.total), 1);
  const resto = grupos.slice(LIMITE);
  const fila = (g: Grupo, tocar?: (() => void) | null, adicional?: ReactNode) => {
    const contenido = (
      <>
        <span className="flex items-baseline justify-between gap-3 text-sm">
          <span className={`min-w-0 truncate ${tocar ? "text-stone-800 group-hover:text-naranja" : "text-stone-700"}`}>{g.nombre}</span>
          <span className="flex shrink-0 items-center gap-2">
            {adicional}
            <span className="font-semibold tabular-nums text-stone-800">{plata(g.total)}</span>
          </span>
        </span>
        <span className="mt-1 flex items-center gap-2">
          <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-stone-100">
            <span className="block h-full rounded-full bg-naranja" style={{ width: `${Math.min(100, Math.max(0, (g.total / mayor) * 100))}%` }} />
          </span>
          <span className="w-28 shrink-0 text-right text-[11px] text-stone-500">
            {total > 0 && `${((g.total / total) * 100).toFixed(1).replace(".", ",")} % · `}
            {g.compras} {g.compras === 1 ? "compra" : "compras"}
          </span>
        </span>
      </>
    );
    return (
      <li key={`${g.id}:${g.nombre}`}>
        {tocar ? (
          <button onClick={tocar} className="group block w-full text-left">
            {contenido}
          </button>
        ) : (
          contenido
        )}
      </li>
    );
  };
  return (
    <ul className="space-y-2.5">
      {grupos.slice(0, LIMITE).map((g) => fila(g, accion?.(g), extra?.(g)))}
      {resto.length > 0 &&
        !sinResto &&
        fila({ id: null, nombre: `Resto (${resto.length})`, total: resto.reduce((t, g) => t + g.total, 0), compras: resto.reduce((t, g) => t + g.compras, 0) })}
    </ul>
  );
}

/** Barras apiladas (mercadería y gastos) por día o por mes. */
function Barras({ evolucion, onElegir }: { evolucion: Datos["evolucion"]; onElegir: (clave: string) => void }) {
  const { barras, porDia } = evolucion;
  const mayor = Math.max(...barras.map((b) => b.mercaderia + b.gasto), 1);
  // Con muchas barras, no entran todos los rótulos: se muestra uno cada tanto.
  const cada = Math.ceil(barras.length / 12);
  const rotulo = (clave: string) => (porDia ? String(Number(clave.slice(8))) : nombrePeriodo(clave).slice(0, 3));
  return (
    <div>
      <div className="flex h-44 items-end gap-0.5 @lg:gap-1">
        {barras.map((b) => {
          const total = b.mercaderia + b.gasto;
          return (
            <button
              key={b.clave}
              onClick={() => total > 0 && onElegir(b.clave)}
              title={`${nombrePeriodo(b.clave)}: ${plata(total)} (mercadería ${plata(b.mercaderia)} · gastos ${plata(b.gasto)})`}
              className="flex h-full min-w-0 flex-1 flex-col justify-end rounded-t hover:opacity-80"
            >
              <span className="block w-full rounded-t bg-cafe" style={{ height: `${(Math.max(0, b.gasto) / mayor) * 100}%` }} />
              <span className="block w-full bg-naranja" style={{ height: `${(Math.max(0, b.mercaderia) / mayor) * 100}%` }} />
            </button>
          );
        })}
      </div>
      <div className="mt-1 flex gap-0.5 border-t border-stone-200 pt-1 @lg:gap-1">
        {barras.map((b, i) => (
          <span key={b.clave} className="min-w-0 flex-1 text-center text-[10px] capitalize text-stone-500">
            {i % cada === 0 ? rotulo(b.clave) : ""}
          </span>
        ))}
      </div>
      <div className="mt-2 flex gap-4 text-xs text-stone-600">
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-naranja" /> Mercadería
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-cafe" /> Gastos
        </span>
      </div>
    </div>
  );
}

function CambiosDePrecio({ titulo, lista, ir }: { titulo: string; lista: CambioDePrecio[]; ir: (d: Destino) => void }) {
  return (
    <div className="mb-3 last:mb-0">
      <h4 className="etiqueta">{titulo}</h4>
      {lista.length ? (
        <ul className="divide-y divide-stone-100 text-sm">
          {lista.slice(0, 5).map((x) => (
            <li key={x.id}>
              <button onClick={() => ir({ pestana: "productos", productoId: x.id })} className="flex w-full items-center justify-between gap-3 py-2 text-left hover:text-naranja">
                <span className="min-w-0 truncate">{x.nombre}</span>
                <Variacion v={x.variacion} />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="py-1 text-sm text-stone-500">Ninguno.</p>
      )}
    </div>
  );
}
