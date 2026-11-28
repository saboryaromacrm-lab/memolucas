import { useState } from "react";
import { ChevronDown, FileText, Pencil, Search, Sparkles, Undo2 } from "lucide-react";
import { Boton, Cargando, Modal, Vacio, useAccion } from "../componentes/ui";
import { get, post } from "../lib/api";
import { fechaHora } from "../lib/fechas";
import { nombreMes } from "../lib/pagos";
import { sinTildes } from "../lib/textos";
import type { CargaIa, CargaParaCorregir, ConfigPagos, FijoPago, LineaCarga, PlanDeshacer } from "../lib/tipos";
import { useDatos } from "../lib/vivo";
import { ModalFijo } from "./PagosFijo";
import { filasDePropuesta, RevisionIa } from "./PagosRevisionIa";

// Cargas con IA: todo lo que aplicaste con la IA en Pagos (los conceptos de Configuración y los montos de un mes), con
// lo que le pasaste y lo que hizo. Cada una se puede deshacer entera o corregir.

const INSIGNIA: Record<LineaCarga["tipo"], [string, string]> = {
  nuevo: ["Nuevo", "bg-emerald-100 text-emerald-800"],
  cambio: ["Cambió", "bg-sky-100 text-sky-800"],
  borrar: ["Borró", "bg-red-100 text-red-700"],
  monto: ["Monto", "bg-sky-100 text-sky-800"],
  suelto: ["Suelto", "bg-violet-100 text-violet-800"],
  lugar: ["Lugar", "bg-amber-100 text-amber-800"],
  categoria: ["Categoría", "bg-amber-100 text-amber-800"],
  queda: ["Quedó", "bg-amber-100 text-amber-800"],
};
const CUANTOS: [LineaCarga["tipo"], string, string][] = [
  ["nuevo", "nuevo", "nuevos"],
  ["cambio", "cambiado", "cambiados"],
  ["borrar", "borrado", "borrados"],
  ["monto", "monto", "montos"],
  ["suelto", "pago suelto", "pagos sueltos"],
  ["lugar", "lugar nuevo", "lugares nuevos"],
  ["categoria", "categoría nueva", "categorías nuevas"],
];

const tituloDe = (c: CargaIa) =>
  c.tipo === "general" ? (c.periodo ? `Carga desde ${nombreMes(c.periodo).toLowerCase()}` : "Carga") : c.tipo === "mes" && c.periodo ? `Montos que corresponden a ${nombreMes(c.periodo).toLowerCase()}` : "Conceptos";
const resumen = (c: CargaIa) =>
  CUANTOS.flatMap(([tipo, uno, varios]) => {
    const n = c.lineas.filter((l) => l.tipo === tipo).length;
    return n ? [`${n} ${n === 1 ? uno : varios}`] : [];
  }).join(" · ");

