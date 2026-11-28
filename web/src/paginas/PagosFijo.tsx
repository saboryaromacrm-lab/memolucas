import { useState } from "react";
import { ElegirForma } from "../componentes/FormasPago";
import { Boton, Interruptor, Modal, useAccion } from "../componentes/ui";
import { post, put } from "../lib/api";
import { aCampo, aNumero, plata } from "../lib/numeros";
import { diasDelMes, FRECUENCIAS_PAGO, nombreMes, periodoActual, soloMes, sumarMeses } from "../lib/pagos";
import type { AlcancePago, CategoriaPago, ConfigPagos, FijoPago, FijoPropuesto, FrecuenciaPago, LugarPago, Moneda, TipoLugar } from "../lib/tipos";

/** Elegido en «Un lugar»: un lugar nuevo (se crea al guardar). */
const NUEVO = "nuevo";
/** Elegido en «Categoría»: una nueva (se suma sola a la lista al guardar). */
const NUEVA = "__nueva";

/** Elegir la categoría de tu lista, o escribir una nueva (se suma sola a la lista al guardar). */
export function ElegirCategoria({ categorias, valor, onCambio }: { categorias: CategoriaPago[]; valor: string; onCambio: (categoria: string) => void }) {
  // Una que no está en la lista (la propuso la IA, por ejemplo) se muestra como nueva.
  const [nueva, setNueva] = useState(() => !!valor && !categorias.some((c) => c.nombre === valor));
  return (
    <>
      <select className="campo" value={nueva ? NUEVA : valor} onChange={(e) => (e.target.value === NUEVA ? (setNueva(true), onCambio("")) : (setNueva(false), onCambio(e.target.value)))} aria-label="Categoría">
        {categorias.map((c) => (
          <option key={c.id} value={c.nombre}>
            {c.nombre}
          </option>
        ))}
        <option value={NUEVA}>+ Nueva categoría…</option>
      </select>
      {nueva && <input className="campo mt-2" autoFocus placeholder="Nombre de la categoría nueva" value={valor} onChange={(e) => onCambio(e.target.value)} aria-label="Nombre de la categoría nueva" />}
    </>
  );
}

/**
 * El formulario de un pago fijo, con todos sus datos. Sin onPropuesta guarda en el servidor (nuevo o editado); con
 * onPropuesta es para revisar lo que propuso la IA: devuelve el pago armado y no guarda nada (el mes lo elige la
 * revisión, por eso no muestra «Desde»).
 */
/** «Lo de octubre se paga en noviembre (vence el 10/11).», con el mes pasado como ejemplo. */
function ejemploDePago(desfase: number, dia: number | null) {
  const corresponde = sumarMeses(periodoActual(), -1);
  const pago = sumarMeses(corresponde, desfase);
  const vence = dia && dia >= 1 && dia <= 31 ? ` (vence el ${Math.min(dia, diasDelMes(pago))}/${Number(pago.slice(5))})` : "";
  return `Lo de ${soloMes(corresponde)} se paga en ${soloMes(pago)}${vence}.`;
}

