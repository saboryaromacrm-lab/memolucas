import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { actualizarNota, borrarNota, CATEGORIAS, crearNota, todasLasNotas } from "../../servicios/notas.js";

const Id = z.object({ id: z.coerce.number().int().positive() });
const Datos = z.object({
  titulo: z.string().trim().max(200),
  contenido: z.string().max(20_000),
  categoria: z.string().trim().max(30).nullish(),
  adjuntoId: z.number().int().positive().nullish(),
});

export const rutasNotas: FastifyPluginAsync = async (app) => {
  app.get("/notas", async () => ({ notas: await todasLasNotas(), categorias: CATEGORIAS }));

  app.post("/notas", async (req) => crearNota(Datos.parse(req.body)));

  app.put("/notas/:id", async (req) => {
    const { id } = Id.parse(req.params);
    return actualizarNota(id, Datos.partial().parse(req.body));
  });

  app.delete("/notas/:id", async (req) => {
    const { id } = Id.parse(req.params);
    await borrarNota(id);
    return { ok: true };
  });
};
