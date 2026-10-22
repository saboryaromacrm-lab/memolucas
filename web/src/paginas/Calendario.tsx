import { useEffect, useRef } from "react";
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
import { Encabezado, useAccion } from "../componentes/ui";
import { get, patch } from "../lib/api";
import { zona } from "../lib/fechas";
import { useCambios } from "../lib/vivo";

type EventoApi = { id: string; recordatorioId: number; titulo: string; inicio: string; estado: string; recurrente: boolean; conFoto: boolean };

const COLORES: Record<string, string> = {
  activo: "#128c7e",
  pausado: "#d97706",
  cumplido: "#94a3b8",
  no_confirmado: "#dc2626",
};

export function Calendario() {
  const ref = useRef<CalendarRef>(null);
  const editor = useEditor();
  const accion = useAccion();
  const movil = typeof window !== "undefined" && window.innerWidth < 640;

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
        <FullCalendar
          ref={ref}
          plugins={[classicTheme, dayGridPlugin, timeGridPlugin, interactionPlugin]}
          locale={esLocale}
          timeZone={zona()}
          initialView={movil ? "timeGridDay" : "dayGridMonth"}
          headerToolbar={
            movil
              ? { start: "prev,next today", center: "", end: "dayGridMonth,timeGridWeek,timeGridDay" }
              : { start: "prev,next today", center: "title", end: "dayGridMonth,timeGridWeek,timeGridDay" }
          }
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
      </div>
    </div>
  );
}
