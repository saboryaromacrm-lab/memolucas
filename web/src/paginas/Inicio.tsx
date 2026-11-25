import { useState } from "react";
import { Link } from "react-router";
import { AlarmClockOff, AlertTriangle, BatteryLow, BellRing, Camera, CheckCircle2, Clock4, ListChecks, MessageCircle, Repeat, Sparkles, XCircle } from "lucide-react";
import { useEditor } from "../componentes/Editor";
import { Boton, Cargando, useAccion } from "../componentes/ui";
import { post, put } from "../lib/api";
import { ahora, cuandoCorto, hora, haceCuanto } from "../lib/fechas";
import { aNumero, plata } from "../lib/numeros";
import { useSuscripciones } from "../lib/suscripciones";
import { colorVencimiento, diasParaVencer, textoDias } from "../lib/vencimientos";
import type { EstadoPanel, Evento } from "../lib/tipos";
import { useDatos } from "../lib/vivo";

export function Inicio() {
  const { datos, error } = useDatos<EstadoPanel>("/api/estado", ["recordatorios", "whatsapp", "configuracion", "mensajes"]);
  const accion = useAccion();
  if (error) return <p className="text-sm text-red-600">{error}</p>;
  if (!datos) return <Cargando />;
  const h = ahora().hour;
  const saludo = h < 13 ? "Buen día" : h < 20 ? "Buenas tardes" : "Buenas noches";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-slate-900 sm:text-2xl">
          {saludo}, {datos.nombre}
        </h1>
        <p className="mt-0.5 text-sm text-slate-500 first-letter:uppercase">{ahora().toFormat("cccc d 'de' LLLL")}</p>
      </div>

      {datos.configInicialPendiente && <ConfigInicial />}

      {datos.ia.falla && <AvisoIA falla={datos.ia.falla} />}

      {datos.silenciadoHasta && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <span className="flex items-center gap-2">
            <AlarmClockOff className="size-4" /> Avisos en silencio hasta {cuandoCorto(datos.silenciadoHasta)}.
          </span>
          <Boton chico onClick={() => accion(() => put("/api/configuracion", { botSilenciadoHasta: null }), "Silencio cortado")}>
            Cortar silencio
          </Boton>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Contador icono={<ListChecks />} titulo="Activos" valor={datos.contadores.activos} />
        <Contador icono={<CheckCircle2 />} titulo="Cumplidos esta semana" valor={datos.contadores.cumplidosSemana} color="text-marca-oscuro" />
        <Contador icono={<XCircle />} titulo="No confirmados (7 días)" valor={datos.contadores.noConfirmados} color={datos.contadores.noConfirmados ? "text-red-600" : undefined} />
        <Contador
          icono={<Sparkles />}
          titulo="IA este mes"
          valor={plata(datos.ia.costoUsd, "USD")}
          detalle={`${datos.ia.llamadas} consultas`}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Bloque titulo="Hoy" eventos={datos.hoy} vacio="Nada para hoy 🙌" />
          <Bloque titulo="Mañana" eventos={datos.manana} vacio="Nada para mañana" />
        </div>
        <div className="space-y-6">
          <TarjetaWhatsapp estado={datos.whatsapp} />
          <TarjetaCredito credito={datos.ia.credito} />
          <VencenPronto />
          <section className="tarjeta">
            <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
              <h2 className="text-sm font-semibold text-slate-800">Sin confirmar</h2>
              <span className="text-xs text-slate-500">{datos.pendientes.length}</span>
            </div>
            {datos.pendientes.length ? (
              <ul className="divide-y divide-slate-100">
                {datos.pendientes.map((p) => (
                  <li key={p.ocurrencia.id} className="px-4 py-3">
                    <div className="text-sm font-medium text-slate-800">{p.recordatorio.titulo}</div>
                    <div className="text-xs text-slate-500">
                      Avisado {p.ocurrencia.ultimoEnvioEn && haceCuanto(p.ocurrencia.ultimoEnvioEn)} · intento {p.ocurrencia.intentos}/{p.ocurrencia.tope + 1}
                    </div>
                    <div className="mt-2 flex gap-1.5">
                      <Boton chico variante="primario" onClick={() => accion(() => post(`/api/ocurrencias/${p.ocurrencia.id}/confirmar`), "Marcado como hecho")}>
                        Hecho
                      </Boton>
                      <Boton chico onClick={() => accion(() => post(`/api/ocurrencias/${p.ocurrencia.id}/posponer`, { minutos: 15 }), "Pospuesto 15 min")}>
                        +15 min
                      </Boton>
                      <Boton chico onClick={() => accion(() => post(`/api/ocurrencias/${p.ocurrencia.id}/posponer`, { minutos: 60 }), "Pospuesto 1 hora")}>
                        +1 h
                      </Boton>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-4 py-6 text-center text-sm text-slate-500">Todo confirmado ✅</p>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function Contador({ icono, titulo, valor, color, detalle }: { icono: React.ReactNode; titulo: string; valor: number | string; color?: string; detalle?: string }) {
  return (
    <div className="tarjeta p-4">
      <div className="flex items-center gap-2 text-xs font-medium text-slate-500 [&>svg]:size-4 [&>svg]:text-slate-400">
        {icono}
        {titulo}
      </div>
      <div className={`mt-1.5 text-2xl font-semibold tracking-tight ${color ?? "text-slate-900"}`}>{valor}</div>
      {detalle && <div className="text-xs text-slate-400">{detalle}</div>}
    </div>
  );
}

function Bloque({ titulo, eventos, vacio }: { titulo: string; eventos: Evento[]; vacio: string }) {
  const editor = useEditor();
  return (
    <section className="tarjeta">
      <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
        <h2 className="text-sm font-semibold text-slate-800">{titulo}</h2>
        <span className="text-xs text-slate-500">{eventos.length}</span>
      </div>
      {eventos.length ? (
        <ul className="divide-y divide-slate-100">
          {eventos.map((e) => (
            <li key={`${e.recordatorio.id}-${e.cuando}`}>
              <button onClick={() => editor.abrir({ id: e.recordatorio.id })} className="flex w-full items-center gap-4 px-4 py-3 text-left hover:bg-slate-50">
                <span className="w-12 shrink-0 text-sm font-semibold tabular-nums text-marca-profundo">{hora(e.cuando)}</span>
                <span className="min-w-0 flex-1">
                  <span className="line-clamp-2 break-words text-sm font-medium text-slate-800">
                    {e.recordatorio.titulo}
                    {e.recordatorio.grupoNombre && <span className="ml-2 text-[11px] font-normal text-sky-700">👨‍👩‍👧 {e.recordatorio.grupoNombre}</span>}
                  </span>
                  {e.recordatorio.descripcion && <span className="block truncate text-xs text-slate-500">{e.recordatorio.descripcion}</span>}
                </span>
                <span className="flex shrink-0 gap-1.5 text-slate-400">
                  {e.recordatorio.rrule && <Repeat className="size-4" />}
                  {e.recordatorio.adjuntoId && <Camera className="size-4" />}
                  {e.recordatorio.avisosPreviosMin.length > 0 && <BellRing className="size-4" />}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-4 py-8 text-center text-sm text-slate-500">{vacio}</p>
      )}
    </section>
  );
}

/** Suscripciones vencidas o que vencen pronto (solo si hay). */
function VencenPronto() {
  const { datos, porVencer } = useSuscripciones();
  if (!datos || !porVencer.length) return null;
  return (
    <section className="tarjeta">
      <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
        <h2 className="text-sm font-semibold text-slate-800">Vencen pronto</h2>
        <Link to="/suscripciones" className="text-xs font-medium text-marca-oscuro hover:underline">
          Ver suscripciones
        </Link>
      </div>
      <ul className="divide-y divide-slate-100">
        {porVencer.map((s) => {
          const dias = diasParaVencer(s.fechaVto);
          return (
            <li key={s.id} className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-slate-800">{s.nombre}</div>
                <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-medium ${colorVencimiento(dias, datos.diasAviso)}`}>{textoDias(dias)}</span>
              </div>
              <span className="shrink-0 text-sm tabular-nums text-slate-700">{plata(s.monto, s.moneda)}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Dónde se arregla cada falla en la consola de Claude. */
const CONSOLA_CLAUDE = { sin_credito: "https://console.anthropic.com/settings/billing", clave: "https://console.anthropic.com/settings/keys" };

/** Con menos de esto, la tarjeta del crédito se marca (y el bot avisa por WhatsApp). */
const DIAS_POCO_CREDITO = 7;
const alcanzaPara = (dias: number) => {
  const n = Math.floor(dias);
  return n < 1 ? "menos de 1 día" : n === 1 ? "1 día" : `${n} días`;
};

/** Crédito de la cuenta de Claude: Anthropic no deja consultarlo, así que se carga acá y el bot descuenta lo que gasta. */
function TarjetaCredito({ credito }: { credito: EstadoPanel["ia"]["credito"] }) {
  const accion = useAccion();
  const [editando, setEditando] = useState(false);
  const [valor, setValor] = useState("");
  const poco = credito !== null && credito.dias !== null && credito.dias < DIAS_POCO_CREDITO;
  const monto = aNumero(valor);
  const guardar = async () => {
    if (monto === null || monto < 0) return;
    if (await accion(() => put("/api/configuracion/saldo-ia", { saldoUsd: monto }), "Saldo guardado")) {
      setEditando(false);
      setValor("");
    }
  };
  return (
    <section className={`tarjeta p-4 ${poco ? "border-amber-200" : ""}`}>
      <div className="flex items-start gap-3">
        <span className={`flex size-10 shrink-0 items-center justify-center rounded-full ${poco ? "bg-amber-50 text-amber-600" : "bg-marca-suave text-marca-oscuro"}`}>
          <BatteryLow className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-slate-800">Crédito de Claude</div>
          {credito ? (
            <>
              <div className={`text-xl font-semibold tracking-tight ${poco ? "text-amber-700" : "text-slate-900"}`}>
                {plata(credito.saldoUsd, "USD")} <span className="text-xs font-normal text-slate-400">aprox.</span>
              </div>
              <div className="text-xs text-slate-500">
                {credito.dias === null ? "Sin gasto en los últimos días" : `Te alcanza para ${alcanzaPara(credito.dias)} · ${plata(credito.porDiaUsd, "USD")} por día`}
              </div>
            </>
          ) : (
            <div className="text-xs text-slate-500">Anthropic no deja consultarlo: cargá el saldo que ves en la consola y te aviso por WhatsApp antes de que se termine.</div>
          )}
        </div>
      </div>
      {editando || !credito ? (
        <form
          className="mt-3 flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void guardar();
          }}
        >
          <input className="campo min-w-0 flex-1" inputMode="decimal" placeholder="Saldo en US$ (ej. 4,50)" value={valor} onChange={(e) => setValor(e.target.value)} autoFocus={editando} />
          <Boton chico variante="primario" type="submit" disabled={monto === null}>
            Guardar
          </Boton>
          {credito && (
            <Boton chico onClick={() => setEditando(false)}>
              Cancelar
            </Boton>
          )}
        </form>
      ) : (
        <Boton chico className="mt-3" onClick={() => setEditando(true)}>
          Actualizar saldo
        </Boton>
      )}
      <p className="mt-3 text-xs text-slate-500">
        Cuando cargues, decile al bot «cargué 10 dólares» o actualizalo acá. Para no quedarte nunca sin crédito, activá la recarga automática en la consola:
        Settings → Billing → <b>Auto reload</b>.{" "}
        <a href={CONSOLA_CLAUDE.sin_credito} target="_blank" rel="noreferrer" className="font-medium text-marca-oscuro underline">
          Abrir la consola
        </a>
      </p>
    </section>
  );
}

/** La IA no anda: la causa, qué hacer y cuántos mensajes de WhatsApp esperan. */
function AvisoIA({ falla }: { falla: NonNullable<EstadoPanel["ia"]["falla"]> }) {
  const accion = useAccion();
  const [probando, setProbando] = useState(false);
  const consola = falla.motivo === "caido" ? null : CONSOLA_CLAUDE[falla.motivo];
  const probar = async () => {
    setProbando(true);
    await accion(async () => {
      const r = await post<{ ok: boolean; mensaje: string }>("/api/configuracion/probar-ia");
      if (!r.ok) throw new Error(`Sigue sin andar. ${r.mensaje}`);
    }, "La IA volvió a andar");
    setProbando(false);
  };
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
      <div className="min-w-0 space-y-1">
        <p className="flex items-center gap-2 font-medium">
          <AlertTriangle className="size-4 shrink-0" /> La IA no anda desde {cuandoCorto(falla.desde).toLowerCase()}
        </p>
        <p>{falla.causa}</p>
        <p className="text-red-700">
          {falla.guardados
            ? `${falla.guardados === 1 ? "Hay 1 mensaje" : `Hay ${falla.guardados} mensajes`} de WhatsApp esperando: se hacen solos cuando vuelva.`
            : "Mientras tanto andan los comandos rápidos (hoy, lista, listo…)."}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        {consola && (
          <a href={consola} target="_blank" rel="noreferrer" className="inline-flex min-h-9 items-center rounded-lg border border-red-200 bg-white px-3 font-medium text-red-700 hover:bg-red-100">
            Abrir la consola
          </a>
        )}
        <Boton chico cargando={probando} onClick={probar}>
          Probar ahora
        </Boton>
      </div>
    </div>
  );
}

function TarjetaWhatsapp({ estado }: { estado: EstadoPanel["whatsapp"] }) {
  const ok = estado.estado === "conectado";
  return (
    <section className={`tarjeta p-4 ${estado.alerta ? "border-red-200" : ""}`}>
      <div className="flex items-start gap-3">
        <span className={`flex size-10 shrink-0 items-center justify-center rounded-full ${ok ? "bg-marca-suave text-marca-oscuro" : estado.alerta ? "bg-red-50 text-red-600" : "bg-amber-50 text-amber-600"}`}>
          <MessageCircle className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-slate-800">
            {ok ? "WhatsApp conectado" : estado.estado === "esperando_qr" ? "Esperando que vincules el número" : estado.estado === "sesion_cerrada" ? "WhatsApp sin vincular" : "WhatsApp desconectado"}
          </div>
          <div className="text-xs text-slate-500">
            {ok && estado.numeroVinculadoTexto ? `Bot: ${estado.numeroVinculadoTexto}` : estado.ultimoError ?? "Reconectando automáticamente…"}
          </div>
          {estado.ultimoMensajeRecibido && (
            <div className="mt-1 flex items-center gap-1 text-xs text-slate-400">
              <Clock4 className="size-3" /> Último mensaje {haceCuanto(estado.ultimoMensajeRecibido)}
            </div>
          )}
        </div>
      </div>
      {!ok && (
        <Link to="/whatsapp" className="mt-3 block rounded-lg bg-slate-900 px-3 py-2 text-center text-sm font-medium text-white hover:bg-slate-800">
          Ir a la conexión
        </Link>
      )}
    </section>
  );
}

function ConfigInicial() {
  const [numero, setNumero] = useState("");
  const [nombre, setNombre] = useState("Lucas");
  const [guardando, setGuardando] = useState(false);
  const accion = useAccion();
  return (
    <section className="tarjeta border-marca/40 bg-gradient-to-br from-white to-marca-suave/60 p-5">
      <h2 className="text-base font-semibold text-slate-900">Configuración inicial</h2>
      <p className="mt-1 text-sm text-slate-600">
        Cargá tu número personal: es el único que va a poder hablarle al bot. Después vinculá el chip del bot desde <b>WhatsApp</b>.
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <div>
          <label className="etiqueta">Tu número personal</label>
          <input className="campo" inputMode="tel" placeholder="11 1234-5678" value={numero} onChange={(e) => setNumero(e.target.value)} />
        </div>
        <div>
          <label className="etiqueta">Cómo te llama el bot</label>
          <input className="campo" value={nombre} onChange={(e) => setNombre(e.target.value)} />
        </div>
        <Boton
          variante="primario"
          cargando={guardando}
          disabled={numero.replace(/\D/g, "").length < 8}
          onClick={async () => {
            setGuardando(true);
            await accion(async () => {
              await put("/api/configuracion", { nombreUsuario: nombre.trim() || "Lucas" });
              await put("/api/whatsapp/autorizado", { numero });
            }, "¡Listo! Ahora vinculá el WhatsApp del bot");
            setGuardando(false);
          }}
        >
          Guardar
        </Boton>
      </div>
    </section>
  );
}