export function ModalFijo({
  fijo,
  inicial,
  lugarInicial,
  config,
  onCerrar,
  onPropuesta,
}: {
  fijo: FijoPago | null;
  /** Lo que propuso la IA (para revisarlo). */
  inicial?: FijoPropuesto;
  lugarInicial?: number;
  config: ConfigPagos;
  onCerrar: () => void;
  onPropuesta?: (f: FijoPropuesto) => void;
}) {
  const base: FijoPropuesto | FijoPago | null = fijo ?? inicial ?? null;
  const [f, setF] = useState({
    lugarId: inicial?.lugarNuevo ? NUEVO : String(base?.lugarId ?? lugarInicial ?? config.lugares[0]?.id ?? ""),
    nombre: base?.nombre ?? "",
    categoria: base?.categoria ?? config.categorias[0]?.nombre ?? "Otros",
    monto: aCampo(base?.monto ?? 0, true),
    variable: base?.variable ?? false,
    moneda: (base?.moneda ?? "ARS") as Moneda,
    dia: String(base?.dia ?? 10),
    /** De entrada sin vencimiento: muchos pagos no tienen fecha. */
    conVencimiento: base ? base.dia !== null : false,
    frecuencia: (base?.frecuencia ?? "mensual") as FrecuenciaPago,
    desde: fijo?.desde ?? periodoActual(),
    desfase: String(base?.desfase ?? 0),
    cuenta: base?.cuenta ?? "",
    aviso: base?.avisoDias === null || base?.avisoDias === undefined ? "" : String(base.avisoDias),
    nota: base?.nota ?? "",
  });
  const [lugarNuevo, setLugarNuevo] = useState<{ nombre: string; tipo: TipoLugar }>(inicial?.lugarNuevo ?? { nombre: "", tipo: "negocio" });
  const [formaId, setFormaId] = useState<number | null>(base?.formaId ?? null);
  const [alcance, setAlcance] = useState<AlcancePago>(base?.alcance ?? "lugar");
  const [tipoGeneral, setTipoGeneral] = useState<TipoLugar>(base?.tipo ?? "personal");
  // Entre qué lugares se reparte: lugarId → porcentaje escrito (solo con porcentajes).
  const [reparto, setReparto] = useState<Record<number, string>>(() => Object.fromEntries((base?.reparto ?? []).map((r) => [r.lugarId, r.porcentaje === null ? "" : aCampo(r.porcentaje)])));
  const [conPorcentajes, setConPorcentajes] = useState(!!base?.reparto?.length && base.reparto.every((r) => r.porcentaje !== null));
  const accion = useAccion();
  const campo = (k: keyof typeof f) => ({ value: String(f[k]), onChange: (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value }) });
  const monto = aNumero(f.monto) ?? 0;
  const elegidos = Object.keys(reparto).map(Number);
  const suma = elegidos.reduce((s, id) => s + (aNumero(reparto[id]) ?? 0), 0);
  const repartoValido = elegidos.length >= 2 && (!conPorcentajes || Math.abs(suma - 100) < 0.01);
  const valido = f.nombre.trim() && f.categoria.trim() && (!f.conVencimiento || (Number(f.dia) >= 1 && Number(f.dia) <= 31)) && (alcance === "lugar" ? !!f.lugarId && (f.lugarId !== NUEVO || !!lugarNuevo.nombre.trim()) : alcance === "repartido" ? repartoValido : true);
  const alternar = (id: number) => setReparto((r) => (id in r ? Object.fromEntries(Object.entries(r).filter(([k]) => Number(k) !== id)) : { ...r, [id]: "" }));
  const conLugarNuevo = alcance === "lugar" && f.lugarId === NUEVO;
  const guardar = async () => {
    const armado: FijoPropuesto = {
      alcance,
      lugarId: alcance === "lugar" && !conLugarNuevo ? Number(f.lugarId) : null,
      tipo: alcance === "general" ? tipoGeneral : null,
      reparto: alcance === "repartido" ? elegidos.map((id) => ({ lugarId: id, porcentaje: conPorcentajes ? (aNumero(reparto[id]) ?? 0) : null })) : null,
      nombre: f.nombre,
      categoria: f.categoria,
      monto,
      variable: f.variable,
      moneda: f.moneda,
      dia: f.conVencimiento ? Number(f.dia) : null,
      frecuencia: f.frecuencia,
      desfase: Number(f.desfase),
      formaId,
      cuenta: f.cuenta,
      avisoDias: f.aviso === "" ? null : Number(f.aviso),
      nota: f.nota,
      ...(conLugarNuevo ? { lugarNuevo: { nombre: lugarNuevo.nombre.trim(), tipo: lugarNuevo.tipo } } : {}),
      ...(inicial?.original ? { original: inicial.original } : {}),
    };
    if (onPropuesta) return (onPropuesta(armado), onCerrar());
    const ok = await accion(async () => {
      // El lugar nuevo se crea primero.
      const lugarId = conLugarNuevo ? (await post<LugarPago>("/api/pagos/lugares", armado.lugarNuevo)).id : armado.lugarId;
      const cuerpo = { ...armado, lugarId, desde: f.desde };
      return fijo ? put(`/api/pagos/fijos/${fijo.id}`, cuerpo) : post("/api/pagos/fijos", cuerpo);
    }, fijo ? "Guardado" : "Pago agregado");
    if (ok) onCerrar();
  };
  return (
    <Modal
      abierto
      onCerrar={onCerrar}
      titulo={onPropuesta ? (inicial ? `Revisar ${inicial.nombre}` : "Agregar un pago") : fijo ? `Editar ${fijo.nombre}` : "Nuevo pago"}
      ancho="max-w-lg"
      pie={
        <>
          <Boton onClick={onCerrar}>Cancelar</Boton>
          <Boton variante="primario" disabled={!valido} onClick={() => void guardar()}>
            Guardar
          </Boton>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <label className="col-span-2 block">
          <span className="etiqueta">Qué pagás</span>
          <input className="campo" autoFocus placeholder="Alquiler, luz, ABL, sueldos…" {...campo("nombre")} />
        </label>
        <div className="col-span-2">
          <span className="etiqueta">A qué corresponde</span>
          <div className="grid grid-cols-3 gap-1 rounded-lg bg-slate-100 p-1">
            {(
              [
                ["lugar", "Un lugar"],
                ["repartido", "Repartido"],
                ["general", "General"],
              ] as const
            ).map(([a, texto]) => (
              <button
                key={a}
                type="button"
                onClick={() => setAlcance(a)}
                className={`min-h-9 rounded-md text-sm font-medium ${alcance === a ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-800"}`}
              >
                {texto}
              </button>
            ))}
          </div>
          {alcance === "lugar" && (
            <>
              <select className="campo mt-2" {...campo("lugarId")} aria-label="Lugar">
                {config.lugares.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.nombre}
                  </option>
                ))}
                <option value={NUEVO}>+ Lugar nuevo…</option>
              </select>
              {conLugarNuevo && (
                <div className="mt-2 grid grid-cols-[1fr_auto] gap-2">
                  <input className="campo" placeholder="Nombre del lugar nuevo" value={lugarNuevo.nombre} onChange={(e) => setLugarNuevo({ ...lugarNuevo, nombre: e.target.value })} aria-label="Nombre del lugar nuevo" />
                  <select className="campo w-auto" value={lugarNuevo.tipo} onChange={(e) => setLugarNuevo({ ...lugarNuevo, tipo: e.target.value as TipoLugar })} aria-label="Tipo del lugar nuevo">
                    <option value="negocio">Negocio</option>
                    <option value="personal">Personal</option>
                  </select>
                </div>
              )}
            </>
          )}
          {alcance === "general" && (
            <div className="mt-2">
              <p className="mb-1.5 text-xs text-slate-500">Sin lugar físico (la tarjeta, la cuota del auto, el celular…). Igual cuenta como negocio o personal.</p>
              <select className="campo" value={tipoGeneral} onChange={(e) => setTipoGeneral(e.target.value as TipoLugar)} aria-label="De negocio o personal">
                <option value="personal">Personal</option>
                <option value="negocio">Del negocio</option>
              </select>
            </div>
          )}
          {alcance === "repartido" && (
            <div className="mt-2 space-y-2">
              <p className="text-xs text-slate-500">Se paga una vez, y cada lugar suma su parte en el resumen (el contador, el abogado…).</p>
              <div className="flex flex-wrap gap-2">
                <Boton chico type="button" onClick={() => setReparto(Object.fromEntries(config.lugares.filter((l) => l.tipo === "negocio").map((l) => [l.id, reparto[l.id] ?? ""])))}>
                  Todos los negocios
                </Boton>
                <label className="flex items-center gap-1.5 text-xs text-slate-600">
                  <input type="checkbox" className="size-4 accent-marca-oscuro" checked={conPorcentajes} onChange={(e) => setConPorcentajes(e.target.checked)} />
                  Con porcentajes (si no, partes iguales)
                </label>
              </div>
              <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
                {config.lugares.map((l) => (
                  <li key={l.id} className="flex items-center gap-2 px-3 py-1.5">
                    <label className="flex flex-1 items-center gap-2 text-sm text-slate-700">
                      <input type="checkbox" className="size-4 accent-marca-oscuro" checked={l.id in reparto} onChange={() => alternar(l.id)} />
                      {l.nombre}
                    </label>
                    {conPorcentajes && l.id in reparto && (
                      <span className="flex items-center gap-1 text-sm text-slate-500">
                        <input className="campo w-20 py-1 text-right" inputMode="decimal" value={reparto[l.id]} onChange={(e) => setReparto({ ...reparto, [l.id]: e.target.value })} aria-label={`Porcentaje de ${l.nombre}`} />%
                      </span>
                    )}
                  </li>
                ))}
              </ul>
              <p className={`text-xs ${repartoValido ? "text-slate-500" : "text-red-600"}`}>
                {elegidos.length < 2
                  ? "Elegí al menos 2 lugares."
                  : conPorcentajes
                    ? `Suma ${Math.round(suma * 100) / 100} %${Math.abs(suma - 100) < 0.01 ? "" : " (tiene que dar 100 %)"}`
                    : `${elegidos.length} lugares en partes iguales${monto ? `: ${plata(monto / elegidos.length, f.moneda)} cada uno` : ""}.`}
              </p>
            </div>
          )}
        </div>
        <div className="col-span-2">
          <span className="etiqueta">Categoría</span>
          <ElegirCategoria categorias={config.categorias} valor={f.categoria} onCambio={(categoria) => setF({ ...f, categoria })} />
        </div>
        <div className="col-span-2">
          <span className="etiqueta">Monto</span>
          <div className="grid grid-cols-2 gap-1 rounded-lg bg-slate-100 p-1" role="radiogroup" aria-label="Fijo o variable">
            {(
              [
                [false, "Fijo"],
                [true, "Variable"],
              ] as const
            ).map(([variable, texto]) => (
              <button
                key={texto}
                type="button"
                role="radio"
                aria-checked={f.variable === variable}
                onClick={() => setF({ ...f, variable })}
                className={`min-h-9 rounded-md text-sm font-medium ${f.variable === variable ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-800"}`}
              >
                {texto}
              </button>
            ))}
          </div>
          <span className="mt-1 block text-[11px] text-slate-500">
            {f.variable ? "Cambia mes a mes (luz, gas, agua): poné un monto aproximado; después sugiere el promedio de lo que pagaste." : "Siempre el mismo monto (alquiler, cuota, abono)."}
          </span>
        </div>
        <label className="block">
          <span className="etiqueta">{f.variable ? "Monto aproximado" : "Monto"}</span>
          <input className="campo" inputMode="decimal" placeholder="0,00" {...campo("monto")} />
        </label>
        <label className="block">
          <span className="etiqueta">Moneda</span>
          <select className="campo" {...campo("moneda")}>
            <option value="ARS">Pesos ($)</option>
            <option value="USD">Dólares (US$)</option>
          </select>
        </label>
        <div className="col-span-2">
          <Interruptor
            activo={f.conVencimiento}
            onChange={(v) => setF({ ...f, conVencimiento: v })}
            etiqueta="Tiene vencimiento"
            ayuda={f.conVencimiento ? "Te aviso antes y, si pasa la fecha sin pagarlo, queda como vencido." : "Sin fecha: aparece en el mes para pagar, sin avisos de vencimiento."}
          />
        </div>
        {f.conVencimiento && (
          <label className="block">
            <span className="etiqueta">Vence el día</span>
            <input className="campo" type="number" min={1} max={31} {...campo("dia")} />
          </label>
        )}
        <label className={f.conVencimiento ? "block" : "col-span-2 block"}>
          <span className="etiqueta">Cada cuánto</span>
          <select className="campo" {...campo("frecuencia")}>
            {Object.entries(FRECUENCIAS_PAGO).map(([v, t]) => (
              <option key={v} value={v}>
                {t}
              </option>
            ))}
          </select>
        </label>
        {!onPropuesta && (
          <label className="block">
            <span className="etiqueta">Primer mes al que corresponde</span>
            <input className="campo" type="month" {...campo("desde")} />
            <span className="mt-0.5 block text-[11px] text-slate-400">{nombreMes(f.desde || periodoActual())}</span>
          </label>
        )}
        <label className="col-span-2 block">
          <span className="etiqueta">¿Cuándo se paga?</span>
          <select className="campo" {...campo("desfase")}>
            <option value="0">El mismo mes al que corresponde</option>
            <option value="1">El mes siguiente (mes vencido)</option>
          </select>
          <span className="mt-0.5 block text-[11px] text-slate-400">{ejemploDePago(Number(f.desfase), f.conVencimiento ? Number(f.dia) : null)}</span>
        </label>
        <label className={onPropuesta ? "col-span-2 block" : "block"}>
          <span className="etiqueta">N.º de cliente o cuenta</span>
          <input className="campo" placeholder="Opcional" {...campo("cuenta")} />
        </label>
        <label className={f.conVencimiento ? "block" : "hidden"}>
          <span className="etiqueta">Aviso por WhatsApp</span>
          <select className="campo" {...campo("aviso")}>
            <option value="">Como en Configuración ({config.diasAviso} días antes)</option>
            <option value="0">Solo el día que vence</option>
            {[1, 2, 3, 5, 7, 10].map((d) => (
              <option key={d} value={d}>
                {d} {d === 1 ? "día" : "días"} antes
              </option>
            ))}
            <option value="-1">No avisar</option>
          </select>
        </label>
        <div className="col-span-2">
          <span className="etiqueta">Con qué lo pagás</span>
          <ElegirForma formas={config.formas} valor={formaId} onCambio={setFormaId} ninguna="Sin forma fija" />
          <span className="mt-1 block text-[11px] text-slate-400">Aparece marcada al tocar «Pagado». Sin forma fija, aparece la última que usaste.</span>
        </div>
        <label className="col-span-2 block">
          <span className="etiqueta">Nota</span>
          <input className="campo" placeholder="Opcional" {...campo("nota")} />
        </label>
      </div>
    </Modal>
  );
}
