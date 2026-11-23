import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { actualizarLink, borrarLink, crearLink, listarLinks, moverLink } from "../../servicios/links.js";

const Id = z.object({ id: z.coerce.number().int().positive() });
const Datos = z.object({ concepto: z.string().trim().min(1, "Falta el concepto").max(120), url: z.string().trim().min(1, "Falta la dirección").max(2000) });

export const rutasLinks: FastifyPluginAsync = async (app) => {
  app.get("/links", async () => listarLinks());

  app.post("/links", async (req) => crearLink(Datos.parse(req.body)));

  app.put("/links/:id", async (req) => {
    await actualizarLink(Id.parse(req.params).id, Datos.parse(req.body));
    return { ok: true };
  });

  app.delete("/links/:id", async (req) => {
    await borrarLink(Id.parse(req.params).id);
    return { ok: true };
  });

  app.post("/links/:id/mover", async (req) => {
    const { paso } = z.object({ paso: z.union([z.literal(-1), z.literal(1)]) }).parse(req.body);
    await moverLink(Id.parse(req.params).id, paso);
    return { ok: true };
  });
};
