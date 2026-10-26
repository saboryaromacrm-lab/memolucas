import { useEffect, useState } from "react";
import { MessagesSquare, Search } from "lucide-react";
import { TextoWhatsapp, useEditor } from "../componentes/Editor";
import { Boton, Cargando, Encabezado, Vacio } from "../componentes/ui";
import { get } from "../lib/api";
import { enZona, fechaHora } from "../lib/fechas";
import type { Mensaje } from "../lib/tipos";
import { useDatos } from "../lib/vivo";

export function Historial() {
  const [desde, setDesde] = useState("");
  const [hasta, setHasta] = useState("");
  const [q, setQ] = useState("");
  const [texto, setTexto] = useState("");
  const [extra, setExtra] = useState<Mensaje[]>([]);
  const [hayMas, setHayMas] = useState(true);
  const editor = useEditor();

  useEffect(() => {
    const t = setTimeout(() => setTexto(q), 300);
    return () => clearTimeout(t);
  }, [q]);

  const params = new URLSearchParams();
  if (desde) params.set("desde", enZona(new Date(`${desde}T00:00`)).startOf("day").toISO()!);
  if (hasta) params.set("hasta", enZona(new Date(`${hasta}T00:00`)).endOf("day").toISO()!);
  if (texto) params.set("texto", texto);
  const ruta = `/api/historial?${params}`;
  const { datos, cargando } = useDatos<Mensaje[]>(ruta, ["mensajes"]);

  useEffect(() => {
    setExtra([]);
    setHayMas(true);
  }, [ruta]);

  const todos = [...(datos ?? []), ...extra];
  const masViejos = async () => {
    const ultimo = todos.at(-1);
    if (!ultimo) return;
    const mas = await get<Mensaje[]>(`${ruta}&antesDe=${ultimo.id}`);
    setExtra((e) => [...e, ...mas]);
    setHayMas(mas.length === 200);
  };

  // Agrupar por día (del más nuevo al más viejo).
  const grupos = new Map<string, Mensaje[]>();
  for (const m of todos) {
    const k = enZona(m.creadoEn).toFormat("cccc d 'de' LLLL yyyy");
    grupos.set(k, [...(grupos.get(k) ?? []), m]);
  }

  return (
    <div>
      <Encabezado titulo="Historial" subtitulo="Todos los mensajes que mandaste y recibiste del bot." />
      <div className="mb-4 grid gap-2 sm:grid-cols-[1fr_auto_auto]">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
          <input className="campo pl-9" placeholder="Buscar en los mensajes…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <input type="date" className="campo" value={desde} onChange={(e) => setDesde(e.target.value)} aria-label="Desde" />
        <input type="date" className="campo" value={hasta} onChange={(e) => setHasta(e.target.value)} aria-label="Hasta" />
      </div>
      {cargando && !datos ? (
        <Cargando />
      ) : !todos.length ? (
        <div className="tarjeta">
          <Vacio icono={<MessagesSquare className="size-10" />} titulo="Sin mensajes" texto="Cuando le escribas al bot, la conversación aparece acá." />
        </div>
      ) : (
        <div className="space-y-6">
          {[...grupos.entries()].map(([dia, ms]) => (
            <section key={dia}>
              <div className="mb-2 text-center">
                <span className="inline-block rounded-full bg-white px-3 py-1 text-xs font-medium text-slate-500 first-letter:uppercase shadow-sm ring-1 ring-slate-200">{dia}</span>
              </div>
              <div className="space-y-2 rounded-xl bg-[#efeae2] p-3 sm:p-4">
                {[...ms].reverse().map((m) => (
                  <div key={m.id} className={`flex ${m.direccion === "saliente" ? "justify-start" : "justify-end"}`}>
                    <div className={`burbuja ${m.direccion === "saliente" ? "bg-white" : "bg-[#d9fdd3]"}`}>
                      {m.adjuntoUrl && (
                        <a href={m.adjuntoUrl} target="_blank" rel="noreferrer">
                          <img src={m.adjuntoUrl} alt="" className="mb-1.5 max-h-48 rounded" />
                        </a>
                      )}
                      {m.texto ? <TextoWhatsapp texto={m.texto} /> : <span className="italic text-slate-400">({m.tipo})</span>}
                      <div className="mt-1 flex flex-wrap items-center justify-end gap-x-2 text-[10px] text-slate-500">
                        {m.intencionDetectada && <span className="rounded bg-black/5 px-1">{m.intencionDetectada}</span>}
                        {m.recordatorioId && (
                          <button className="underline" onClick={() => editor.abrir({ id: m.recordatorioId! })}>
                            {m.recordatorioTitulo ?? "ver"}
                          </button>
                        )}
                        <span title={fechaHora(m.creadoEn)}>{enZona(m.creadoEn).toFormat("H:mm")}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ))}
          {hayMas && todos.length >= 200 && (
            <div className="text-center">
              <Boton onClick={masViejos}>Ver más viejos</Boton>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
