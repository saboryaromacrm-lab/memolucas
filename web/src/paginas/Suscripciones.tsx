import { useState } from "react";
import { CreditCard, ExternalLink, Pencil, Plus, RefreshCw, Repeat, Trash2 } from "lucide-react";
import { Boton, Cargando, Encabezado, MenuAcciones, Modal, Vacio, useAccion } from "../componentes/ui";
import { del, post, put } from "../lib/api";
import { ahora } from "../lib/fechas";
import { aCampo, aNumero, plata } from "../lib/numeros";
import { FRECUENCIAS, useSuscripciones } from "../lib/suscripciones";
import { colorVencimiento, diasParaVencer, textoDias } from "../lib/vencimientos";
import type { FrecuenciaSuscripcion, Suscripcion, Tarjeta } from "../lib/tipos";
import { useDatos } from "../lib/vivo";

const fechaLarga = (iso: string) => iso.split("-").reverse().join("/");
const nombreTarjeta = (t: Pick<Tarjeta, "nombre" | "ultimos4">) => `${t.nombre}${t.ultimos4 ? ` ···${t.ultimos4}` : ""}`;

/** Las tarjetas, para elegir con cuál se paga cada suscripción. */
const useTarjetas = () => useDatos<{ tarjetas: Tarjeta[] }>("/api/tarjetas", ["tarjetas"]).datos?.tarjetas ?? [];

