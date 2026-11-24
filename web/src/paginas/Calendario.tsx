import { useEffect, useRef, useState } from "react";
import { CalendarDays, Camera, ChevronLeft, ChevronRight, Repeat } from "lucide-react";
import FullCalendar, { type CalendarRef, type EventInput, type EventSourceFuncInfo } from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/react/daygrid";
import interactionPlugin from "@fullcalendar/react/interaction";
import timeGridPlugin from "@fullcalendar/react/timegrid";
import classicTheme from "@fullcalendar/react/themes/classic";
import esLocale from "@fullcalendar/react/locales/es";
import "@fullcalendar/react/skeleton.css";
import "@fullcalendar/react/themes/classic/theme.css";
import "@fullcalendar/react/themes/classic/palette.css";
import { useEditor } from "../componentes/Editor";
import { Cargando, Encabezado, Vacio, useAccion } from "../componentes/ui";
import { get, patch } from "../lib/api";
import { ahora, enZona, hora, zona } from "../lib/fechas";
import { useCambios, useDatos } from "../lib/vivo";

type EventoApi = { id: string; recordatorioId: number; titulo: string; inicio: string; estado: string; recurrente: boolean; conFoto: boolean };

const COLORES: Record<string, string> = {
  activo: "#128c7e",
  pausado: "#d97706",
  cumplido: "#94a3b8",
  no_confirmado: "#dc2626",
};

const DIAS_AGENDA = 30;

/** Las vistas, en el orden en que se ofrecen. "agenda": lo que viene, día por día (la cómoda en el celular). */
const VISTAS = [
  ["agenda", "Agenda"],
  ["timeGridDay", "Día"],
  ["timeGridWeek", "Semana"],
  ["dayGridMonth", "Mes"],
] as const;
type Vista = (typeof VISTAS)[number][0];

export function Calendario() {
  const ref = useRef<CalendarRef>(null);
  const editor = useEditor();
  const accion = useAccion();
  const movil = typeof window !== "undefined" && window.innerWidth < 640;
  const [vista, setVista] = useState<Vista>(movil ? "agenda" : "dayGridMonth");
  const [titulo, setTitulo] = useState("");
  const [desdeAgenda, setDesdeAgenda] = useState(() => ahora().startOf("day"));
  const api = () => ref.current?.getApi();
  const agenda = vista === "agenda";
  // Las flechas mueven la agenda de a 30 días, o el calendario según su vista.
  const mover = (paso: -1 | 0 | 1) => {
    if (!agenda) return paso === 0 ? api()?.today() : paso < 0 ? api()?.prev() : api()?.next();
    setDesdeAgenda((d) => (paso === 0 ? ahora().startOf("day") : d.plus({ days: paso * DIAS_AGENDA })));
  };
  const hastaAgenda = desdeAgenda.plus({ days: DIAS_AGENDA });

  // Se actualiza solo cuando cambia algo (por WhatsApp o desde otra pestaña).
  useCambios(["recordatorios"], () => ref.current?.getApi().refetchEvents());
  useEffect(() => {
    const t = setInterval(() => ref.current?.getApi().refetchEvents(), 5 * 60_000);
    return () => clearInterval(t);
  }, []);

  return (
    <div>
      <Encabezado titulo="Calendario" subtitulo="Arrastrá un recordatorio para cambiarle la fecha. Tocá un hueco para crear uno." />
      <div className="calendario tarjeta p-2 sm:p-4">
        {/* Barra propia: qué estás viendo, flechas grandes y las vistas. */}
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1">
            <button onClick={() => mover(-1)} aria-label="Anterior" className="flex size-10 items-center justify-center rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50">
              <ChevronLeft className="size-5" />
            </button>
            <button onClick={() => mover(0)} className="h-10 rounded-lg border border-slate-200 px-3 text-sm font-medium text-slate-700 hover:bg-slate-50">
              Hoy
            </button>
            <button onClick={() => mover(1)} aria-label="Siguiente" className="flex size-10 items-center justify-center rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50">
              <ChevronRight className="size-5" />
            </button>
          </div>
          <h2 className="min-w-0 flex-1 truncate text-base font-semibold text-slate-900 first-letter:uppercase">
            {agenda ? `${desdeAgenda.toFormat("d LLL")} – ${hastaAgenda.minus({ days: 1 }).toFormat("d LLL")}` : titulo}
          </h2>
          <div className="flex w-full rounded-lg bg-slate-100 p-1 text-sm sm:w-auto">
            {VISTAS.map(([v, texto]) => (
              <button
                key={v}
                onClick={() => (v !== "agenda" && api()?.changeView(v), setVista(v))}
                className={`h-9 flex-1 rounded-md px-3 font-medium sm:flex-none ${vista === v ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"}`}
              >
                {texto}
              </button>
            ))}
          </div>
        </div>
        {agenda ? (
          <Agenda desde={desdeAgenda.toISO()!} hasta={hastaAgenda.toISO()!} />
        ) : (
          <FullCalendar
            ref={ref}
            plugins={[classicTheme, dayGridPlugin, timeGridPlugin, interactionPlugin]}
            locale={esLocale}
            timeZone={zona()}
            initialView={vista}
            headerToolbar={false}
            datesSet={(info) => setTitulo(info.view.title)}
            height="auto"
            nowIndicator
            editable
            eventDurationEditable={false}
            dayMaxEvents={4}
            slotMinTime="06:00:00"
            scrollTime="08:00:00"
            eventTimeFormat={{ hour: "numeric", minute: "2-digit", hour12: false }}
            events={async (info: EventSourceFuncInfo): Promise<EventInput[]> => {
              const evs = await get<EventoApi[]>(`/api/calendario?desde=${encodeURIComponent(info.start.toISOString())}&hasta=${encodeURIComponent(info.end.toISOString())}`);
              return evs.map((e) => ({
                id: e.id,
                title: `${e.recurrente ? "🔁 " : ""}${e.conFoto ? "📎 " : ""}${e.titulo}`,
                start: e.inicio,
                allDay: false,
                color: COLORES[e.estado] ?? COLORES.activo,
                // Los recurrentes se cambian desde el editor (mover uno movería toda la serie).
                editable: !e.recurrente && e.estado === "activo",
                extendedProps: { recordatorioId: e.recordatorioId },
              }));
            }}
            eventClick={(info) => editor.abrir({ id: info.event.extendedProps.recordatorioId as number })}
            dateClick={(info) => editor.abrir({ fecha: info.date })}
            eventDrop={async (info) => {
              const ok = await accion(
                () => patch(`/api/recordatorios/${info.event.extendedProps.recordatorioId}/mover`, { fechaHora: info.event.start!.toISOString() }),
                "Fecha cambiada",
              );
              if (!ok) info.revert();
            }}
          />
        )}
      </div>
    </div>
  );
}

