import fs from "node:fs";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import sharp from "sharp";
import { z } from "zod";
import { entorno } from "../../entorno.js";
import { bus } from "../../lib/eventos.js";
import { borrarAdjunto, guardarArchivo, MIMES_IMAGEN, obtenerAdjunto } from "../../servicios/adjuntos.js";
import {
  actualizarDatos,
  confirmarComprobante,
  descartarComprobante,
  fijarFormaPago,
  listarComprobantes,
  nombres,
  obtenerComprobante,
} from "../../servicios/compras.js";
import { obtenerConfig } from "../../servicios/configuracion.js";
import { borrarCompraManual, EsquemaCompraManual, guardarCompraManual, obtenerCompraManual } from "../../servicios/compras-manuales.js";
import { actualizarFormaPago, borrarFormaPago, crearFormaPago, listarFormasPago, moverFormaPago } from "../../servicios/formas-pago.js";
import { corregirConTexto } from "../../servicios/lectura-compras.js";
import { metricas, metricasCsv } from "../../servicios/metricas.js";
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
import {
  actualizarProveedor,
  borrarProveedor,
  crearProveedor,
  desenlazarProducto,
  enlazarProducto,
  juntarProveedores,
  listarProveedores,
  obtenerProveedor,
  pagosDelMes,
} from "../../servicios/proveedores.js";
import {
  actualizarCompra,
  actualizarProducto,
  juntarProductos,
  listarProductos,
  obtenerProducto,
  productosCsv,
  productosDeComprobante,
  productosDeProveedor,
  reasignarRenglon,
  separarAlias,
} from "../../servicios/productos.js";
import { serializar } from "./compras.js";
import type { UsuarioCompras } from "../../db/schema.js";

export const COOKIE_COMPRAS = "compras_sesion";
const DIAS_SESION = 60;
const ADJUNTOS = "/api/c/adjuntos";
const Id = z.object({ id: z.coerce.number().int().positive() });
/** Un mes ("2026-11") o un día ("2026-11-05"). */
const Periodo = z.string().regex(/^\d{4}-\d{2}(-\d{2})?$/);
const Fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
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

/**
 * Los íconos del panel: tamaño y cuánto del cuadrado ocupa el logo. Los "recorte" son para Android, que los recorta
 * en círculo: el logo tiene que entrar en el círculo central (80 %).
 */
const ICONOS: Record<string, { tam: number; logo: number }> = {
  "32": { tam: 32, logo: 0.94 }, // pestaña del navegador
  "180": { tam: 180, logo: 0.82 }, // iPhone (redondea las esquinas)
  "192": { tam: 192, logo: 0.86 },
  "512": { tam: 512, logo: 0.86 },
  "192-recorte": { tam: 192, logo: 0.56 },
  "512-recorte": { tam: 512, logo: 0.56 },
};

/** Luminancia relativa (0 negro, 1 blanco) de un color, para medir el contraste. */
function luminancia(r: number, g: number, b: number) {
  const lineal = (c: number) => (c / 255 <= 0.03928 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lineal(r) + 0.7152 * lineal(g) + 0.0722 * lineal(b);
}
const hexARgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
const contraste = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

/** Si el logo ya trae fondo (no es transparente), ese color; si no, café o beige: el que más contraste con el logo. */
async function fondoDelIcono(ruta: string): Promise<string> {
  const { data } = await sharp(ruta).resize(64, 64, { fit: "inside" }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const suma = [0, 0, 0];
  let visible = 0;
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3] / 255;
    visible += a;
    for (let c = 0; c < 3; c++) suma[c] += a * data[i + c];
  }
  if (visible >= (data.length / 4) * 0.99) return `rgb(${data[0]}, ${data[1]}, ${data[2]})`;
  if (!visible) return COLORES_COFFIT.beige;
  const logo = luminancia(suma[0] / visible, suma[1] / visible, suma[2] / visible);
  const [cafe, beige] = [COLORES_COFFIT.cafe, COLORES_COFFIT.beige].map((c) => contraste(logo, luminancia(...hexARgb(c))));
  return cafe >= beige ? COLORES_COFFIT.cafe : COLORES_COFFIT.beige;
}

