import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import jwt from "@fastify/jwt";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { ZodError } from "zod";
import { entorno } from "../entorno.js";
import { ErrorUsuario } from "../servicios/recordatorios.js";
import { versionSesionActual } from "./rutas/auth.js";
import { rutasAuth } from "./rutas/auth.js";
import { rutasCompras } from "./rutas/compras.js";
import { rutasPanelCompras } from "./rutas/panel-compras.js";
import { obtenerConfig } from "../servicios/configuracion.js";
import { rutasConfiguracion } from "./rutas/configuracion.js";
import { rutasEventos } from "./rutas/eventos.js";
import { rutasNotas } from "./rutas/notas.js";
import { rutasPanel } from "./rutas/panel.js";
import { rutasRecordatorios } from "./rutas/recordatorios.js";
import { rutasWhatsapp } from "./rutas/whatsapp.js";
import { rutasSalud } from "./rutas/salud.js";

export const COOKIE_SESION = "memolucas_sesion";

declare module "@fastify/jwt" {
  interface FastifyJWT {
    // tipo "compras": sesión del panel de compras (u = la persona). El panel principal no la acepta.
    payload: { v: number; tipo?: "compras"; u?: number };
    user: { v: number; tipo?: "compras"; u?: number };
  }
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
      const datos = await req.jwtVerify<{ v: number; tipo?: string }>();
      if (datos.tipo === "compras") throw new Error("sesión del panel de compras");
      if (datos.v !== (await versionSesionActual())) throw new Error("sesión vieja");
    } catch {
      return reply.code(401).send({ error: "Tenés que ingresar con tu PIN" });
    }
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ErrorUsuario) return reply.code(400).send({ error: err.message });
    if (err instanceof ZodError) return reply.code(400).send({ error: "Datos inválidos", detalle: err.issues });
    const e = err as { statusCode?: number; message?: string };
    if (e.statusCode && e.statusCode < 500) return reply.code(e.statusCode).send({ error: e.message });
    console.error(err);
    return reply.code(500).send({ error: "Error interno" });
  });

  // En la dirección del panel de compras solo se sirve ese panel y su API.
  app.addHook("onRequest", async (req, reply) => {
    if (!(await esHostCompras(req.hostname))) return;
    if (req.url.startsWith("/api/") && !req.url.startsWith("/api/c/")) return reply.code(404).send({ error: "No existe" });
  });

  await app.register(rutasSalud);
  await app.register(rutasPanelCompras, { prefix: "/api/c" });
  await app.register(rutasAuth, { prefix: "/api/auth" });
  await app.register(
    async (privado) => {
      privado.addHook("onRequest", app.autenticar);
      await privado.register(rutasRecordatorios);
      await privado.register(rutasConfiguracion);
      await privado.register(rutasWhatsapp);
      await privado.register(rutasPanel);
      await privado.register(rutasNotas);
      await privado.register(rutasCompras);
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
    app.get("/*", (req, reply) => {
      if (req.url.startsWith("/api/")) return reply.code(404).send({ error: "No existe" });
      return esHostCompras(req.hostname).then((compras) => reply.header("Cache-Control", "no-cache").sendFile(compras ? "compras.html" : "index.html"));
    });
  }

  return app;
}

/** ¿Pidieron la dirección del panel de compras? (también "comprascoff.localhost" para probar). */
async function esHostCompras(host: string): Promise<boolean> {
  const dominio = (await obtenerConfig()).comprasDominio.trim().toLowerCase();
  const h = host.split(":")[0].toLowerCase();
  if (!dominio) return false;
  return h === dominio || h.split(".")[0] === dominio.split(".")[0];
}

declare module "fastify" {
  interface FastifyInstance {
    autenticar: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}