export function Suscripciones() {
  const { datos } = useSuscripciones();
  const tarjetas = useTarjetas();
  const [editando, setEditando] = useState<Suscripcion | "nueva" | null>(null);
  const accion = useAccion();
  const pagarCon = (s: Suscripcion, tarjetaId: number) => accion(() => put(`/api/suscripciones/${s.id}/tarjeta`, { tarjetaId }), `${s.nombre}: suma al próximo resumen`);

  const renovar = (s: Suscripcion) => accion(() => post<Suscripcion>(`/api/suscripciones/${s.id}/renovar`), `${s.nombre}: renovada`);
  const borrar = (s: Suscripcion) => confirm(`¿Borrar ${s.nombre}?`) && accion(() => del(`/api/suscripciones/${s.id}`), "Suscripción borrada");

  return (
    <div>
      <Encabezado
        titulo="Suscripciones"
        subtitulo={datos && `El bot te avisa por WhatsApp ${datos.diasAviso ? `${datos.diasAviso} ${datos.diasAviso === 1 ? "día" : "días"} antes y ` : ""}el día que vence.`}
        acciones={
          <Boton variante="primario" icono={<Plus className="size-4" />} onClick={() => setEditando("nueva")}>
            Nueva suscripción
          </Boton>
        }
      />
      {!datos ? (
        <Cargando />
      ) : !datos.suscripciones.length ? (
        <div className="tarjeta">
          <Vacio icono={<Repeat className="size-10" />} titulo="Todavía no tenés suscripciones" texto="Cargá Netflix, el hosting, los dominios… y te aviso antes de que venzan." />
        </div>
      ) : (
        <div className="tarjeta divide-y divide-slate-100">
          {datos.suscripciones.map((s) => {
            const dias = diasParaVencer(s.fechaVto);
            const tarjeta = tarjetas.find((t) => t.id === s.tarjetaId);
            const sugerencia = datos.sugerencias[s.id];
            return (
              // Celular: nombre y botones arriba, vencimiento y monto abajo. Compu: todo en una fila.
              <div key={s.id} className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1.5 px-4 py-3 sm:flex sm:gap-4">
                <div className="min-w-0 sm:flex-1">
                  <div className="flex items-center gap-2">
                    <span className="line-clamp-2 break-words font-medium text-slate-900">{s.nombre}</span>
                    {s.url && (
                      <a href={s.url} target="_blank" rel="noreferrer" className="inline-flex shrink-0 items-center gap-0.5 text-xs font-medium text-marca-oscuro hover:underline">
                        Abrir <ExternalLink className="size-3" />
                      </a>
                    )}
                  </div>
                  <div className="truncate text-xs text-slate-500">
                    {FRECUENCIAS[s.frecuencia]}
                    {tarjeta && (
                      <>
                        {" · "}
                        <CreditCard className="inline size-3 align-[-2px]" /> {nombreTarjeta(tarjeta)}
                      </>
                    )}
                    {s.observacion && ` · ${s.observacion}`}
                  </div>
                  {sugerencia && (
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-600">
                      <span>
                        ¿Se paga con la <b className="font-medium">{sugerencia.tarjeta}</b>? En el resumen figura como {sugerencia.comoAparece}.
                      </span>
                      <button className="rounded-full bg-marca-suave px-3.5 py-2 font-medium text-marca-profundo" onClick={() => void pagarCon(s, sugerencia.tarjetaId)}>
                        Sí
                      </button>
                      <button className="rounded-full border border-slate-200 px-3.5 py-2 font-medium text-slate-600" onClick={() => setEditando(s)}>
                        Elegir otra
                      </button>
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 justify-end sm:order-last">
                  <MenuAcciones
                    etiqueta={`Acciones de ${s.nombre}`}
                    acciones={[
                      { texto: "Renovar (suma un período)", icono: <RefreshCw />, onClick: () => void renovar(s) },
                      { texto: "Editar", icono: <Pencil />, onClick: () => setEditando(s) },
                      { texto: "Borrar", icono: <Trash2 />, peligro: true, onClick: () => void borrar(s) },
                    ]}
                  />
                </div>
                <div className="flex items-center gap-2 text-sm sm:block sm:w-44 sm:text-right">
                  <div className="tabular-nums text-slate-800">{fechaLarga(s.fechaVto)}</div>
                  <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-medium ${colorVencimiento(dias, datos.diasAviso)}`}>{textoDias(dias)}</span>
                </div>
                <div className="text-right font-semibold tabular-nums text-slate-900 sm:w-32">{plata(s.monto, s.moneda)}</div>
              </div>
            );
          })}
        </div>
      )}
      {editando && <FormSuscripcion s={editando === "nueva" ? null : editando} onCerrar={() => setEditando(null)} />}
    </div>
  );
}

function FormSuscripcion({ s, onCerrar }: { s: Suscripcion | null; onCerrar: () => void }) {
  const tarjetas = useTarjetas();
  const [f, setF] = useState({
    /** "" sin definir, "otro" otro medio, o el id de la tarjeta. */
    pago: s?.tarjetaId ? String(s.tarjetaId) : s?.sinTarjeta ? "otro" : "",
    nombre: s?.nombre ?? "",
    url: s?.url ?? "",
    fechaInicio: s?.fechaInicio ?? "",
    fechaVto: s?.fechaVto ?? ahora().plus({ months: 1 }).toISODate()!,
    monto: s ? aCampo(s.monto) : "",
    moneda: s?.moneda ?? "ARS",
    frecuencia: s?.frecuencia ?? ("mensual" as FrecuenciaSuscripcion),
    observacion: s?.observacion ?? "",
  });
  const [guardando, setGuardando] = useState(false);
  const accion = useAccion();
  const campo = (k: keyof typeof f) => ({ value: f[k], onChange: (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value }) });

  const guardar = async () => {
    setGuardando(true);
    const { pago, ...resto } = f;
    const datos = {
      ...resto,
      url: f.url.trim(),
      fechaInicio: f.fechaInicio || null,
      monto: aNumero(f.monto) ?? 0,
      tarjetaId: pago && pago !== "otro" ? Number(pago) : null,
      sinTarjeta: pago === "otro",
    };
    const ok = await accion(() => (s ? put(`/api/suscripciones/${s.id}`, datos) : post("/api/suscripciones", datos)), s ? "Suscripción guardada" : "Suscripción creada");
    setGuardando(false);
    if (ok) onCerrar();
  };

  return (
    <Modal
      abierto
      onCerrar={onCerrar}
      titulo={s ? "Editar suscripción" : "Nueva suscripción"}
      ancho="max-w-lg"
      pie={
        <>
          <Boton onClick={onCerrar}>Cancelar</Boton>
          <Boton variante="primario" cargando={guardando} disabled={!f.nombre.trim() || !f.fechaVto} onClick={() => void guardar()}>
            Guardar
          </Boton>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <label className="col-span-2 block">
          <span className="etiqueta">Nombre</span>
          <input className="campo" placeholder="Netflix, hosting, dominio…" autoFocus {...campo("nombre")} />
        </label>
        <label className="col-span-2 block">
          <span className="etiqueta">Dirección (opcional)</span>
          <input className="campo" type="url" placeholder="https://…" {...campo("url")} />
        </label>
        <label className="block">
          <span className="etiqueta">Inicio (opcional)</span>
          <input className="campo" type="date" {...campo("fechaInicio")} />
        </label>
        <label className="block">
          <span className="etiqueta">Vencimiento</span>
          <input className="campo" type="date" {...campo("fechaVto")} />
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
        <label className="col-span-2 block">
          <span className="etiqueta">Frecuencia</span>
          <select className="campo" {...campo("frecuencia")}>
            {Object.entries(FRECUENCIAS).map(([v, t]) => (
              <option key={v} value={v}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label className="col-span-2 block">
          <span className="etiqueta">Se paga con</span>
          <select className="campo" {...campo("pago")}>
            <option value="">Sin definir</option>
            {tarjetas.map((t) => (
              <option key={t.id} value={t.id}>
                {nombreTarjeta(t)} (suma a su próximo resumen)
              </option>
            ))}
            <option value="otro">Otro medio (débito, transferencia…)</option>
          </select>
        </label>
        <label className="col-span-2 block">
          <span className="etiqueta">Observación (opcional)</span>
          <textarea className="campo min-h-16" {...campo("observacion")} />
        </label>
      </div>
    </Modal>
  );
}
