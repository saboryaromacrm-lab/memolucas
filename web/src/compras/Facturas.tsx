import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, CheckCircle2, FileText, Loader2, Pencil, Search, Trash2 } from "lucide-react";
import { useAccion, useAviso } from "../componentes/ui";
import { post } from "../lib/api";
import type { Compra, ComprobanteDatos } from "../lib/tipos";
import { Cargador, EstadoCola, TarjetaLectura, type Lectura } from "./Cargador";
import { atajosBloqueados, fechaCorta, Hoja, plata, useVivo, type Ancho } from "./comun";
import { Correccion } from "./Correccion";
import { Visor } from "./Visor";

type Detalle = Compra & { datos: ComprobanteDatos };
type Filtro = "abiertas" | "confirmado" | "todas";
type Envio = { ok: boolean; mensaje: string } | null;

const ESTADOS: Record<Compra["estado"], [string, string]> = {
  pendiente: ["A confirmar", "bg-sky-50 text-sky-700"],
  revisar: ["A revisar", "bg-amber-100 text-amber-800"],
  confirmado: ["Confirmada", "bg-emerald-50 text-emerald-700"],
  descartado: ["Descartada", "bg-stone-100 text-stone-500"],
};
const abiertaSegunEstado = (c: Pick<Compra, "estado">) => c.estado === "pendiente" || c.estado === "revisar";
/** Solo las que cierran se pueden confirmar de a varias; las otras conviene mirarlas una por una. */
const confirmableEnLote = (c: Compra) => c.estado === "pendiente" && c.cierra;

