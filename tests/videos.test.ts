import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { WAMessage } from "baileys";
import { Procesador } from "../src/bot/procesador.js";
import { interpretar, type Interpretacion } from "../src/bot/ia.js";
import { binarios } from "../src/entorno.js";
import { obtenerConfig } from "../src/servicios/configuracion.js";
import { transcribir } from "../src/servicios/audio.js";
import { listarLinks } from "../src/servicios/links.js";
import { todasLasNotas } from "../src/servicios/notas.js";
import { esLinkDeVideo, leerVideo, type Video } from "../src/servicios/videos.js";
import type { ResumenVideo } from "../src/bot/resumir-video.js";
import { baseLimpia, panelConSesion } from "./ayuda.js";

// Claude simulado. El que resume llama a dar_resumen con lo que diga cada prueba; el asistente llama a las
// herramientas que diga "asistente" y contesta con lo que devuelven.
type Params = { tools: { name: string; run?: (i: unknown) => Promise<string> }[]; messages: { content: { type: string; text?: string }[] }[] };
const resumen = vi.fn<(p: Params) => ResumenVideo>();
const asistente = vi.fn<() => { llamadas: { name: string; input: unknown }[]; responder: (r: string[]) => string }>();
vi.mock("../src/bot/ia.js", async (orig) => ({
  ...(await orig<object>()),
  cliente: () => ({
    beta: {
      messages: {
        toolRunner: (p: Params) => ({
          async *[Symbol.asyncIterator]() {
            const dar = p.tools.find((t) => t.name === "dar_resumen");
            let texto = "";
            if (dar) await dar.run!(resumen(p));
            else {
              const { llamadas, responder } = asistente();
              const resultados: string[] = [];
              for (const l of llamadas) resultados.push(await p.tools.find((t) => t.name === l.name)!.run!(l.input));
              texto = responder(resultados);
            }
            yield { usage: { input_tokens: 10, output_tokens: 10 }, stop_reason: "end_turn", content: [{ type: "text", text: texto }] };
          },
        }),
      },
    },
  }),
  interpretar: vi.fn(),
}));
vi.mock("../src/servicios/audio.js", async (orig) => ({ ...(await orig<object>()), transcribir: vi.fn(async () => "Hoy te traigo tres páginas: Canva, Notion y Remove.bg") }));

const DIR = path.resolve("tests/.datos/videos");
const MUESTRA = path.join(DIR, "muestra.mp4");
const MUDO = path.join(DIR, "mudo.mp4");

/** yt-dlp falso: copia la muestra donde dice -o e imprime el JSON, o falla según el link. */
const YTDLP_FALSO = `#!/bin/sh
url=""; salida=""; prev=""
for a in "$@"; do [ "$prev" = "-o" ] && salida="$a"; prev="$a"; url="$a"; done
case "$url" in
  *login*) echo "ERROR: [Instagram] x: Requested content is not available, rate-limit reached or login required" >&2; exit 1;;
  *largo*) echo '{"duration": 900}'; exit 0;;
  *roto*) echo "ERROR: Unable to extract" >&2; exit 1;;
esac
cp "${MUESTRA}" "$(echo "$salida" | sed 's/%(ext)s/mp4/')"
echo '{"title": "3 páginas que te ahorran horas", "description": "3 páginas que te ahorran horas #ia", "uploader_id": "agustin", "duration": 8}'
`;

beforeAll(() => {
  fs.mkdirSync(DIR, { recursive: true });
  const ffmpeg = (args: string[]) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args]);
  ffmpeg(["-f", "lavfi", "-i", "testsrc=duration=8:size=320x240:rate=10", "-f", "lavfi", "-i", "sine=frequency=440:duration=8", "-shortest", "-c:v", "mpeg4", "-c:a", "aac", MUESTRA]);
  ffmpeg(["-f", "lavfi", "-i", "testsrc=duration=4:size=320x240:rate=10", "-an", "-c:v", "mpeg4", MUDO]);
  const falso = path.join(DIR, "yt-dlp");
  fs.writeFileSync(falso, YTDLP_FALSO, { mode: 0o755 });
  binarios.ytDlp = falso;
});

