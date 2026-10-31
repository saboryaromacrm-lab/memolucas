import fs from "node:fs";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import sharp from "sharp";
import { z } from "zod";
import { entorno } from "../../entorno.js";
import { bus } from "../../lib/eventos.js";
import { guardarArchivo, MIMES_IMAGEN, obtenerAdjunto } from "../../servicios/adjuntos.js";
import {
  actualizarDatos,
  confirmarComprobante,
  descartarComprobante,
  listarComprobantes,
  obtenerComprobante,
} from "../../servicios/compras.js";
import { obtenerConfig } from "../../servicios/configuracion.js";
import { corregirConTexto } from "../../servicios/lectura-compras.js";
import {
  adjuntoDeCompras,
  cerrarLectura,
  crearLectura,
  existeLectura,
  ingresar,
  lecturasAbiertas,
  obtenerUsuario,
  reintentarLectura,
} from "../../servicios/panel-compras.js";
import { ErrorUsuario } from "../../servicios/recordatorios.js";
import { nombresGrupos, serializar } from "./compras.js";
import type { UsuarioCompras } from "../../db/schema.js";

export const COOKIE_COMPRAS = "compras_sesion";
const DIAS_SESION = 60;
const ADJUNTOS = "/api/c/adjuntos";
const Id = z.object({ id: z.coerce.number().int().positive() });
const ESTADOS = ["pendiente", "revisar", "confirmado", "descartado"] as const;

/** Colores de Coffit: marrón oscuro, naranja y beige. */
export const COLORES_COFFIT = { cafe: "#3b2416", naranja: "#e07a2c", beige: "#f3e8d8" };

declare module "fastify" {
  interface FastifyRequest {
    usuarioCompras?: UsuarioCompras;
  }
}

