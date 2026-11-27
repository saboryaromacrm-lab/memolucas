import { useState, type ReactNode } from "react";
import { CreditCard, FileText, Pencil, Plus, Trash2 } from "lucide-react";
import { Ayuda, Boton, Cargando, Encabezado, MenuAcciones, Modal, useAccion, Vacio } from "../componentes/ui";
import { del, post, put } from "../lib/api";
import { aCampo, aNumero, pct, plata } from "../lib/numeros";
import { useRecordado } from "../lib/recordado";
import { ahora } from "../lib/fechas";
import type { CuotaTarjeta, LineaResumen, Tarjeta } from "../lib/tipos";
import { ImportarResumen } from "./ImportarResumen";
import { colorVencimiento, diasParaVencer, textoDias } from "../lib/vencimientos";
import { useDatos } from "../lib/vivo";

const fecha = (iso: string | null) => (iso ? iso.split("-").reverse().join("/") : "—");
const nombreDe = (t: Pick<Tarjeta, "nombre" | "ultimos4">) => `${t.nombre}${t.ultimos4 ? ` ···${t.ultimos4}` : ""}`;

export function Tarjetas() {
  const { datos } = useDatos<{ tarjetas: Tarjeta[]; diasAviso: number }>("/api/tarjetas", ["tarjetas", "suscripciones", "configuracion"]);
  const [elegida, setElegida] = useRecordado("tarjetas-elegida", { id: 0 });
  const [editando, setEditando] = useState<Tarjeta | "nueva" | null>(null);
  const [importando, setImportando] = useState(false);
  const tarjetas = datos?.tarjetas ?? [];
  const t = tarjetas.find((x) => x.id === elegida.id) ?? tarjetas[0];

  return (
    <div>
      <Encabezado
        titulo="Tarjetas"
        subtitulo={datos && `El bot te avisa por WhatsApp ${datos.diasAviso} ${datos.diasAviso === 1 ? "día" : "días"} antes del vencimiento del resumen.`}
        acciones={
          <>
            {tarjetas.length > 1 && (
              <select aria-label="Tarjeta" className="campo w-auto" value={t?.id} onChange={(e) => setElegida({ id: Number(e.target.value) })}>
                {tarjetas.map((x) => (
                  <option key={x.id} value={x.id}>
                    {nombreDe(x)}
                  </option>
                ))}
              </select>
            )}
            {t && (
              <>
                <Boton icono={<FileText className="size-4" />} onClick={() => setImportando(true)}>
                  Importar resumen
                </Boton>
                <Boton icono={<Pencil className="size-4" />} onClick={() => setEditando(t)}>
                  Editar
                </Boton>
              </>
            )}
            <Boton variante="primario" icono={<Plus className="size-4" />} onClick={() => setEditando("nueva")}>
              Nueva tarjeta
            </Boton>
          </>
        }
      />
      {!datos ? (
        <Cargando />
      ) : !t ? (
        <div className="tarjeta">
          <Vacio icono={<CreditCard className="size-10" />} titulo="Todavía no cargaste ninguna tarjeta" texto="Cargá la tarjeta con los datos del último resumen: saldo, vencimiento, límites y cuotas." />
        </div>
      ) : (
        <DetalleTarjeta t={t} diasAviso={datos.diasAviso} />
      )}
      {importando && t && <ImportarResumen tarjetaId={t.id} onCerrar={() => setImportando(false)} />}
      {editando && (
        <FormTarjeta
          t={editando === "nueva" ? null : editando}
          onCerrar={() => setEditando(null)}
          onCreada={(id) => setElegida({ id })}
        />
      )}
    </div>
  );
}

// ───────────── La tarjeta elegida ─────────────

function Seccion({ titulo, accion, children }: { titulo: string; accion?: ReactNode; children: ReactNode }) {
  return (
    <section className="tarjeta">
      <div className="flex items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
        <h2 className="text-sm font-semibold text-slate-800">{titulo}</h2>
        {accion}
      </div>
      {children}
    </section>
  );
}

function Cifra({ titulo, valor, detalle }: { titulo: string; valor: ReactNode; detalle?: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="etiqueta">{titulo}</div>
      <div className="truncate text-lg font-semibold tabular-nums text-slate-900">{valor}</div>
      {detalle && <div className="mt-0.5 text-xs text-slate-500">{detalle}</div>}
    </div>
  );
}

