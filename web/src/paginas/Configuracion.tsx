import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Download, KeyRound, PlugZap, RotateCcw, Save, Upload } from "lucide-react";
import { Boton, Cargando, Encabezado, Interruptor, useAccion, useAviso } from "../componentes/ui";
import { post, put } from "../lib/api";
import type { Configuracion as Cfg, Plantillas } from "../lib/tipos";
import { useDatos } from "../lib/vivo";

const SECCIONES = [
  ["general", "General"],
  ["insistencia", "Insistencia"],
  ["silencio", "Silencio"],
  ["resumen", "Resumen diario"],
  ["ia", "IA"],
  ["audios", "Audios"],
  ["compras", "Compras"],
  ["mensajes", "Mensajes"],
  ["seguridad", "Seguridad"],
  ["respaldo", "Respaldo"],
  ["avanzado", "Avanzado"],
] as const;
type Seccion = (typeof SECCIONES)[number][0];

const EDITABLES = [
  "nombreUsuario",
  "zonaHoraria",
  "horaDefecto",
  "horaTarde",
  "horaNoche",
  "insistenciaActiva",
  "insistenciaIntervaloMin",
  "insistenciaTope",
  "insistirPrevios",
  "avisarEnHoraDefecto",
  "silencioActivo",
  "silencioDesde",
  "silencioHasta",
  "silencioDias",
  "resumenActivo",
  "resumenHora",
  "resumenDias",
  "resumenIncluirPendientes",
  "iaModelo",
  "iaEsfuerzo",
  "plantillas",
  "sesionDuracionDias",
  "maxIntentosLogin",
  "bloqueoMinutos",
  "fotoMaxMb",
  "limpiezaFotosActiva",
  "limpiezaFotosDias",
  "demoraMinMs",
  "demoraMaxMs",
  "alertaDesconexionMin",
  "minutosAtrasado",
  "audioModelo",
  "audioMaxSegundos",
  "usarEncuestas",
  "comprasModelo",
  "comprasModeloReintento",
  "comprasInstructivo",
  "comprasEsperaSeg",
  "comprasDiasArchivo",
  "erpUrl",
  "erpEnvioAuto",
] as const;
type Editable = Pick<Cfg, (typeof EDITABLES)[number]>;

const elegir = (c: Cfg): Editable => Object.fromEntries(EDITABLES.map((k) => [k, c[k]])) as Editable;

