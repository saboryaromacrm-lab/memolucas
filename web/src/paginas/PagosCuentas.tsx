import { useState } from "react";
import { HandCoins, Pencil, Plus, Trash2, UserRound } from "lucide-react";
import { ElegirForma } from "../componentes/FormasPago";
import { Boton, Cargando, MenuAcciones, Modal, Vacio, useAccion } from "../componentes/ui";
import { del, post, put } from "../lib/api";
import { ahora } from "../lib/fechas";
import { aCampo, aNumero, plata } from "../lib/numeros";
import { nombreMes } from "../lib/pagos";
import type { ConfigPagos, CuentaPersona, FormaPago } from "../lib/tipos";
import { useDatos } from "../lib/vivo";

/** Saldo positivo: le debés; negativo: tenés a favor. */
function textoSaldo(saldo: number): [string, string] {
  if (saldo >= 0.5) return [`Le debés ${plata(saldo)}`, "text-red-600"];
  if (saldo <= -0.5) return [`Tenés ${plata(-saldo)} a favor`, "text-emerald-700"];
  return ["Están al día", "text-slate-500"];
}
const fecha = (iso: string) => iso.split("-").reverse().join("/");

/**
 * Cuentas con personas que pagan cosas por vos (la contadora, un socio…). Lo que pagan se marca en Este mes con
 * «Pagado» → «Lo pagó: …» (es el gasto, se cuenta una vez); lo que vos les pagás se anota acá con «Le pagué».
 */