function DetalleTarjeta({ t, diasAviso }: { t: Tarjeta; diasAviso: number }) {
  const [verProyeccion, setVerProyeccion] = useState(false);
  const [cuota, setCuota] = useState<CuotaTarjeta | "nueva" | null>(null);
  const accion = useAccion();
  const dias = t.vencimiento ? diasParaVencer(t.vencimiento) : null;
  const uso = t.usoLimite ?? 0;
  const colorUso = uso >= 80 ? "bg-red-500" : uso >= 50 ? "bg-amber-400" : "bg-marca";
  const totalConsumos = t.consumos.reduce((s, c) => s + c.monto, 0);

  return (
    <div className="space-y-4">
      <div>
        <p className="text-sm text-slate-500">
          {t.ultimoResumen
            ? `Último resumen: cierre ${fecha(t.ultimoResumen.cierre)} · vence ${fecha(t.ultimoResumen.vencimiento)} · ${t.cantidadResumenes} ${t.cantidadResumenes === 1 ? "resumen" : "resúmenes"} en el historial.`
            : "Todavía no hay resúmenes importados: los datos son los que cargaste a mano."}
        </p>
        <Ayuda titulo="¿Cómo se actualiza?">
          <p>
            Con <b className="font-medium text-slate-600">Importar resumen</b> elegís el PDF del banco (se lee en tu navegador) o pegás el texto: la IA lo ordena, lo revisás y al guardar se actualizan todos los datos de la tarjeta (saldo, pago mínimo, límites, disponibles, fechas), las cuotas y los consumos. Reimportar el mismo resumen no duplica nada.
          </p>
        </Ayuda>
      </div>

      <Seccion titulo="Estado de cuenta">
        <div className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-3 lg:grid-cols-5">
          <Cifra titulo="Saldo actual" valor={plata(t.saldo)} />
          <Cifra
            titulo="Vencimiento"
            valor={fecha(t.vencimiento)}
            detalle={dias !== null && <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-medium ${colorVencimiento(dias, diasAviso)}`}>{textoDias(dias)}</span>}
          />
          <Cifra titulo="Pago mínimo" valor={plata(t.pagoMinimo)} />
          <Cifra
            titulo="Próximo resumen (estimado)"
            valor={plata(t.proximoResumen.totalArs)}
            detalle={`${t.proximoResumen.totalUsd ? `+ ${plata(t.proximoResumen.totalUsd, "USD")} · ` : ""}cierra el ${fecha(t.proximoResumen.cierre)}`}
          />
          <Cifra titulo="Total adeudado (cuotas)" valor={plata(t.totalAdeudado)} />
        </div>
        {t.usoLimite !== null && (
          <div className="border-t border-slate-100 px-4 py-3">
            <div className="mb-1.5 flex flex-wrap justify-between gap-2 text-xs text-slate-500">
              <span>
                Usaste {plata(t.limiteCompra - t.disponibleCompra)} de {plata(t.limiteCompra)} ({pct(uso)})
              </span>
              <span>
                Disponible: {plata(t.disponibleCompra)} en compras · {plata(t.disponibleCuotas)} en cuotas
              </span>
            </div>
            <div className="h-2.5 overflow-hidden rounded-full bg-slate-100">
              <div className={`h-full rounded-full ${colorUso}`} style={{ width: `${Math.min(100, Math.max(0, uso))}%` }} />
            </div>
          </div>
        )}
      </Seccion>

      <SeccionProximoResumen t={t} />

      <Seccion
        titulo="Proyección del disponible"
        accion={
          <Boton chico onClick={() => setVerProyeccion(!verProyeccion)}>
            {verProyeccion ? "Ocultar" : "Ver los próximos 12 cierres"}
          </Boton>
        }
      >
        {verProyeccion ? (
          <ul className="divide-y divide-slate-100">
            {t.proyeccion.map((p) => (
              <li key={p.mes} className="grid grid-cols-[1fr_auto] gap-x-3 px-4 py-2.5 text-sm sm:grid-cols-[110px_1fr_1fr_1fr] sm:items-center">
                <span className="font-medium capitalize text-slate-800">{p.mes}</span>
                <span className="text-right font-semibold tabular-nums sm:order-last">
                  {plata(p.disponible)}
                  <span className="block text-[11px] font-normal text-slate-400">disponible</span>
                </span>
                <span className="tabular-nums text-slate-600">Cuotas {plata(p.cuotas)}</span>
                <span className={`tabular-nums ${p.libera ? "text-marca-oscuro" : "text-slate-400"} sm:text-right`}>{p.libera ? `Se libera +${plata(p.libera)}` : "No se libera nada"}</span>
                {p.terminan.length > 0 && <span className="col-span-2 text-xs text-slate-500 sm:col-span-4">Terminan: {p.terminan.join(", ")}</span>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-4 py-3 text-sm text-slate-500">Cuánto vas a pagar de cuotas y cuánto disponible se libera cuando terminan.</p>
        )}
      </Seccion>

      <Seccion
        titulo={`Cuotas en curso (${t.cuotas.length})`}
        accion={
          <Boton chico icono={<Plus className="size-3.5" />} onClick={() => setCuota("nueva")}>
            Manual
          </Boton>
        }
      >
        {t.cuotas.length ? (
          <ul className="divide-y divide-slate-100">
            {t.cuotas.map((c) => (
              <li key={c.id} className="flex items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="line-clamp-2 break-words font-medium text-slate-800">{c.comercio}</span>
                    <span className="shrink-0 text-sm font-semibold tabular-nums">{plata(c.montoCuota)}</span>
                  </div>
                  <div className="my-1.5 h-1.5 overflow-hidden rounded-full bg-slate-100">
                    <div className="h-full rounded-full bg-marca" style={{ width: `${(c.actual / c.cuotaTotal) * 100}%` }} />
                  </div>
                  <div className="flex flex-wrap justify-between gap-x-3 text-xs text-slate-500">
                    <span>
                      Cuota {c.actual} de {c.cuotaTotal}
                      {c.fechaCompra && ` · comprado el ${fecha(c.fechaCompra)}`}
                    </span>
                    <span>Faltan {plata(c.montoCuota * c.restantes)}</span>
                  </div>
                </div>
                <MenuAcciones
                  etiqueta={`Acciones de ${c.comercio}`}
                  acciones={[
                    { texto: "Editar", icono: <Pencil />, onClick: () => setCuota(c) },
                    {
                      texto: "Borrar",
                      icono: <Trash2 />,
                      peligro: true,
                      onClick: () => confirm(`¿Borrar las cuotas de ${c.comercio}?`) && void accion(() => del(`/api/tarjetas/cuotas/${c.id}`), "Cuotas borradas"),
                    },
                  ]}
                />
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-4 py-3 text-sm text-slate-500">Sin compras en cuotas. Avanzan solas en cada cierre.</p>
        )}
      </Seccion>

      <Seccion titulo="Consumos que se repiten cada mes">
        {t.consumos.length ? (
          <ul className="divide-y divide-slate-100 text-sm">
            {t.consumos.map((c) => (
              <li key={c.id} className="flex items-center gap-3 py-1.5 pl-4 pr-2">
                <div className="min-w-0 flex-1">
                  <div className="line-clamp-2 break-words font-medium text-slate-800">{c.nombre}</div>
                  <div className="text-xs text-slate-500">{c.anterior === null ? "Nuevo" : `Antes ${plata(c.anterior)}`}</div>
                </div>
                <div className="shrink-0 text-right">
                  <div className="font-semibold tabular-nums text-slate-900">{plata(c.monto)}</div>
                  {c.anterior !== null && (
                    <div className={`text-xs tabular-nums ${!c.variacion ? "text-slate-500" : c.variacion > 0 ? "text-red-600" : "text-marca-oscuro"}`}>
                      {!c.variacion ? "Igual" : `${c.variacion > 0 ? "↑" : "↓"} ${pct(Math.abs(c.variacion))}`}
                    </div>
                  )}
                </div>
                <MenuAcciones
                  etiqueta={`Acciones de ${c.nombre}`}
                  acciones={[
                    {
                      texto: "Borrar",
                      icono: <Trash2 />,
                      peligro: true,
                      onClick: () => confirm(`¿Borrar ${c.nombre}?`) && void accion(() => del(`/api/tarjetas/consumos/${c.id}`), "Consumo borrado"),
                    },
                  ]}
                />
              </li>
            ))}
            <li className="flex justify-between gap-3 py-2.5 pl-4 pr-14 font-semibold">
              <span>Total</span>
              <span className="tabular-nums">{plata(totalConsumos)}</span>
            </li>
          </ul>
        ) : (
          <p className="px-4 py-3 text-sm text-slate-500">Aparecen al importar los resúmenes (Netflix, Spotify… cobrados en la tarjeta).</p>
        )}
      </Seccion>

      {t.finalizadas.length > 0 && (
        <Seccion titulo="Cuotas terminadas (últimas 10)">
          <ul className="divide-y divide-slate-100">
            {t.finalizadas.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                <span className="min-w-0 truncate text-slate-700">
                  {c.comercio} <span className="text-xs text-slate-400">· {c.cuotaTotal} cuotas · última en el cierre del {fecha(c.ultimoCierre)}</span>
                </span>
                <span className="shrink-0 tabular-nums text-slate-500">{plata(c.montoTotal)}</span>
              </li>
            ))}
          </ul>
        </Seccion>
      )}

      {cuota && <FormCuota tarjetaId={t.id} c={cuota === "nueva" ? null : cuota} onCerrar={() => setCuota(null)} />}
    </div>
  );
}

// ───────────── Próximo resumen ─────────────

const GRUPOS: [string, LineaResumen["tipo"][]][] = [
  ["Cuotas", ["cuota"]],
  ["Suscripciones", ["suscripcion"]],
  ["Débitos que se repiten", ["debito"]],
  ["Compras que cargaste", ["compra"]],
  ["Saldo anterior", ["saldo"]],
];

/** Pesos y dólares por separado, como el resumen del banco (cada importe sin cortarse en dos renglones). */
function Importes({ lineas }: { lineas: Pick<LineaResumen, "monto" | "moneda">[] }) {
  const ars = lineas.filter((l) => l.moneda === "ARS").reduce((s, l) => s + l.monto, 0);
  const usd = lineas.filter((l) => l.moneda === "USD").reduce((s, l) => s + l.monto, 0);
  const partes = [ars || !usd ? plata(ars) : null, usd ? plata(usd, "USD") : null].filter(Boolean);
  return (
    <span className="text-right tabular-nums">
      {partes.map((p, i) => (
        <span key={i} className="whitespace-nowrap">
          {i > 0 && " + "}
          {p}
        </span>
      ))}
    </span>
  );
}

function SeccionProximoResumen({ t }: { t: Tarjeta }) {
  const p = t.proximoResumen;
  const [compra, setCompra] = useState(false);
  const accion = useAccion();
  return (
    <Seccion
      titulo={`Próximo resumen · cierra el ${fecha(p.cierre)}${p.vencimiento ? ` · vence el ${fecha(p.vencimiento)}` : ""}`}
      accion={
        <Boton chico className="shrink-0 whitespace-nowrap" icono={<Plus className="size-3.5" />} onClick={() => setCompra(true)}>
          Cargar compra
        </Boton>
      }
    >
      {p.sinImportar && (
        <p className="border-b border-amber-100 bg-amber-50 px-4 py-2.5 text-sm text-amber-900">
          El resumen que cerró el {fecha(p.sinImportar)} todavía no lo importaste: importalo para que la cuenta dé bien.
        </p>
      )}
      <Pago t={t} />
      {p.lineas.length ? (
        <div className="divide-y divide-slate-100">
          {GRUPOS.map(([titulo, tipos]) => {
            const ls = p.lineas.filter((l) => tipos.includes(l.tipo));
            if (!ls.length) return null;
            return (
              <div key={titulo} className="px-4 py-3">
                <div className="mb-1.5 flex justify-between gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  <span className="min-w-0">
                    {titulo}
                    {ls.length > 1 && ` (${ls.length})`}
                  </span>
                  <Importes lineas={ls} />
                </div>
                <ul className="space-y-1">
                  {ls.map((l, i) => (
                    <li key={`${l.tipo}-${l.id ?? i}`} className="flex items-baseline gap-2 text-sm">
                      <span className="min-w-0 flex-1 truncate text-slate-800">
                        {l.descripcion}
                        {l.detalle && <span className="text-xs text-slate-400"> · {l.detalle}</span>}
                      </span>
                      <span className="shrink-0 whitespace-nowrap tabular-nums text-slate-900">{plata(l.monto, l.moneda)}</span>
                      {l.tipo === "compra" && (
                        <button
                          onClick={() => void accion(() => del(`/api/tarjetas/compras/${l.id}`), "Compra borrada")}
                          aria-label={`Borrar ${l.descripcion}`}
                          className="-my-2 flex size-10 shrink-0 items-center justify-center self-center rounded-lg text-slate-400 hover:bg-red-50 hover:text-red-600"
                        >
                          <Trash2 className="size-4" />
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
          <div className="flex justify-between gap-2 bg-slate-50 px-4 py-3 font-semibold">
            <span>Total estimado</span>
            <Importes lineas={p.lineas} />
          </div>
        </div>
      ) : (
        <p className="px-4 py-3 text-sm text-slate-500">Todavía no hay nada para el próximo resumen.</p>
      )}
      <div className="border-t border-slate-100 px-4 py-2 text-xs text-slate-500">
        <p className="pt-1">Es un estimado: no incluye impuestos, percepciones ni intereses.</p>
        <Ayuda titulo="¿Qué incluye?">
          <p>
            De las compras en un pago cuentan las que cargues acá o le digas al asistente (“gasté 30 mil en el súper con la Visa”); al importar el resumen
            que ya las trae, se van solas. Las suscripciones suman si en Suscripciones elegiste que se pagan con esta tarjeta.
          </p>
        </Ayuda>
      </div>
      {compra && <FormCompra tarjetaId={t.id} onCerrar={() => setCompra(false)} />}
    </Seccion>
  );
}

/** Cuánto pagaste del último resumen: si quedó algo, suma al próximo. */
function Pago({ t }: { t: Tarjeta }) {
  const p = t.proximoResumen;
  const [abierto, setAbierto] = useState(false);
  const [monto, setMonto] = useState(aCampo(p.pagado ?? t.saldo, true));
  const accion = useAccion();
  if (!t.cierre || (!p.faltaPago && p.pagado === null)) return null;
  const guardar = async () => {
    if (await accion(() => put(`/api/tarjetas/${t.id}/pago`, { monto: aNumero(monto) ?? 0 }), "Pago anotado")) setAbierto(false);
  };
  return (
    <div className="border-b border-slate-100 px-4 py-2.5 text-sm text-slate-600">
      {abierto ? (
        <div className="flex flex-wrap items-center gap-2">
          <span>Pagaste del resumen del {fecha(t.cierre)}:</span>
          <input className="campo w-40" inputMode="decimal" autoFocus value={monto} onChange={(e) => setMonto(e.target.value)} />
          <Boton chico variante="primario" onClick={() => void guardar()}>
            Guardar
          </Boton>
          <Boton chico onClick={() => setAbierto(false)}>
            Cancelar
          </Boton>
        </div>
      ) : p.pagado === null ? (
        <span>
          ¿Cuánto pagaste del resumen del {fecha(t.cierre)} ({plata(t.saldo)})? Si no pagaste todo, lo que quedó suma al próximo.{" "}
          <button className="-my-2 px-1 py-2 font-medium text-marca-oscuro hover:underline" onClick={() => setAbierto(true)}>
            Anotar pago
          </button>
        </span>
      ) : (
        <span>
          Pagaste {plata(p.pagado)} de {plata(t.saldo)} del resumen del {fecha(t.cierre)}.{" "}
          <button className="-my-2 px-1 py-2 font-medium text-marca-oscuro hover:underline" onClick={() => setAbierto(true)}>
            Cambiar
          </button>
        </span>
      )}
    </div>
  );
}

function FormCompra({ tarjetaId, onCerrar }: { tarjetaId: number; onCerrar: () => void }) {
  const [f, setF] = useState({ descripcion: "", monto: "", moneda: "ARS", fecha: ahora().toISODate()!, cuotas: "1" });
  const [guardando, setGuardando] = useState(false);
  const accion = useAccion();
  const campo = (k: keyof typeof f) => ({ value: f[k], onChange: (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value }) });
  const cuotas = Math.max(1, Number(f.cuotas) || 1);
  const monto = aNumero(f.monto) ?? 0;

  const guardar = async () => {
    setGuardando(true);
    const ok = await accion(() => post(`/api/tarjetas/${tarjetaId}/compras`, { ...f, monto, cuotas }), cuotas > 1 ? "Compra agregada a las cuotas" : "Compra cargada");
    setGuardando(false);
    if (ok) onCerrar();
  };

  return (
    <Modal
      abierto
      onCerrar={onCerrar}
      titulo="Cargar una compra"
      ancho="max-w-md"
      pie={
        <>
          <Boton onClick={onCerrar}>Cancelar</Boton>
          <Boton variante="primario" cargando={guardando} disabled={!f.descripcion.trim() || !monto} onClick={() => void guardar()}>
            Guardar
          </Boton>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <Campo etiqueta="Qué compraste" ancho>
          <input className="campo" placeholder="Súper, nafta, zapatillas…" autoFocus {...campo("descripcion")} />
        </Campo>
        <Campo etiqueta="Monto total">
          <input className="campo" inputMode="decimal" placeholder="0,00" {...campo("monto")} />
        </Campo>
        <Campo etiqueta="Moneda">
          <select className="campo" {...campo("moneda")}>
            <option value="ARS">Pesos ($)</option>
            <option value="USD">Dólares (US$)</option>
          </select>
        </Campo>
        <Campo etiqueta="Fecha">
          <input className="campo" type="date" {...campo("fecha")} />
        </Campo>
        <Campo etiqueta="Cuotas">
          <input className="campo" inputMode="numeric" {...campo("cuotas")} />
        </Campo>
      </div>
      {cuotas > 1 && monto > 0 && (
        <p className="mt-3 text-sm text-slate-600">
          {cuotas} cuotas de {plata(monto / cuotas)}: va a las cuotas en curso y la primera viene en el próximo resumen.
        </p>
      )}
    </Modal>
  );
}

// ───────────── Formularios ─────────────

function Campo({ etiqueta, ancho, children }: { etiqueta: string; ancho?: boolean; children: ReactNode }) {
  return (
    <label className={`block ${ancho ? "col-span-2" : ""}`}>
      <span className="etiqueta">{etiqueta}</span>
      {children}
    </label>
  );
}

const SALDOS = [
  ["limiteCompra", "Límite de compra"],
  ["limiteCuotas", "Límite en cuotas"],
  ["disponibleCompra", "Disponible para compras"],
  ["disponibleCuotas", "Disponible en cuotas"],
  ["saldo", "Saldo actual"],
  ["pagoMinimo", "Pago mínimo"],
] as const;

function FormTarjeta({ t, onCerrar, onCreada }: { t: Tarjeta | null; onCerrar: () => void; onCreada: (id: number) => void }) {
  const [f, setF] = useState({
    nombre: t?.nombre ?? "",
    ultimos4: t?.ultimos4 ?? "",
    cierre: t?.cierre ?? "",
    vencimiento: t?.vencimiento ?? "",
    ...Object.fromEntries(SALDOS.map(([k]) => [k, t ? aCampo(t[k], true) : ""])),
  } as Record<string, string>);
  const [negocio, setNegocio] = useState(t?.negocio ?? false);
  const [guardando, setGuardando] = useState(false);
  const accion = useAccion();
  const campo = (k: string) => ({ value: f[k], onChange: (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value }) });

  const guardar = async () => {
    setGuardando(true);
    const datos = {
      negocio,
      nombre: f.nombre,
      ultimos4: f.ultimos4.trim(),
      cierre: f.cierre || null,
      vencimiento: f.vencimiento || null,
      ...Object.fromEntries(SALDOS.map(([k]) => [k, aNumero(f[k]) ?? 0])),
    };
    const r = await accion(() => (t ? put(`/api/tarjetas/${t.id}`, datos) : post<{ id: number }>("/api/tarjetas", datos)), t ? "Tarjeta guardada" : "Tarjeta creada");
    setGuardando(false);
    if (!r) return;
    if (!t) onCreada((r as { id: number }).id);
    onCerrar();
  };
  const borrar = async () => {
    if (t && confirm(`¿Borrar ${nombreDe(t)}? Se borran también sus cuotas, resúmenes y consumos.`) && (await accion(() => del(`/api/tarjetas/${t.id}`), "Tarjeta borrada"))) onCerrar();
  };

  return (
    <Modal
      abierto
      onCerrar={onCerrar}
      titulo={t ? "Editar tarjeta" : "Nueva tarjeta"}
      ancho="max-w-lg"
      pie={
        <>
          {t && (
            <Boton variante="peligro" className="mr-auto" icono={<Trash2 className="size-4" />} onClick={() => void borrar()}>
              Borrar
            </Boton>
          )}
          <Boton onClick={onCerrar}>Cancelar</Boton>
          <Boton variante="primario" cargando={guardando} disabled={!f.nombre.trim()} onClick={() => void guardar()}>
            Guardar
          </Boton>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <Campo etiqueta="Nombre">
          <input className="campo" placeholder="VISA Banco Formosa" autoFocus {...campo("nombre")} />
        </Campo>
        <Campo etiqueta="Últimos 4 números">
          <input className="campo" inputMode="numeric" maxLength={4} placeholder="1376" {...campo("ultimos4")} />
        </Campo>
        <Campo etiqueta="Último cierre">
          <input className="campo" type="date" {...campo("cierre")} />
        </Campo>
        <Campo etiqueta="Vencimiento">
          <input className="campo" type="date" {...campo("vencimiento")} />
        </Campo>
        {SALDOS.map(([k, etiqueta]) => (
          <Campo key={k} etiqueta={etiqueta}>
            <input className="campo" inputMode="decimal" placeholder="0,00" {...campo(k)} />
          </Campo>
        ))}
        <label className="col-span-2 flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" className="size-4 accent-marca-oscuro" checked={negocio} onChange={(e) => setNegocio(e.target.checked)} />
          Es del negocio (en Pagos su resumen cuenta como negocio; si no, personal)
        </label>
      </div>
      <p className="mt-3 text-xs text-slate-500">Nunca cargues el número completo ni el código de seguridad: solo hacen falta los últimos 4. Los importes se guardan cifrados.</p>
    </Modal>
  );
}

function FormCuota({ tarjetaId, c, onCerrar }: { tarjetaId: number; c: CuotaTarjeta | null; onCerrar: () => void }) {
  const [f, setF] = useState({
    comercio: c?.comercio ?? "",
    fechaCompra: c?.fechaCompra ?? "",
    cuotaActual: String(c?.actual ?? 1),
    cuotaTotal: String(c?.cuotaTotal ?? ""),
    montoCuota: c ? aCampo(c.montoCuota) : "",
  });
  const [guardando, setGuardando] = useState(false);
  const accion = useAccion();
  const campo = (k: keyof typeof f) => ({ value: f[k], onChange: (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value }) });
  const total = (aNumero(f.montoCuota) ?? 0) * (Number(f.cuotaTotal) || 0);

  const guardar = async () => {
    setGuardando(true);
    const datos = { comercio: f.comercio, fechaCompra: f.fechaCompra || null, cuotaActual: Number(f.cuotaActual) || 0, cuotaTotal: Number(f.cuotaTotal) || 0, montoCuota: aNumero(f.montoCuota) ?? 0 };
    const ok = await accion(() => (c ? put(`/api/tarjetas/cuotas/${c.id}`, datos) : post(`/api/tarjetas/${tarjetaId}/cuotas`, datos)), c ? "Cuotas guardadas" : "Cuotas agregadas");
    setGuardando(false);
    if (ok) onCerrar();
  };

  return (
    <Modal
      abierto
      onCerrar={onCerrar}
      titulo={c ? "Editar compra en cuotas" : "Compra en cuotas"}
      ancho="max-w-md"
      pie={
        <>
          <Boton onClick={onCerrar}>Cancelar</Boton>
          <Boton variante="primario" cargando={guardando} disabled={!f.comercio.trim() || !total} onClick={() => void guardar()}>
            Guardar
          </Boton>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <Campo etiqueta="Comercio" ancho>
          <input className="campo" autoFocus {...campo("comercio")} />
        </Campo>
        <Campo etiqueta="Cuota que ya se cobró">
          <input className="campo" inputMode="numeric" {...campo("cuotaActual")} />
        </Campo>
        <Campo etiqueta="Total de cuotas">
          <input className="campo" inputMode="numeric" {...campo("cuotaTotal")} />
        </Campo>
        <Campo etiqueta="Monto de cada cuota">
          <input className="campo" inputMode="decimal" placeholder="0,00" {...campo("montoCuota")} />
        </Campo>
        <Campo etiqueta="Fecha de compra (opcional)">
          <input className="campo" type="date" {...campo("fechaCompra")} />
        </Campo>
      </div>
      <p className="mt-3 text-sm text-slate-600">Total de la compra: {plata(total)}. Desde ahora avanza sola una cuota en cada cierre.</p>
    </Modal>
  );
}