export function Configuracion() {
  const { datos, recargar } = useDatos<Cfg>("/api/configuracion", ["configuracion"]);
  const [seccion, setSeccion] = useState<Seccion>("general");
  const [form, setForm] = useState<Editable | null>(null);
  const [guardando, setGuardando] = useState(false);
  const avisar = useAviso();

  const original = useMemo(() => (datos ? elegir(datos) : null), [datos]);
  const sucio = !!form && !!original && JSON.stringify(form) !== JSON.stringify(original);

  // Si cambia desde otro lado (ej. "silencio 2h" por WhatsApp) y no estás editando, se actualiza solo.
  useEffect(() => {
    if (original && (!form || !sucio)) setForm(original);
  }, [original]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!datos || !form) return <Cargando />;
  const set = <K extends keyof Editable>(k: K, v: Editable[K]) => setForm({ ...form, [k]: v });

  async function guardar() {
    if (!form || !original) return;
    const cambios = Object.fromEntries(EDITABLES.filter((k) => JSON.stringify(form[k]) !== JSON.stringify(original[k])).map((k) => [k, form[k]]));
    setGuardando(true);
    try {
      await put("/api/configuracion", cambios);
      avisar("Configuración guardada");
      await recargar();
    } catch (e) {
      avisar(e instanceof Error ? e.message : "No se pudo guardar", "error");
    } finally {
      setGuardando(false);
    }
  }

  return (
    <div>
      <Encabezado titulo="Configuración" subtitulo="Todo se aplica al instante, sin reiniciar nada." />
      <div className="grid gap-6 md:grid-cols-[200px_1fr]">
        <nav className="-mx-4 flex gap-1 overflow-x-auto px-4 md:mx-0 md:flex-col md:px-0">
          {SECCIONES.map(([v, t]) => (
            <button
              key={v}
              onClick={() => setSeccion(v)}
              className={`shrink-0 rounded-lg px-3 py-2 text-left text-sm font-medium ${
                seccion === v ? "bg-white text-marca-profundo shadow-sm ring-1 ring-slate-200" : "text-slate-600 hover:bg-white/60"
              }`}
            >
              {t}
            </button>
          ))}
        </nav>

        <div className="space-y-4 pb-16">
          {seccion === "general" && (
            <Tarjeta titulo="General" texto="Cómo te habla el bot y cómo interpreta las horas.">
              <Campo etiqueta="Tu nombre (para el bot)">
                <input className="campo" value={form.nombreUsuario} onChange={(e) => set("nombreUsuario", e.target.value)} />
              </Campo>
              <div className="grid gap-4 sm:grid-cols-3">
                <Campo etiqueta="Hora por defecto" ayuda="Si no decís hora (“mañana comprar pilas”)">
                  <input type="time" className="campo" value={form.horaDefecto} onChange={(e) => set("horaDefecto", e.target.value)} />
                </Campo>
                <Campo etiqueta="“A la tarde”">
                  <input type="time" className="campo" value={form.horaTarde} onChange={(e) => set("horaTarde", e.target.value)} />
                </Campo>
                <Campo etiqueta="“A la noche”">
                  <input type="time" className="campo" value={form.horaNoche} onChange={(e) => set("horaNoche", e.target.value)} />
                </Campo>
              </div>
              <Campo etiqueta="Zona horaria">
                <input className="campo" value={form.zonaHoraria} onChange={(e) => set("zonaHoraria", e.target.value)} />
              </Campo>
            </Tarjeta>
          )}

          {seccion === "insistencia" && (
            <Tarjeta titulo="Insistencia" texto="Si no confirmás un aviso, el bot te lo vuelve a mandar. Cada recordatorio puede tener la suya.">
              <Interruptor activo={form.insistenciaActiva} onChange={(v) => set("insistenciaActiva", v)} etiqueta="Insistir si no confirmo" />
              <div className="grid gap-4 sm:grid-cols-2">
                <Campo etiqueta="Cada cuántos minutos">
                  <Numero valor={form.insistenciaIntervaloMin} min={1} onChange={(v) => set("insistenciaIntervaloMin", v)} />
                </Campo>
                <Campo etiqueta="Máximo de insistencias" ayuda="Después se marca como “no confirmado”">
                  <Numero valor={form.insistenciaTope} min={0} onChange={(v) => set("insistenciaTope", v)} />
                </Campo>
              </div>
              <Interruptor activo={form.insistirPrevios} onChange={(v) => set("insistirPrevios", v)} etiqueta="Insistir también en los avisos previos" ayuda="Ej. “1 hora antes”" />
              <Interruptor
                activo={form.avisarEnHoraDefecto}
                onChange={(v) => set("avisarEnHoraDefecto", v)}
                etiqueta="Con avisos previos, avisar también a la hora exacta"
                ayuda="Valor por defecto para los recordatorios nuevos"
              />
            </Tarjeta>
          )}

          {seccion === "silencio" && (
            <Tarjeta titulo="Horario de silencio" texto="En este horario no se mandan avisos; lo que vence se manda al terminar.">
              <Interruptor activo={form.silencioActivo} onChange={(v) => set("silencioActivo", v)} etiqueta="Activar horario de silencio" />
              <div className="grid gap-4 sm:grid-cols-2">
                <Campo etiqueta="Desde">
                  <input type="time" className="campo" value={form.silencioDesde} onChange={(e) => set("silencioDesde", e.target.value)} />
                </Campo>
                <Campo etiqueta="Hasta">
                  <input type="time" className="campo" value={form.silencioHasta} onChange={(e) => set("silencioHasta", e.target.value)} />
                </Campo>
              </div>
              <Campo etiqueta="Días (el día en que empieza el silencio)">
                <Dias valor={form.silencioDias} onChange={(v) => set("silencioDias", v)} />
              </Campo>
              {datos.botSilenciadoHasta && new Date(datos.botSilenciadoHasta) > new Date() && (
                <div className="flex items-center justify-between rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
                  Silencio manual activo (comando “silencio”).
                  <Boton chico onClick={() => put("/api/configuracion", { botSilenciadoHasta: null }).then(recargar)}>
                    Cortar
                  </Boton>
                </div>
              )}
            </Tarjeta>
          )}

          {seccion === "resumen" && (
            <Tarjeta titulo="Resumen diario" texto="Un mensaje por la mañana con lo que tenés para el día.">
              <Interruptor activo={form.resumenActivo} onChange={(v) => set("resumenActivo", v)} etiqueta="Enviar resumen diario" />
              <Campo etiqueta="Hora">
                <input type="time" className="campo sm:w-40" value={form.resumenHora} onChange={(e) => set("resumenHora", e.target.value)} />
              </Campo>
              <Campo etiqueta="Días">
                <Dias valor={form.resumenDias} onChange={(v) => set("resumenDias", v)} />
              </Campo>
              <Interruptor activo={form.resumenIncluirPendientes} onChange={(v) => set("resumenIncluirPendientes", v)} etiqueta="Incluir los pendientes sin confirmar" />
            </Tarjeta>
          )}

          {seccion === "ia" && <SeccionIA datos={datos} form={form} set={set} recargar={recargar} />}

          {seccion === "audios" && <SeccionAudios datos={datos} form={form} set={set} recargar={recargar} />}

          {seccion === "compras" && <SeccionCompras datos={datos} form={form} set={set} recargar={recargar} />}

          {seccion === "mensajes" && (
            <>
              <Tarjeta titulo="Opciones para tocar" texto="Encuestas de WhatsApp en los avisos y cuando el bot te propone algo. Igual podés responder escribiendo.">
                <Interruptor
                  activo={form.usarEncuestas}
                  onChange={(v) => set("usarEncuestas", v)}
                  etiqueta="Mandar opciones para tocar"
                  ayuda="✅ Hecho · ⏰ En 15 min · ⏰ En 1 h · 📅 Mañana"
                />
              </Tarjeta>
              <Tarjeta
                titulo="Mensajes del bot"
                texto="Variables: {titulo} {descripcion} {cuando} {hora} {fecha} {falta} {intento} {tope} {nombre} {ayuda} {lista}; en la confirmación también {intro} y {previos}. Usá *negrita* y _cursiva_ como en WhatsApp."
              >
                {(Object.keys(datos.plantillasDefecto) as (keyof Plantillas)[]).map((k) => (
                  <Campo
                    key={k}
                    etiqueta={
                      { confirmacion: "Confirmación al crear", aviso: "Aviso", previo: "Aviso previo", insistencia: "Insistencia", atrasado: "Aviso atrasado", resumen: "Resumen diario" }[k]
                    }
                  >
                    <textarea
                      className="campo min-h-16 font-mono text-xs"
                      value={form.plantillas[k] ?? datos.plantillasDefecto[k]}
                      onChange={(e) => set("plantillas", { ...form.plantillas, [k]: e.target.value })}
                    />
                    {form.plantillas[k] && form.plantillas[k] !== datos.plantillasDefecto[k] && (
                      <button
                        className="mt-1 flex items-center gap-1 text-xs text-slate-500 hover:text-slate-800"
                        onClick={() => {
                          const p = { ...form.plantillas };
                          delete p[k];
                          set("plantillas", p);
                        }}
                      >
                        <RotateCcw className="size-3" /> Restaurar original
                      </button>
                    )}
                  </Campo>
                ))}
              </Tarjeta>
            </>
          )}

          {seccion === "seguridad" && (
            <>
              <CambiarPin />
              <Tarjeta titulo="Sesión y bloqueo">
                <div className="grid gap-4 sm:grid-cols-3">
                  <Campo etiqueta="Duración de la sesión (días)">
                    <Numero valor={form.sesionDuracionDias} min={1} onChange={(v) => set("sesionDuracionDias", v)} />
                  </Campo>
                  <Campo etiqueta="Intentos antes del bloqueo">
                    <Numero valor={form.maxIntentosLogin} min={1} onChange={(v) => set("maxIntentosLogin", v)} />
                  </Campo>
                  <Campo etiqueta="Minutos de bloqueo">
                    <Numero valor={form.bloqueoMinutos} min={1} onChange={(v) => set("bloqueoMinutos", v)} />
                  </Campo>
                </div>
              </Tarjeta>
            </>
          )}

          {seccion === "respaldo" && <Respaldo />}

          {seccion === "avanzado" && (
            <Tarjeta titulo="Avanzado">
              <div className="grid gap-4 sm:grid-cols-2">
                <Campo etiqueta="Demora mínima antes de responder (ms)" ayuda="Con “escribiendo…”, para parecer natural">
                  <Numero valor={form.demoraMinMs} min={0} onChange={(v) => set("demoraMinMs", v)} />
                </Campo>
                <Campo etiqueta="Demora máxima (ms)">
                  <Numero valor={form.demoraMaxMs} min={0} onChange={(v) => set("demoraMaxMs", v)} />
                </Campo>
                <Campo etiqueta="Alerta de desconexión (min)" ayuda="Se marca en rojo en el panel">
                  <Numero valor={form.alertaDesconexionMin} min={1} onChange={(v) => set("alertaDesconexionMin", v)} />
                </Campo>
                <Campo etiqueta="Considerar atrasado después de (min)">
                  <Numero valor={form.minutosAtrasado} min={1} onChange={(v) => set("minutosAtrasado", v)} />
                </Campo>
                <Campo etiqueta="Tamaño máximo por foto (MB)">
                  <Numero valor={form.fotoMaxMb} min={1} onChange={(v) => set("fotoMaxMb", v)} />
                </Campo>
              </div>
              <Interruptor
                activo={form.limpiezaFotosActiva}
                onChange={(v) => set("limpiezaFotosActiva", v)}
                etiqueta="Borrar fotos viejas"
                ayuda="Solo de recordatorios terminados"
              />
              {form.limpiezaFotosActiva && (
                <Campo etiqueta="Después de (días)">
                  <Numero valor={form.limpiezaFotosDias} min={1} onChange={(v) => set("limpiezaFotosDias", v)} />
                </Campo>
              )}
            </Tarjeta>
          )}
        </div>
      </div>

      {sucio && (
        <div className="fixed inset-x-0 bottom-16 z-40 flex justify-center px-4 md:bottom-6 md:pl-60">
          <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-2.5 shadow-lg">
            <span className="text-sm text-slate-600">Tenés cambios sin guardar</span>
            <Boton chico variante="fantasma" onClick={() => setForm(original)}>
              Descartar
            </Boton>
            <Boton chico variante="primario" icono={<Save className="size-3.5" />} cargando={guardando} onClick={guardar}>
              Guardar
            </Boton>
          </div>
        </div>
      )}
    </div>
  );
}

