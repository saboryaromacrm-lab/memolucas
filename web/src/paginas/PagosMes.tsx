import { useRef, useState, type ReactNode } from "react";
import { AlertTriangle, Ban, Check, FileText, Paperclip, Pencil, RotateCcw, Sparkles, Trash2, Undo2, Wallet } from "lucide-react";
import { Boton, Cargando, Deslizable, MenuAcciones, Modal, Vacio, useAccion } from "../componentes/ui";
import { api, del, post, put } from "../lib/api";
import { ahora } from "../lib/fechas";
import { aCampo, aNumero, plata } from "../lib/numeros";
import { diaMes, plataTotales } from "../lib/pagos";
import type { ConfigPagos, ItemPago, MesPagos } from "../lib/tipos";
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
  const config = useDatos<ConfigPagos>("/api/pagos/config", ["pagos"]).datos;
  const [filtro, setFiltro] = useState<Filtro>({ tipo: "todos" });
  const [pagando, setPagando] = useState<ItemPago | null>(null);
  const [editando, setEditando] = useState<ItemPago | null>(null);
  const [analizando, setAnalizando] = useState(false);
  const comprobante = useRef<HTMLInputElement>(null);
  const [paraComprobante, setParaComprobante] = useState<ItemPago | null>(null);
  const accion = useAccion();

  if (!datos) return <Cargando />;
  const pasa = (i: ItemPago) => filtro.tipo === "todos" || (filtro.tipo === "lugar" ? i.lugar === filtro.lugar : i.tipo === filtro.tipo);
  const items = datos.items.filter(pasa);
  const lugares = [...new Set(datos.items.map((i) => i.lugar))];
  const pagar = (i: ItemPago) => accion(() => post(`/api/pagos/${i.id}/pagar`, {}), `${i.nombre} · ${i.lugar}: pagado`);
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

      {(datos.alertas.length > 0 || datos.analisis || datos.items.length > 0) && (
        <section className="rounded-xl border border-teal-200 bg-gradient-to-br from-teal-50 to-white p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="flex items-center gap-1.5 text-sm font-semibold text-marca-profundo">
              <Sparkles className="size-4" /> Lo que ve la IA este mes
            </h2>
            {datos.items.length > 0 && (
              <Boton chico cargando={analizando} onClick={() => void analizar()} title="Usa la IA: cuesta unos centavos de dólar">
                {datos.analisis ? "Actualizar análisis" : "Pedir análisis"}
              </Boton>
            )}
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
            !datos.alertas.length && <p className="mt-1 text-sm text-slate-500">Todo en orden. El día 1 te llega por WhatsApp cómo cerró el mes.</p>
          )}
        </section>
      )}

      {datos.items.length > 0 && (
        <Deslizable className="gap-1.5">
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
                      onPagar={() => void pagar(i)}
                      acciones={[
                        i.estado !== "pagado" && i.estado !== "omitido" && { texto: "Pagar otro monto o en partes", icono: <Wallet />, onClick: () => setPagando(i) },
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
      {pagando && <ModalPagar i={pagando} medios={config?.medios ?? []} onCerrar={() => setPagando(null)} />}
      {editando && <ModalDelMes i={editando} onCerrar={() => setEditando(null)} />}
      {nuevo && config && <ModalSuelto config={config} periodo={periodo} onCerrar={onCerrarNuevo} />}
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

function Fila({ i, onPagar, acciones }: { i: ItemPago; onPagar: () => void; acciones: Parameters<typeof MenuAcciones>[0]["acciones"] }) {
  const etiqueta = i.boleta !== null ? "Boleta" : ETIQUETA_ORIGEN[i.origen];
  const pendiente = i.estado === "pendiente" || i.estado === "parcial";
  return (
    // Celular: nombre y monto arriba; fecha, lugar y el botón abajo. Compu: todo en una fila.
    <li className={`grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1.5 px-4 py-3 sm:grid-cols-[3.5rem_1fr_9rem_9rem_11.5rem] ${i.vencido ? "bg-red-50/60" : ""}`}>
      <div className={`hidden text-sm font-semibold sm:col-start-1 sm:row-start-1 sm:block ${i.vencido ? "text-red-600" : "text-slate-700"}`}>{diaMes(i.vence)}</div>
      <div className="min-w-0 sm:col-start-2 sm:row-start-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-medium text-slate-900">{i.nombre}</span>
          {etiqueta && <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${i.boleta !== null ? "bg-amber-100 text-amber-800" : "bg-sky-100 text-sky-800"}`}>{etiqueta}</span>}
          {i.comprobante && <Paperclip className="size-3.5 text-slate-400" aria-label="Con comprobante" />}
        </div>
        <div className="truncate text-xs text-slate-500">{[i.categoria, i.cuenta, i.nota].filter(Boolean).join(" · ")}</div>
      </div>
      <div className="text-right sm:col-start-4 sm:row-start-1">
        <div className="font-semibold tabular-nums text-slate-900">{plata(i.monto, i.moneda)}</div>
        <div className="text-[11px] text-slate-400">{i.estado === "parcial" ? `falta ${plata(i.falta, i.moneda)}` : i.boleta !== null ? "de la boleta" : ""}</div>
      </div>
      <div className="flex min-w-0 items-center gap-2 text-xs text-slate-500 sm:col-start-3 sm:row-start-1">
        <span className={`sm:hidden ${i.vencido ? "font-medium text-red-600" : ""}`}>{diaMes(i.vence)} ·</span>
        <span className={`truncate rounded-md px-2 py-0.5 ${i.tipo === "negocio" ? "bg-indigo-50 text-indigo-700" : "bg-slate-100 text-slate-600"}`}>{i.lugar}</span>
      </div>
      <div className="col-start-2 row-start-2 flex items-center justify-end gap-1 sm:col-start-5 sm:row-start-1">
        {pendiente ? (
          <Boton chico variante="primario" icono={<Check className="size-3.5" />} onClick={onPagar}>
            Pagado
          </Boton>
        ) : i.estado === "pagado" ? (
          <div className="text-right text-xs font-semibold text-marca-oscuro">
            ✓ Pagado{i.pagadoEn ? ` el ${diaMes(i.pagadoEn)}` : ""}
            {i.medio && <div className="font-normal text-slate-400">{i.medio}</div>}
          </div>
        ) : (
          <span className="text-xs text-slate-400">No va</span>
        )}
        <MenuAcciones etiqueta={`Acciones de ${i.nombre}`} acciones={acciones} />
      </div>
    </li>
  );
}

function ModalPagar({ i, medios, onCerrar }: { i: ItemPago; medios: string[]; onCerrar: () => void }) {
  const [monto, setMonto] = useState(aCampo(i.falta, true));
  const [fecha, setFecha] = useState(ahora().toISODate()!);
  const [medio, setMedio] = useState(i.medio);
  const accion = useAccion();
  const n = aNumero(monto);
  const guardar = async () => {
    if (n === null) return;
    if (await accion(() => post(`/api/pagos/${i.id}/pagar`, { monto: n, fecha, medio }), n + 0.5 < i.falta ? "Anotado: pagado en parte" : "Pagado")) onCerrar();
  };
  return (
    <Modal
      abierto
      onCerrar={onCerrar}
      titulo={`Pagar ${i.nombre} · ${i.lugar}`}
      ancho="max-w-md"
      pie={
        <>
          <Boton onClick={onCerrar}>Cancelar</Boton>
          <Boton variante="primario" disabled={n === null} onClick={() => void guardar()}>
            Guardar
          </Boton>
        </>
      }
    >
      <p className="mb-3 text-sm text-slate-500">
        Falta {plata(i.falta, i.moneda)}. Si pagás menos, queda <b>pagado en parte</b> y después sumás el resto.
      </p>
      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="etiqueta">Monto</span>
          <input className="campo" inputMode="decimal" autoFocus value={monto} onChange={(e) => setMonto(e.target.value)} />
        </label>
        <label className="block">
          <span className="etiqueta">Fecha</span>
          <input className="campo" type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} />
        </label>
        <label className="col-span-2 block">
          <span className="etiqueta">Cómo lo pagaste</span>
          <input className="campo" list="medios-pago" value={medio} onChange={(e) => setMedio(e.target.value)} placeholder="Transferencia, efectivo…" />
          <datalist id="medios-pago">
            {medios.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </label>
      </div>
    </Modal>
  );
}

function ModalDelMes({ i, onCerrar }: { i: ItemPago; onCerrar: () => void }) {
  const [monto, setMonto] = useState(aCampo(i.monto, true));
  const [vence, setVence] = useState(i.vence);
  const [nota, setNota] = useState(i.nota);
  const accion = useAccion();
  const n = aNumero(monto);
  const guardar = async () => {
    const cambios = { ...(n !== null && n !== i.monto ? { monto: n } : {}), ...(vence !== i.vence ? { vence } : {}), ...(nota !== i.nota ? { nota } : {}) };
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
          <span className="etiqueta">Vence</span>
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
  const [f, setF] = useState({ nombre: "", lugarId: "", categoria: "Otros", monto: "", moneda: "ARS", fecha: hoy.startsWith(periodo) ? hoy : `${periodo}-01`, medio: "", nota: "", pagado: true });
  const accion = useAccion();
  const campo = (k: keyof typeof f) => ({ value: String(f[k]), onChange: (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value }) });
  const n = aNumero(f.monto);
  const guardar = async () => {
    if (n === null) return;
    const ok = await accion(() => post("/api/pagos", { ...f, monto: n, lugarId: f.lugarId ? Number(f.lugarId) : null }), "Pago anotado");
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
          <Boton variante="primario" disabled={!f.nombre.trim() || n === null} onClick={() => void guardar()}>
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
          <span className="etiqueta">Lugar</span>
          <select className="campo" {...campo("lugarId")}>
            <option value="">Sin lugar</option>
            {config.lugares.map((l) => (
              <option key={l.id} value={l.id}>
                {l.nombre}
              </option>
            ))}
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
        <label className="block">
          <span className="etiqueta">Cómo lo pagaste</span>
          <input className="campo" list="medios-suelto" placeholder="Transferencia…" {...campo("medio")} />
          <datalist id="medios-suelto">
            {config.medios.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </label>
        <label className="col-span-2 flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" className="size-4 accent-marca-oscuro" checked={f.pagado} onChange={(e) => setF({ ...f, pagado: e.target.checked })} />
          Ya está pagado (si no, queda para pagar en esa fecha)
        </label>
      </div>
    </Modal>
  );
}
