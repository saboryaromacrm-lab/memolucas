import { useEffect, useRef, useState } from "react";
import { Loader2, Mic, Send, Square } from "lucide-react";
import { TextoWhatsapp } from "./Editor";
import { Modal, useAccion, useAviso } from "./ui";
import { api, post } from "../lib/api";
import { hora } from "../lib/fechas";
import { useDatos } from "../lib/vivo";

type Mensaje = { id: number; direccion: "entrante" | "saliente"; texto: string; creadoEn: string };

/** Cuando el asistente solo confirma lo que hizo, contesta con un emoji (en WhatsApp va como reacción). */
const SOLO_EMOJI = /^\p{Extended_Pictographic}\uFE0F?$/u;

const SE_PUEDE_GRABAR = typeof MediaRecorder !== "undefined" && !!navigator.mediaDevices?.getUserMedia;

/** Grabar con el micrófono: empieza al tocar y termina al volver a tocar. */
function useGrabador(onAudio: (audio: Blob) => void) {
  const [grabando, setGrabando] = useState(false);
  const grabador = useRef<MediaRecorder | null>(null);
  const alternar = async () => {
    if (grabador.current) return grabador.current.stop();
    const flujo = await navigator.mediaDevices.getUserMedia({ audio: true });
    const g = new MediaRecorder(flujo);
    const partes: Blob[] = [];
    g.ondataavailable = (e) => partes.push(e.data);
    g.onstop = () => {
      flujo.getTracks().forEach((t) => t.stop());
      grabador.current = null;
      setGrabando(false);
      onAudio(new Blob(partes, { type: g.mimeType }));
    };
    g.start();
    grabador.current = g;
    setGrabando(true);
  };
  return { grabando, alternar };
}

/** El asistente en el panel: su propia conversación, aparte del chat de WhatsApp. Se escribe o se habla. */
export function Asistente({ onCerrar }: { onCerrar: () => void }) {
  const { datos: mensajes } = useDatos<Mensaje[]>("/api/agente", ["mensajes"]);
  const [texto, setTexto] = useState("");
  const [enviando, setEnviando] = useState<string | null>(null);
  const accion = useAccion();
  const avisar = useAviso();
  const final = useRef<HTMLDivElement>(null);

  const visibles = mensajes ?? [];
  useEffect(() => {
    final.current?.scrollIntoView({ block: "end" });
  }, [visibles.length, enviando]);

  const enviar = async (pedido: () => Promise<unknown>, mostrar: string) => {
    setEnviando(mostrar);
    await accion(pedido);
    setEnviando(null);
  };
  const escribir = () => {
    const t = texto.trim();
    if (!t || enviando) return;
    setTexto("");
    void enviar(() => post("/api/agente", { texto: t }), t);
  };
  const { grabando, alternar } = useGrabador((audio) => {
    const formulario = new FormData();
    formulario.append("audio", audio, "audio.webm");
    void enviar(() => api("/api/agente/audio", { formulario }), "🎙️ Audio");
  });

  return (
    <Modal
      abierto
      onCerrar={onCerrar}
      titulo="Asistente"
      ancho="max-w-xl"
      pie={
        <div className="flex w-full items-end gap-2">
          <textarea
            className="campo max-h-32 min-h-10 flex-1 resize-none"
            rows={1}
            placeholder={grabando ? "Grabando… tocá ■ para mandar" : "Preguntame o pedime algo…"}
            autoFocus={matchMedia("(pointer: fine)").matches}
            value={texto}
            disabled={grabando}
            onChange={(e) => setTexto(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                escribir();
              }
            }}
          />
          {SE_PUEDE_GRABAR && (
            <button
              onClick={() => void alternar().catch(() => avisar("No pude usar el micrófono: revisá el permiso del navegador.", "error"))}
              disabled={!!enviando}
              aria-label={grabando ? "Terminar y mandar" : "Hablar"}
              className={`flex size-10 shrink-0 items-center justify-center rounded-full ${grabando ? "animate-pulse bg-red-500 text-white" : "border border-slate-300 text-slate-600 hover:bg-slate-50"} disabled:opacity-50`}
            >
              {grabando ? <Square className="size-4" /> : <Mic className="size-5" />}
            </button>
          )}
          <button
            onClick={escribir}
            disabled={!texto.trim() || !!enviando || grabando}
            aria-label="Mandar"
            className="flex size-10 shrink-0 items-center justify-center rounded-full bg-marca-oscuro text-white hover:bg-marca-profundo disabled:opacity-40"
          >
            <Send className="size-4" />
          </button>
        </div>
      }
    >
      <div className="space-y-2">
        {!visibles.length && !enviando && (
          <p className="py-8 text-center text-sm text-slate-500">
            Preguntame lo que quieras: <i>¿cuánto debo de la Visa?</i>, <i>¿qué vence esta semana?</i>, <i>¿cuánto está el dólar?</i>…
          </p>
        )}
        {visibles.map((m) =>
          m.direccion === "saliente" && SOLO_EMOJI.test(m.texto.trim()) ? (
            <div key={m.id} className="text-xs text-slate-500">
              {m.texto} Hecho · {hora(m.creadoEn)}
            </div>
          ) : (
            <div key={m.id} className={`flex ${m.direccion === "entrante" ? "justify-end" : "justify-start"}`}>
              <div className={`burbuja max-w-[85%] whitespace-pre-wrap ${m.direccion === "entrante" ? "bg-[#d9fdd3]" : "bg-white"}`}>
                <TextoWhatsapp texto={m.texto} />
                <div className="mt-0.5 text-right text-[10px] text-slate-400">{hora(m.creadoEn)}</div>
              </div>
            </div>
          ),
        )}
        {enviando && (
          <>
            {/* Lo que se mandó, mientras el asistente piensa (después llega guardado con la respuesta). */}
            {!visibles.some((m) => m.direccion === "entrante" && m.texto === enviando) && (
              <div className="flex justify-end">
                <div className="burbuja max-w-[85%] whitespace-pre-wrap bg-[#d9fdd3]">{enviando}</div>
              </div>
            )}
            <div className="flex items-center gap-2 text-sm text-slate-500">
              <Loader2 className="size-4 animate-spin" /> Pensando…
            </div>
          </>
        )}
        <div ref={final} />
      </div>
    </Modal>
  );
}