function Tarjeta({ titulo, texto, children }: { titulo: string; texto?: string; children: ReactNode }) {
  return (
    <section className="tarjeta p-5">
      <h2 className="text-base font-semibold text-slate-900">{titulo}</h2>
      {texto && <p className="mt-0.5 text-sm text-slate-500">{texto}</p>}
      <div className="mt-4 space-y-4">{children}</div>
    </section>
  );
}

function Campo({ etiqueta, ayuda, children }: { etiqueta: ReactNode; ayuda?: string; children: ReactNode }) {
  return (
    <div>
      <label className="etiqueta">{etiqueta}</label>
      {children}
      {ayuda && <p className="mt-1 text-xs text-slate-500">{ayuda}</p>}
    </div>
  );
}

function Numero({ valor, onChange, min }: { valor: number; onChange: (v: number) => void; min?: number }) {
  return <input type="number" min={min} className="campo" value={valor} onChange={(e) => onChange(Number(e.target.value))} />;
}

const NOMBRES_DIAS = ["L", "M", "X", "J", "V", "S", "D"];
function Dias({ valor, onChange }: { valor: number[]; onChange: (v: number[]) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {NOMBRES_DIAS.map((d, i) => {
        const n = i + 1;
        const on = valor.includes(n);
        return (
          <button
            key={n}
            type="button"
            onClick={() => onChange(on ? valor.filter((x) => x !== n) : [...valor, n].sort())}
            className={`size-9 rounded-full text-sm font-semibold ${on ? "bg-marca-oscuro text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}
          >
            {d}
          </button>
        );
      })}
    </div>
  );
}

function SeccionIA({
  datos,
  form,
  set,
  recargar,
}: {
  datos: Cfg;
  form: Editable;
  set: <K extends keyof Editable>(k: K, v: Editable[K]) => void;
  recargar: () => Promise<void>;
}) {
  const accion = useAccion();
  const { datos: uso } = useDatos<{ costoUsd: number; llamadas: number; tokensEntrada: number; tokensSalida: number }>("/api/uso-ia", ["mensajes"]);
  const [clave, setClave] = useState("");
  const [prueba, setPrueba] = useState<{ ok: boolean; mensaje: string; ms: number } | null>(null);
  const [probando, setProbando] = useState(false);
  const conocido = datos.modelos.some((m) => m.id === form.iaModelo);
  const [otro, setOtro] = useState(!conocido);

  return (
    <>
      <Tarjeta titulo="Modelo de IA" texto="Interpreta tus mensajes y lee las fotos. El cambio se usa en el próximo mensaje.">
        <Campo etiqueta="Modelo">
          <select
            className="campo"
            value={otro ? "otro" : form.iaModelo}
            onChange={(e) => {
              if (e.target.value === "otro") return setOtro(true);
              setOtro(false);
              set("iaModelo", e.target.value);
            }}
          >
            {datos.modelos.map((m) => (
              <option key={m.id} value={m.id}>
                {m.nombre} — US$ {m.entrada} / {m.salida} por millón de tokens
              </option>
            ))}
            <option value="otro">Otro (escribir el nombre)</option>
          </select>
          {otro && <input className="campo mt-2 font-mono text-xs" value={form.iaModelo} onChange={(e) => set("iaModelo", e.target.value)} placeholder="claude-…" />}
        </Campo>
        <Campo etiqueta="Esfuerzo de razonamiento" ayuda="Bajo es rápido y barato, y alcanza para recordatorios.">
          <select className="campo" value={form.iaEsfuerzo} onChange={(e) => set("iaEsfuerzo", e.target.value as Editable["iaEsfuerzo"])}>
            <option value="low">Bajo (recomendado)</option>
            <option value="medium">Medio</option>
            <option value="high">Alto</option>
          </select>
        </Campo>
        <div className="flex flex-wrap items-center gap-3">
          <Boton
            icono={<PlugZap className="size-4" />}
            cargando={probando}
            onClick={async () => {
              setProbando(true);
              setPrueba((await accion(() => post<{ ok: boolean; mensaje: string; ms: number }>("/api/configuracion/probar-ia"))) ?? null);
              setProbando(false);
            }}
          >
            Probar conexión
          </Boton>
          {prueba && (
            <span className={`text-sm ${prueba.ok ? "text-marca-profundo" : "text-red-600"}`}>
              {prueba.ok ? "✅" : "❌"} {prueba.mensaje} ({prueba.ms} ms)
            </span>
          )}
        </div>
        <p className="text-xs text-slate-500">Probá con el modelo guardado: si cambiaste el modelo, guardá antes de probar.</p>
      </Tarjeta>

      <Tarjeta titulo="API key de Claude">
        <p className="text-sm text-slate-600">
          {datos.apiKeyPropia
            ? "Usando la API key cargada desde el panel (guardada cifrada)."
            : datos.apiKeyEntorno
              ? "Usando la API key del servidor (archivo .env)."
              : "⚠️ No hay API key configurada: el bot no puede interpretar mensajes."}
        </p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input className="campo font-mono text-xs" type="password" placeholder="sk-ant-…" value={clave} onChange={(e) => setClave(e.target.value)} autoComplete="off" />
          <Boton
            icono={<KeyRound className="size-4" />}
            disabled={!clave.trim()}
            onClick={async () => {
              if (await accion(() => put("/api/configuracion/api-key", { clave }), "API key guardada")) {
                setClave("");
                await recargar();
              }
            }}
          >
            Guardar
          </Boton>
          {datos.apiKeyPropia && (
            <Boton variante="peligro" onClick={async () => (await accion(() => put("/api/configuracion/api-key", { clave: null }), "Se usa la del servidor")) && recargar()}>
              Quitar
            </Boton>
          )}
        </div>
      </Tarjeta>

      <Tarjeta titulo="Gasto de este mes">
        {uso ? (
          <div className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
            <Cifra titulo="Estimado" valor={`US$ ${uso.costoUsd.toFixed(3)}`} />
            <Cifra titulo="Consultas" valor={String(uso.llamadas)} />
            <Cifra titulo="Tokens de entrada" valor={uso.tokensEntrada.toLocaleString("es-AR")} />
            <Cifra titulo="Tokens de salida" valor={uso.tokensSalida.toLocaleString("es-AR")} />
          </div>
        ) : (
          <Cargando />
        )}
        <p className="text-xs text-slate-500">Los comandos rápidos (hoy, lista, listo…) no usan IA.</p>
      </Tarjeta>
    </>
  );
}

function SeccionAudios({
  datos,
  form,
  set,
  recargar,
}: {
  datos: Cfg;
  form: Editable;
  set: <K extends keyof Editable>(k: K, v: Editable[K]) => void;
  recargar: () => Promise<void>;
}) {
  const accion = useAccion();
  const [clave, setClave] = useState("");
  const [prueba, setPrueba] = useState<{ ok: boolean; mensaje: string; ms: number } | null>(null);
  const [probando, setProbando] = useState(false);
  return (
    <>
      <Tarjeta titulo="Audios (Groq)" texto="Los audios que le mandás al bot se pasan a texto con Groq y se procesan como si los hubieras escrito.">
        <p className="text-sm text-slate-600">
          {datos.groqKeyPropia
            ? "Usando la API key de Groq cargada desde el panel (guardada cifrada)."
            : datos.groqKeyEntorno
              ? "Usando la API key de Groq del servidor."
              : "⚠️ Falta la API key de Groq: el bot no puede entender audios."}
        </p>
        <ol className="list-decimal space-y-1 pl-5 text-xs text-slate-500">
          <li>
            Entrá a <b>console.groq.com</b> e iniciá sesión (podés usar tu cuenta de Google).
          </li>
          <li>
            Andá a <b>API Keys → Create API Key</b> y copiala con el botón de copiar (empieza con <code>gsk_</code>).
          </li>
          <li>Pegala acá abajo y tocá Guardar.</li>
        </ol>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input className="campo font-mono text-xs" type="password" placeholder="gsk_…" value={clave} onChange={(e) => setClave(e.target.value)} autoComplete="off" />
          <Boton
            icono={<KeyRound className="size-4" />}
            disabled={!clave.trim()}
            onClick={async () => {
              if (await accion(() => put("/api/configuracion/groq-key", { clave }), "API key de Groq guardada")) {
                setClave("");
                await recargar();
              }
            }}
          >
            Guardar
          </Boton>
          {datos.groqKeyPropia && (
            <Boton variante="peligro" onClick={async () => (await accion(() => put("/api/configuracion/groq-key", { clave: null }), "Clave quitada")) && recargar()}>
              Quitar
            </Boton>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Boton
            icono={<PlugZap className="size-4" />}
            cargando={probando}
            onClick={async () => {
              setProbando(true);
              setPrueba((await accion(() => post<{ ok: boolean; mensaje: string; ms: number }>("/api/configuracion/probar-groq"))) ?? null);
              setProbando(false);
            }}
          >
            Probar conexión
          </Boton>
          {prueba && (
            <span className={`text-sm ${prueba.ok ? "text-marca-profundo" : "text-red-600"}`}>
              {prueba.ok ? "✅" : "❌"} {prueba.mensaje} ({prueba.ms} ms)
            </span>
          )}
        </div>
      </Tarjeta>
      <Tarjeta titulo="Opciones">
        <div className="grid gap-4 sm:grid-cols-2">
          <Campo etiqueta="Modelo de transcripción" ayuda="whisper-large-v3-turbo es rápido y barato; whisper-large-v3 es un poco más preciso.">
            <input className="campo font-mono text-xs" value={form.audioModelo} onChange={(e) => set("audioModelo", e.target.value)} />
          </Campo>
          <Campo etiqueta="Duración máxima (segundos)">
            <Numero valor={form.audioMaxSegundos} min={10} onChange={(v) => set("audioMaxSegundos", v)} />
          </Campo>
        </div>
      </Tarjeta>
    </>
  );
}

function SeccionCompras({
  datos,
  form,
  set,
  recargar,
}: {
  datos: Cfg;
  form: Editable;
  set: <K extends keyof Editable>(k: K, v: Editable[K]) => void;
  recargar: () => Promise<void>;
}) {
  const accion = useAccion();
  const [token, setToken] = useState("");
  const modelo = (k: "comprasModelo" | "comprasModeloReintento", vacio?: string) => (
    <select className="campo" value={form[k]} onChange={(e) => set(k, e.target.value)}>
      {vacio !== undefined && <option value="">{vacio}</option>}
      {datos.modelos.map((m) => (
        <option key={m.id} value={m.id}>
          {m.nombre}
        </option>
      ))}
    </select>
  );
  return (
    <>
      <Tarjeta
        titulo="Lectura de comprobantes"
        texto="Facturas, remitos y tickets de proveedores. Se leen en el grupo marcado como “de compras” (en WhatsApp) o por privado con “factura” en el pie o en PDF."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Campo etiqueta="Modelo para leer" ayuda="Sonnet lee bien los números chicos a buen precio.">
            {modelo("comprasModelo")}
          </Campo>
          <Campo etiqueta="Si las cuentas no cierran, releer con" ayuda="Se queda con la lectura que tenga menos diferencias.">
            {modelo("comprasModeloReintento", "No releer")}
          </Campo>
          <Campo etiqueta="Espera para juntar hojas (segundos)" ayuda="Las fotos de la misma persona que llegan dentro de este tiempo se leen juntas.">
            <Numero valor={form.comprasEsperaSeg} min={0} onChange={(v) => set("comprasEsperaSeg", v)} />
          </Campo>
          <Campo etiqueta="Días que se guardan las fotos y PDF" ayuda="Después se borran; los datos quedan siempre.">
            <Numero valor={form.comprasDiasArchivo} min={1} onChange={(v) => set("comprasDiasArchivo", v)} />
          </Campo>
        </div>
      </Tarjeta>
      <Tarjeta titulo="Instructivo para la IA" texto="Cómo tiene que leer los comprobantes. El formato del JSON se mantiene fijo para que el ERP lo pueda cargar.">
        <textarea
          className="campo min-h-80 font-mono text-xs"
          value={form.comprasInstructivo || datos.instructivoComprasDefecto}
          onChange={(e) => set("comprasInstructivo", e.target.value)}
        />
        {form.comprasInstructivo && form.comprasInstructivo !== datos.instructivoComprasDefecto && (
          <button className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-800" onClick={() => set("comprasInstructivo", "")}>
            <RotateCcw className="size-3" /> Restaurar original
          </button>
        )}
      </Tarjeta>
      <Tarjeta
        titulo="Envío al ERP"
        texto="Al confirmar un comprobante, se manda por POST a esta dirección con el JSON { comprobantes: [...] }. Sin dirección, quedan en Compras para copiar o descargar."
      >
        <Campo etiqueta="Dirección (URL)">
          <input className="campo font-mono text-xs" placeholder="https://api.saboryaroma.com/…" value={form.erpUrl} onChange={(e) => set("erpUrl", e.target.value.trim())} />
        </Campo>
        <Interruptor activo={form.erpEnvioAuto} onChange={(v) => set("erpEnvioAuto", v)} etiqueta="Mandarlo solo al confirmar" ayuda="Si lo apagás, se manda desde Compras con “Enviar al ERP”." />
        <div>
          <label className="etiqueta">Clave del ERP (opcional)</label>
          <p className="mb-2 text-xs text-slate-500">
            {datos.erpTokenCargado ? "Hay una clave cargada (guardada cifrada). Va como “Authorization: Bearer …”." : "Sin clave. Si el ERP pide una, cargala acá."}
          </p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input className="campo font-mono text-xs" type="password" placeholder="Clave o token" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" />
            <Boton
              icono={<KeyRound className="size-4" />}
              disabled={!token.trim()}
              onClick={async () => {
                if (await accion(() => put("/api/configuracion/erp-token", { token }), "Clave del ERP guardada")) {
                  setToken("");
                  await recargar();
                }
              }}
            >
              Guardar
            </Boton>
            {datos.erpTokenCargado && (
              <Boton variante="peligro" onClick={async () => (await accion(() => put("/api/configuracion/erp-token", { token: null }), "Clave quitada")) && recargar()}>
                Quitar
              </Boton>
            )}
          </div>
        </div>
      </Tarjeta>
    </>
  );
}

function Cifra({ titulo, valor }: { titulo: string; valor: string }) {
  return (
    <div>
      <div className="etiqueta">{titulo}</div>
      <div className="text-lg font-semibold text-slate-900">{valor}</div>
    </div>
  );
}

function CambiarPin() {
  const [actual, setActual] = useState("");
  const [nuevo, setNuevo] = useState("");
  const [repetir, setRepetir] = useState("");
  const [error, setError] = useState<string | null>(null);
  const accion = useAccion();
  return (
    <Tarjeta titulo="Cambiar PIN" texto="De 4 a 8 números. Al cambiarlo se cierran todas las sesiones.">
      <div className="grid gap-4 sm:grid-cols-3">
        {[
          ["PIN actual", actual, setActual],
          ["PIN nuevo", nuevo, setNuevo],
          ["Repetir PIN nuevo", repetir, setRepetir],
        ].map(([t, v, fn]) => (
          <Campo key={t as string} etiqueta={t as string}>
            <input
              type="password"
              inputMode="numeric"
              maxLength={8}
              className="campo tracking-widest"
              value={v as string}
              onChange={(e) => (fn as (s: string) => void)(e.target.value.replace(/\D/g, ""))}
            />
          </Campo>
        ))}
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <Boton
        variante="primario"
        onClick={async () => {
          setError(null);
          if (nuevo !== repetir) return setError("Los PIN nuevos no coinciden.");
          if (!/^\d{4,8}$/.test(nuevo)) return setError("El PIN nuevo tiene que tener de 4 a 8 números.");
          if (await accion(() => put("/api/configuracion/pin", { actual, nuevo }), "PIN cambiado. Volvé a ingresar.")) {
            setTimeout(() => (window.location.href = "/"), 1200);
          }
        }}
      >
        Cambiar PIN
      </Boton>
    </Tarjeta>
  );
}

function Respaldo() {
  const archivo = useRef<HTMLInputElement>(null);
  const accion = useAccion();
  const [resultado, setResultado] = useState<string | null>(null);
  return (
    <Tarjeta titulo="Respaldo" texto="Exportá todos los recordatorios en un archivo JSON, o importalos desde un respaldo.">
      <div className="flex flex-wrap gap-2">
        <a href="/api/respaldo" className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50">
          <Download className="size-4" /> Exportar JSON
        </a>
        <Boton icono={<Upload className="size-4" />} onClick={() => archivo.current?.click()}>
          Importar JSON
        </Boton>
      </div>
      {resultado && <p className="text-sm text-marca-profundo">{resultado}</p>}
      <p className="text-xs text-slate-500">Importar agrega los recordatorios a los que ya tenés (no borra nada). Las fotos no se incluyen.</p>
      <input
        ref={archivo}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (!f) return;
          const r = await accion(async () => {
            const json = JSON.parse(await f.text());
            return post<{ programados: number; archivados: number }>("/api/respaldo", { recordatorios: json.recordatorios ?? json });
          });
          if (r) setResultado(`Importados: ${r.programados} activos y ${r.archivados} archivados.`);
        }}
      />
    </Tarjeta>
  );
}
