import type { Configuracion } from "../db/schema.js";
import { entorno } from "../entorno.js";
import { descifrar } from "../lib/cifrado.js";

const URL_GROQ = "https://api.groq.com/openai/v1/audio/transcriptions";

export class ErrorAudio extends Error {}

export function claveGroq(cfg: Configuracion): string {
  const propia = cfg.groqApiKeyCifrada ? descifrar(cfg.groqApiKeyCifrada) : null;
  return (propia || entorno.groqApiKey).trim();
}

const EXTENSIONES: Record<string, string> = { "audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/aac": "aac", "audio/wav": "wav", "audio/webm": "webm" };

/** Pasa un audio a texto con Groq (Whisper). */
export async function transcribir(cfg: Configuracion, datos: Buffer, mime: string): Promise<string> {
  const clave = claveGroq(cfg);
  if (!clave) throw new ErrorAudio("Falta la API key de Groq");
  const tipo = mime.split(";")[0].trim() || "audio/ogg";
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(datos)], { type: tipo }), `audio.${EXTENSIONES[tipo] ?? "ogg"}`);
  form.append("model", cfg.audioModelo);
  form.append("language", "es");
  form.append("response_format", "json");
  const r = await fetch(URL_GROQ, {
    method: "POST",
    headers: { authorization: `Bearer ${clave}` },
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  const cuerpo = (await r.json().catch(() => ({}))) as { text?: string; error?: { message?: string } };
  if (!r.ok) throw new ErrorAudio(cuerpo.error?.message ?? `Groq respondió ${r.status}`);
  return (cuerpo.text ?? "").trim();
}

/** Prueba la clave de Groq: pide la lista de modelos (no gasta). */
export async function probarGroq(cfg: Configuracion): Promise<{ ok: boolean; mensaje: string; ms: number }> {
  const inicio = Date.now();
  const clave = claveGroq(cfg);
  if (!clave) return { ok: false, mensaje: "Falta la API key de Groq", ms: 0 };
  try {
    const r = await fetch("https://api.groq.com/openai/v1/models", { headers: { authorization: `Bearer ${clave}` }, signal: AbortSignal.timeout(15_000) });
    const j = (await r.json().catch(() => ({}))) as { data?: { id: string }[]; error?: { message?: string } };
    if (!r.ok) return { ok: false, mensaje: j.error?.message ?? `Groq respondió ${r.status}`, ms: Date.now() - inicio };
    const hay = j.data?.some((m) => m.id === cfg.audioModelo);
    return {
      ok: !!hay,
      mensaje: hay ? `Clave OK, modelo ${cfg.audioModelo} disponible` : `La clave anda, pero el modelo ${cfg.audioModelo} no figura en tu cuenta`,
      ms: Date.now() - inicio,
    };
  } catch (err) {
    return { ok: false, mensaje: err instanceof Error ? err.message : String(err), ms: Date.now() - inicio };
  }
}
