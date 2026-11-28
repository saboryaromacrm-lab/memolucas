import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Configuracion } from "../db/schema.js";
import { binarios } from "../entorno.js";
import { registrar } from "../lib/log.js";
import { ErrorAudio, transcribir } from "./audio.js";

// Videos cortos (reels, TikTok, Shorts) para resumir: se bajan sin iniciar sesión, se les saca el audio (para
// transcribirlo) y algunos cuadros (para leer lo que aparece escrito). El video se borra apenas termina.

export const MAX_SEGUNDOS_VIDEO = 600;
const MAX_MB = 150;
const ejecutar = promisify(execFile);

export type MotivoErrorVideo = "login" | "largo" | "no_disponible";
export class ErrorVideo extends Error {
  constructor(public motivo: MotivoErrorVideo) {
    super(motivo);
  }
}

const ERRORES: Record<MotivoErrorVideo, string> = {
  login: "No pude bajar ese video: la página pide iniciar sesión para verlo (pasa con Instagram y Facebook) 😕\nGuardalo desde la app y mandámelo acá como *video*, y te lo resumo.",
  no_disponible: "No pude bajar ese video 😕 (puede ser privado o que la página haya cambiado).\nGuardalo desde la app y mandámelo acá como *video*, y te lo resumo.",
  largo: `Ese video dura más de ${MAX_SEGUNDOS_VIDEO / 60} minutos: es muy largo para resumirlo por acá.`,
};
/** Qué decirte cuando un video no se puede resumir. */
export const textoErrorVideo = (motivo: MotivoErrorVideo) => ERRORES[motivo];

/** ¿Es un video de TikTok, Instagram, YouTube o Facebook? */
export function esLinkDeVideo(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const host = u.hostname.toLowerCase().replace(/^(www|m)\./, "");
  const ruta = u.pathname.toLowerCase();
  const de = (dominio: string) => host === dominio || host.endsWith(`.${dominio}`);
  if (de("tiktok.com")) return true;
  // Los /p/ suelen ser fotos (flyers, entradas): siguen como link para agendar.
  if (de("instagram.com")) return /^\/(reels?|tv)\//.test(ruta);
  if (host === "youtu.be" || host === "fb.watch") return true;
  if (de("youtube.com")) return /^\/(shorts\/|watch)/.test(ruta);
  // Los links de «Compartir» de un reel (/share/r/) o un video (/share/v/) ya dicen que son videos.
  if (de("facebook.com")) return /\/(reel|watch|videos)\b|^\/share\/[rv]\//.test(ruta);
  return false;
}

export type Video = {
  titulo: string | null;
  autor: string | null;
  descripcion: string | null;
  segundos: number;
  /** Lo que se dice; null si no tiene audio o no se pudo transcribir. */
  transcripcion: string | null;
  /** Falta la clave de Groq: el audio no se pudo escuchar. */
  faltaGroq: boolean;
  cuadros: Buffer[];
};

export type FuenteVideo = { url: string } | { datos: Buffer; mime: string; epigrafe?: string | null };

type InfoYtDlp = { title?: string; description?: string; uploader?: string; uploader_id?: string; channel?: string; duration?: number };

const LOGIN = /login required|log in|sign in|cookies|rate-limit|private|not available|empty media/i;

/** Baja el video con yt-dlp (sin iniciar sesión). */
async function bajar(url: string, carpeta: string) {
  let salida: string;
  try {
    ({ stdout: salida } = await ejecutar(
      binarios.ytDlp,
      [
        "-j",
        "--no-simulate",
        "--no-playlist",
        "--no-progress",
        "--no-warnings",
        "-f",
        "b[height<=720]/bv*[height<=720]+ba/b",
        "--merge-output-format",
        "mp4",
        "--max-filesize",
        `${MAX_MB}M`,
        "--match-filter",
        `duration <=? ${MAX_SEGUNDOS_VIDEO}`,
        "--socket-timeout",
        "20",
        "-o",
        path.join(carpeta, "video.%(ext)s"),
        url,
      ],
      { timeout: 180_000, maxBuffer: 64 * 1024 * 1024 },
    ));
  } catch (err) {
    const detalle = `${(err as { stderr?: string }).stderr ?? ""} ${(err as Error).message}`;
    if ((err as NodeJS.ErrnoException).code === "ENOENT") throw err; // Falta yt-dlp: es un problema de la instalación.
    await registrar("aviso", "videos", `No se pudo bajar ${url}`, { detalle: detalle.slice(0, 500) });
    throw new ErrorVideo(/instagram|facebook|fb\.watch/i.test(url) && LOGIN.test(detalle) ? "login" : "no_disponible");
  }
  const info = JSON.parse(salida.trim().split("\n").at(-1) || "{}") as InfoYtDlp;
  const archivo = (await fs.readdir(carpeta)).find((n) => n.startsWith("video.") && !n.endsWith(".part"));
  if (!archivo) throw new ErrorVideo((info.duration ?? 0) > MAX_SEGUNDOS_VIDEO ? "largo" : "no_disponible");
  const autor = info.uploader_id ? `@${info.uploader_id.replace(/^@/, "")}` : info.uploader || info.channel || null;
  const descripcion = info.description?.trim() || null;
  // En TikTok e Instagram el título suele ser la descripción repetida o "Video by …": no aporta.
  const titulo = info.title && !descripcion?.includes(info.title) && !/^video by /i.test(info.title) ? info.title : null;
  return { archivo: path.join(carpeta, archivo), titulo, autor, descripcion };
}

