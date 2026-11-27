import { useRef, useState, type ReactNode } from "react";
import { AlertTriangle, Ban, Check, CheckCircle2, FileText, Paperclip, Pencil, RotateCcw, Sparkles, Trash2, Undo2, Upload, Wallet } from "lucide-react";
import { archivoParaIa, CampoIa } from "../componentes/CampoIa";
import { ElegirForma } from "../componentes/FormasPago";
import { Boton, Cargando, Deslizable, MenuAcciones, Modal, Vacio, useAccion } from "../componentes/ui";
import { api, del, post, put } from "../lib/api";
import { ahora } from "../lib/fechas";
import { aCampo, aNumero, plata } from "../lib/numeros";
import { describirAlcance, diaMes, nombreMes, plataTotales } from "../lib/pagos";
import type { ConfigPagos, FijoPropuesto, FormaPago, ItemPago, MesPagos, PartePago, PropuestaMes } from "../lib/tipos";
import { useDatos } from "../lib/vivo";

type Filtro = { tipo: "todos" } | { tipo: "negocio" | "personal" } | { tipo: "lugar"; lugar: string };

const GRUPOS: { titulo: string; de: (i: ItemPago) => boolean; color?: string }[] = [
  { titulo: "Vencido", de: (i) => i.vencido, color: "text-red-600" },
  { titulo: "Por pagar", de: (i) => !i.vencido && (i.estado === "pendiente" || i.estado === "parcial") },
  { titulo: "Pagado", de: (i) => i.estado === "pagado" },
  { titulo: "No se paga este mes", de: (i) => i.estado === "omitido" },
];
const ETIQUETA_ORIGEN: Partial<Record<ItemPago["origen"], string>> = { suscripcion: "De Suscripciones", tarjeta: "De Tarjetas" };

