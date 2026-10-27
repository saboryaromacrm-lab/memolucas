import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { DateTime } from "luxon";
import { Camera, Clock, History, ImageOff, Plus, Repeat, ShoppingCart, X } from "lucide-react";
import { api, del, get, post, put } from "../lib/api";
import { aInputs, ahora, desdeInputs, fechaHora as fmtFechaHora, zona } from "../lib/fechas";
import type { Configuracion, Grupo, Lista, ModoInsistencia, Ocurrencia, RecordatorioDetalle } from "../lib/tipos";
import { Boton, Cargando, Insignia, Interruptor, Modal, useAviso } from "./ui";

// ───────────── Repetición (editor visual ⇄ RRULE) ─────────────
type TipoRep = "no" | "diaria" | "cada_n_dias" | "semanal" | "mensual" | "anual" | "personalizada";
type Rep = {
  tipo: TipoRep;
  intervalo: number;
  dias: string[];
  diaMes: number;
  fin: "nunca" | "veces" | "fecha";
  veces: number;
  hasta: string;
  texto: string;
};
const DIAS = [
  ["MO", "L"],
  ["TU", "M"],
  ["WE", "X"],
  ["TH", "J"],
  ["FR", "V"],
  ["SA", "S"],
  ["SU", "D"],
] as const;
const CLAVES_CONOCIDAS = ["FREQ", "INTERVAL", "BYDAY", "BYMONTHDAY", "COUNT", "UNTIL", "BYHOUR", "BYMINUTE", "BYSECOND", "WKST"];

const repVacia = (fecha: DateTime): Rep => ({
  tipo: "no",
  intervalo: 1,
  dias: [DIAS[fecha.weekday - 1][0]],
  diaMes: fecha.day,
  fin: "nunca",
  veces: 10,
  hasta: fecha.plus({ months: 3 }).toFormat("yyyy-MM-dd"),
  texto: "",
});

function parsearRrule(rrule: string | null, fecha: DateTime): Rep {
  const r = repVacia(fecha);
  if (!rrule) return r;
  const p = Object.fromEntries(rrule.split(";").map((x) => x.split("=") as [string, string]));
  r.texto = rrule;
  if (Object.keys(p).some((k) => !CLAVES_CONOCIDAS.includes(k))) return { ...r, tipo: "personalizada" };
  r.intervalo = Number(p.INTERVAL ?? 1);
  if (p.COUNT) {
    r.fin = "veces";
    r.veces = Number(p.COUNT);
  } else if (p.UNTIL) {
    r.fin = "fecha";
    const u = DateTime.fromFormat(p.UNTIL.slice(0, 8), "yyyyMMdd");
    if (u.isValid) r.hasta = u.toFormat("yyyy-MM-dd");
  }
  switch (p.FREQ) {
    case "DAILY":
      r.tipo = r.intervalo > 1 ? "cada_n_dias" : "diaria";
      break;
    case "WEEKLY":
      r.tipo = "semanal";
      if (p.BYDAY) r.dias = p.BYDAY.split(",").map((d) => d.slice(-2));
      break;
    case "MONTHLY":
      if (p.BYDAY) return { ...r, tipo: "personalizada" };
      r.tipo = "mensual";
      if (p.BYMONTHDAY) r.diaMes = Number(p.BYMONTHDAY.split(",")[0]);
      break;
    case "YEARLY":
      r.tipo = "anual";
      break;
    default:
      r.tipo = "personalizada";
  }
  return r;
}

function armarRrule(r: Rep): string | null {
  if (r.tipo === "no") return null;
  if (r.tipo === "personalizada") return r.texto.trim() || null;
  const p: string[] = [];
  const n = Math.max(1, Math.floor(r.intervalo || 1));
  if (r.tipo === "diaria") p.push("FREQ=DAILY");
  if (r.tipo === "cada_n_dias") p.push("FREQ=DAILY", `INTERVAL=${Math.max(2, n)}`);
  if (r.tipo === "semanal") p.push("FREQ=WEEKLY", `BYDAY=${(r.dias.length ? r.dias : ["MO"]).join(",")}`);
  if (r.tipo === "mensual") p.push("FREQ=MONTHLY", `BYMONTHDAY=${Math.min(31, Math.max(1, r.diaMes))}`);
  if (r.tipo === "anual") p.push("FREQ=YEARLY");
  if (n > 1 && r.tipo !== "cada_n_dias") p.push(`INTERVAL=${n}`);
  if (r.fin === "veces") p.push(`COUNT=${Math.max(1, r.veces)}`);
  if (r.fin === "fecha") {
    const u = DateTime.fromISO(`${r.hasta}T23:59:59`, { zone: zona() }).toUTC();
    if (u.isValid) p.push(`UNTIL=${u.toFormat("yyyyMMdd'T'HHmmss'Z'")}`);
  }
  return p.join(";");
}

