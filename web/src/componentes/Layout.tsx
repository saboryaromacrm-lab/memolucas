import { useEffect, useState, type ReactNode } from "react";
import { NavLink, useLocation } from "react-router";
import { Bell, Calculator, CalendarDays, CreditCard, History, LayoutDashboard, Link2, ListChecks, LogOut, Menu, MessageCircle, NotebookPen, Plus, Repeat, ScrollText, Settings, Sparkles, StickyNote, Wallet, X } from "lucide-react";
import { post } from "../lib/api";
import { useSuscripciones } from "../lib/suscripciones";
import { useConexionVivo, useDatos } from "../lib/vivo";
import type { InfoWhatsapp } from "../lib/tipos";
import { useEditor } from "./Editor";
import { Asistente } from "./Asistente";
import { Links } from "./Links";

const SECCIONES = [
  { a: "/", texto: "Inicio", icono: LayoutDashboard },
  { a: "/recordatorios", texto: "Recordatorios", icono: ListChecks },
  // Notas y Calendario van en la barra inferior del celular (posiciones 3 y 4).
  { a: "/notas", texto: "Notas", icono: StickyNote },
  { a: "/calendario", texto: "Calendario", icono: CalendarDays },
  { a: "/bloc", texto: "Bloc", icono: NotebookPen },
  { a: "/pagos", texto: "Pagos", icono: Wallet },
  { a: "/calculadoras", texto: "Calculadoras", icono: Calculator },
  { a: "/suscripciones", texto: "Suscripciones", icono: Repeat },
  { a: "/tarjetas", texto: "Tarjetas", icono: CreditCard },
  { a: "/whatsapp", texto: "WhatsApp", icono: MessageCircle },
  { a: "/historial", texto: "Historial", icono: History },
  { a: "/configuracion", texto: "Configuración", icono: Settings },
  { a: "/logs", texto: "Logs", icono: ScrollText },
];

const TEXTO_WA: Record<InfoWhatsapp["estado"], string> = {
  iniciando: "Iniciando",
  conectando: "Conectando",
  esperando_qr: "Esperando QR",
  conectado: "Conectado",
  desconectado: "Desconectado",
  sesion_cerrada: "Sin vincular",
};

export function ChipWhatsapp({ info, compacto }: { info: InfoWhatsapp | null; compacto?: boolean }) {
  if (!info) return null;
  const ok = info.estado === "conectado";
  const color = ok ? "bg-marca" : info.alerta ? "bg-red-500" : "bg-amber-400";
  return (
    <NavLink
      to="/whatsapp"
      className={`inline-flex items-center gap-2 rounded-full text-xs font-medium ${
        compacto ? "size-10 justify-center" : `border px-2.5 py-1 ${info.alerta ? "border-red-200 bg-red-50 text-red-700" : "border-slate-200 bg-white text-slate-600"}`
      }`}
      title={`WhatsApp: ${TEXTO_WA[info.estado]}`}
    >
      <span className={`relative flex size-2.5`}>
        {!ok && <span className={`absolute inline-flex size-full animate-ping rounded-full opacity-60 ${color}`} />}
        <span className={`relative inline-flex size-2.5 rounded-full ${color}`} />
      </span>
      {!compacto && <span>WhatsApp: {TEXTO_WA[info.estado]}</span>}
    </NavLink>
  );
}

function Marca() {
  return (
    <div className="flex items-center gap-2.5">
      <img src="/icono.svg" alt="" className="size-8 rounded-lg" />
      <div className="leading-tight">
        <div className="text-[15px] font-semibold text-slate-900">Memolucas</div>
        <div className="hidden text-[11px] text-slate-500 md:block">Recordatorios por WhatsApp</div>
      </div>
    </div>
  );
}

async function salir() {
  await post("/api/auth/logout");
  window.location.href = "/";
}

