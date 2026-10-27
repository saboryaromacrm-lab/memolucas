import { useState } from "react";
import { Link } from "react-router";
import { AlarmClockOff, BellRing, Camera, CheckCircle2, Clock4, ListChecks, MessageCircle, Repeat, Sparkles, XCircle } from "lucide-react";
import { useEditor } from "../componentes/Editor";
import { Boton, Cargando, useAccion } from "../componentes/ui";
import { post, put } from "../lib/api";
import { ahora, cuandoCorto, hora, haceCuanto } from "../lib/fechas";
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
          valor={`US$ ${datos.ia.costoUsd.toFixed(2)}`}
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
                  <span className="block truncate text-sm font-medium text-slate-800">
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