/** Ícono por defecto: una taza naranja sobre marrón. */
const ICONO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
<rect width="512" height="512" rx="112" fill="${COLORES_COFFIT.cafe}"/>
<path d="M140 190h196v92c0 54-44 98-98 98s-98-44-98-98z" fill="${COLORES_COFFIT.naranja}"/>
<path d="M336 214h20c26 0 46 20 46 46s-20 46-46 46h-24" fill="none" stroke="${COLORES_COFFIT.naranja}" stroke-width="22"/>
<path d="M196 110c-14 18 14 30 0 50M252 100c-14 22 14 36 0 60M308 110c-14 18 14 30 0 50" fill="none" stroke="${COLORES_COFFIT.beige}" stroke-width="14" stroke-linecap="round"/>
<rect x="120" y="396" width="236" height="20" rx="10" fill="${COLORES_COFFIT.beige}"/>
</svg>`;

async function icono(tam: number): Promise<Buffer> {
  const cfg = await obtenerConfig();
  const logo = cfg.comprasLogoAdjuntoId ? await obtenerAdjunto(cfg.comprasLogoAdjuntoId) : null;
  if (logo && fs.existsSync(logo.rutaArchivo)) {
    // El logo va centrado sobre beige, con margen (los íconos de Android se recortan en círculo).
    const interior = Math.round(tam * 0.72);
    const dibujo = await sharp(logo.rutaArchivo).resize(interior, interior, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
    return sharp({ create: { width: tam, height: tam, channels: 4, background: COLORES_COFFIT.beige } })
      .composite([{ input: dibujo, gravity: "center" }])
      .png()
      .toBuffer();
  }
  return sharp(Buffer.from(ICONO_SVG)).resize(tam, tam).png().toBuffer();
}

async function autenticarCompras(req: FastifyRequest, reply: FastifyReply) {
  try {
    const token = req.cookies[COOKIE_COMPRAS];
    if (!token) throw new Error("sin sesión");
    const datos = req.server.jwt.verify<{ v: number; tipo?: string; u?: number }>(token);
    if (datos.tipo !== "compras" || !datos.u) throw new Error("token de otro panel");
    const u = await obtenerUsuario(datos.u);
    if (!u?.activo || u.version !== datos.v) throw new Error("sesión vieja");
    req.usuarioCompras = u;
  } catch {
    return reply.code(401).send({ error: "Tenés que ingresar con tu clave" });
  }
}

/** API del panel de compras (el que usa el colaborador desde el celular). */
export const rutasPanelCompras: FastifyPluginAsync = async (app) => {
  // ───── Públicas: marca, íconos e ingreso ─────
  app.get("/marca", async () => {
    const cfg = await obtenerConfig();
    return { nombre: "Compras Coffit", logo: cfg.comprasLogoAdjuntoId ? `/api/c/logo?v=${cfg.comprasLogoAdjuntoId}` : null, colores: COLORES_COFFIT };
  });

  app.get("/logo", async (_req, reply) => {
    const cfg = await obtenerConfig();
    const a = cfg.comprasLogoAdjuntoId ? await obtenerAdjunto(cfg.comprasLogoAdjuntoId) : null;
    if (!a || !fs.existsSync(a.rutaArchivo)) return reply.code(404).send({ error: "Sin logo" });
    return reply.header("Content-Type", a.mime).header("Cache-Control", "public, max-age=86400").send(fs.createReadStream(a.rutaArchivo));
  });

  app.get("/icono/:tam", async (req, reply) => {
    const tam = Number(String((req.params as { tam: string }).tam).replace(/\.png$/, ""));
    if (![180, 192, 512].includes(tam)) return reply.code(404).send({ error: "No existe" });
    return reply.header("Content-Type", "image/png").header("Cache-Control", "public, max-age=3600").send(await icono(tam));
  });

  app.get("/manifest.webmanifest", async (_req, reply) => {
    const cfg = await obtenerConfig();
    const v = cfg.comprasLogoAdjuntoId ?? 0;
    return reply.header("Content-Type", "application/manifest+json").send({
      name: "Compras Coffit",
      short_name: "Compras",
      start_url: "/",
      display: "standalone",
      background_color: COLORES_COFFIT.beige,
      theme_color: COLORES_COFFIT.cafe,
      icons: [192, 512].map((t) => ({ src: `/api/c/icono/${t}.png?v=${v}`, sizes: `${t}x${t}`, type: "image/png", purpose: "any maskable" })),
    });
  });

  app.post("/ingresar", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    const { clave } = z.object({ clave: z.string() }).parse(req.body);
    const u = await ingresar(clave.trim(), req.ip);
    const token = app.jwt.sign({ v: u.version, tipo: "compras", u: u.id }, { expiresIn: `${DIAS_SESION}d` });
    return reply
      .setCookie(COOKIE_COMPRAS, token, { httpOnly: true, secure: entorno.produccion, sameSite: "lax", path: "/", maxAge: DIAS_SESION * 86_400 })
      .send({ nombre: u.nombre });
  });

  app.post("/salir", async (_req, reply) => reply.clearCookie(COOKIE_COMPRAS, { path: "/" }).send({ ok: true }));

  // ───── Con sesión ─────
  await app.register(async (privado) => {
    privado.addHook("onRequest", autenticarCompras);

    privado.get("/yo", async (req) => ({ nombre: req.usuarioCompras!.nombre }));

    privado.get("/eventos", { config: { rateLimit: false } }, (req, reply) => {
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
      res.write("retry: 3000\n\n");
      // Solo se avisa que cambió algo de compras (nada del resto de Memolucas).
      const enviar = (e: { tipo: string }) => e.tipo === "compras" && res.write(`event: cambio\ndata: {"tipo":"compras"}\n\n`);
      const latido = setInterval(() => res.write(": latido\n\n"), 25_000);
      bus.on("cambio", enviar);
      req.raw.on("close", () => {
        clearInterval(latido);
        bus.off("cambio", enviar);
      });
    });

    privado.get("/compras", async (req) => {
      const { estado, q } = z.object({ estado: z.enum(ESTADOS).optional(), q: z.string().optional() }).parse(req.query);
      let lista = await listarComprobantes({ estado });
      if (q?.trim()) {
        const buscado = q.trim().toLowerCase();
        lista = lista.filter((c) => `${c.datos.encabezado.razonSocialEmisor} ${c.datos.encabezado.numero} ${c.datos.encabezado.cuitEmisor}`.toLowerCase().includes(buscado));
      }
      const grupos = await nombresGrupos();
      return {
        lecturas: (await lecturasAbiertas()).map((l) => ({ id: l.id, estado: l.estado, autor: l.autor, mensaje: l.mensaje, hojas: l.nombres.length, creadoEn: l.creadoEn, clienteId: l.clienteId })),
        compras: await Promise.all(lista.map((c) => serializar(c, grupos, ADJUNTOS))),
      };
    });

    privado.get("/compras/:id", async (req) => {
      const { id } = Id.parse(req.params);
      const c = await obtenerComprobante(id);
      if (!c) throw new ErrorUsuario("No existe ese comprobante");
      return { ...(await serializar(c, await nombresGrupos(), ADJUNTOS)), datos: c.datos };
    });

    /** Fotos o PDF de un comprobante (pueden ser varias hojas). Se leen en segundo plano. */
    privado.post("/subir", { bodyLimit: 60 * 1024 * 1024 }, async (req) => {
      const cfg = await obtenerConfig();
      let clienteId = "";
      const archivos: { datos: Buffer; mime: string; nombre: string }[] = [];
      for await (const parte of req.parts({ limits: { files: 12, fileSize: Math.max(cfg.fotoMaxMb, 20) * 1024 * 1024 } })) {
        if (parte.type === "field") {
          if (parte.fieldname === "clienteId") clienteId = String(parte.value).slice(0, 80);
          continue;
        }
        const mime = parte.mimetype.split(";")[0];
        const datos = await parte.toBuffer();
        if (mime !== "application/pdf" && !MIMES_IMAGEN.includes(mime))
          throw new ErrorUsuario(`"${parte.filename}" no es una foto ni un PDF que se pueda leer.`);
        archivos.push({ datos, mime, nombre: parte.filename || "foto.jpg" });
      }
      if (!/^[\w-]{8,80}$/.test(clienteId)) throw new ErrorUsuario("Falta el identificador de la subida.");
      // Si el celular reintenta una subida que ya llegó, no se duplica.
      const existente = await existeLectura(clienteId);
      if (existente) return { id: existente.id, estado: existente.estado };
      if (!archivos.length) throw new ErrorUsuario("No llegó ninguna foto.");
      const guardados = [];
      for (const [i, a] of archivos.entries()) {
        const adj = await guardarArchivo(a.datos, a.mime);
        const ext = a.mime === "application/pdf" ? "pdf" : "jpg";
        guardados.push({ adjuntoId: adj.id, nombre: a.mime === "application/pdf" && a.nombre.endsWith(".pdf") ? a.nombre : `hoja-${i + 1}-${adj.id}.${ext}` });
      }
      const l = await crearLectura({ clienteId, usuario: req.usuarioCompras!, archivos: guardados });
      return { id: l.id, estado: l.estado };
    });

    privado.post("/lecturas/:id/reintentar", async (req) => {
      await reintentarLectura(Id.parse(req.params).id);
      return { ok: true };
    });

    privado.post("/lecturas/:id/cerrar", async (req) => {
      await cerrarLectura(Id.parse(req.params).id);
      return { ok: true };
    });

    privado.post("/compras/:id/confirmar", async (req) => {
      const r = await confirmarComprobante(Id.parse(req.params).id);
      if (!r) throw new ErrorUsuario("Ese comprobante ya estaba confirmado o descartado.");
      return { envio: r.envio };
    });

    privado.post("/compras/:id/descartar", async (req) => {
      if (!(await descartarComprobante(Id.parse(req.params).id))) throw new ErrorUsuario("Ese comprobante ya estaba confirmado o descartado.");
      return { ok: true };
    });

    /** Corrección escrita: la aplica la IA. */
    privado.post("/compras/:id/corregir", async (req) => {
      const { id } = Id.parse(req.params);
      const { texto } = z.object({ texto: z.string().trim().min(2).max(2000) }).parse(req.body);
      const c = await obtenerComprobante(id);
      if (!c) throw new ErrorUsuario("No existe ese comprobante");
      if (c.fila.estado === "confirmado" || c.fila.estado === "descartado") throw new ErrorUsuario("Ya está cerrado: no se puede corregir.");
      const r = await corregirConTexto(c.fila, texto);
      return { ...(await serializar(r, await nombresGrupos(), ADJUNTOS)), datos: r.datos };
    });

    /** Corrección con el formulario: llega el comprobante completo y se rehacen los controles. */
    privado.put("/compras/:id", async (req) => {
      const { id } = Id.parse(req.params);
      const { datos } = z.object({ datos: z.unknown() }).parse(req.body);
      const r = await actualizarDatos(id, datos);
      return { ...(await serializar(r, await nombresGrupos(), ADJUNTOS)), datos: r.datos };
    });

    privado.get("/adjuntos/:id", async (req, reply) => {
      const { id } = Id.parse(req.params);
      const a = (await adjuntoDeCompras(id)) ? await obtenerAdjunto(id) : null;
      if (!a || !fs.existsSync(a.rutaArchivo)) return reply.code(404).send({ error: "No existe" });
      return reply.header("Content-Type", a.mime).header("Cache-Control", "private, max-age=86400").send(fs.createReadStream(a.rutaArchivo));
    });
  });
};