export function Layout({ children }: { children: ReactNode }) {
  const { datos: wa } = useDatos<InfoWhatsapp>("/api/whatsapp", ["whatsapp", "mensajes"]);
  const vivo = useConexionVivo();
  const editor = useEditor();
  // "Mis links" y el asistente: botones siempre a mano, Ctrl+K y Ctrl+J (⌘ en Mac).
  const [links, setLinks] = useState(false);
  const [asistente, setAsistente] = useState(false);
  useEffect(() => {
    const atajo = (e: KeyboardEvent) => {
      const abrir = e.ctrlKey || e.metaKey ? ({ k: setLinks, j: setAsistente } as Record<string, (v: boolean) => void>)[e.key.toLowerCase()] : undefined;
      if (abrir) {
        e.preventDefault();
        abrir(true);
      }
    };
    window.addEventListener("keydown", atajo);
    return () => window.removeEventListener("keydown", atajo);
  }, []);
  const [menu, setMenu] = useState(false);
  const loc = useLocation();
  // Numerito en el menú: lo que hay que mirar (por ahora, las suscripciones que vencen pronto).
  const { porVencer } = useSuscripciones();
  const avisos: Partial<Record<string, number>> = { "/suscripciones": porVencer.length };
  const hayAvisos = Object.values(avisos).some(Boolean);

  const enlace = (s: (typeof SECCIONES)[number], onClick?: () => void) => (
    <NavLink
      key={s.a}
      to={s.a}
      end={s.a === "/"}
      onClick={onClick}
      className={({ isActive }) =>
        `flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition ${
          isActive ? "bg-marca-suave text-marca-profundo" : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
        }`
      }
    >
      <s.icono className="size-[18px]" />
      {s.texto}
      {!!avisos[s.a] && <span className="ml-auto min-w-5 rounded-full bg-amber-400 px-1.5 text-center text-[11px] font-bold leading-5 text-white">{avisos[s.a]}</span>}
    </NavLink>
  );

  return (
    <div className="min-h-full md:pl-60">
      {/* Barra lateral (escritorio) */}
      <aside className="fixed inset-y-0 left-0 hidden w-60 flex-col border-r border-slate-200 bg-white md:flex">
        <div className="px-5 py-5">
          <Marca />
        </div>
        <div className="px-3">
          <button
            onClick={() => editor.abrir({})}
            className="mb-4 flex w-full items-center justify-center gap-2 rounded-lg bg-marca-oscuro px-3 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-marca-profundo"
          >
            <Plus className="size-4" /> Nuevo recordatorio
          </button>
          <div className="-mt-2 mb-4 grid gap-1.5">
            {(
              [
                [setAsistente, Sparkles, "Asistente", "Ctrl J"],
                [setLinks, Link2, "Links", "Ctrl K"],
              ] as const
            ).map(([abrir, Icono, texto, atajo]) => (
              <button
                key={texto}
                onClick={() => abrir(true)}
                className="flex w-full items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                <Icono className="size-4 text-marca-oscuro" /> {texto}
                <kbd className="ml-auto rounded border border-slate-200 px-1.5 text-[10px] font-medium text-slate-400">{atajo}</kbd>
              </button>
            ))}
          </div>
        </div>
        <nav className="flex flex-1 flex-col gap-0.5 px-3">{SECCIONES.map((s) => enlace(s))}</nav>
        <div className="space-y-3 border-t border-slate-200 p-4">
          <ChipWhatsapp info={wa} />
          <div className="flex items-center justify-between text-xs text-slate-500">
            <span className="flex items-center gap-1.5" title="Actualización en vivo">
              <span className={`size-1.5 rounded-full ${vivo ? "bg-marca" : "bg-slate-300"}`} />
              {vivo ? "En vivo" : "Reconectando…"}
            </span>
            <button onClick={salir} className="flex items-center gap-1 hover:text-slate-800">
              <LogOut className="size-3.5" /> Salir
            </button>
          </div>
        </div>
      </aside>

      {/* Barra superior (celular) */}
      <header className="sticky top-0 z-30 flex items-center justify-between border-b border-slate-200 bg-white/95 px-4 py-1.5 backdrop-blur md:hidden">
        <Marca />
        <div className="flex items-center gap-0.5">
          <ChipWhatsapp info={wa} compacto />
          <button onClick={() => setAsistente(true)} className="flex size-10 items-center justify-center rounded-lg text-marca-oscuro hover:bg-slate-100" aria-label="Asistente">
            <Sparkles className="size-5" />
          </button>
          <button onClick={() => setLinks(true)} className="flex size-10 items-center justify-center rounded-lg text-marca-oscuro hover:bg-slate-100" aria-label="Mis links">
            <Link2 className="size-5" />
          </button>
          <button onClick={() => setMenu(true)} className="relative flex size-10 items-center justify-center rounded-lg text-slate-600 hover:bg-slate-100" aria-label="Menú">
            <Menu className="size-5" />
            {hayAvisos && <span className="absolute right-1.5 top-1.5 size-2.5 rounded-full bg-amber-400 ring-2 ring-white" />}
          </button>
        </div>
      </header>

      {wa?.alerta && (
        <div className="border-b border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700 md:px-8">
          <Bell className="mr-1.5 inline size-4" />
          WhatsApp está desconectado hace {wa.minutosCaido} min. Los avisos se envían cuando vuelva.{" "}
          <NavLink to="/whatsapp" className="font-semibold underline">
            Ver conexión
          </NavLink>
        </div>
      )}

      {/* El Bloc usa todo el ancho, como un editor; el resto, una columna cómoda de leer. */}
      <main key={loc.pathname} className={`mx-auto px-4 pb-28 pt-5 md:px-8 md:pb-10 md:pt-8 ${loc.pathname === "/bloc" ? "max-w-none" : "max-w-6xl"}`}>
        {children}
      </main>

      {/* Navegación inferior (celular) */}
      <nav className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-slate-200 bg-white pb-[env(safe-area-inset-bottom)] md:hidden">
        {SECCIONES.slice(0, 2).map((s) => (
          <NavLink
            key={s.a}
            to={s.a}
            end={s.a === "/"}
            className={({ isActive }) => `flex flex-col items-center gap-0.5 py-2 text-[11px] ${isActive ? "text-marca-oscuro" : "text-slate-500"}`}
          >
            <s.icono className="size-5" />
            {s.texto}
          </NavLink>
        ))}
        <button onClick={() => editor.abrir({})} className="flex flex-col items-center justify-center" aria-label="Nuevo recordatorio">
          <span className="-mt-5 flex size-12 items-center justify-center rounded-full bg-marca-oscuro text-white shadow-lg ring-4 ring-white">
            <Plus className="size-6" />
          </span>
        </button>
        {SECCIONES.slice(2, 4).map((s) => (
          <NavLink
            key={s.a}
            to={s.a}
            className={({ isActive }) => `flex flex-col items-center gap-0.5 py-2 text-[11px] ${isActive ? "text-marca-oscuro" : "text-slate-500"}`}
          >
            <s.icono className="size-5" />
            {s.texto}
          </NavLink>
        ))}
      </nav>

      {links && <Links onCerrar={() => setLinks(false)} />}
      {asistente && <Asistente onCerrar={() => setAsistente(false)} />}

      {/* Menú completo (celular) */}
      {menu && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 md:hidden" onClick={() => setMenu(false)}>
          <div className="absolute inset-y-0 right-0 flex w-72 flex-col bg-white p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-4 flex items-center justify-between">
              <Marca />
              <button onClick={() => setMenu(false)} className="flex size-10 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100" aria-label="Cerrar">
                <X className="size-5" />
              </button>
            </div>
            <nav className="flex flex-col gap-0.5">{SECCIONES.map((s) => enlace(s, () => setMenu(false)))}</nav>
            <div className="mt-auto border-t border-slate-200 pt-3">
              <button onClick={salir} className="flex items-center gap-2 px-3 py-2 text-sm text-slate-600">
                <LogOut className="size-4" /> Salir
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