export function PagosCargas() {
  const { datos: cargas } = useDatos<CargaIa[]>("/api/pagos/cargas", ["pagos"]);
  const config = useDatos<ConfigPagos>("/api/pagos/config", ["pagos", "tarjetas"]).datos;
  const [buscar, setBuscar] = useState("");
  const [abiertas, setAbiertas] = useState<number[]>([]);
  const [deshacer, setDeshacer] = useState<{ carga: CargaIa; plan: PlanDeshacer } | null>(null);
  const [corrigiendo, setCorrigiendo] = useState<CargaParaCorregir | null>(null);
  const [editando, setEditando] = useState<FijoPago | null>(null);
  const accion = useAccion();
  if (!cargas || !config) return <Cargando />;

  const palabras = sinTildes(buscar).split(/\s+/).filter(Boolean);
  const visibles = cargas.filter((c) => {
    const donde = sinTildes([tituloDe(c), fechaHora(c.aplicadaEn), c.texto, ...c.lineas.flatMap((l) => [l.nombre, l.detalle])].join(" "));
    return palabras.every((p) => donde.includes(p));
  });
  const alternar = (id: number) => setAbiertas((a) => (a.includes(id) ? a.filter((x) => x !== id) : [...a, id]));
  const verDeshacer = async (carga: CargaIa) => {
    const plan = await accion(() => get<PlanDeshacer>(`/api/pagos/cargas/${carga.id}/deshacer`));
    if (plan) setDeshacer({ carga, plan });
  };
  const abrirCorregir = async (carga: CargaIa) => {
    const c = await accion(() => get<CargaParaCorregir>(`/api/pagos/cargas/${carga.id}/corregir`));
    if (c) setCorrigiendo(c);
  };

  if (!cargas.length)
    return (
      <Vacio
        icono={<Sparkles />}
        titulo="Todavía no cargaste nada con la IA"
        texto="Cuando apliques lo que propone la IA (en Configuración o con «Cargar con IA» del mes), queda acá para verlo, corregirlo o deshacerlo."
      />
    );

  return (
    <div className="space-y-4">
      <p className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600">
        Todo lo que aplicaste con la IA, con lo que le pasaste. <b>Corregir</b> abre la misma revisión con lo que hizo; <b>Deshacer</b> la saca entera (lo que tocaste a mano después queda como lo dejaste).
      </p>
      <label className="relative block">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
        <input className="campo pl-9" type="search" value={buscar} onChange={(e) => setBuscar(e.target.value)} placeholder="Buscar por lo que escribiste, un concepto, un lugar o el mes…" aria-label="Buscar cargas" />
      </label>
      {!visibles.length && <p className="text-sm text-slate-500">No hay cargas con «{buscar}».</p>}
      <ul className="space-y-3">
        {visibles.map((c) => {
          const abierta = abiertas.includes(c.id);
          return (
            <li key={c.id} className="tarjeta overflow-hidden">
              <button onClick={() => alternar(c.id)} className="flex w-full items-start gap-3 px-4 py-3 text-left" aria-expanded={abierta}>
                <Sparkles className="mt-0.5 size-4 shrink-0 text-marca-oscuro" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="font-semibold text-slate-900">{tituloDe(c)}</span>
                    <span className="text-xs text-slate-500">{fechaHora(c.aplicadaEn)}</span>
                    {c.reconstruida && <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-slate-600">Recuperada</span>}
                    {c.estado === "parcial" && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-amber-800">Deshecha en parte</span>}
                  </div>
                  {c.texto && <p className={`mt-0.5 text-sm text-slate-600 ${abierta ? "whitespace-pre-wrap" : "line-clamp-2"}`}>«{c.texto}»</p>}
                  <p className="mt-0.5 text-xs text-slate-500">{resumen(c) || "Ya no queda nada de lo que hizo"}</p>
                </div>
                <ChevronDown className={`mt-1 size-4 shrink-0 text-slate-400 transition ${abierta ? "" : "-rotate-90"}`} />
              </button>
              {abierta && (
                <div className="border-t border-slate-100">
                  <ul className="divide-y divide-slate-100">
                    {c.lineas.map((l, k) => {
                      const [insignia, color] = INSIGNIA[l.tipo];
                      const concepto = l.fijoId ? config.fijos.find((f) => f.id === l.fijoId) : undefined;
                      return (
                        <li key={k} className="flex items-start gap-2 px-4 py-2 text-sm">
                          <span className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${color}`}>{insignia}</span>
                          <div className="min-w-0 flex-1">
                            {concepto ? (
                              <button onClick={() => setEditando(concepto)} className="font-medium text-marca-oscuro underline-offset-2 hover:underline" title="Abrir el concepto para editarlo">
                                {l.nombre}
                              </button>
                            ) : (
                              <span className="font-medium text-slate-900">{l.nombre}</span>
                            )}
                            <div className="break-words text-xs text-slate-500">{l.detalle}</div>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                  {c.estado === "parcial" ? (
                    <p className="mx-4 mb-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
                      Ya se deshizo. Esto quedó como lo dejaste porque lo cambiaste después de la carga: revisalo o volvé a intentar deshacerla.
                    </p>
                  ) : (
                    c.reconstruida && (
                      <p className="mx-4 mb-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
                        Se armó con lo que se creó junto (de antes de que se guardaran las cargas, o de una que se borró sin borrar lo suyo). Si además cambió montos de un mes, eso no quedó registrado.
                      </p>
                    )
                  )}
                  <div className="flex flex-wrap gap-2 border-t border-slate-100 px-4 py-3">
                    {c.archivo && (
                      <Boton chico icono={<FileText className="size-3.5" />} onClick={() => void window.open(`/api/pagos/cargas/${c.id}/archivo`, "_blank")}>
                        Ver {c.archivo === "application/pdf" ? "el PDF" : "la imagen"}
                      </Boton>
                    )}
                    {!c.reconstruida && c.estado === "aplicada" && (
                      <Boton chico icono={<Pencil className="size-3.5" />} onClick={() => void abrirCorregir(c)}>
                        Corregir
                      </Boton>
                    )}
                    <Boton chico variante="peligro" icono={<Undo2 className="size-3.5" />} onClick={() => void verDeshacer(c)}>
                      Deshacer todo
                    </Boton>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {deshacer && (
        <ModalDeshacer
          {...deshacer}
          onCerrar={() => setDeshacer(null)}
          onConfirmar={(borrarPagos) => accion(() => post(`/api/pagos/cargas/${deshacer.carga.id}/deshacer`, { borrarPagos }), "Carga deshecha").then((ok) => ok && setDeshacer(null))}
        />
      )}
      {corrigiendo && (
        // Todo tildado (también lo que borró): es lo que está aplicado.
        <RevisionIa
          config={config}
          filas={filasDePropuesta(corrigiendo, true)}
          totalImagen={null}
          mensaje=""
          cargaId={corrigiendo.id}
          propios={corrigiendo.propios}
          onCerrar={() => setCorrigiendo(null)}
          onListo={() => setCorrigiendo(null)}
        />
      )}
      {editando && <ModalFijo fijo={editando} config={config} onCerrar={() => setEditando(null)} />}
    </div>
  );
}

/**
 * Antes de deshacer: qué se borra, qué vuelve a como estaba, los pagos que registraste después (cada uno se puede borrar
 * también) y qué queda como lo dejaste.
 */
function ModalDeshacer({ carga, plan, onCerrar, onConfirmar }: { carga: CargaIa; plan: PlanDeshacer; onCerrar: () => void; onConfirmar: (borrarPagos: number[]) => Promise<unknown> }) {
  const [deshaciendo, setDeshaciendo] = useState(false);
  const [borrarPagos, setBorrarPagos] = useState<number[]>([]);
  const grupo = (titulo: string, lista: string[], color = "text-slate-700") =>
    lista.length > 0 && (
      <section>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">{titulo}</h3>
        <p className={`mt-0.5 text-sm ${color}`}>{lista.join(" · ")}</p>
      </section>
    );
  const nada = !plan.borra.length && !plan.vuelve.length && !plan.recrea.length && !plan.montos.length && !plan.lugares.length && !plan.categorias.length && !plan.pagosDespues.length;
  return (
    <Modal
      abierto
      onCerrar={onCerrar}
      titulo={`Deshacer «${tituloDe(carga)}» del ${fechaHora(carga.aplicadaEn)}`}
      ancho="max-w-lg"
      pie={
        <>
          <Boton onClick={onCerrar}>Cancelar</Boton>
          <Boton variante="peligro" icono={<Undo2 className="size-4" />} cargando={deshaciendo} onClick={() => (setDeshaciendo(true), void onConfirmar(borrarPagos).finally(() => setDeshaciendo(false)))}>
            {nada ? "Sacarla de la lista" : "Deshacer todo"}
          </Boton>
        </>
      }
    >
      <div className="space-y-3">
        {nada && <p className="text-sm text-slate-600">Ya no queda nada de lo que hizo esta carga: solo se saca de la lista.</p>}
        {grupo("Se borran (los creó la carga)", plan.borra, "text-red-700")}
        {grupo("Vuelven a como estaban", plan.vuelve)}
        {grupo("Vuelven (los había borrado)", plan.recrea)}
        {grupo("Montos del mes que vuelven a como estaban", plan.montos)}
        {grupo("Lugares y categorías nuevos (se borran si no los usás en otra cosa)", [...plan.lugares, ...plan.categorias])}
        {plan.pagosDespues.length > 0 && (
          <section className="rounded-lg border border-slate-200 px-3 py-2 text-sm">
            <h3 className="font-semibold text-slate-800">Pagos que registraste después</h3>
            <p className="text-xs text-slate-500">Si no los tildás, quedan en el historial (sin el concepto), para no perder plata registrada.</p>
            <ul className="mt-1.5 space-y-1">
              {plan.pagosDespues.map((x) => (
                <li key={x.id}>
                  <label className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      className="mt-0.5 size-4 accent-red-600"
                      checked={borrarPagos.includes(x.id)}
                      onChange={(e) => setBorrarPagos((b) => (e.target.checked ? [...b, x.id] : b.filter((y) => y !== x.id)))}
                    />
                    <span>
                      Borrar también <b>{x.nombre}</b>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </section>
        )}
        {plan.quedan.length > 0 && (
          <section className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
            <h3 className="font-semibold">Quedan como los dejaste</h3>
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              {plan.quedan.map((q) => (
                <li key={q.nombre}>
                  <b>{q.nombre}</b>: {q.motivo}
                </li>
              ))}
            </ul>
          </section>
        )}
        {plan.reconstruida && <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">Se armó con lo que se creó junto: se borra lo que creó. Si cambió montos de un mes, revisalos a mano.</p>}
      </div>
    </Modal>
  );
}