/** Lo que viene, día por día: hora, título completo y si se repite o tiene foto. Tocar uno lo abre. */
function Agenda({ desde, hasta }: { desde: string; hasta: string }) {
  const editor = useEditor();
  const { datos } = useDatos<EventoApi[]>(`/api/calendario?desde=${encodeURIComponent(desde)}&hasta=${encodeURIComponent(hasta)}`, ["recordatorios"]);
  if (!datos) return <Cargando />;
  if (!datos.length) return <Vacio icono={<CalendarDays className="size-10" />} titulo="Nada en estos días" texto="Tocá + para crear un recordatorio." />;
  const hoy = ahora().startOf("day");
  const dias = new Map<string, EventoApi[]>();
  for (const e of [...datos].sort((a, b) => a.inicio.localeCompare(b.inicio))) {
    const k = enZona(e.inicio).toISODate()!;
    dias.set(k, [...(dias.get(k) ?? []), e]);
  }
  /** "Hoy", "Mañana" o el día, a partir de un recordatorio de ese día (en tu zona horaria). */
  const nombreDia = (inicio: string) => {
    const d = enZona(inicio).startOf("day");
    const diff = Math.round(d.diff(hoy, "days").days);
    return diff === 0 ? "Hoy" : diff === 1 ? "Mañana" : d.toFormat("cccc d 'de' LLLL");
  };
  return (
    <div className="space-y-4">
      {[...dias].map(([dia, evs]) => (
        <section key={dia}>
          <h3 className="mb-1 px-1 text-xs font-semibold uppercase tracking-wide text-slate-500">{nombreDia(evs[0].inicio)}</h3>
          <ul className="divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-100">
            {evs.map((e) => (
              <li key={e.id}>
                <button onClick={() => editor.abrir({ id: e.recordatorioId })} className="flex w-full items-center gap-3 px-3 py-3 text-left hover:bg-slate-50">
                  <span className="h-8 w-1 shrink-0 rounded-full" style={{ background: COLORES[e.estado] ?? COLORES.activo }} />
                  <span className="w-11 shrink-0 text-sm font-semibold tabular-nums text-marca-profundo">{hora(e.inicio)}</span>
                  <span className="line-clamp-2 min-w-0 flex-1 break-words text-sm text-slate-800">{e.titulo}</span>
                  <span className="flex shrink-0 gap-1 text-slate-400">
                    {e.recurrente && <Repeat className="size-4" />}
                    {e.conFoto && <Camera className="size-4" />}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
