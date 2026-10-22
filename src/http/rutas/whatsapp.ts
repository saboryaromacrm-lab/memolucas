import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { registrar } from "../../lib/log.js";
import { actualizarConfig, obtenerConfig } from "../../servicios/configuracion.js";
import { registrarMensaje, ultimoEntrante } from "../../servicios/mensajes.js";
import { ErrorUsuario } from "../../servicios/recordatorios.js";
import { whatsapp } from "../../whatsapp/conexion.js";
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

  app.post("/whatsapp/codigo", async (req) => {
    const { numero } = z.object({ numero: z.string().min(6) }).parse(req.body);
    const n = normalizarNumero(numero);
    if (n.length < 10) throw new ErrorUsuario("Número inválido.");
    try {
      return { codigo: await whatsapp.pedirCodigo(n) };
    } catch (err) {
      throw new ErrorUsuario(err instanceof Error ? err.message : "No se pudo generar el código");
    }
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