async function icono({ tam, logo: parte }: { tam: number; logo: number }): Promise<Buffer> {
  const cfg = await obtenerConfig();
  const logo = cfg.comprasLogoAdjuntoId ? await obtenerAdjunto(cfg.comprasLogoAdjuntoId) : null;
  if (!logo || !fs.existsSync(logo.rutaArchivo)) return sharp(Buffer.from(ICONO_SVG)).resize(tam, tam).png().toBuffer();
  const interior = Math.round(tam * parte);
  const dibujo = await sharp(logo.rutaArchivo).resize(interior, interior, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
  return sharp({ create: { width: tam, height: tam, channels: 4, background: await fondoDelIcono(logo.rutaArchivo) } })
    .composite([{ input: dibujo, gravity: "center" }])
    .png()
    .toBuffer();
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

/** Lee un formulario con archivos (fotos o PDF). Los campos de texto quedan en "campos". */
async function leerFormulario(req: FastifyRequest, maxArchivos: number) {
  const cfg = await obtenerConfig();
  const campos: Record<string, string> = {};
  const archivos: { datos: Buffer; mime: string; nombre: string }[] = [];
  for await (const parte of req.parts({ limits: { files: maxArchivos, fileSize: Math.max(cfg.fotoMaxMb, 20) * 1024 * 1024 } })) {
    if (parte.type === "field") {
      campos[parte.fieldname] = String(parte.value);
      continue;
    }
    const mime = parte.mimetype.split(";")[0];
    const datos = await parte.toBuffer();
    if (mime !== "application/pdf" && !MIMES_IMAGEN.includes(mime)) throw new ErrorUsuario(`"${parte.filename}" no es una foto ni un PDF que se pueda leer.`);
    archivos.push({ datos, mime, nombre: parte.filename || "foto.jpg" });
  }
  return { campos, archivos };
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

  // Las direcciones llevan la versión del logo (?v=): al cambiarlo cambian, así que se pueden guardar mucho tiempo.
  app.get("/icono/:nombre", async (req, reply) => {
    const variante = ICONOS[String((req.params as { nombre: string }).nombre).replace(/\.png$/, "")];
    if (!variante) return reply.code(404).send({ error: "No existe" });
    const versionada = "v" in (req.query as object);
    return reply
      .header("Content-Type", "image/png")
      .header("Cache-Control", versionada ? "public, max-age=31536000, immutable" : "no-cache")
      .send(await icono(variante));
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
      icons: [192, 512].flatMap((t) => [
        { src: `/api/c/icono/${t}.png?v=${v}`, sizes: `${t}x${t}`, type: "image/png", purpose: "any" },
        { src: `/api/c/icono/${t}-recorte.png?v=${v}`, sizes: `${t}x${t}`, type: "image/png", purpose: "maskable" },
      ]),
    });
  });

  app.post("/ingresar", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    const { clave } = z.object({ clave: z.string() }).parse(req.body);
    const u = await ingresar(clave.trim(), req.ip);
    const token = app.jwt.sign({ v: u.version, tipo: "compras", u: u.id }, { expiresIn: `${DIAS_SESION}d` });
    return reply
      .setCookie(COOKIE_COMPRAS, token, { httpOnly: true, secure: entorno.produccion, sameSite: "lax", path: "/", maxAge: DIAS_SESION * 86_400 })
      .send({ nombre: u.nombre, metricas: u.metricas });
  });

  app.post("/salir", async (_req, reply) => reply.clearCookie(COOKIE_COMPRAS, { path: "/" }).send({ ok: true }));

  // ───── Con sesión ─────
  await app.register(async (privado) => {
    privado.addHook("onRequest", autenticarCompras);

    privado.get("/yo", async (req) => ({ nombre: req.usuarioCompras!.nombre, metricas: req.usuarioCompras!.metricas }));

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
      const { estado, q, periodo } = z.object({ estado: z.enum(ESTADOS).optional(), q: z.string().optional(), periodo: Periodo.optional() }).parse(req.query);
      let lista = await listarComprobantes({ estado, periodo });
      if (q?.trim()) {
        const buscado = q.trim().toLowerCase();
        lista = lista.filter((c) => `${c.datos.encabezado.razonSocialEmisor} ${c.datos.encabezado.numero} ${c.datos.encabezado.cuitEmisor}`.toLowerCase().includes(buscado));
      }
      const n = await nombres();
      return {
        lecturas: (await lecturasAbiertas()).map((l) => ({ id: l.id, estado: l.estado, autor: l.autor, mensaje: l.mensaje, hojas: l.nombres.length, creadoEn: l.creadoEn, clienteId: l.clienteId })),
        compras: await Promise.all(lista.map((c) => serializar(c, n, ADJUNTOS))),
      };
    });

    /** El comprobante completo y, si ya pasó a Productos, a qué producto fue cada renglón. */
    privado.get("/compras/:id", async (req) => {
      const { id } = Id.parse(req.params);
      const c = await obtenerComprobante(id);
      if (!c) throw new ErrorUsuario("No existe ese comprobante");
      return { ...(await serializar(c, await nombres(), ADJUNTOS)), datos: c.datos, productos: await productosDeComprobante(id) };
    });

    /** Corrige a qué producto fue un renglón (y lo que venga igual de ese proveedor). */
    privado.put("/compras/:id/renglones/:renglon/producto", async (req) => {
      const { id, renglon } = Id.extend({ renglon: z.coerce.number().int().positive() }).parse(req.params);
      const { productoId } = z.object({ productoId: z.number().int().positive() }).parse(req.body);
      await reasignarRenglon(id, renglon, productoId);
      return { ok: true };
    });

    /** Fotos o PDF de un comprobante (pueden ser varias hojas). Se leen en segundo plano. */
    privado.post("/subir", { bodyLimit: 60 * 1024 * 1024 }, async (req) => {
      const { campos, archivos } = await leerFormulario(req, 12);
      const clienteId = (campos.clienteId ?? "").slice(0, 80);
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

    // ───── Proveedores ─────
    privado.get("/proveedores", async (req) => {
      const { ocultos } = z.object({ ocultos: z.string().optional() }).parse(req.query);
      return listarProveedores(!!ocultos);
    });

    /** Ficha: el proveedor, sus últimas compras, lo pagado este mes en cada forma y lo que se le compra (con el último precio). */
    privado.get("/proveedores/:id", async (req) => {
      const { id } = Id.parse(req.params);
      const [p, productos, compras, pagos, n] = await Promise.all([
        obtenerProveedor(id),
        productosDeProveedor(id),
        listarComprobantes({ proveedorId: id }),
        pagosDelMes(id),
        nombres(),
      ]);
      return { ...p, productos, pagos, ultimas: await Promise.all(compras.slice(0, 50).map((c) => serializar(c, n, ADJUNTOS))) };
    });

    const FormaPagoId = z.number().int().positive().nullable();
    const DatosProveedor = z.object({ nombre: z.string().trim().min(2).max(120), notas: z.string().max(2000), oculto: z.boolean(), formaPagoId: FormaPagoId });

    privado.post("/proveedores", async (req) => {
      const { nombre, notas, formaPagoId } = DatosProveedor.pick({ nombre: true, notas: true, formaPagoId: true }).partial({ notas: true, formaPagoId: true }).parse(req.body);
      return crearProveedor(nombre, notas, formaPagoId);
    });

    privado.put("/proveedores/:id", async (req) => {
      await actualizarProveedor(Id.parse(req.params).id, DatosProveedor.partial().parse(req.body));
      return { ok: true };
    });

    privado.delete("/proveedores/:id", async (req) => {
      await borrarProveedor(Id.parse(req.params).id);
      return { ok: true };
    });

    /** Lo que vende cada proveedor: se suma o se quita a mano (con cada compra se suma solo). */
    privado.post("/proveedores/:id/productos", async (req) => {
      const { productoId } = z.object({ productoId: z.number().int().positive() }).parse(req.body);
      await enlazarProducto(Id.parse(req.params).id, productoId);
      return { ok: true };
    });

    privado.delete("/proveedores/:id/productos/:productoId", async (req) => {
      const { id, productoId } = Id.extend({ productoId: z.coerce.number().int().positive() }).parse(req.params);
      await desenlazarProducto(id, productoId);
      return { ok: true };
    });

    privado.post("/proveedores/:id/juntar", async (req) => {
      const { conId } = z.object({ conId: z.number().int().positive() }).parse(req.body);
      await juntarProveedores(Id.parse(req.params).id, conId);
      return { ok: true };
    });

    // ───── Formas de pago ─────
    privado.get("/formas-pago", async (req) => {
      const { ocultas } = z.object({ ocultas: z.string().optional() }).parse(req.query);
      return listarFormasPago(!!ocultas);
    });

    const DatosFormaPago = z.object({ nombre: z.string().trim().min(2).max(60), oculta: z.boolean() });

    privado.post("/formas-pago", async (req) => crearFormaPago(DatosFormaPago.pick({ nombre: true }).parse(req.body).nombre));

    privado.put("/formas-pago/:id", async (req) => {
      await actualizarFormaPago(Id.parse(req.params).id, DatosFormaPago.partial().parse(req.body));
      return { ok: true };
    });

    privado.post("/formas-pago/:id/mover", async (req) => {
      const { paso } = z.object({ paso: z.union([z.literal(-1), z.literal(1)]) }).parse(req.body);
      await moverFormaPago(Id.parse(req.params).id, paso);
      return { ok: true };
    });

    privado.delete("/formas-pago/:id", async (req) => {
      await borrarFormaPago(Id.parse(req.params).id);
      return { ok: true };
    });

    // ───── Compras sin factura (cargadas a mano) ─────
    /** Formulario con los datos (JSON) y, opcional, una foto del ticket o remito. Si no se guarda, la foto no queda suelta. */
    const guardarManual = async (req: FastifyRequest, id?: number) => {
      const { campos, archivos } = await leerFormulario(req, 1);
      let crudo: unknown;
      try {
        crudo = JSON.parse(campos.datos ?? "");
      } catch {
        throw new ErrorUsuario("Datos inválidos");
      }
      const datos = EsquemaCompraManual.parse(crudo);
      const nueva = archivos[0] ? (await guardarArchivo(archivos[0].datos, archivos[0].mime)).id : null;
      // Sin foto nueva: al crear no hay; al editar queda la que tenía, salvo que se pida quitarla.
      const foto = nueva ?? (campos.quitarFoto || !id ? null : undefined);
      try {
        return { id: await guardarCompraManual(datos, req.usuarioCompras!.nombre, foto, id) };
      } catch (err) {
        if (nueva) await borrarAdjunto(nueva);
        throw err;
      }
    };

    privado.post("/manuales", { bodyLimit: 30 * 1024 * 1024 }, async (req) => guardarManual(req));

    privado.get("/manuales/:id", async (req) => obtenerCompraManual(Id.parse(req.params).id));

    privado.put("/manuales/:id", { bodyLimit: 30 * 1024 * 1024 }, async (req) => guardarManual(req, Id.parse(req.params).id));

    privado.delete("/manuales/:id", async (req) => {
      await borrarCompraManual(Id.parse(req.params).id);
      return { ok: true };
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
      return { ...(await serializar(r, await nombres(), ADJUNTOS)), datos: r.datos };
    });

    /** Corrección con el formulario: llega el comprobante completo y se rehacen los controles. */
    privado.put("/compras/:id", async (req) => {
      const { id } = Id.parse(req.params);
      const { datos } = z.object({ datos: z.unknown() }).parse(req.body);
      const r = await actualizarDatos(id, datos);
      return { ...(await serializar(r, await nombres(), ADJUNTOS)), datos: r.datos };
    });

    /** Cómo se pagó: se puede cambiar siempre, aunque ya esté confirmada. */
    privado.put("/compras/:id/forma-pago", async (req) => {
      const { formaPagoId } = z.object({ formaPagoId: FormaPagoId }).parse(req.body);
      await fijarFormaPago(Id.parse(req.params).id, formaPagoId);
      return { ok: true };
    });

    // ───── Métricas: solo para quien la tiene permitida ─────
    const conMetricas = {
      preHandler: async (req: FastifyRequest, reply: FastifyReply) => {
        if (!req.usuarioCompras!.metricas) return reply.code(403).send({ error: "No tenés acceso a Métricas" });
      },
    };
    const leerMetricas = (req: FastifyRequest) => {
      const { desde, hasta, confirmadas } = z
        .object({ desde: Fecha, hasta: Fecha, confirmadas: z.string().optional() })
        .refine((p) => p.desde <= p.hasta, "El período termina antes de empezar")
        .parse(req.query);
      return metricas({ desde, hasta }, !!confirmadas);
    };

    privado.get("/metricas", conMetricas, leerMetricas);

    privado.get("/metricas.csv", conMetricas, async (req, reply) => {
      const m = await leerMetricas(req);
      return reply
        .header("Content-Type", "text/csv; charset=utf-8")
        .header("Content-Disposition", `attachment; filename="metricas-coffit-${m.periodo.desde}-a-${m.periodo.hasta}.csv"`)
        .send(metricasCsv(m));
    });

    // ───── Productos (precios por bulto, unidad y kg o litro de lo que se compró) ─────
    privado.get("/productos", async () => ({ productos: await listarProductos(), alertaPct: (await obtenerConfig()).productosAlertaPct }));

    privado.get("/productos.csv", async (_req, reply) =>
      reply
        .header("Content-Type", "text/csv; charset=utf-8")
        .header("Content-Disposition", `attachment; filename="productos-coffit-${new Date().toISOString().slice(0, 10)}.csv"`)
        .send(await productosCsv()),
    );

    privado.get("/productos/:id", async (req) => obtenerProducto(Id.parse(req.params).id));

    privado.put("/productos/:id", async (req) => {
      const c = z
        .object({
          nombre: z.string().trim().min(2).max(120),
          categoria: z.string().trim().min(1).max(40),
          clase: z.enum(["mercaderia", "gasto"]),
          contenido: z.number().positive().max(100_000).nullable(),
          medida: z.enum(["kg", "l"]).nullable(),
        })
        .partial()
        .parse(req.body);
      await actualizarProducto(Id.parse(req.params).id, c);
      return { ok: true };
    });

    privado.post("/productos/:id/juntar", async (req) => {
      const { conId } = z.object({ conId: z.number().int().positive() }).parse(req.body);
      await juntarProductos(Id.parse(req.params).id, conId);
      return { ok: true };
    });

    privado.post("/productos/:id/separar", async (req) => {
      const { alias } = z.object({ alias: z.string().min(1) }).parse(req.body);
      return { id: await separarAlias(Id.parse(req.params).id, alias) };
    });

    privado.put("/productos/compras/:id", async (req) => {
      const c = z.object({ unidadCompra: z.enum(["bulto", "unidad", "kg", "litro"]), unidadesPorBulto: z.number().min(0).max(10_000) }).partial().parse(req.body);
      await actualizarCompra(Id.parse(req.params).id, c);
      return { ok: true };
    });

    privado.get("/adjuntos/:id", async (req, reply) => {
      const { id } = Id.parse(req.params);
      const a = (await adjuntoDeCompras(id)) ? await obtenerAdjunto(id) : null;
      if (!a || !fs.existsSync(a.rutaArchivo)) return reply.code(404).send({ error: "No existe" });
      return reply.header("Content-Type", a.mime).header("Cache-Control", "private, max-age=86400").send(fs.createReadStream(a.rutaArchivo));
    });
  });
};
