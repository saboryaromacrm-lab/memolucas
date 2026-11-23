import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { registrar } from "../../lib/log.js";
import { actualizarConfig, obtenerConfig } from "../../servicios/configuracion.js";
import { registrarMensaje, ultimoEntrante } from "../../servicios/mensajes.js";
import { ErrorUsuario } from "../../servicios/recordatorios.js";
import { cancelarProgramadoWa, programadosWa, resumenWa } from "../../servicios/wa-personal.js";
import { whatsapp } from "../../whatsapp/conexion.js";
import { personal } from "../../whatsapp/personal.js";
import { mostrarNumero, normalizarNumero } from "../../whatsapp/numeros.js";

export async function infoWhatsapp() {
  const cfg = await obtenerConfig();
  const info = whatsapp.info();
  const ultimo = await ultimoEntrante();
  const minutosCaido = info.desconectadoDesde ? (Date.now() - new Date(info.desconectadoDesde).getTime()) / 60_000 : 0;
  return {
    ...info,
    numeroVinculadoTexto: info.numeroVinculado ? mostrarNumero(info.numeroVinculado) : null,
    numeroAutorizado: cfg.numeroAutorizado,
    numeroAutorizadoTexto: mostrarNumero(cfg.numeroAutorizado),
    ultimoMensajeRecibido: ultimo?.creadoEn ?? null,
    alerta: info.estado !== "conectado" && minutosCaido >= cfg.alertaDesconexionMin,
    minutosCaido: Math.floor(minutosCaido),
  };
}

/** Tu WhatsApp personal: estado, lo guardado y los mensajes programados. */
async function infoPersonal() {
  const info = personal.info();
  return { ...info, numeroVinculadoTexto: info.numeroVinculado ? mostrarNumero(info.numeroVinculado) : null, ...(await resumenWa()), programados: await programadosWa() };
}

/** Vincular tu número personal tiene riesgo de bloqueo: el panel pide aceptarlo antes. */
function exigirRiesgo(cuerpo: unknown) {
  if ((cuerpo as { acepto?: unknown } | null)?.acepto !== true) throw new ErrorUsuario("Primero marcá que entendés el riesgo.");
}

export const rutasWhatsapp: FastifyPluginAsync = async (app) => {
  app.get("/whatsapp", async () => infoWhatsapp());

  app.post("/whatsapp/reconectar", async () => {
    await whatsapp.reconectar();
    return infoWhatsapp();
  });

  app.post("/whatsapp/desvincular", async () => {
    await whatsapp.desvincular();
    return infoWhatsapp();
  });

  /** Código para vincular sin QR (el bot o tu WhatsApp). */
  const pedirCodigo = async (sesion: typeof whatsapp | typeof personal, numero: string) => {
    const n = normalizarNumero(numero);
    if (n.length < 10) throw new ErrorUsuario("Número inválido.");
    try {
      return { codigo: await sesion.pedirCodigo(n) };
    } catch (err) {
      throw new ErrorUsuario(err instanceof Error ? err.message : "No se pudo generar el código");
    }
  };

  app.post("/whatsapp/codigo", async (req) => pedirCodigo(whatsapp, z.object({ numero: z.string().min(6) }).parse(req.body).numero));

  app.get("/whatsapp/personal", async () => infoPersonal());

  app.post("/whatsapp/personal/vincular", async (req) => {
    exigirRiesgo(req.body);
    if (personal.conectado()) throw new ErrorUsuario("Tu WhatsApp ya está vinculado.");
    await personal.reconectar();
    return infoPersonal();
  });

  app.post("/whatsapp/personal/codigo", async (req) => {
    exigirRiesgo(req.body);
    return pedirCodigo(personal, z.object({ numero: z.string().min(6) }).parse(req.body).numero);
  });

  app.post("/whatsapp/personal/desvincular", async () => {
    await personal.desvincular();
    return infoPersonal();
  });

  app.delete("/whatsapp/personal/programados/:id", async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    await cancelarProgramadoWa(id);
    return infoPersonal();
  });

  app.post("/whatsapp/prueba", async () => {
    if (!whatsapp.conectado()) throw new ErrorUsuario("WhatsApp no está conectado.");
    const cfg = await obtenerConfig();
    if (!cfg.numeroAutorizado) throw new ErrorUsuario("Primero cargá tu número autorizado.");
    const texto = "👋 Mensaje de prueba de Memolucas. ¡Todo funcionando!";
    const id = await whatsapp.enviarTexto(texto);
    await registrarMensaje({ direccion: "saliente", texto, waMessageId: id, intencionDetectada: "prueba" });
    return { ok: true };
  });

  app.put("/whatsapp/autorizado", async (req) => {
    const { numero } = z.object({ numero: z.string() }).parse(req.body);
    const n = normalizarNumero(numero);
    if (n.length < 10) throw new ErrorUsuario("Número inválido. Escribilo con código de área, ej. 11 1234-5678.");
    await actualizarConfig({ numeroAutorizado: n, lidAutorizado: null });
    whatsapp.olvidarChat();
    await whatsapp.resolverAutorizado();
    await registrar("aviso", "panel", `Número autorizado: ${mostrarNumero(n)}`);
    return infoWhatsapp();
  });
};