function Estado({ c }: { c: Compra }) {
  return <span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium ${ESTADOS[c.estado][1]}`}>{ESTADOS[c.estado][0]}</span>;
}
function Cierra({ c }: { c: Compra }) {
  return (
    <span className={`flex items-center justify-end gap-1 text-xs ${c.cierra ? "text-emerald-700" : "text-amber-700"}`}>
      {c.cierra ? <CheckCircle2 className="size-3.5" /> : <AlertTriangle className="size-3.5" />}
      {c.cierra ? "Cierra" : "No cierra"}
    </span>
  );
}

export function Facturas({ ancho }: { ancho: Ancho }) {
  const { datos, recargar } = useVivo<{ lecturas: Lectura[]; compras: Compra[] }>("/api/c/compras");
  const [filtro, setFiltro] = useState<Filtro>("abiertas");
  const [q, setQ] = useState("");
  const [abierta, setAbierta] = useState<number | null>(null);
  const [elegidas, setElegidas] = useState<Set<number>>(new Set());
  const [confirmando, setConfirmando] = useState(false);
  const accion = useAccion();
  const avisar = useAviso();
  const pc = ancho === "pc";

  const lista = useMemo(() => {
    const buscado = q.trim().toLowerCase();
    return (datos?.compras ?? []).filter(
      (c) =>
        (filtro === "abiertas" ? abiertaSegunEstado(c) : filtro === "confirmado" ? c.estado === "confirmado" : true) &&
        (!buscado || `${c.proveedor} ${c.titulo} ${c.autor ?? ""}`.toLowerCase().includes(buscado)),
    );
  }, [datos, filtro, q]);
  const cantidadAbiertas = (datos?.compras ?? []).filter(abiertaSegunEstado).length;
  const loteVisible = lista.filter(confirmableEnLote);
  const seleccion = loteVisible.filter((c) => elegidas.has(c.id)).map((c) => c.id);

  /** Después de confirmar o descartar, en la compu pasa sola a la siguiente de la lista. */
  const siguiente = (id: number) => {
    const i = lista.findIndex((c) => c.id === id);
    const prox = lista[i + 1] ?? lista[i - 1];
    setAbierta(ancho !== "movil" && prox && prox.id !== id ? prox.id : null);
    void recargar();
  };
  const avisarEnvio = (envio: Envio, n = 1) => {
    const texto = n === 1 ? "Confirmada" : `${n} confirmadas`;
    if (envio && !envio.ok) avisar(`${texto}, pero no se pudo mandar al ERP: ${envio.mensaje}`, "error");
    else avisar(`${texto}${envio?.ok ? " y enviada" + (n === 1 ? "" : "s") + " al ERP" : ""} ✅`);
  };
  const confirmar = async (id: number) => {
    const r = await accion(() => post<{ envio: Envio }>(`/api/c/compras/${id}/confirmar`));
    if (!r) return;
    avisarEnvio(r.envio);
    siguiente(id);
  };
  const descartar = async (id: number) => {
    if (!confirm("¿Descartar esta factura?")) return;
    if (await accion(() => post(`/api/c/compras/${id}/descartar`), "Descartada")) siguiente(id);
  };
  const confirmarElegidas = async () => {
    setConfirmando(true);
    let fallaErp: Envio = null;
    let hechas = 0;
    for (const id of seleccion) {
      const r = await accion(() => post<{ envio: Envio }>(`/api/c/compras/${id}/confirmar`));
      if (!r) continue;
      hechas++;
      if (r.envio && !r.envio.ok) fallaErp = r.envio;
    }
    setConfirmando(false);
    setElegidas(new Set());
    if (hechas) avisarEnvio(fallaErp ?? { ok: true, mensaje: "" }, hechas);
    void recargar();
  };

  // Atajos en la compu y la tablet: ↑ ↓ para pasar de factura y Ctrl+Enter para confirmar la abierta.
  const estado = useRef({ lista, abierta, confirmar });
  estado.current = { lista, abierta, confirmar };
  useEffect(() => {
    if (ancho === "movil") return;
    const tecla = (e: KeyboardEvent) => {
      if (atajosBloqueados(e)) return;
      const { lista, abierta, confirmar } = estado.current;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const i = lista.findIndex((c) => c.id === abierta);
        const prox = lista[e.key === "ArrowDown" ? i + 1 : Math.max(0, i - 1)] ?? lista[i];
        if (prox) setAbierta(prox.id);
      } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && abierta) {
        const c = lista.find((x) => x.id === abierta);
        if (c && abiertaSegunEstado(c)) {
          e.preventDefault();
          void confirmar(abierta);
        }
      }
    };
    window.addEventListener("keydown", tecla);
    return () => window.removeEventListener("keydown", tecla);
  }, [ancho]);
  // La fila abierta siempre a la vista.
  useEffect(() => {
    if (abierta) document.querySelector(`[data-factura="${abierta}"]`)?.scrollIntoView({ block: "nearest" });
  }, [abierta]);

  const filtros = (
    <div className="flex flex-wrap gap-1.5">
      {(
        [
          ["abiertas", `Para revisar${cantidadAbiertas ? ` (${cantidadAbiertas})` : ""}`],
          ["confirmado", "Confirmadas"],
          ["todas", "Todas"],
        ] as const
      ).map(([v, t]) => (
        <button
          key={v}
          onClick={() => setFiltro(v)}
          className={`rounded-full px-3.5 py-1.5 text-sm font-medium transition ${filtro === v ? "bg-cafe text-beige" : "border border-stone-300 bg-white text-stone-600 hover:border-stone-400"}`}
        >
          {t}
        </button>
      ))}
    </div>
  );
  const vacio = (
    <p className="px-4 py-10 text-center text-sm text-stone-500">
      {q ? "No hay facturas con esa búsqueda." : filtro === "abiertas" ? "No hay facturas para revisar 🙌" : "Todavía no hay facturas acá."}
    </p>
  );
  const cargando = (
    <div className="flex justify-center py-10">
      <Loader2 className="size-6 animate-spin text-naranja" />
    </div>
  );
  const arriba = (
    <>
      <Cargador ancho={ancho} />
      <EstadoCola />
      {datos?.lecturas.map((l) => (
        <TarjetaLectura key={l.id} l={l} />
      ))}
    </>
  );
  const detalle = abierta && (
    <DetalleFactura key={abierta} id={abierta} ancho={ancho} onCerrar={() => setAbierta(null)} onConfirmar={confirmar} onDescartar={descartar} onCambio={recargar} />
  );

  // ───── Celular: tarjetas y el detalle a pantalla completa ─────
  if (ancho === "movil")
    return (
      <div className="space-y-4">
        {arriba}
        {filtros}
        {!datos ? (
          cargando
        ) : !lista.length ? (
          <div className="tarjeta">{vacio}</div>
        ) : (
          <div className="space-y-2">
            {lista.map((c) => (
              <button key={c.id} onClick={() => setAbierta(c.id)} className="tarjeta flex w-full items-center gap-3 px-4 py-3 text-left active:bg-stone-50">
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-semibold text-stone-800">{c.proveedor || "Proveedor sin datos"}</span>
                  <span className="block truncate text-xs text-stone-500">
                    {c.titulo} · {fechaCorta(c.fecha)}
                    {c.autor && ` · ${c.autor}`}
                  </span>
                  <span className="mt-1 block">
                    <Estado c={c} />
                  </span>
                </span>
                <span className="shrink-0 text-right">
                  <span className="block font-semibold tabular-nums text-stone-800">{plata(c.total, c.moneda)}</span>
                  <Cierra c={c} />
                </span>
              </button>
            ))}
          </div>
        )}
        {detalle}
      </div>
    );

  // ───── Compu y tablet: tabla; el detalle al costado (compu) o encima (tablet) ─────
  const tabla = (
    <section className="tarjeta flex min-h-0 flex-col overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 border-b border-stone-100 px-4 py-3">
        {filtros}
        <div className="relative ml-auto w-full max-w-64">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-stone-400" />
          <input className="campo py-2 pl-9 text-sm" placeholder="Buscar proveedor o número…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      {seleccion.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 border-b border-orange-100 bg-orange-50 px-4 py-2 text-sm">
          <span className="font-medium text-stone-700">
            {seleccion.length} {seleccion.length === 1 ? "elegida" : "elegidas"}
          </span>
          <button
            onClick={() => void confirmarElegidas()}
            disabled={confirmando}
            className="flex items-center gap-1.5 rounded-lg bg-cafe px-3 py-1.5 font-semibold text-beige hover:bg-marca-profundo disabled:opacity-60"
          >
            {confirmando ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4 text-naranja" />} Confirmar {seleccion.length}
          </button>
          <button onClick={() => setElegidas(new Set())} className="text-stone-500 hover:text-stone-800">
            Limpiar
          </button>
        </div>
      )}
      <div className="@container min-h-0 flex-1 overflow-y-auto">
        {!datos ? (
          cargando
        ) : !lista.length ? (
          vacio
        ) : (
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10 bg-stone-50 text-left text-xs font-semibold uppercase tracking-wide text-stone-500 shadow-[0_1px_0_#e7e5e4]">
              <tr>
                <th className="w-10 py-2.5 pl-4">
                  {loteVisible.length > 0 && (
                    <input
                      type="checkbox"
                      aria-label="Elegir todas las que cierran"
                      title="Elegir todas las que cierran"
                      className="size-4 accent-cafe"
                      checked={seleccion.length === loteVisible.length}
                      onChange={(e) => setElegidas(new Set(e.target.checked ? loteVisible.map((c) => c.id) : []))}
                    />
                  )}
                </th>
                <th className="px-3 py-2.5">Proveedor</th>
                <th className="hidden px-3 py-2.5 @xl:table-cell">Fecha</th>
                <th className="hidden px-3 py-2.5 @4xl:table-cell">Cargó</th>
                <th className="hidden px-3 py-2.5 @lg:table-cell">Estado</th>
                <th className="py-2.5 pl-3 pr-4 text-right">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {lista.map((c) => (
                <tr
                  key={c.id}
                  data-factura={c.id}
                  onClick={() => setAbierta(c.id)}
                  className={`cursor-pointer ${abierta === c.id ? "bg-orange-50 shadow-[inset_3px_0_0_var(--color-naranja)]" : "hover:bg-stone-50"}`}
                >
                  <td className="py-3 pl-4" onClick={(e) => e.stopPropagation()}>
                    {confirmableEnLote(c) && (
                      <input
                        type="checkbox"
                        aria-label="Elegir"
                        className="size-4 accent-cafe"
                        checked={elegidas.has(c.id)}
                        onChange={(e) =>
                          setElegidas((s) => {
                            const n = new Set(s);
                            if (e.target.checked) n.add(c.id);
                            else n.delete(c.id);
                            return n;
                          })
                        }
                      />
                    )}
                  </td>
                  <td className="max-w-0 px-3 py-3">
                    <div className="truncate font-medium text-stone-800">{c.proveedor || "Proveedor sin datos"}</div>
                    <div className="truncate text-xs text-stone-500">
                      {c.titulo}
                      <span className="@xl:hidden"> · {fechaCorta(c.fecha)}</span>
                    </div>
                  </td>
                  <td className="hidden whitespace-nowrap px-3 py-3 text-stone-600 @xl:table-cell">{fechaCorta(c.fecha)}</td>
                  <td className="hidden max-w-32 truncate px-3 py-3 text-stone-600 @4xl:table-cell">{c.autor ?? "—"}</td>
                  <td className="hidden px-3 py-3 @lg:table-cell">
                    <Estado c={c} />
                  </td>
                  <td className="py-3 pl-3 pr-4 text-right">
                    <div className="whitespace-nowrap font-semibold tabular-nums text-stone-800">{plata(c.total, c.moneda)}</div>
                    <Cierra c={c} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {pc && lista.length > 0 && (
        <div className="border-t border-stone-100 px-4 py-2 text-xs text-stone-400">
          <kbd className="rounded border border-stone-200 px-1">↑</kbd> <kbd className="rounded border border-stone-200 px-1">↓</kbd> para pasar de factura ·{" "}
          <kbd className="rounded border border-stone-200 px-1">Ctrl</kbd>+<kbd className="rounded border border-stone-200 px-1">Enter</kbd> confirma ·{" "}
          <kbd className="rounded border border-stone-200 px-1">Esc</kbd> cierra
        </div>
      )}
    </section>
  );

  if (!pc)
    return (
      <div className="space-y-4">
        {arriba}
        {tabla}
        {detalle}
      </div>
    );
  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      {arriba}
      <div className={`grid min-h-0 flex-1 gap-4 ${abierta ? "grid-cols-[minmax(0,5fr)_minmax(0,7fr)]" : "grid-cols-1"}`}>
        {tabla}
        {detalle}
      </div>
    </div>
  );
}

function DetalleFactura({
  id,
  ancho,
  onCerrar,
  onConfirmar,
  onDescartar,
  onCambio,
}: {
  id: number;
  ancho: Ancho;
  onCerrar: () => void;
  onConfirmar: (id: number) => Promise<void>;
  onDescartar: (id: number) => Promise<void>;
  onCambio: () => Promise<void>;
}) {
  const { datos: c, recargar } = useVivo<Detalle>(`/api/c/compras/${id}`);
  const [visor, setVisor] = useState<string | null>(null);
  const [corrigiendo, setCorrigiendo] = useState(false);
  const [ocupado, setOcupado] = useState(false);
  const abierta = c && abiertaSegunEstado(c);
  const hacer = async (fn: () => Promise<void>) => {
    setOcupado(true);
    await fn();
    setOcupado(false);
  };

  return (
    <Hoja
      ancho={ancho}
      onCerrar={onCerrar}
      titulo={c ? c.proveedor || "Proveedor sin datos" : "Factura"}
      subtitulo={c && `${c.titulo} · ${fechaCorta(c.fecha)}${c.autor ? ` · Cargó ${c.autor}` : ""}`}
      pie={
        abierta && (
          <div className="flex gap-2">
            <button
              aria-label="Descartar"
              title="Descartar"
              disabled={ocupado}
              onClick={() => void hacer(() => onDescartar(id))}
              className="rounded-2xl border border-red-200 px-4 text-red-600 hover:bg-red-50 md:rounded-xl"
            >
              <Trash2 className="size-5" />
            </button>
            <button
              onClick={() => setCorrigiendo(true)}
              disabled={ocupado}
              className="flex flex-1 items-center justify-center gap-2 rounded-2xl border border-stone-300 py-3.5 font-semibold text-stone-700 hover:bg-stone-50 md:rounded-xl md:py-2.5"
            >
              <Pencil className="size-4" /> Corregir
            </button>
            <button
              onClick={() => void hacer(() => onConfirmar(id))}
              disabled={ocupado}
              title={ancho === "movil" ? undefined : "Confirmar (Ctrl+Enter)"}
              className="flex flex-[1.4] items-center justify-center gap-2 rounded-2xl bg-cafe py-3.5 font-semibold text-beige hover:bg-marca-profundo disabled:opacity-60 md:rounded-xl md:py-2.5"
            >
              {ocupado ? <Loader2 className="size-5 animate-spin" /> : <Check className="size-5 text-naranja" />} Confirmar
              {ancho !== "movil" && <span className="hidden text-xs font-normal text-beige/60 lg:inline">Ctrl+Enter</span>}
            </button>
          </div>
        )
      }
    >
      {!c ? (
        <div className="flex justify-center py-16">
          <Loader2 className="size-6 animate-spin text-naranja" />
        </div>
      ) : (
        <div className="space-y-4 p-4 @xl:grid @xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] @xl:items-start @xl:gap-5 @xl:space-y-0">
          <div className="flex gap-2 overflow-x-auto @xl:sticky @xl:top-0 @xl:flex-col">
            {c.archivos.length ? (
              c.archivos.map((a, i) =>
                a.mime === "application/pdf" ? (
                  <a
                    key={a.url}
                    href={a.url}
                    target="_blank"
                    rel="noreferrer"
                    className="flex h-36 w-28 shrink-0 flex-col items-center justify-center gap-1 rounded-xl border border-stone-200 bg-white text-xs text-stone-600 hover:bg-stone-50 @xl:h-24 @xl:w-full"
                  >
                    <FileText className="size-8 text-red-500" /> Abrir PDF
                  </a>
                ) : (
                  <button key={a.url} onClick={() => setVisor(a.url)} title="Ampliar" className="group relative shrink-0 overflow-hidden rounded-xl border border-stone-200 bg-white">
                    <img src={a.url} alt={`Hoja ${i + 1}`} className="h-36 w-28 object-cover @xl:h-auto @xl:w-full @xl:object-contain" />
                    <span className="absolute inset-x-0 bottom-0 hidden bg-black/50 py-1 text-center text-xs text-white group-hover:block">Ampliar</span>
                  </button>
                ),
              )
            ) : (
              <p className="text-xs text-stone-500">{c.archivosBorrados ? "La foto ya se borró (se guarda unos días)." : "Sin foto."}</p>
            )}
          </div>

          <div className="@container space-y-4">
            <div className={`rounded-2xl border px-4 py-3 ${c.cierra ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-amber-200 bg-amber-50 text-amber-900"}`}>
              <div className="flex items-center gap-2 font-semibold">
                {c.cierra ? <CheckCircle2 className="size-5" /> : <AlertTriangle className="size-5" />}
                {c.cierra ? "Las cuentas cierran" : "Las cuentas no cierran"}
              </div>
              {!c.cierra && <p className="mt-1 text-sm">{c.diferencias}</p>}
            </div>
            {c.dudas.length > 0 && (
              <div className="tarjeta px-4 py-3 text-sm text-stone-700">
                <div className="mb-1 font-semibold">Dudas de la lectura</div>
                <ul className="list-disc space-y-0.5 pl-5">
                  {c.dudas.map((d) => (
                    <li key={d}>{d}</li>
                  ))}
                </ul>
              </div>
            )}
            <Resumen c={c} />
            {c.estado !== "pendiente" && c.estado !== "revisar" && (
              <p className="text-center text-sm text-stone-500">
                {ESTADOS[c.estado][0]}
                {c.enviadoEn ? " y enviada al ERP" : ""}.{c.envioError && !c.enviadoEn ? ` No se pudo mandar al ERP: ${c.envioError}` : ""}
              </p>
            )}
          </div>
        </div>
      )}
      {visor && <Visor url={visor} onCerrar={() => setVisor(null)} />}
      {corrigiendo && c && (
        <Correccion
          c={c}
          ancho={ancho}
          onCerrar={() => setCorrigiendo(false)}
          onListo={() => {
            setCorrigiendo(false);
            void recargar();
            void onCambio();
          }}
        />
      )}
    </Hoja>
  );
}

