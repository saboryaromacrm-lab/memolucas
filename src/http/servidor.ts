import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import jwt from "@fastify/jwt";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { anotarFallaIA } from "../bot/estado-ia.js";
import { registrar } from "../lib/log.js";
import { CAUSA_FALLA_IA, ErrorIA, motivoFallaIA } from "../bot/ia.js";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { ZodError } from "zod";
import { entorno } from "../entorno.js";
import { ErrorUsuario } from "../servicios/recordatorios.js";
import { versionSesionActual } from "./rutas/auth.js";
import { rutasAgente } from "./rutas/agente.js";
import { rutasAuth } from "./rutas/auth.js";
import { rutasCalculadoras } from "./rutas/calculadoras.js";
import { rutasLinks } from "./rutas/links.js";
import { rutasBloc } from "./rutas/bloc.js";
import { rutasPagos } from "./rutas/pagos.js";
import { rutasConfiguracion } from "./rutas/configuracion.js";
import { rutasEventos } from "./rutas/eventos.js";
import { rutasNotas } from "./rutas/notas.js";
import { rutasPanel } from "./rutas/panel.js";
import { rutasRecordatorios } from "./rutas/recordatorios.js";
import { rutasWhatsapp } from "./rutas/whatsapp.js";
import { rutasSalud } from "./rutas/salud.js";
import { rutasSuscripciones } from "./rutas/suscripciones.js";
import { rutasTarjetas } from "./rutas/tarjetas.js";

export const COOKIE_SESION = "memolucas_sesion";

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: { v: number };
    user: { v: number };
  }
}

/**
 * Qué página va. El Bloc tiene su propia dirección (otro dominio): así el navegador lo instala como una app aparte,
 * sin mezclarse con el panel. La dirección vieja (/app/bloc) lleva a la nueva.
 */
export function paginaPara(host: string, url: string): "bloc" | "panel" | { redirigir: string } {
  if (host.toLowerCase() === entorno.dominioBloc) return "bloc";
  if (/^\/app\/bloc(?:[/?#]|$)/.test(url)) return { redirigir: `https://${entorno.dominioBloc}/` };
  return "panel";
}

/** La misma página del panel, con el manifiesto, el título y los íconos del Bloc (y la marca para abrir solo el Bloc). */
export function htmlDelBloc(indice: string): string {
  return indice
    .replace('<meta charset="UTF-8" />', '<meta charset="UTF-8" />\n    <meta name="app" content="bloc" />')
    .replace('href="/manifest.webmanifest"', 'href="/bloc.webmanifest"')
    .replace('name="apple-mobile-web-app-title" content="Memolucas"', 'name="apple-mobile-web-app-title" content="Bloc"')
    .replace('rel="apple-touch-icon" href="/icono-192.png"', 'rel="apple-touch-icon" href="/bloc-192.png"')
    .replace('rel="icon" href="/icono.svg"', 'rel="icon" href="/bloc.svg"')
    .replace("<title>Memolucas</title>", "<title>Bloc</title>");
}

export async function crearServidor() {
  const app = Fastify({
    logger: false,
    trustProxy: true,
    bodyLimit: 5 * 1024 * 1024,
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", "data:", "blob:"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'", "data:"],
        upgradeInsecureRequests: entorno.produccion ? [] : null,
      },
    },
    hsts: entorno.produccion,
  });
  await app.register(cookie);
  await app.register(jwt, {
    secret: entorno.appSecret || "solo-para-desarrollo-cambiar-en-produccion-xxxxxxxx",
    cookie: { cookieName: COOKIE_SESION, signed: false },
  });
  await app.register(rateLimit, { max: 600, timeWindow: "1 minute" });
  await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024, files: 1 } });

  app.decorate("autenticar", async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const datos = await req.jwtVerify<{ v: number }>();
      if (datos.v !== (await versionSesionActual())) throw new Error("sesión vieja");
    } catch {
      return reply.code(401).send({ error: "Tenés que ingresar con tu PIN" });
    }
  });

  app.setErrorHandler(async (err, req, reply) => {
    if (err instanceof ErrorUsuario) return reply.code(400).send({ error: err.message });
    if (err instanceof ZodError) return reply.code(400).send({ error: "Datos inválidos", detalle: err.issues });
    const e = err as { statusCode?: number; message?: string };
    if (e.statusCode && e.statusCode < 500) return reply.code(e.statusCode).send({ error: e.message });
    // La IA no anda (sin crédito, la clave, Anthropic caído): se dice por qué y queda anotado (el cartel de Inicio).
    const motivo = motivoFallaIA(err);
    if (motivo) {
      await anotarFallaIA(motivo);
      return reply.code(503).send({ error: CAUSA_FALLA_IA[motivo] });
    }
    if (err instanceof ErrorIA) {
      await registrar("error", "ia", `Falló la IA en ${req.method} ${req.url.split("?")[0]}`, err);
      const detalle = err.message.length > 160 ? `${err.message.slice(0, 160)}… (el detalle completo quedó en Logs)` : err.message;
      return reply.code(502).send({ error: `La IA no pudo responder: ${detalle}` });
    }
    await registrar("error", "http", `Falló ${req.method} ${req.url.split("?")[0]}`, err);
    return reply.code(500).send({ error: "Error interno: el detalle quedó en Logs." });
  });

  await app.register(rutasSalud);
  await app.register(rutasAuth, { prefix: "/api/auth" });
  await app.register(
    async (privado) => {
      privado.addHook("onRequest", app.autenticar);
      await privado.register(rutasRecordatorios);
      await privado.register(rutasConfiguracion);
      await privado.register(rutasWhatsapp);
      await privado.register(rutasPanel);
      await privado.register(rutasNotas);
      await privado.register(rutasCalculadoras);
      await privado.register(rutasLinks);
      await privado.register(rutasBloc);
      await privado.register(rutasPagos);
      await privado.register(rutasAgente);
      await privado.register(rutasSuscripciones);
      await privado.register(rutasTarjetas);
      await privado.register(rutasEventos);
    },
    { prefix: "/api" },
  );

  // Panel web (archivos estáticos del build de Vite) con fallback a index.html.
  const aqui = path.dirname(fileURLToPath(import.meta.url));
  const web = path.resolve(aqui, "../../web/dist");
  if (fs.existsSync(web)) {
    await app.register(fastifyStatic, {
      root: web,
      wildcard: false,
      index: false,
      setHeaders: (res, ruta) => {
        if (ruta.includes(`${path.sep}assets${path.sep}`)) res.header("Cache-Control", "public, max-age=31536000, immutable");
        else res.header("Cache-Control", "no-cache");
      },
    });
    const indiceBloc = htmlDelBloc(fs.readFileSync(path.join(web, "index.html"), "utf8"));
    app.get("/*", async (req, reply) => {
      if (req.url.startsWith("/api/")) return reply.code(404).send({ error: "No existe" });
      reply.header("Cache-Control", "no-cache");
      const pagina = paginaPara(req.hostname, req.url);
      if (pagina === "bloc") return reply.type("text/html; charset=utf-8").send(indiceBloc);
      if (pagina !== "panel") return reply.redirect(pagina.redirigir);
      return reply.sendFile("index.html");
    });
  }

  return app;
}

declare module "fastify" {
  interface FastifyInstance {
    autenticar: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}
