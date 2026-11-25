import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { ErrorUsuario } from "../../servicios/recordatorios.js";
import {
  agregarImagen,
  borrarImagen,
  borrarPestana,
  cerrarPestana,
  crearPestana,
  guardarPestana,
  IMAGEN_MAX_BYTES,
  leerImagen,
  listarBloc,
  ordenarBloc,
  papeleraBloc,
  restaurarPestana,
  restaurarVersion,
  versionesPestana,
} from "../../servicios/bloc.js";

const Id = z.object({ id: z.coerce.number().int().positive() });
/** Hasta ~1 MB de texto por pestaña. */
const Texto = z.string().max(1_000_000, "La pestaña es demasiado larga: partila en dos.");
const Titulo = z.string().max(120);

export const rutasBloc: FastifyPluginAsync = async (app) => {
  app.get("/bloc", async () => listarBloc());

  app.post("/bloc", async (req) => crearPestana(z.object({ titulo: Titulo.optional(), texto: Texto.optional() }).parse(req.body ?? {})));

  /** Guardar (se llama solo mientras se escribe). Devuelve la versión nueva y si otro dispositivo había escrito antes. */
  app.put("/bloc/:id", async (req) =>
    guardarPestana(Id.parse(req.params).id, z.object({ texto: Texto.optional(), titulo: Titulo.optional(), version: z.number().int() }).parse(req.body)),
  );

  app.post("/bloc/orden", async (req) => {
    await ordenarBloc(z.object({ ids: z.array(z.number().int().positive()).max(500) }).parse(req.body).ids);
    return { ok: true };
  });

  app.delete("/bloc/:id", async (req) => {
    await cerrarPestana(Id.parse(req.params).id);
    return { ok: true };
  });

  app.get("/bloc/papelera", async () => papeleraBloc());

  app.post("/bloc/:id/restaurar", async (req) => {
    await restaurarPestana(Id.parse(req.params).id);
    return { ok: true };
  });

  app.delete("/bloc/:id/definitivo", async (req) => {
    await borrarPestana(Id.parse(req.params).id);
    return { ok: true };
  });

  app.get("/bloc/:id/versiones", async (req) => versionesPestana(Id.parse(req.params).id));

  app.post("/bloc/:id/versiones/:version/restaurar", async (req) => {
    const { id, version } = z.object({ id: z.coerce.number().int().positive(), version: z.coerce.number().int().positive() }).parse(req.params);
    return restaurarVersion(id, version);
  });

  // Imágenes: llegan como el archivo tal cual (Ctrl+V, arrastrada o de la cámara), hasta 15 MB.
  app.addContentTypeParser(/^image\//, { parseAs: "buffer", bodyLimit: IMAGEN_MAX_BYTES }, (_req, cuerpo, listo) => listo(null, cuerpo));

  app.post("/bloc/:id/imagenes", { bodyLimit: IMAGEN_MAX_BYTES }, async (req) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw new ErrorUsuario("Eso no es una imagen.");
    return agregarImagen(Id.parse(req.params).id, req.body);
  });

  /** WebP; ?mini=1 la miniatura. No cambia nunca (cada imagen nueva tiene otro id): se guarda en la caché del navegador. */
  app.get("/bloc/imagenes/:id", async (req, reply) => {
    const mini = z.object({ mini: z.string().optional() }).parse(req.query).mini === "1";
    const datos = await leerImagen(Id.parse(req.params).id, mini);
    return reply.header("Cache-Control", "private, max-age=31536000, immutable").type("image/webp").send(datos);
  });

  app.delete("/bloc/imagenes/:id", async (req) => {
    await borrarImagen(Id.parse(req.params).id);
    return { ok: true };
  });
};
