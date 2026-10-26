import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  agregarItems,
  borrarLista,
  obtenerLista,
  obtenerOCrearLista,
  quitarItems,
  renombrarLista,
  todasLasListas,
  vaciarLista,
} from "../../servicios/listas.js";
import { ErrorUsuario } from "../../servicios/recordatorios.js";

const Id = z.object({ id: z.coerce.number().int().positive() });

export const rutasListas: FastifyPluginAsync = async (app) => {
  app.get("/listas", async () => todasLasListas());

  app.post("/listas", async (req) => {
    const { nombre } = z.object({ nombre: z.string().trim().min(1).max(60) }).parse(req.body);
    return obtenerOCrearLista(nombre);
  });

  app.put("/listas/:id", async (req) => {
    const { id } = Id.parse(req.params);
    const { nombre } = z.object({ nombre: z.string().trim().min(1).max(60) }).parse(req.body);
    await renombrarLista(id, nombre);
    return obtenerLista(id);
  });

  app.delete("/listas/:id", async (req) => {
    const { id } = Id.parse(req.params);
    await borrarLista(id);
    return { ok: true };
  });

  app.post("/listas/:id/vaciar", async (req) => {
    const { id } = Id.parse(req.params);
    await vaciarLista(id);
    return { ok: true };
  });

  app.post("/listas/:id/items", async (req) => {
    const { id } = Id.parse(req.params);
    const { texto, cantidad } = z.object({ texto: z.string().trim().min(1).max(200), cantidad: z.string().trim().max(40).nullish() }).parse(req.body);
    if (!(await obtenerLista(id))) throw new ErrorUsuario("No existe esa lista.");
    await agregarItems(id, [{ texto, cantidad }]);
    return obtenerLista(id);
  });

  app.delete("/listas/items/:id", async (req) => {
    const { id } = Id.parse(req.params);
    await quitarItems([id]);
    return { ok: true };
  });
};