export function PagosCuentas() {
  const { datos } = useDatos<CuentaPersona[]>("/api/pagos/cuentas", ["pagos"]);
  const config = useDatos<ConfigPagos>("/api/pagos/config", ["pagos", "tarjetas"]).datos;
  const [elegida, setElegida] = useState<number | null>(null);
  const [editando, setEditando] = useState<CuentaPersona | "nueva" | null>(null);
  const [pagando, setPagando] = useState<CuentaPersona | null>(null);
  const [desde, setDesde] = useState("");
  const [hasta, setHasta] = useState("");
  const accion = useAccion();
  if (!datos || !config) return <Cargando />;
  const cuenta = datos.find((c) => c.id === elegida) ?? datos[0];

  return (
    <div className="space-y-4">
      <p className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600">
        Cuando alguien paga algo tuyo, marcalo en <b>Este mes</b> con «Pagado» → <b>«Lo pagó: …»</b>. Lo que vos le pagás (transferencia, efectivo) se anota acá con <b>«Le pagué»</b>. El gasto se cuenta
        una sola vez: lo que le pagás a esa persona solo baja lo que le debés.
      </p>
      <div className="grid gap-4 lg:grid-cols-[17rem_1fr]">
        <section className="tarjeta self-start overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3">
            <h2 className="text-sm font-semibold text-slate-800">Personas</h2>
            <Boton chico icono={<Plus className="size-3.5" />} onClick={() => setEditando("nueva")}>
              Persona
            </Boton>
          </div>
          <ul className="border-t border-slate-100">
            {datos.map((c) => {
              const [texto, color] = textoSaldo(c.saldo);
              return (
                <li key={c.id} className="border-t border-slate-100 first:border-t-0">
                  <button
                    onClick={() => setElegida(c.id)}
                    className={`flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm ${c.id === cuenta?.id ? "bg-marca-suave font-medium text-marca-profundo" : "text-slate-700 hover:bg-slate-50"}`}
                  >
                    <UserRound className="size-4 shrink-0 text-slate-400" />
                    <span className="min-w-0 flex-1 truncate">{c.nombre}</span>
                    <span className={`shrink-0 text-xs ${color}`}>{texto}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          {!datos.length && <p className="px-4 pb-3 text-sm text-slate-500">Agregá a quien paga cosas por vos: tu contadora, un socio…</p>}
        </section>

        {cuenta ? (
          <Detalle
            cuenta={cuenta}
            desde={desde}
            hasta={hasta}
            onFiltro={(d, h) => (setDesde(d), setHasta(h))}
            onPagar={() => setPagando(cuenta)}
            onEditar={() => setEditando(cuenta)}
            onBorrar={() => confirm(`¿Borrar la cuenta de ${cuenta.nombre}?`) && void accion(() => del(`/api/pagos/cuentas/${cuenta.id}`), "Cuenta borrada")}
            onBorrarMovimiento={(id) => confirm("¿Borrar este pago que le hiciste?") && void accion(() => del(`/api/pagos/cuentas/pagos/${id}`), "Borrado")}
          />
        ) : (
          <div className="tarjeta">
            <Vacio icono={<HandCoins className="size-10" />} titulo="Sin cuentas todavía" texto="Agregá a la persona que paga cosas por vos para llevar lo que le debés." />
          </div>
        )}
      </div>
      {editando && <ModalPersona cuenta={editando === "nueva" ? null : editando} onCerrar={() => setEditando(null)} onCreada={setElegida} />}
      {pagando && <ModalLePague cuenta={pagando} formas={config.formas} onCerrar={() => setPagando(null)} />}
    </div>
  );
}

function Detalle({
  cuenta,
  desde,
  hasta,
  onFiltro,
  onPagar,
  onEditar,
  onBorrar,
  onBorrarMovimiento,
}: {
  cuenta: CuentaPersona;
  desde: string;
  hasta: string;
  onFiltro: (desde: string, hasta: string) => void;
  onPagar: () => void;
  onEditar: () => void;
  onBorrar: () => void;
  onBorrarMovimiento: (id: number) => void;
}) {
  const [texto, color] = textoSaldo(cuenta.saldo);
  // El saldo después de cada movimiento (del más viejo al más nuevo, arrancando del saldo inicial).
  let corrido = cuenta.saldoInicial;
  const conSaldo = [...cuenta.movimientos].reverse().map((m) => ({ ...m, saldo: (corrido += m.tipo === "pago" ? m.monto : -m.monto) })).reverse();
  const visibles = conSaldo.filter((m) => (!desde || m.fecha.slice(0, 7) >= desde) && (!hasta || m.fecha.slice(0, 7) <= hasta));

  return (
    <section className="tarjeta overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-4">
        <div>
          <h2 className="text-base font-semibold text-slate-900">{cuenta.nombre}</h2>
          <div className={`text-xl font-semibold tracking-tight ${color}`}>{texto}</div>
        </div>
        <div className="flex items-center gap-2">
          <Boton variante="primario" icono={<HandCoins className="size-4" />} onClick={onPagar}>
            Le pagué
          </Boton>
          <MenuAcciones
            etiqueta={`Acciones de ${cuenta.nombre}`}
            acciones={[
              { texto: "Nombre o saldo inicial", icono: <Pencil />, onClick: onEditar },
              { texto: "Borrar la cuenta", icono: <Trash2 />, peligro: true, onClick: onBorrar },
            ]}
          />
        </div>
      </div>
      <div className="flex flex-wrap items-end gap-2 border-t border-slate-100 px-4 py-3">
        <label className="block">
          <span className="etiqueta">Desde</span>
          <input className="campo h-9 py-0" type="month" value={desde} onChange={(e) => onFiltro(e.target.value, hasta)} />
        </label>
        <label className="block">
          <span className="etiqueta">Hasta</span>
          <input className="campo h-9 py-0" type="month" value={hasta} onChange={(e) => onFiltro(desde, e.target.value)} />
        </label>
        {(desde || hasta) && (
          <Boton chico variante="fantasma" onClick={() => onFiltro("", "")}>
            Ver todo
          </Boton>
        )}
      </div>
      <ul className="divide-y divide-slate-100 border-t border-slate-100">
        {visibles.map((m) => (
          <li key={m.tipo === "pago" ? `p${m.pagoId}${m.fecha}${m.monto}` : `l${m.id}`} className="grid grid-cols-[1fr_auto_2.5rem] items-center gap-x-3 gap-y-0.5 px-4 py-2.5 text-sm sm:grid-cols-[5.5rem_1fr_9rem_9rem_2.5rem]">
            <span className="text-xs text-slate-500 sm:text-sm">{fecha(m.fecha)}</span>
            <span className="col-start-1 min-w-0 sm:col-start-2">
              {m.tipo === "pago" ? (
                <>
                  <span className="font-medium text-slate-900">Pagó {m.detalle}</span>
                  <span className="block text-xs text-slate-500">{nombreMes(m.periodo)}</span>
                </>
              ) : (
                <>
                  <span className="font-medium text-slate-900">Le pagaste</span>
                  <span className="block text-xs text-slate-500">{[m.forma, m.nota].filter(Boolean).join(" · ") || "—"}</span>
                </>
              )}
            </span>
            <span className={`col-start-2 row-span-2 row-start-1 text-right font-semibold tabular-nums sm:col-start-3 sm:row-span-1 ${m.tipo === "pago" ? "text-red-600" : "text-emerald-700"}`}>
              {m.tipo === "pago" ? "+" : "−"} {plata(m.monto)}
            </span>
            <span className="hidden text-right text-xs tabular-nums text-slate-500 sm:block">Saldo {plata(m.saldo)}</span>
            <span className="col-start-3 row-span-2 row-start-1 sm:col-start-auto sm:row-span-1 sm:row-start-auto">
              {m.tipo === "lePagaste" && <MenuAcciones etiqueta="Acciones" acciones={[{ texto: "Borrar", icono: <Trash2 />, peligro: true, onClick: () => onBorrarMovimiento(m.id) }]} />}
            </span>
          </li>
        ))}
        {!desde && (
          <li className="flex items-center justify-between px-4 py-2.5 text-sm text-slate-500">
            <span>Saldo inicial</span>
            <span className="tabular-nums">{plata(cuenta.saldoInicial)}</span>
          </li>
        )}
        {!visibles.length && desde && <li className="px-4 py-6 text-center text-sm text-slate-500">Sin movimientos en esas fechas.</li>}
      </ul>
      <p className="border-t border-slate-100 px-4 py-2 text-xs text-slate-500">
        <span className="text-red-600">+</span> lo que pagó por vos (suma a lo que le debés) · <span className="text-emerald-700">−</span> lo que le pagaste (resta)
      </p>
    </section>
  );
}

function ModalPersona({ cuenta, onCerrar, onCreada }: { cuenta: CuentaPersona | null; onCerrar: () => void; onCreada: (id: number) => void }) {
  const [nombre, setNombre] = useState(cuenta?.nombre ?? "");
  const [sentido, setSentido] = useState<"debo" | "favor">(cuenta && cuenta.saldoInicial < 0 ? "favor" : "debo");
  const [monto, setMonto] = useState(cuenta ? aCampo(Math.abs(cuenta.saldoInicial), true) : "");
  const accion = useAccion();
  const guardar = async () => {
    const n = aNumero(monto) ?? 0;
    const cuerpo = { nombre, saldoInicial: sentido === "favor" ? -n : n };
    if (cuenta) {
      if (await accion(() => put(`/api/pagos/cuentas/${cuenta.id}`, cuerpo), "Guardado")) onCerrar();
      return;
    }
    const nueva = await accion(() => post<{ id: number }>("/api/pagos/cuentas", cuerpo), "Cuenta creada");
    if (nueva) (onCreada(nueva.id), onCerrar());
  };
  return (
    <Modal
      abierto
      onCerrar={onCerrar}
      titulo={cuenta ? `Editar ${cuenta.nombre}` : "Nueva cuenta"}
      ancho="max-w-md"
      pie={
        <>
          <Boton onClick={onCerrar}>Cancelar</Boton>
          <Boton variante="primario" disabled={!nombre.trim()} onClick={() => void guardar()}>
            Guardar
          </Boton>
        </>
      }
    >
      <div className="space-y-3">
        <label className="block">
          <span className="etiqueta">Quién</span>
          <input className="campo" autoFocus placeholder="Contadora, Juan (socio)…" value={nombre} onChange={(e) => setNombre(e.target.value)} />
          <span className="mt-1 block text-xs text-slate-500">En «Pagado» aparece como «Lo pagó: {nombre.trim() || "…"}».</span>
        </label>
        <div>
          <span className="etiqueta">Saldo al empezar (opcional)</span>
          <div className="grid grid-cols-[auto_1fr] gap-2">
            <select className="campo w-auto" value={sentido} onChange={(e) => setSentido(e.target.value as "debo" | "favor")} aria-label="Le debo o tengo a favor">
              <option value="debo">Le debo</option>
              <option value="favor">Tengo a favor</option>
            </select>
            <input className="campo" inputMode="decimal" placeholder="0,00" value={monto} onChange={(e) => setMonto(e.target.value)} aria-label="Monto del saldo inicial" />
          </div>
        </div>
      </div>
    </Modal>
  );
}

/** «Le pagué»: cuánto, cuándo y con qué (transferencia, efectivo…). Una parte o más de lo que le debés. */
function ModalLePague({ cuenta, formas, onCerrar }: { cuenta: CuentaPersona; formas: FormaPago[]; onCerrar: () => void }) {
  const hoy = ahora().toISODate()!;
  const ayer = ahora().minus({ days: 1 }).toISODate()!;
  const [monto, setMonto] = useState(cuenta.saldo > 0 ? aCampo(cuenta.saldo, true) : "");
  const [dia, setDia] = useState(hoy);
  const [formaId, setFormaId] = useState<number | null>(null);
  const [nota, setNota] = useState("");
  const accion = useAccion();
  const n = aNumero(monto);
  const listo = n !== null && n > 0 && formaId !== null && !!dia;
  const guardar = async () => {
    if (listo && (await accion(() => post(`/api/pagos/cuentas/${cuenta.id}/pagos`, { monto: n, fecha: dia, formaId, nota }), `Anotado: le pagaste ${plata(n)} a ${cuenta.nombre}`))) onCerrar();
  };
  const atajo = (valor: string, texto: string) => (
    <button type="button" onClick={() => setDia(valor)} className={`h-9 rounded-full border px-3 text-sm ${dia === valor ? "border-marca-oscuro bg-marca-oscuro text-white" : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"}`}>
      {texto}
    </button>
  );
  return (
    <Modal
      abierto
      onCerrar={onCerrar}
      titulo={`Le pagué a ${cuenta.nombre}`}
      ancho="max-w-md"
      pie={
        <>
          <Boton onClick={onCerrar}>Cancelar</Boton>
          <Boton variante="primario" disabled={!listo} onClick={() => void guardar()}>
            Guardar
          </Boton>
        </>
      }
    >
      <div className="space-y-4">
        <label className="block">
          <span className="etiqueta">¿Cuánto?</span>
          <input className="campo" inputMode="decimal" autoFocus value={monto} onChange={(e) => setMonto(e.target.value)} />
          <span className="mt-1 block text-xs text-slate-500">{textoSaldo(cuenta.saldo)[0]}. Puede ser una parte o más (queda a favor).</span>
        </label>
        <div>
          <span className="etiqueta">¿Cuándo?</span>
          <div className="flex flex-wrap items-center gap-2">
            {atajo(hoy, "Hoy")}
            {atajo(ayer, "Ayer")}
            <input className="campo w-auto flex-1" type="date" value={dia} max={hoy} onChange={(e) => setDia(e.target.value)} aria-label="Fecha" />
          </div>
        </div>
        <div>
          <span className="etiqueta">¿Con qué le pagaste?</span>
          <ElegirForma formas={formas.filter((f) => f.tipo !== "tercero")} valor={formaId} onCambio={setFormaId} />
        </div>
        <label className="block">
          <span className="etiqueta">Nota</span>
          <input className="campo" placeholder="Opcional («a cuenta de noviembre»…)" value={nota} onChange={(e) => setNota(e.target.value)} />
        </label>
      </div>
    </Modal>
  );
}
