import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { guardarNotaCalculadora, obtenerNotaCalculadora } from "../../servicios/calculadoras.js";

/** Una clave por calculadora (ej. "bavosi"), para poder sumar notas a otras. */
const Clave = z.object({ clave: z.string().regex(/^[a-z0-9-]{1,50}$/) });

export const rutasCalculadoras: FastifyPluginAsync = async (app) => {
  app.get("/calculadoras/notas/:clave", async (req) => obtenerNotaCalculadora(Clave.parse(req.params).clave));

  app.put("/calculadoras/notas/:clave", async (req) => {
    const { texto } = z.object({ texto: z.string().max(20_000) }).parse(req.body);
    return guardarNotaCalculadora(Clave.parse(req.params).clave, texto);
  });
};