function Resumen({ c }: { c: Detalle }) {
  const d = c.datos;
  const m = String(d.encabezado.moneda || "PES");
  return (
    <>
      <section className="tarjeta grid grid-cols-2 gap-3 px-4 py-3 text-sm @lg:grid-cols-4">
        <Dato t="Comprobante" v={c.titulo} />
        <Dato t="Fecha" v={fechaCorta(String(d.encabezado.fecha))} />
        <Dato t="Proveedor" v={c.proveedor || "—"} />
        <Dato t="CUIT" v={String(d.encabezado.cuitEmisor || "—")} />
      </section>
      <section className="tarjeta divide-y divide-stone-100">
        {d.renglones.map((r, i) => (
          <div key={i} className={`flex gap-3 px-4 py-2.5 text-sm ${r.cierra ? "" : "bg-amber-50"}`}>
            <span className="w-5 shrink-0 text-xs text-stone-400">{i + 1}</span>
            <span className="min-w-0 flex-1">
              <span className="block text-stone-800">{r.descripcion}</span>
              <span className="block text-xs text-stone-500">
                {r.cantidad} {r.unidad} × {plata(r.precioUnitario, m)}
                {r.descuentos.length ? ` − ${r.descuentos.join("+")}%` : ""}
              </span>
            </span>
            <span className="shrink-0 text-right font-medium tabular-nums">
              {plata(r.importe, m)}
              {!r.cierra && <AlertTriangle className="ml-auto mt-0.5 size-3.5 text-amber-600" />}
            </span>
          </div>
        ))}
      </section>
      <section className="tarjeta space-y-1 px-4 py-3 text-sm">
        {d.pie.subtotal > 0 && <Linea t="Subtotal" v={plata(d.pie.subtotal, m)} />}
        {d.pie.bonificacionImporte > 0 && <Linea t="Bonificación" v={`− ${plata(d.pie.bonificacionImporte, m)}`} />}
        {d.pie.ivas.map((x) => (
          <Linea key={`iva${x.alicuota}`} t={`IVA ${x.alicuota}%`} v={plata(x.importe, m)} />
        ))}
        {d.pie.impuestosInternos > 0 && <Linea t="Impuestos internos" v={plata(d.pie.impuestosInternos, m)} />}
        {d.pie.percepciones.map((x) => (
          <Linea key={x.nombre} t={x.nombre} v={plata(x.importe, m)} />
        ))}
        {d.pie.otrosImpuestos > 0 && <Linea t="Otros impuestos" v={plata(d.pie.otrosImpuestos, m)} />}
        <div className="flex justify-between border-t border-stone-200 pt-1.5 text-base font-bold text-stone-900">
          <span>Total</span>
          <span className="tabular-nums">{plata(d.pie.total, m)}</span>
        </div>
      </section>
    </>
  );
}

const Dato = ({ t, v }: { t: string; v: string }) => (
  <div className="min-w-0">
    <div className="etiqueta">{t}</div>
    <div className="break-words text-stone-800">{v}</div>
  </div>
);
const Linea = ({ t, v }: { t: string; v: string }) => (
  <div className="flex justify-between text-stone-600">
    <span>{t}</span>
    <span className="tabular-nums">{v}</span>
  </div>
);