// ───────────── Avisos previos ─────────────
const PRESETS = [10, 30, 60, 120, 1440];
const textoPrevio = (m: number) =>
  m % 1440 === 0 ? `${m / 1440} ${m === 1440 ? "día" : "días"}` : m % 60 === 0 ? `${m / 60} ${m === 60 ? "hora" : "horas"}` : `${m} min`;

// ───────────── Contexto ─────────────
type Apertura = { id?: number; fecha?: Date };
const Ctx = createContext<{ abrir: (a: Apertura) => void }>({ abrir: () => {} });
export const useEditor = () => useContext(Ctx);

export function ProveedorEditor({ children }: { children: ReactNode }) {
  const [apertura, setApertura] = useState<Apertura | null>(null);
  const abrir = useCallback((a: Apertura) => setApertura(a), []);
  return (
    <Ctx.Provider value={{ abrir }}>
      {children}
      {apertura && <EditorModal apertura={apertura} onCerrar={() => setApertura(null)} />}
    </Ctx.Provider>
  );
}

type Previa = {
  confirmacion: string;
  previos: { cuando: string; texto: string }[];
  aviso: string | null;
  insistencia: string | null;
  insistenciaResumen: string;
};

function EditorModal({ apertura, onCerrar }: { apertura: Apertura; onCerrar: () => void }) {
  const avisar = useAviso();
  const [cfg, setCfg] = useState<Configuracion | null>(null);
  const [original, setOriginal] = useState<RecordatorioDetalle | null>(null);
  const [cargando, setCargando] = useState(true);
  const [pestana, setPestana] = useState<"datos" | "historial">("datos");

  const [titulo, setTitulo] = useState("");
  const [descripcion, setDescripcion] = useState("");
  const [fecha, setFecha] = useState("");
  const [hora, setHora] = useState("09:00");
  const [rep, setRep] = useState<Rep>(repVacia(ahora()));
  const [previos, setPrevios] = useState<number[]>([]);
  const [avisarEnHora, setAvisarEnHora] = useState(true);
  const [modo, setModo] = useState<ModoInsistencia>("global");
  const [intervalo, setIntervalo] = useState(60);
  const [tope, setTope] = useState(5);
  const [insistirPrevios, setInsistirPrevios] = useState(false);
  const [adjunto, setAdjunto] = useState<{ id: number; url: string } | null>(null);
  const [listaId, setListaId] = useState<number | null>(null);
  const [chatDestino, setChatDestino] = useState<string | null>(null);
  const [grupos, setGrupos] = useState<Grupo[]>([]);
  const [listas, setListas] = useState<Lista[]>([]);
  const [subiendo, setSubiendo] = useState(false);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previa, setPrevia] = useState<Previa | null>(null);
  const [nuevoPrevio, setNuevoPrevio] = useState({ n: 15, unidad: 1 });
  const archivo = useRef<HTMLInputElement>(null);

  useEffect(() => {
    (async () => {
      try {
        const c = await get<Configuracion>("/api/configuracion");
        get<Lista[]>("/api/listas").then(setListas).catch(() => {});
        get<Grupo[]>("/api/grupos").then(setGrupos).catch(() => {});
        setCfg(c);
        setIntervalo(c.insistenciaIntervaloMin);
        setTope(c.insistenciaTope);
        setInsistirPrevios(c.insistirPrevios);
        setAvisarEnHora(c.avisarEnHoraDefecto);
        if (apertura.id) {
          const r = await get<RecordatorioDetalle>(`/api/recordatorios/${apertura.id}`);
          setOriginal(r);
          setTitulo(r.titulo);
          setDescripcion(r.descripcion ?? "");
          const base = r.rrule ? r.proxima : r.fechaHora;
          const i = aInputs(base);
          setFecha(i.fecha);
          setHora(i.hora);
          setRep(parsearRrule(r.rrule, DateTime.fromISO(base).setZone(zona())));
          setPrevios(r.avisosPreviosMin);
          setAvisarEnHora(r.avisarEnHora);
          setModo(r.insistenciaModo);
          if (r.insistenciaIntervaloMin) setIntervalo(r.insistenciaIntervaloMin);
          if (r.insistenciaTope !== null) setTope(r.insistenciaTope);
          if (r.insistirPrevios !== null) setInsistirPrevios(r.insistirPrevios);
          if (r.adjuntoId && r.adjuntoUrl) setAdjunto({ id: r.adjuntoId, url: r.adjuntoUrl });
          setListaId(r.listaId);
          setChatDestino(r.chat);
        } else {
          let f = apertura.fecha ? DateTime.fromJSDate(apertura.fecha).setZone(zona()) : ahora().plus({ hours: 1 }).startOf("hour");
          // Clic en un día del mes (medianoche): usar la hora por defecto.
          if (apertura.fecha && f.hour === 0 && f.minute === 0) {
            const [h, m] = c.horaDefecto.split(":").map(Number);
            f = f.set({ hour: h, minute: m });
          }
          setFecha(f.toFormat("yyyy-MM-dd"));
          setHora(f.toFormat("HH:mm"));
          setRep(repVacia(f));
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "No se pudo cargar");
      } finally {
        setCargando(false);
      }
    })();
  }, [apertura]);

  const fechaDt = useMemo(() => desdeInputs(fecha, hora), [fecha, hora]);
  const rrule = armarRrule(rep);

  const cuerpo = useMemo(
    () => ({
      titulo: titulo.trim(),
      descripcion: descripcion.trim() || null,
      fechaHora: fechaDt.isValid ? fechaDt.toISO() : null,
      rrule,
      avisosPreviosMin: previos,
      avisarEnHora: previos.length ? avisarEnHora : true,
      insistenciaModo: modo,
      insistenciaIntervaloMin: modo === "propia" ? intervalo : null,
      insistenciaTope: modo === "propia" ? tope : null,
      insistirPrevios: modo === "propia" ? insistirPrevios : null,
      adjuntoId: adjunto?.id ?? null,
      listaId,
      chat: chatDestino,
    }),
    [titulo, descripcion, fechaDt, rrule, previos, avisarEnHora, modo, intervalo, tope, insistirPrevios, adjunto, listaId, chatDestino],
  );

  // Vista previa del mensaje (con una pequeña espera mientras se escribe).
  useEffect(() => {
    if (cargando || !cuerpo.fechaHora) return;
    const t = setTimeout(() => {
      post<Previa>("/api/vista-previa", { ...cuerpo, titulo: cuerpo.titulo || "Título del recordatorio" })
        .then(setPrevia)
        .catch(() => setPrevia(null));
    }, 400);
    return () => clearTimeout(t);
  }, [cuerpo, cargando]);

  async function subirFoto(f: File) {
    setSubiendo(true);
    try {
      const fd = new FormData();
      fd.append("archivo", f);
      const r = await api<{ id: number; url: string }>("/api/adjuntos", { formulario: fd });
      setAdjunto(r);
    } catch (e) {
      avisar(e instanceof Error ? e.message : "No se pudo subir la foto", "error");
    } finally {
      setSubiendo(false);
    }
  }

  async function guardar() {
    setError(null);
    if (!cuerpo.titulo) return setError("Poné un título.");
    if (!cuerpo.fechaHora) return setError("La fecha no es válida.");
    setGuardando(true);
    try {
      if (original) {
        if (original.adjuntoId && !adjunto) await del(`/api/recordatorios/${original.id}/adjunto`);
        await put(`/api/recordatorios/${original.id}`, cuerpo);
        avisar("Recordatorio actualizado");
      } else {
        await post("/api/recordatorios", cuerpo);
        avisar("Recordatorio creado");
      }
      onCerrar();
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo guardar");
    } finally {
      setGuardando(false);
    }
  }

  const agregarPrevio = (m: number) => setPrevios((p) => (p.includes(m) || m <= 0 ? p : [...p, m].sort((a, b) => a - b)));

  return (
    <Modal
      abierto
      onCerrar={onCerrar}
      ancho="max-w-4xl"
      titulo={original ? "Editar recordatorio" : "Nuevo recordatorio"}
      pie={
        pestana === "datos" && (
          <>
            <Boton variante="fantasma" onClick={onCerrar}>
              Cancelar
            </Boton>
            <Boton variante="primario" onClick={guardar} cargando={guardando} disabled={cargando}>
              {original ? "Guardar cambios" : "Crear recordatorio"}
            </Boton>
          </>
        )
      }
    >
      {cargando ? (
        <Cargando />
      ) : (
        <>
          {original && (
            <div className="mb-4 flex gap-1 rounded-lg bg-slate-100 p-1 text-sm">
              {(["datos", "historial"] as const).map((p) => (
                <button
                  key={p}
                  onClick={() => setPestana(p)}
                  className={`flex-1 rounded-md px-3 py-1.5 font-medium ${pestana === p ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"}`}
                >
                  {p === "datos" ? "Datos" : `Historial de avisos (${original.ocurrencias.length})`}
                </button>
              ))}
            </div>
          )}
          {pestana === "historial" && original ? (
            <HistorialOcurrencias ocurrencias={original.ocurrencias} />
          ) : (
            <div className="grid gap-6 lg:grid-cols-[1fr_300px]">
              <div className="space-y-5">
                {error && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
                <div>
                  <label className="etiqueta">Título</label>
                  <input className="campo" value={titulo} onChange={(e) => setTitulo(e.target.value)} placeholder="Ej. Pagar la luz" autoFocus />
                </div>
                <div>
                  <label className="etiqueta">Descripción (opcional)</label>
                  <textarea className="campo min-h-16" value={descripcion} onChange={(e) => setDescripcion(e.target.value)} placeholder="Detalles que van en el mensaje" />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="etiqueta">{rep.tipo === "no" ? "Fecha" : "Próxima vez"}</label>
                    <input type="date" className="campo" value={fecha} onChange={(e) => setFecha(e.target.value)} />
                  </div>
                  <div>
                    <label className="etiqueta">Hora</label>
                    <input type="time" className="campo" value={hora} onChange={(e) => setHora(e.target.value)} />
                  </div>
                </div>

                {/* Repetición */}
                <section className="rounded-xl border border-slate-200 p-4">
                  <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-800">
                    <Repeat className="size-4 text-slate-400" /> Repetición
                  </div>
                  <select className="campo" value={rep.tipo} onChange={(e) => setRep({ ...rep, tipo: e.target.value as TipoRep })}>
                    <option value="no">No se repite</option>
                    <option value="diaria">Todos los días</option>
                    <option value="cada_n_dias">Cada N días</option>
                    <option value="semanal">Semanal (elegir días)</option>
                    <option value="mensual">Mensual (día del mes)</option>
                    <option value="anual">Todos los años</option>
                    <option value="personalizada">Personalizada (RRULE)</option>
                  </select>
                  {rep.tipo !== "no" && (
                    <div className="mt-3 space-y-3">
                      {rep.tipo === "cada_n_dias" && (
                        <FilaNumero etiqueta="Cada" valor={rep.intervalo < 2 ? 2 : rep.intervalo} sufijo="días" onChange={(n) => setRep({ ...rep, intervalo: n })} min={2} />
                      )}
                      {(rep.tipo === "semanal" || rep.tipo === "mensual") && (
                        <FilaNumero
                          etiqueta="Cada"
                          valor={rep.intervalo}
                          sufijo={rep.tipo === "semanal" ? "semana(s)" : "mes(es)"}
                          onChange={(n) => setRep({ ...rep, intervalo: n })}
                        />
                      )}
                      {rep.tipo === "semanal" && (
                        <div className="flex flex-wrap gap-1.5">
                          {DIAS.map(([cod, letra]) => {
                            const on = rep.dias.includes(cod);
                            return (
                              <button
                                key={cod}
                                type="button"
                                onClick={() => setRep({ ...rep, dias: on ? rep.dias.filter((d) => d !== cod) : [...rep.dias, cod] })}
                                className={`size-9 rounded-full text-sm font-semibold ${on ? "bg-marca-oscuro text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}
                              >
                                {letra}
                              </button>
                            );
                          })}
                        </div>
                      )}
                      {rep.tipo === "mensual" && (
                        <FilaNumero etiqueta="El día" valor={rep.diaMes} sufijo="de cada mes" min={1} max={31} onChange={(n) => setRep({ ...rep, diaMes: n })} />
                      )}
                      {rep.tipo === "personalizada" && (
                        <div>
                          <input
                            className="campo font-mono text-xs"
                            value={rep.texto}
                            onChange={(e) => setRep({ ...rep, texto: e.target.value })}
                            placeholder="FREQ=WEEKLY;BYDAY=MO,TH"
                          />
                          <p className="mt-1 text-xs text-slate-500">Regla RRULE (RFC 5545). La hora sale del campo Hora.</p>
                        </div>
                      )}
                      {rep.tipo !== "personalizada" && (
                        <div className="flex flex-wrap items-center gap-2 text-sm">
                          <span className="text-slate-600">Termina:</span>
                          <select className="campo w-auto" value={rep.fin} onChange={(e) => setRep({ ...rep, fin: e.target.value as Rep["fin"] })}>
                            <option value="nunca">Nunca</option>
                            <option value="veces">Después de</option>
                            <option value="fecha">El día</option>
                          </select>
                          {rep.fin === "veces" && (
                            <>
                              <input type="number" min={1} className="campo w-20" value={rep.veces} onChange={(e) => setRep({ ...rep, veces: Number(e.target.value) })} />
                              <span className="text-slate-600">veces</span>
                            </>
                          )}
                          {rep.fin === "fecha" && <input type="date" className="campo w-auto" value={rep.hasta} onChange={(e) => setRep({ ...rep, hasta: e.target.value })} />}
                        </div>
                      )}
                    </div>
                  )}
                </section>

                {/* Avisos previos */}
                <section className="rounded-xl border border-slate-200 p-4">
                  <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-800">
                    <Clock className="size-4 text-slate-400" /> Avisos previos
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {previos.map((m) => (
                      <Insignia key={m} className="bg-marca-suave py-1 pl-2.5 pr-1 text-marca-profundo">
                        {textoPrevio(m)} antes
                        <button onClick={() => setPrevios(previos.filter((x) => x !== m))} className="rounded-full p-0.5 hover:bg-marca/20" aria-label="Quitar">
                          <X className="size-3" />
                        </button>
                      </Insignia>
                    ))}
                    {!previos.length && <span className="text-sm text-slate-500">Sin avisos previos.</span>}
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-1.5">
                    {PRESETS.filter((m) => !previos.includes(m)).map((m) => (
                      <Boton key={m} chico icono={<Plus className="size-3" />} onClick={() => agregarPrevio(m)}>
                        {textoPrevio(m)}
                      </Boton>
                    ))}
                    <span className="ml-1 flex items-center gap-1">
                      <input
                        type="number"
                        min={1}
                        className="campo w-16 px-2 py-1 text-xs"
                        value={nuevoPrevio.n}
                        onChange={(e) => setNuevoPrevio({ ...nuevoPrevio, n: Number(e.target.value) })}
                      />
                      <select
                        className="campo w-auto px-2 py-1 text-xs"
                        value={nuevoPrevio.unidad}
                        onChange={(e) => setNuevoPrevio({ ...nuevoPrevio, unidad: Number(e.target.value) })}
                      >
                        <option value={1}>min</option>
                        <option value={60}>horas</option>
                        <option value={1440}>días</option>
                      </select>
                      <Boton chico onClick={() => agregarPrevio(nuevoPrevio.n * nuevoPrevio.unidad)}>
                        Agregar
                      </Boton>
                    </span>
                  </div>
                  {previos.length > 0 && (
                    <div className="mt-3">
                      <Interruptor activo={avisarEnHora} onChange={setAvisarEnHora} etiqueta="Avisar también a la hora exacta" />
                    </div>
                  )}
                </section>

                {/* Insistencia */}
                <section className="rounded-xl border border-slate-200 p-4">
                  <div className="mb-3 text-sm font-semibold text-slate-800">Insistencia si no confirmás</div>
                  <select className="campo" value={modo} onChange={(e) => setModo(e.target.value as ModoInsistencia)}>
                    <option value="global">
                      Usar la general ({cfg?.insistenciaActiva ? `cada ${cfg.insistenciaIntervaloMin} min, hasta ${cfg.insistenciaTope} veces` : "desactivada"})
                    </option>
                    <option value="propia">Personalizada para este recordatorio</option>
                    <option value="off">Sin insistencia</option>
                  </select>
                  {modo === "propia" && (
                    <div className="mt-3 space-y-2">
                      <FilaNumero etiqueta="Insistir cada" valor={intervalo} sufijo="minutos" min={1} onChange={setIntervalo} />
                      <FilaNumero etiqueta="Hasta" valor={tope} sufijo="veces (sin contar el primer aviso)" min={0} onChange={setTope} />
                      <Interruptor activo={insistirPrevios} onChange={setInsistirPrevios} etiqueta="Insistir también en los avisos previos" />
                    </div>
                  )}
                </section>

                {/* Dónde avisa */}
                {(grupos.length > 0 || chatDestino) && (
                  <section className="rounded-xl border border-slate-200 p-4">
                    <div className="mb-3 text-sm font-semibold text-slate-800">Dónde avisa</div>
                    <select className="campo" value={chatDestino ?? ""} onChange={(e) => setChatDestino(e.target.value || null)}>
                      <option value="">Mi WhatsApp (privado)</option>
                      {grupos.map((g) => (
                        <option key={g.jid} value={g.jid}>
                          👨‍👩‍👧 Grupo {g.nombre}
                        </option>
                      ))}
                    </select>
                  </section>
                )}

                {/* Lista */}
                {(listas.length > 0 || listaId) && (
                  <section className="rounded-xl border border-slate-200 p-4">
                    <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-800">
                      <ShoppingCart className="size-4 text-slate-400" /> Adjuntar lista al aviso
                    </div>
                    <select className="campo" value={listaId ?? ""} onChange={(e) => setListaId(e.target.value ? Number(e.target.value) : null)}>
                      <option value="">Ninguna</option>
                      {listas.filter((l) => (l.chat ?? null) === chatDestino).map((l) => (
                        <option key={l.id} value={l.id}>
                          {l.nombre} ({l.items.length})
                        </option>
                      ))}
                    </select>
                    <p className="mt-1 text-xs text-slate-500">El aviso trae los ítems que falten en ese momento.</p>
                  </section>
                )}

                {/* Foto */}
                <section className="rounded-xl border border-slate-200 p-4">
                  <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-800">
                    <Camera className="size-4 text-slate-400" /> Foto adjunta
                  </div>
                  {adjunto ? (
                    <div className="flex items-start gap-3">
                      <a href={adjunto.url} target="_blank" rel="noreferrer">
                        <img src={adjunto.url} alt="Adjunto" className="h-28 w-28 rounded-lg border border-slate-200 object-cover" />
                      </a>
                      <div className="space-y-2">
                        <p className="text-sm text-slate-600">Se reenvía junto con el aviso.</p>
                        <Boton chico variante="peligro" icono={<ImageOff className="size-3.5" />} onClick={() => setAdjunto(null)}>
                          Quitar foto
                        </Boton>
                      </div>
                    </div>
                  ) : (
                    <Boton chico cargando={subiendo} icono={<Camera className="size-3.5" />} onClick={() => archivo.current?.click()}>
                      Adjuntar foto
                    </Boton>
                  )}
                  <input
                    ref={archivo}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void subirFoto(f);
                      e.target.value = "";
                    }}
                  />
                </section>
              </div>

              {/* Vista previa */}
              <aside className="lg:sticky lg:top-0 lg:self-start">
                <div className="etiqueta">Vista previa</div>
                <div className="space-y-2 rounded-xl bg-[#efeae2] p-3">
                  {previa ? (
                    <>
                      <p className="rounded-md bg-white/70 px-2 py-1 text-center text-[11px] text-slate-600">{previa.confirmacion}</p>
                      {previa.previos.map((p) => (
                        <Burbuja key={p.cuando} etiqueta={`Aviso previo · ${fmtFechaHora(p.cuando)}`} texto={p.texto} foto={null} />
                      ))}
                      {previa.aviso && <Burbuja etiqueta="Aviso" texto={previa.aviso} foto={adjunto?.url ?? null} />}
                      {previa.insistencia && <Burbuja etiqueta="Si no confirmás" texto={previa.insistencia} foto={null} />}
                      <p className="px-1 text-[11px] text-slate-600">{previa.insistenciaResumen}</p>
                    </>
                  ) : (
                    <p className="py-6 text-center text-xs text-slate-500">Completá los datos para ver cómo llega.</p>
                  )}
                </div>
              </aside>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}

/** Formato WhatsApp básico: *negrita* y _cursiva_. */
export function TextoWhatsapp({ texto }: { texto: string }) {
  // Primero la cursiva (puede tener negritas adentro), después la negrita.
  const partes = texto.split(/(_[^_\n]+_|\*[^*\n]+\*)/g);
  return (
    <>
      {partes.map((p, i) =>
        p.startsWith("*") && p.endsWith("*") && p.length > 2 ? (
          <strong key={i}>{p.slice(1, -1)}</strong>
        ) : p.startsWith("_") && p.endsWith("_") && p.length > 2 ? (
          <em key={i}>
            <TextoWhatsapp texto={p.slice(1, -1)} />
          </em>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

function Burbuja({ etiqueta, texto, foto }: { etiqueta: string; texto: string; foto: string | null }) {
  return (
    <div>
      <div className="mb-0.5 px-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">{etiqueta}</div>
      <div className="burbuja bg-white text-slate-800">
        {foto && <img src={foto} alt="" className="mb-1.5 max-h-40 w-full rounded object-cover" />}
        <TextoWhatsapp texto={texto} />
      </div>
    </div>
  );
}

function FilaNumero({
  etiqueta,
  valor,
  sufijo,
  onChange,
  min = 1,
  max,
}: {
  etiqueta: string;
  valor: number;
  sufijo: string;
  onChange: (n: number) => void;
  min?: number;
  max?: number;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm text-slate-600">
      <span>{etiqueta}</span>
      <input type="number" min={min} max={max} className="campo w-20" value={valor} onChange={(e) => onChange(Number(e.target.value))} />
      <span>{sufijo}</span>
    </div>
  );
}

const ESTADO_OC: Record<Ocurrencia["estado"], [string, string]> = {
  pendiente: ["Pendiente", "bg-slate-100 text-slate-600"],
  enviada: ["Enviado", "bg-blue-50 text-blue-700"],
  confirmada: ["Confirmado", "bg-marca-suave text-marca-profundo"],
  no_confirmada: ["Sin confirmar", "bg-red-50 text-red-700"],
  cancelada: ["Cancelado", "bg-slate-100 text-slate-400"],
};

export function HistorialOcurrencias({ ocurrencias }: { ocurrencias: Ocurrencia[] }) {
  if (!ocurrencias.length) return <p className="py-6 text-center text-sm text-slate-500">Todavía no hay avisos.</p>;
  return (
    <div className="space-y-2">
      {ocurrencias.map((o) => {
        const [txt, cls] = ESTADO_OC[o.estado];
        return (
          <div key={o.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm">
            <div>
              <div className="font-medium text-slate-800">
                {o.tipo === "previo" ? `Aviso previo (${textoPrevio(o.minutosAntes)} antes)` : "Aviso"} · {fmtFechaHora(o.programadaPara)}
              </div>
              <div className="text-xs text-slate-500">
                {o.enviadaEn ? `Enviado ${fmtFechaHora(o.enviadaEn)}` : "Sin enviar"}
                {o.intentos > 1 && ` · insistió ${o.intentos - 1} ${o.intentos - 1 === 1 ? "vez" : "veces"}`}
                {o.confirmadaEn && ` · confirmado ${fmtFechaHora(o.confirmadaEn)}`}
                {o.pospuestaHasta && ` · pospuesto a ${fmtFechaHora(o.pospuestaHasta)}`}
                {o.atrasada && " · llegó atrasado"}
              </div>
            </div>
            <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>
              <History className="size-3" />
              {txt}
            </span>
          </div>
        );
      })}
    </div>
  );
}