export function PagosMes({ periodo, nuevo, onCerrarNuevo, onConfigurar }: { periodo: string; nuevo: boolean; onCerrarNuevo: () => void; onConfigurar: () => void }) {
  const { datos } = useDatos<MesPagos>(`/api/pagos/mes?periodo=${periodo}`, ["pagos", "suscripciones", "tarjetas"]);
  const config = useDatos<ConfigPagos>("/api/pagos/config", ["pagos", "tarjetas"]).datos;
  const [filtro, setFiltro] = useState<Filtro>({ tipo: "todos" });
  /** Con qué se pagó (solo lo pagado). */
  const [conForma, setConForma] = useState<number | null>(null);
  /** Marcar pagado o corregir un pago ya hecho. */
  const [pago, setPago] = useState<{ i: ItemPago; corregir: boolean } | null>(null);
  const [editando, setEditando] = useState<ItemPago | null>(null);
  const [analizando, setAnalizando] = useState(false);
  const [cargando, setCargando] = useState(false);
  const comprobante = useRef<HTMLInputElement>(null);
  const [paraComprobante, setParaComprobante] = useState<ItemPago | null>(null);
  const accion = useAccion();

  if (!datos) return <Cargando />;
  // Un repartido aparece en cada uno de sus lugares (con su parte) y en Negocio o Personal según sus partes.
  const pasa = (i: ItemPago) =>
    (filtro.tipo === "todos" || i.partes.some((p) => (filtro.tipo === "lugar" ? p.lugar === filtro.lugar : p.tipo === filtro.tipo))) &&
    (conForma === null || (i.pagado > 0 && i.formaId === conForma));
  const items = datos.items.filter(pasa);
  const lugares = [...new Set(datos.items.flatMap((i) => i.partes.map((p) => p.lugar)))];
  // Las formas con que ya se pagó algo este mes (para el filtro).
  const formasUsadas = [...new Map(datos.items.filter((i) => i.pagado > 0 && i.formaId && i.forma).map((i) => [i.formaId!, i.forma!])).entries()];
  const parteDe = (i: ItemPago) => (filtro.tipo === "lugar" && i.partes.length > 1 ? i.partes.find((p) => p.lugar === filtro.lugar) : undefined);
  const analizar = async () => {
    setAnalizando(true);
    await accion(() => post("/api/pagos/ia/analizar", { periodo }), "Listo el análisis");
    setAnalizando(false);
  };
  const subirComprobante = async (archivo: File | undefined) => {
    const i = paraComprobante;
    if (!archivo || !i) return;
    await accion(() => api(`/api/pagos/${i.id}/comprobante`, { metodo: "PUT", archivo }), "Comprobante guardado");
  };
  const t = datos.totales;
  const avance = t.total.ARS ? Math.min(100, (t.pagado.ARS / t.total.ARS) * 100) : 0;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Cifra titulo="Total del mes" valor={plataTotales(t.total)} detalle={`${t.cantidad} ${t.cantidad === 1 ? "pago" : "pagos"}`} />
        <Cifra titulo="Pagado" valor={plataTotales(t.pagado)} color="text-marca-oscuro">
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-200">
            <div className="h-full rounded-full bg-marca-oscuro" style={{ width: `${avance}%` }} />
          </div>
        </Cifra>
        <Cifra titulo="Falta pagar" valor={plataTotales(t.falta)} detalle={t.pendientes ? `${t.pendientes} ${t.pendientes === 1 ? "pago" : "pagos"}` : "Nada 🙌"} />
        <Cifra titulo="Vencidos" valor={String(t.vencidos)} color={t.vencidos ? "text-red-600" : undefined} detalle={t.vencidos ? "Mirá arriba de la lista" : "Ninguno"} />
      </div>

      <section className="rounded-xl border border-teal-200 bg-gradient-to-br from-teal-50 to-white p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-marca-profundo">
            <Sparkles className="size-4" /> Lo que ve la IA este mes
          </h2>
          <div className="flex flex-wrap gap-2">
            <Boton chico icono={<Upload className="size-3.5" />} onClick={() => setCargando(true)} title="Pegá una foto o un PDF (el resumen de la contadora) y carga los montos del mes">
              Cargar con IA
            </Boton>
            {datos.items.length > 0 && (
              <Boton chico cargando={analizando} onClick={() => void analizar()} title="Usa la IA: cuesta unos centavos de dólar">
                {datos.analisis ? "Actualizar análisis" : "Pedir análisis"}
              </Boton>
            )}
          </div>
        </div>
        {datos.alertas.length > 0 && (
          <ul className="mt-2 space-y-1 text-sm text-slate-700">
            {datos.alertas.map((a) => (
              <li key={a} className="flex gap-1.5">
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" /> {a}
              </li>
            ))}
          </ul>
        )}
        {datos.analisis ? (
          <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-slate-700">{datos.analisis.texto}</p>
        ) : (
          !datos.alertas.length && (
            <p className="mt-1 text-sm text-slate-500">
              {datos.items.length ? "Todo en orden. El día 1 te llega por WhatsApp cómo cerró el mes." : "Pegá el resumen de la contadora (foto o PDF) con «Cargar con IA» y se cargan los montos."}
            </p>
          )
        )}
        </section>

      {datos.items.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <Deslizable className="min-w-0 flex-1 gap-1.5">
            {[
              { f: { tipo: "todos" } as Filtro, texto: "Todos" },
              { f: { tipo: "negocio" } as Filtro, texto: "Negocio" },
              { f: { tipo: "personal" } as Filtro, texto: "Personal" },
              ...lugares.map((l) => ({ f: { tipo: "lugar", lugar: l } as Filtro, texto: l })),
            ].map(({ f, texto }) => {
              const activo = JSON.stringify(f) === JSON.stringify(filtro);
              return (
                <button
                  key={texto + f.tipo}
                  onClick={() => setFiltro(f)}
                  className={`h-9 shrink-0 rounded-full border px-3.5 text-sm ${activo ? "border-marca-oscuro bg-marca-oscuro text-white" : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"}`}
                >
                  {texto}
                </button>
              );
            })}
          </Deslizable>
          {formasUsadas.length > 0 && (
            <select className="campo h-9 w-auto py-0 text-sm" value={conForma ?? ""} onChange={(e) => setConForma(e.target.value ? Number(e.target.value) : null)} aria-label="Pagado con">
              <option value="">Pagado con: todas</option>
              {formasUsadas.map(([id, nombre]) => (
                <option key={id} value={id}>
                  Pagado con {nombre}
                </option>
              ))}
            </select>
          )}
        </div>
      )}

      {!datos.items.length ? (
        <div className="tarjeta">
          <Vacio
            icono={<Wallet className="size-10" />}
            titulo="Todavía no hay pagos este mes"
            texto="Cargá en Configuración lo que pagás siempre (alquiler, luz, impuestos, sueldos…) y la lista se arma sola cada mes."
            accion={
              <Boton variante="primario" onClick={onConfigurar}>
                Ir a Configuración
              </Boton>
            }
          />
        </div>
      ) : (
        <div className="tarjeta overflow-hidden">
          {GRUPOS.map((g) => {
            const delGrupo = items.filter(g.de);
            if (!delGrupo.length) return null;
            return (
              <div key={g.titulo}>
                <h3 className={`px-4 pb-1.5 pt-3 text-xs font-semibold uppercase tracking-wide ${g.color ?? "text-slate-500"}`}>{g.titulo}</h3>
                <ul className="divide-y divide-slate-100 border-t border-slate-100">
                  {delGrupo.map((i) => (
                    <Fila
                      key={i.id}
                      i={i}
                      parte={parteDe(i)}
                      onPagar={() => setPago({ i, corregir: false })}
                      acciones={[
                        (i.estado === "pagado" || i.estado === "parcial") && { texto: "Editar pago (forma, fecha o monto)", icono: <Wallet />, onClick: () => setPago({ i, corregir: true }) },
                        { texto: "Monto, vencimiento o nota del mes", icono: <Pencil />, onClick: () => setEditando(i) },
                        { texto: i.comprobante ? "Cambiar el comprobante" : "Adjuntar comprobante", icono: <Paperclip />, onClick: () => (setParaComprobante(i), comprobante.current?.click()) },
                        !!i.comprobante && { texto: "Ver comprobante", icono: <FileText />, onClick: () => void window.open(`/api/pagos/${i.id}/comprobante`, "_blank") },
                        !!i.comprobante && { texto: "Quitar comprobante", icono: <Trash2 />, onClick: () => void accion(() => del(`/api/pagos/${i.id}/comprobante`), "Comprobante quitado") },
                        (i.estado === "pagado" || i.estado === "parcial") && { texto: "Desmarcar el pago", icono: <Undo2 />, onClick: () => void accion(() => post(`/api/pagos/${i.id}/desmarcar`), "Desmarcado") },
                        i.estado === "omitido"
                          ? { texto: "Volver a la lista del mes", icono: <RotateCcw />, onClick: () => void accion(() => post(`/api/pagos/${i.id}/omitir`, { omitido: false })) }
                          : i.estado !== "pagado" && { texto: "No se paga este mes", icono: <Ban />, onClick: () => void accion(() => post(`/api/pagos/${i.id}/omitir`, { omitido: true })) },
                        i.origen === "suelto" && { texto: "Borrar", icono: <Trash2 />, peligro: true, onClick: () => confirm(`¿Borrar ${i.nombre}?`) && void accion(() => del(`/api/pagos/${i.id}`), "Pago borrado") },
                      ]}
                    />
                  ))}
                </ul>
              </div>
            );
          })}
          {!items.length && <p className="px-4 py-6 text-center text-sm text-slate-500">No hay pagos con ese filtro.</p>}
        </div>
      )}

      <input ref={comprobante} type="file" accept="image/*,application/pdf" hidden onChange={(e) => (void subirComprobante(e.target.files?.[0]), (e.target.value = ""))} />
      {pago && config && <ModalPago {...pago} formas={config.formas} onCerrar={() => setPago(null)} />}
      {editando && <ModalDelMes i={editando} onCerrar={() => setEditando(null)} />}
      {nuevo && config && <ModalSuelto config={config} periodo={periodo} onCerrar={onCerrarNuevo} />}
      {cargando && config && <ModalCargarMes periodo={periodo} config={config} onCerrar={() => setCargando(false)} />}
    </div>
  );
}