async function segundosDe(archivo: string): Promise<number> {
  const { stdout } = await ejecutar(binarios.ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", archivo], { timeout: 30_000 });
  return Number.parseFloat(stdout) || 0;
}

/** El audio en mp3 mono liviano (para Groq). null si el video no tiene sonido. */
async function audioDe(archivo: string, carpeta: string): Promise<Buffer | null> {
  const destino = path.join(carpeta, "audio.mp3");
  try {
    await ejecutar(binarios.ffmpeg, ["-v", "error", "-i", archivo, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "48k", "-y", destino], { timeout: 120_000 });
    return await fs.readFile(destino);
  } catch {
    return null;
  }
}

/** Cuadros repartidos a lo largo del video (más cuadros si es más largo). */
async function cuadrosDe(archivo: string, carpeta: string, segundos: number): Promise<Buffer[]> {
  const cantidad = segundos <= 60 ? 6 : segundos <= 180 ? 8 : 10;
  const fps = segundos > 0 ? cantidad / segundos : 1;
  await ejecutar(
    binarios.ffmpeg,
    ["-v", "error", "-i", archivo, "-vf", `fps=${fps},scale='min(768,iw)':-2`, "-frames:v", String(cantidad), "-q:v", "5", "-y", path.join(carpeta, "cuadro_%02d.jpg")],
    { timeout: 120_000 },
  );
  const nombres = (await fs.readdir(carpeta)).filter((n) => n.startsWith("cuadro_")).sort();
  return Promise.all(nombres.map((n) => fs.readFile(path.join(carpeta, n))));
}

async function transcripcionDe(cfg: Configuracion, audio: Buffer | null) {
  if (!audio) return { transcripcion: null, faltaGroq: false };
  try {
    return { transcripcion: (await transcribir(cfg, audio, "audio/mpeg")) || null, faltaGroq: false };
  } catch (err) {
    if (err instanceof ErrorAudio && /falta/i.test(err.message)) return { transcripcion: null, faltaGroq: true };
    await registrar("aviso", "videos", "No se pudo transcribir el audio de un video", err);
    return { transcripcion: null, faltaGroq: false };
  }
}

/** Todo lo que se puede leer de un video (de un link o de un archivo que mandaste). */
export async function leerVideo(cfg: Configuracion, fuente: FuenteVideo): Promise<Video> {
  const carpeta = await fs.mkdtemp(path.join(os.tmpdir(), "memolucas-video-"));
  try {
    let datos: { archivo: string; titulo: string | null; autor: string | null; descripcion: string | null };
    if ("url" in fuente) datos = await bajar(fuente.url, carpeta);
    else {
      const archivo = path.join(carpeta, `video.${fuente.mime.split("/")[1]?.split(";")[0] || "mp4"}`);
      await fs.writeFile(archivo, fuente.datos);
      datos = { archivo, titulo: null, autor: null, descripcion: fuente.epigrafe?.trim() || null };
    }
    const segundos = await segundosDe(datos.archivo);
    if (segundos > MAX_SEGUNDOS_VIDEO) throw new ErrorVideo("largo");
    const [audio, cuadros] = await Promise.all([audioDe(datos.archivo, carpeta), cuadrosDe(datos.archivo, carpeta, segundos)]);
    return { titulo: datos.titulo, autor: datos.autor, descripcion: datos.descripcion, segundos, cuadros, ...(await transcripcionDe(cfg, audio)) };
  } finally {
    await fs.rm(carpeta, { recursive: true, force: true });
  }
}

let ultimaActualizacion = 0;

/** Las páginas cambian seguido: yt-dlp se actualiza al arrancar y una vez por día. */
export async function actualizarYtDlp() {
  if (Date.now() - ultimaActualizacion < 86_400_000) return;
  ultimaActualizacion = Date.now();
  try {
    const { stdout } = await ejecutar(binarios.ytDlp, ["-U"], { timeout: 120_000 });
    if (/updated yt-dlp to/i.test(stdout)) await registrar("info", "videos", stdout.trim().split("\n").at(-1)!);
  } catch (err) {
    await registrar("aviso", "videos", "No se pudo actualizar yt-dlp", err);
  }
}
