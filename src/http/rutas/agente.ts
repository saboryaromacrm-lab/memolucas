import type { FastifyPluginAsync } from "fastify";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db/index.js";
import { mensaje } from "../../db/schema.js";
import { preguntarAlAgente, textoTope } from "../../bot/agente.js";
import { anotarFallaIA } from "../../bot/estado-ia.js";
import { CAUSA_FALLA_IA, motivoFallaIA } from "../../bot/ia.js";
import { ErrorAudio, transcribir } from "../../servicios/audio.js";
import { obtenerConfig } from "../../servicios/configuracion.js";
import { registrarMensaje } from "../../servicios/mensajes.js";
import { ErrorUsuario } from "../../servicios/recordatorios.js";

/** Lo que se le dice al asistente desde el panel: es su propia conversación, aparte del chat de WhatsApp. */
async function conversar(texto: string, tipo: "texto" | "audio") {
  const entrante = await registrarMensaje({ direccion: "entrante", texto, tipo, chat: null, canal: "panel", intencionDetectada: "agente" });
  let r: Awaited<ReturnType<typeof preguntarAlAgente>>;
  try {
    r = await preguntarAlAgente(texto, "panel", entrante.id);
  } catch (err) {
    const motivo = motivoFallaIA(err);
    if (!motivo) throw err;
    await anotarFallaIA(motivo);
    throw new ErrorUsuario(CAUSA_FALLA_IA[motivo]);
  }
  const respuesta = "tope" in r ? textoTope(r.tope) : r.texto;
  await registrarMensaje({ direccion: "saliente", texto: respuesta, chat: null, canal: "panel", intencionDetectada: "tope" in r ? "agente_tope" : "agente" });
  return respuesta;
}

export const rutasAgente: FastifyPluginAsync = async (app) => {
  /** Los últimos mensajes de la conversación del panel, del más viejo al más nuevo. */
  app.get("/agente", async () => {
    const filas = await db
      .select({ id: mensaje.id, direccion: mensaje.direccion, texto: mensaje.texto, creadoEn: mensaje.creadoEn })
      .from(mensaje)
      .where(and(eq(mensaje.canal, "panel"), isNotNull(mensaje.texto)))
      .orderBy(desc(mensaje.id))
      .limit(40);
    return filas.reverse();
  });

  app.post("/agente", async (req) => {
    const { texto } = z.object({ texto: z.string().trim().min(1).max(4000) }).parse(req.body);
    return { respuesta: await conversar(texto, "texto") };
  });

  /** Un audio grabado en el panel: se transcribe (como los audios de WhatsApp) y se le pregunta al asistente. */
  app.post("/agente/audio", async (req) => {
    const archivo = await req.file();
    if (!archivo) throw new ErrorUsuario("No llegó el audio.");
    let texto: string;
    try {
      texto = await transcribir(await obtenerConfig(), await archivo.toBuffer(), archivo.mimetype);
    } catch (err) {
      if (err instanceof ErrorAudio) throw new ErrorUsuario(/falta/i.test(err.message) ? "Para hablarle falta la clave de Groq (Configuración → Audios)." : "No pude entender el audio.");
      throw err;
    }
    if (!texto.trim()) throw new ErrorUsuario("No escuché nada en el audio.");
    return { transcripcion: texto, respuesta: await conversar(texto, "audio") };
  });
};