function Cifra({ titulo, valor, detalle, color, children }: { titulo: string; valor: string; detalle?: string; color?: string; children?: ReactNode }) {
  return (
    <div className="tarjeta p-4">
      <div className="text-xs font-medium text-slate-500">{titulo}</div>
      <div className={`mt-1 text-lg font-semibold tracking-tight sm:text-xl ${color ?? "text-slate-900"}`}>{valor}</div>
      {detalle && <div className="text-xs text-slate-400">{detalle}</div>}
      {children}
    </div>
  );
}

/** parte: con el filtro de un lugar, lo que le toca a ese lugar de un pago repartido. */
function Fila({ i, parte, onPagar, acciones }: { i: ItemPago; parte?: PartePago; onPagar: () => void; acciones: Parameters<typeof MenuAcciones>[0]["acciones"] }) {
  const etiqueta = i.boleta !== null ? "Boleta" : ETIQUETA_ORIGEN[i.origen];
  const pendiente = i.estado === "pendiente" || i.estado === "parcial";
  return (
    // Celular: nombre y monto arriba; fecha, lugar y el botón abajo. Compu: todo en una fila.
    <li className={`grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1.5 px-4 py-3 sm:grid-cols-[3.5rem_1fr_9rem_9rem_11.5rem] ${i.vencido ? "bg-red-50/60" : ""}`}>
      <div className={`hidden text-sm font-semibold sm:col-start-1 sm:row-start-1 sm:block ${i.vencido ? "text-red-600" : i.vence ? "text-slate-700" : "text-slate-400"}`}>{i.vence ? diaMes(i.vence) : "Sin vto."}</div>
      <div className="min-w-0 sm:col-start-2 sm:row-start-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-medium text-slate-900">{i.nombre}</span>
          {etiqueta && <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${i.boleta !== null ? "bg-amber-100 text-amber-800" : "bg-sky-100 text-sky-800"}`}>{etiqueta}</span>}
          {i.comprobante && <Paperclip className="size-3.5 text-slate-400" aria-label="Con comprobante" />}
        </div>
        <div className="truncate text-xs text-slate-500">{[i.categoria, i.cuenta, i.nota].filter(Boolean).join(" · ")}</div>
      </div>
      <div className="text-right sm:col-start-4 sm:row-start-1">
        <div className="font-semibold tabular-nums text-slate-900">{plata(parte?.monto ?? i.monto, i.moneda)}</div>
        <div className="text-[11px] text-slate-400">
          {parte ? `de ${plata(i.monto, i.moneda)}` : i.estado === "parcial" ? `falta ${plata(i.falta, i.moneda)}` : i.boleta !== null ? "de la boleta" : ""}
        </div>
      </div>
      <div className="flex min-w-0 items-center gap-2 text-xs text-slate-500 sm:col-start-3 sm:row-start-1">
        <span className={`sm:hidden ${i.vencido ? "font-medium text-red-600" : ""}`}>{i.vence ? diaMes(i.vence) : "Sin vto."} ·</span>
        <span
          title={i.partes.length > 1 ? i.partes.map((p) => `${p.lugar}: ${plata(p.monto, i.moneda)}`).join(" · ") : undefined}
          className={`truncate rounded-md px-2 py-0.5 ${i.alcance === "repartido" ? "bg-amber-50 text-amber-800" : i.tipo === "negocio" ? "bg-indigo-50 text-indigo-700" : "bg-slate-100 text-slate-600"}`}
        >
          {i.alcance === "general" ? `General · ${i.tipo}` : i.lugar}
        </span>
      </div>
      <div className="col-start-2 row-start-2 flex items-center justify-end gap-1 sm:col-start-5 sm:row-start-1">
        {pendiente ? (
          <Boton chico variante="primario" icono={<Check className="size-3.5" />} onClick={onPagar}>
            Pagado
          </Boton>
        ) : i.estado === "pagado" ? (
          <div className="text-right text-xs font-semibold text-marca-oscuro">
            ✓ Pagado{i.pagadoEn ? ` el ${diaMes(i.pagadoEn)}` : ""}
            {i.forma && <div className="font-normal text-slate-400">{i.forma}</div>}
          </div>
        ) : (
          <span className="text-xs text-slate-400">No va</span>
        )}
        <MenuAcciones etiqueta={`Acciones de ${i.nombre}`} acciones={acciones} />
      </div>
    </li>
  );
}

/**
 * Marcar pagado: con qué (la de siempre o la última, ya marcada), cuándo (hoy, se puede cambiar) y cuánto (lo que
 * falta; con menos queda en parte). corregir: un pago ya hecho, sin desmarcarlo (cambia la última parte).
 */
function ModalPago({ i, corregir, formas, onCerrar }: { i: ItemPago; corregir: boolean; formas: FormaPago[]; onCerrar: () => void }) {
  const hoy = ahora().toISODate()!;
  const ayer = ahora().minus({ days: 1 }).toISODate()!;
  const ultima = i.pagos.at(-1);
  const [formaId, setFormaId] = useState(i.formaId && formas.some((f) => f.id === i.formaId && (corregir || !f.archivada)) ? i.formaId : null);
  const [fecha, setFecha] = useState(corregir ? (ultima?.fecha ?? hoy) : hoy);
  const [monto, setMonto] = useState(aCampo(corregir ? (ultima?.monto ?? i.pagado) : i.falta, true));
  const accion = useAccion();
  const n = aNumero(monto);
  const listo = n !== null && n > 0 && formaId !== null && !!fecha;
  const guardar = async () => {
    if (!listo) return;
    const ok = corregir
      ? await accion(() => put(`/api/pagos/${i.id}/pago`, { monto: n, fecha, formaId }), "Pago corregido")
      : await accion(() => post(`/api/pagos/${i.id}/pagar`, { monto: n, fecha, formaId }), n + 0.5 < i.falta ? "Anotado: pagado en parte" : `${i.nombre} · ${i.lugar}: pagado`);
    if (ok) onCerrar();
  };
  const atajo = (valor: string, texto: string) => (
    <button type="button" onClick={() => setFecha(valor)} className={`h-9 rounded-full border px-3 text-sm ${fecha === valor ? "border-marca-oscuro bg-marca-oscuro text-white" : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"}`}>
      {texto}
    </button>
  );
  return (
    <Modal
      abierto
      onCerrar={onCerrar}
      titulo={`${corregir ? "Editar el pago de" : "Pagar"} ${i.nombre} · ${i.lugar}`}
      ancho="max-w-md"
      pie={
        <>
          <Boton onClick={onCerrar}>Cancelar</Boton>
          <Boton variante="primario" disabled={!listo} onClick={() => void guardar()}>
            {corregir ? "Guardar" : "Confirmar"}
          </Boton>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <span className="etiqueta">¿Con qué pagaste?</span>
          <ElegirForma formas={formas} valor={formaId} onCambio={setFormaId} />
        </div>
        <div>
          <span className="etiqueta">¿Cuándo?</span>
          <div className="flex flex-wrap items-center gap-2">
            {atajo(hoy, "Hoy")}
            {atajo(ayer, "Ayer")}
            <input className="campo w-auto flex-1" type="date" value={fecha} max={hoy} onChange={(e) => setFecha(e.target.value)} aria-label="Fecha del pago" />
          </div>
        </div>
        <label className="block">
          <span className="etiqueta">¿Cuánto?</span>
          <input className="campo" inputMode="decimal" value={monto} onChange={(e) => setMonto(e.target.value)} />
          <span className="mt-1 block text-xs text-slate-500">
            {corregir
              ? i.pagos.length > 1
                ? `Se pagó en ${i.pagos.length} partes: esto corrige la última.`
                : `Del total de ${plata(i.monto, i.moneda)}.`
              : `Falta ${plata(i.falta, i.moneda)}. Si pagás menos, queda pagado en parte y después sumás el resto.`}
          </span>
        </label>
      </div>
    </Modal>
  );
}

function ModalDelMes({ i, onCerrar }: { i: ItemPago; onCerrar: () => void }) {
  const [monto, setMonto] = useState(aCampo(i.monto, true));
  const [vence, setVence] = useState(i.vence ?? "");
  const [nota, setNota] = useState(i.nota);
  const accion = useAccion();
  const n = aNumero(monto);
  const guardar = async () => {
    const cambios = { ...(n !== null && n !== i.monto ? { monto: n } : {}), ...(vence !== (i.vence ?? "") ? { vence: vence || null } : {}), ...(nota !== i.nota ? { nota } : {}) };
    if (await accion(() => put(`/api/pagos/${i.id}`, cambios), "Guardado")) onCerrar();
  };
  return (
    <Modal
      abierto
      onCerrar={onCerrar}
      titulo={`${i.nombre} · ${i.lugar}`}
      ancho="max-w-md"
      pie={
        <>
          <Boton onClick={onCerrar}>Cancelar</Boton>
          <Boton variante="primario" onClick={() => void guardar()}>
            Guardar
          </Boton>
        </>
      }
    >
      <p className="mb-3 text-sm text-slate-500">Solo para este mes (por ejemplo, lo que vino en la boleta). Lo de todos los meses se cambia en Configuración.</p>
      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="etiqueta">Monto de este mes</span>
          <input className="campo" inputMode="decimal" value={monto} onChange={(e) => setMonto(e.target.value)} />
        </label>
        <label className="block">
          <span className="etiqueta">Vence (opcional)</span>
          <input className="campo" type="date" value={vence} onChange={(e) => setVence(e.target.value)} />
        </label>
        <label className="col-span-2 block">
          <span className="etiqueta">Nota</span>
          <input className="campo" value={nota} onChange={(e) => setNota(e.target.value)} placeholder="Opcional" />
        </label>
      </div>
    </Modal>
  );
}

function ModalSuelto({ config, periodo, onCerrar }: { config: ConfigPagos; periodo: string; onCerrar: () => void }) {
  const hoy = ahora().toISODate()!;
  const [f, setF] = useState({ nombre: "", lugarId: "general-personal", categoria: "Otros", monto: "", moneda: "ARS", fecha: hoy.startsWith(periodo) ? hoy : `${periodo}-01`, nota: "", pagado: true });
  const [formaId, setFormaId] = useState<number | null>(null);
  const accion = useAccion();
  const campo = (k: keyof typeof f) => ({ value: String(f[k]), onChange: (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value }) });
  const n = aNumero(f.monto);
  const guardar = async () => {
    if (n === null) return;
    // "general-personal" / "general-negocio": sin lugar físico.
    const general = f.lugarId.startsWith("general-");
    const ok = await accion(
      () => post("/api/pagos", { ...f, monto: n, formaId, lugarId: general ? null : Number(f.lugarId), tipo: general ? f.lugarId.slice(8) : undefined }),
      "Pago anotado",
    );
    if (ok) onCerrar();
  };
  return (
    <Modal
      abierto
      onCerrar={onCerrar}
      titulo="Anotar un pago"
      ancho="max-w-lg"
      pie={
        <>
          <Boton onClick={onCerrar}>Cancelar</Boton>
          <Boton variante="primario" disabled={!f.nombre.trim() || n === null || (f.pagado && formaId === null)} onClick={() => void guardar()}>
            Guardar
          </Boton>
        </>
      }
    >
      <p className="mb-3 text-sm text-slate-500">Para algo que no pagás siempre (un arreglo, una multa, una compra). Lo de todos los meses se carga en Configuración.</p>
      <div className="grid grid-cols-2 gap-3">
        <label className="col-span-2 block">
          <span className="etiqueta">Qué pagaste</span>
          <input className="campo" autoFocus placeholder="Arreglo de la heladera" {...campo("nombre")} />
        </label>
        <label className="block">
          <span className="etiqueta">A qué corresponde</span>
          <select className="campo" {...campo("lugarId")}>
            {config.lugares.map((l) => (
              <option key={l.id} value={l.id}>
                {l.nombre}
              </option>
            ))}
            <option value="general-personal">General · personal</option>
            <option value="general-negocio">General · negocio</option>
          </select>
        </label>
        <label className="block">
          <span className="etiqueta">Categoría</span>
          <input className="campo" list="categorias-pago" {...campo("categoria")} />
          <datalist id="categorias-pago">
            {config.categorias.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </label>
        <label className="block">
          <span className="etiqueta">Monto</span>
          <input className="campo" inputMode="decimal" placeholder="0,00" {...campo("monto")} />
        </label>
        <label className="block">
          <span className="etiqueta">Moneda</span>
          <select className="campo" {...campo("moneda")}>
            <option value="ARS">Pesos ($)</option>
            <option value="USD">Dólares (US$)</option>
          </select>
        </label>
        <label className="block">
          <span className="etiqueta">Fecha</span>
          <input className="campo" type="date" {...campo("fecha")} />
        </label>
        <label className="col-span-2 flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" className="size-4 accent-marca-oscuro" checked={f.pagado} onChange={(e) => setF({ ...f, pagado: e.target.checked })} />
          Ya está pagado (si no, queda para pagar en esa fecha)
        </label>
        <div className="col-span-2">
          <span className="etiqueta">{f.pagado ? "¿Con qué pagaste?" : "¿Con qué lo vas a pagar? (opcional)"}</span>
          <ElegirForma formas={config.formas} valor={formaId} onCambio={setFormaId} ninguna={f.pagado ? undefined : "Todavía no sé"} />
        </div>
      </div>
    </Modal>
  );
}

/** Cada cosa que leyó la IA, con su casilla. */
type ItemMes = ({ tipo: "cambio"; cambio: PropuestaMes["cambios"][number] } | { tipo: "nuevo"; fijo: FijoPropuesto }) & { elegido: boolean };

/**
 * Cargar con IA: una foto, un PDF o un texto (el resumen de impuestos de la contadora) y la IA pone cada monto en el
 * pago del mes; lo que no estaba lo propone como pago fijo nuevo. Se revisa todo antes de aplicar.
 */
function ModalCargarMes({ periodo, config, onCerrar }: { periodo: string; config: ConfigPagos; onCerrar: () => void }) {
  const [texto, setTexto] = useState("");
  const [archivo, setArchivo] = useState<File | null>(null);
  const [leyendo, setLeyendo] = useState(false);
  const [leido, setLeido] = useState<{ items: ItemMes[]; iguales: number; control: PropuestaMes["control"]; mensaje: string } | null>(null);
  const accion = useAccion();
  const leer = async () => {
    setLeyendo(true);
    const r = await accion(async () => post<PropuestaMes>("/api/pagos/ia/mes", { periodo, texto, archivo: archivo ? await archivoParaIa(archivo) : undefined }));
    setLeyendo(false);
    if (r)
      setLeido({
        items: [...r.cambios.map((cambio) => ({ tipo: "cambio" as const, cambio, elegido: true })), ...r.nuevos.map((fijo) => ({ tipo: "nuevo" as const, fijo, elegido: true }))],
        iguales: r.iguales,
        control: r.control,
        mensaje: r.mensaje,
      });
  };
  const elegidos = leido?.items.filter((i) => i.elegido) ?? [];
  const aplicar = async () => {
    const montos = elegidos.flatMap((i) => (i.tipo === "cambio" ? [{ id: i.cambio.id, monto: i.cambio.monto }] : []));
    const nuevos = elegidos.flatMap((i) => (i.tipo === "nuevo" ? [i.fijo] : []));
    if (await accion(() => post("/api/pagos/mes/aplicar", { periodo, montos, nuevos }), `Listo: ${elegidos.length} ${elegidos.length === 1 ? "pago cargado" : "pagos cargados"} en ${nombreMes(periodo).toLowerCase()}`)) onCerrar();
  };
  const marcar = (k: number, elegido: boolean) => leido && setLeido({ ...leido, items: leido.items.map((x, j) => (j === k ? { ...x, elegido } : x)) });
  const todos = (elegido: boolean) => leido && setLeido({ ...leido, items: leido.items.map((x) => ({ ...x, elegido })) });
  const coincide = leido?.control && Math.abs(leido.control.suma - leido.control.total) < 1;

  return (
    <Modal
      abierto
      onCerrar={onCerrar}
      titulo={`Cargar con IA · ${nombreMes(periodo)}`}
      ancho="max-w-3xl"
      pie={
        <>
          <Boton onClick={leido ? () => setLeido(null) : onCerrar}>{leido ? "Volver" : "Cancelar"}</Boton>
          {leido ? (
            <Boton variante="primario" disabled={!elegidos.length} onClick={() => void aplicar()}>
              Aplicar {elegidos.length}
            </Boton>
          ) : (
            <Boton variante="primario" icono={<Sparkles className="size-4" />} cargando={leyendo} disabled={texto.trim().length < 3 && !archivo} onClick={() => void leer()}>
              Leer con IA
            </Boton>
          )}
        </>
      }
    >
      {!leido ? (
        <>
          <p className="mb-3 text-sm text-slate-500">
            Pegá o elegí la foto o el PDF (por ejemplo, el resumen de impuestos de la contadora), o escribí los montos. Cada monto va al pago de {nombreMes(periodo).toLowerCase()}; lo que no
            tengas cargado se propone como pago nuevo. Revisás todo antes de guardar (cuesta unos centavos).
          </p>
          <CampoIa texto={texto} onTexto={setTexto} archivo={archivo} onArchivo={setArchivo} placeholder="Opcional: algo que la IA tenga que saber («es lo de octubre», «el IVA diferido va a Fontana»…)" />
        </>
      ) : (
        <div className="space-y-3">
          {leido.control &&
            (coincide ? (
              <p className="flex items-center gap-1.5 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
                <CheckCircle2 className="size-4 shrink-0" /> La suma da {plata(leido.control.total)}, igual que el total: no falta nada.
              </p>
            ) : (
              <p className="flex items-center gap-1.5 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
                <AlertTriangle className="size-4 shrink-0" /> La suma da {plata(leido.control.suma)} y el total dice {plata(leido.control.total)}: revisá que no falte o sobre nada.
              </p>
            ))}
          {leido.mensaje && <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">{leido.mensaje}</p>}
          {leido.items.length > 0 && (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm text-slate-500">
                  Destildá lo que no va.{leido.iguales > 0 && ` ${leido.iguales} ya ${leido.iguales === 1 ? "tenía" : "tenían"} ese monto.`}
                </p>
                <div className="flex gap-1">
                  <Boton variante="fantasma" chico onClick={() => todos(true)}>
                    Elegir todos
                  </Boton>
                  <Boton variante="fantasma" chico onClick={() => todos(false)}>
                    Ninguno
                  </Boton>
                </div>
              </div>
              <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
                {leido.items.map((it, k) => (
                  <li key={k} className="flex items-start gap-3 px-3 py-2.5 text-sm">
                    <input type="checkbox" className="mt-1 size-4 accent-marca-oscuro" checked={it.elegido} onChange={(e) => marcar(k, e.target.checked)} aria-label={it.tipo === "cambio" ? it.cambio.nombre : it.fijo.nombre} />
                    {it.tipo === "cambio" ? (
                      <div className="min-w-0 flex-1">
                        <div className="font-medium text-slate-900">
                          <span className="mr-1.5 rounded bg-sky-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-sky-800">Monto</span>
                          {it.cambio.nombre} · {it.cambio.lugar}
                          {it.cambio.pagado && <span className="ml-1.5 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-amber-800">Ya pagado</span>}
                        </div>
                        <div className="text-xs text-slate-500">
                          <span className="text-slate-400 line-through">{plata(it.cambio.antes)}</span> → <span className="font-medium text-slate-800">{plata(it.cambio.monto)}</span>
                        </div>
                      </div>
                    ) : (
                      <div className="min-w-0 flex-1">
                        <div className="font-medium text-slate-900">
                          <span className="mr-1.5 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-emerald-800">Nuevo</span>
                          {it.fijo.nombre} · {it.fijo.lugarNuevo ? it.fijo.lugarNuevo.nombre : describirAlcance(it.fijo, config.lugares)}
                          {it.fijo.lugarNuevo && <span className="ml-1.5 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-amber-800">Lugar nuevo</span>}
                        </div>
                        <div className="text-xs text-slate-500">
                          {[it.fijo.categoria, plata(it.fijo.monto, it.fijo.moneda), it.fijo.variable ? "variable" : "fijo", it.fijo.dia ? `vence el ${it.fijo.dia}` : "sin vencimiento", "todos los meses desde este"].join(" · ")}
                        </div>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}