const RECURSOS: ResumenVideo = {
  titulo: "3 páginas para ahorrar horas",
  resumen: "Tres herramientas gratis para crear contenido más rápido.",
  recursos: [
    { nombre: "Canva", para_que: "diseños y videos", url: "https://www.canva.com" },
    { nombre: "Notion", para_que: "organizar ideas", url: "notion.so" },
    { nombre: "Una que no encontró", para_que: "algo", url: null },
  ],
  nota: null,
};

describe("videos", () => {
  beforeEach(async () => {
    await baseLimpia();
    resumen.mockReset();
    asistente.mockReset();
    vi.mocked(transcribir).mockClear();
  });

  it("reconoce los links de video", () => {
    for (const u of [
      "https://www.tiktok.com/@agustincorbalanmkt/video/7703972773772692744?_r=1",
      "https://vm.tiktok.com/ZMabc/",
      "https://www.instagram.com/reel/C1abc/",
      "https://youtube.com/shorts/abc",
      "https://youtu.be/abc",
      "https://www.facebook.com/reel/123",
      "https://fb.watch/abc",
    ])
      expect(esLinkDeVideo(u), u).toBe(true);
    for (const u of ["https://www.instagram.com/agustin/", "https://www.instagram.com/p/C1abc/", "https://www.youtube.com/@canal", "https://www.facebook.com/eventos/1", "https://www.canva.com", "no es link"])
      expect(esLinkDeVideo(u), u).toBe(false);
  });

  it("de un link saca el posteo, lo que se dice y cuadros; sin audio no transcribe", async () => {
    const cfg = await obtenerConfig();
    const v = await leerVideo(cfg, { url: "https://www.tiktok.com/@agustin/video/1" });
    expect(v).toMatchObject({ titulo: null, autor: "@agustin", descripcion: "3 páginas que te ahorran horas #ia", transcripcion: "Hoy te traigo tres páginas: Canva, Notion y Remove.bg", faltaGroq: false });
    expect(v.segundos).toBeCloseTo(8, 0);
    expect(v.cuadros).toHaveLength(6);
    expect(v.cuadros[0].subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8])); // JPEG

    const mudo: Video = await leerVideo(cfg, { datos: fs.readFileSync(MUDO), mime: "video/mp4", epigrafe: "mirá esto" });
    expect(mudo).toMatchObject({ transcripcion: null, descripcion: "mirá esto", autor: null });
    expect(mudo.cuadros.length).toBeGreaterThan(0);
    expect(transcribir).toHaveBeenCalledTimes(1);
  });

  it("en el panel, el asistente lo resume con su herramienta", async () => {
    const { app, headers } = await panelConSesion();
    resumen.mockReturnValueOnce(RECURSOS);
    asistente.mockReturnValueOnce({ llamadas: [{ name: "resumir_video", input: { url: "https://vt.tiktok.com/ZSsLtax8R/" } }], responder: ([r]) => r });
    const r = JSON.parse((await app.inject({ method: "POST", url: "/api/agente", headers, payload: { texto: "https://vt.tiktok.com/ZSsLtax8R/" } })).json().respuesta);
    expect(r).toMatchObject({ cuenta: "@agustin", titulo: "3 páginas para ahorrar horas", escucho_el_audio: true, recursos: [{ nombre: "Canva" }, { nombre: "Notion" }, {}] });
    asistente.mockReturnValueOnce({ llamadas: [{ name: "resumir_video", input: { url: "https://www.instagram.com/reel/login/" } }], responder: ([r]) => r });
    expect((await app.inject({ method: "POST", url: "/api/agente", headers, payload: { texto: "y este?" } })).json().respuesta).toContain("Instagram pide iniciar sesión");
    await app.close();
  });

  describe("por WhatsApp", () => {
    const yo = "5491112345678@s.whatsapp.net";
    let respuestas: string[];
    let reacciones: string[];
    let bot: Procesador;
    let n = 0;
    const texto = (t: string) => bot.procesar({ key: { id: `T${++n}`, remoteJid: yo }, message: { conversation: t } });
    beforeEach(() => {
      respuestas = [];
      reacciones = [];
      bot = new Procesador({
        responder: async (t: string) => (respuestas.push(t), `OUT${respuestas.length}`),
        responderImagen: async () => null,
        responderEncuesta: async () => ({ id: null, secreto: "" }),
        descifrarVoto: () => null,
        descargarMedia: async () => fs.readFileSync(MUESTRA),
        reaccionar: async (_m: WAMessage, e: string) => void reacciones.push(e),
      });
    });

    it("un TikTok: resumen con las páginas y sus links, texto completo y las guarda en tus links", async () => {
      resumen.mockReturnValueOnce(RECURSOS);
      await texto("https://www.tiktok.com/@agustin/video/1?_r=1");
      expect(reacciones).toEqual(["⏳", "✅"]);
      expect(respuestas.at(-1)).toBe(
        [
          "🎬 *3 páginas para ahorrar horas* · @agustin",
          "Tres herramientas gratis para crear contenido más rápido.",
          "1. *Canva* — diseños y videos\nhttps://www.canva.com/\n2. *Notion* — organizar ideas\nhttps://notion.so/\n3. *Una que no encontró* — algo",
          "¿Las guardo en tus links?",
          "_Respondé *texto completo* para ver todo lo que se dice._",
        ].join("\n\n"),
      );
      // Claude recibe los cuadros y lo que se dice.
      const contenido = resumen.mock.calls[0][0].messages[0].content;
      expect(contenido.filter((c) => c.type === "image")).toHaveLength(6);
      expect(contenido.at(-1)!.text).toContain("Lo que se dice:\nHoy te traigo tres páginas");

      await texto("texto completo");
      expect(respuestas.at(-1)).toBe("📝 *Lo que se dice en el video:*\nHoy te traigo tres páginas: Canva, Notion y Remove.bg");
      await texto("sí");
      expect(reacciones.at(-1)).toBe("🔗");
      expect((await listarLinks()).map((l) => [l.concepto, l.url])).toEqual([
        ["Canva", "https://www.canva.com/"],
        ["Notion", "https://notion.so/"],
      ]);
    });

    it("un link de video justo después de una pregunta del asistente se resume (no es la respuesta)", async () => {
      vi.mocked(interpretar).mockResolvedValue({ intencion: "consulta" } as Interpretacion);
      asistente.mockReturnValueOnce({ llamadas: [], responder: () => "¿Lo mando?" });
      await texto("mandale a maca que la quiero");
      resumen.mockReturnValueOnce(RECURSOS);
      await texto("https://vt.tiktok.com/ZSsLtax8R/");
      expect(asistente).toHaveBeenCalledTimes(1);
      expect(respuestas.at(-1)).toContain("🎬 *3 páginas para ahorrar horas*");
    });

    it("un video mandado como archivo: receta que ofrece guardar como nota", async () => {
      resumen.mockReturnValueOnce({ titulo: "Budín de banana", resumen: "*Ingredientes:* …", recursos: [], nota: { titulo: "Budín de banana", contenido: "3 bananas…", categoria: "casa" } });
      await bot.procesar({ key: { id: "V1", remoteJid: yo }, message: { videoMessage: { seconds: 8, mimetype: "video/mp4", caption: "para el finde" } } });
      expect(respuestas.at(-1)).toContain("¿Lo guardo en tus notas?");
      expect(resumen.mock.calls[0][0].messages[0].content.at(-1)!.text).toContain("Texto del posteo: para el finde");
      await texto("dale");
      expect(reacciones.at(-1)).toBe("🗒️");
      expect((await todasLasNotas()).map((x) => x.titulo)).toEqual(["Budín de banana"]);
    });

    it("si no lo puede bajar, pide el video; si es largo, lo dice; con 'recordame' va como link", async () => {
      await texto("https://www.instagram.com/reel/login/");
      expect(respuestas.at(-1)).toContain("Instagram pide iniciar sesión");
      expect(respuestas.at(-1)).toContain("mandámelo acá como *video*");
      expect(reacciones).toEqual(["⏳", "😕"]);
      await texto("https://www.tiktok.com/@x/video/roto");
      expect(respuestas.at(-1)).toContain("No pude bajar ese video");
      await texto("https://www.tiktok.com/@x/video/largo");
      expect(respuestas.at(-1)).toBe("Ese video dura más de 10 minutos: es muy largo para resumirlo por acá.");
      await bot.procesar({ key: { id: "V2", remoteJid: yo }, message: { videoMessage: { seconds: 700, mimetype: "video/mp4" } } });
      expect(respuestas.at(-1)).toContain("dura más de 10 minutos");
      expect(resumen).not.toHaveBeenCalled();
    });
  });
});
