import fs from "node:fs";
import { and, desc, eq, ilike, inArray, isNotNull, ne, or, type SQL } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { db } from "../../db/index.js";
import { ocurrencia, recordatorio, type Configuracion, type Ocurrencia, type Recordatorio } from "../../db/schema.js";
import { aLocal } from "../../lib/fechas.js";
import { describirRrule, normalizarRrule } from "../../lib/recurrencia.js";
import { describirCuando } from "../../bot/procesador.js";
import { borrarAdjunto, guardarImagen, MIMES_IMAGEN, obtenerAdjunto } from "../../servicios/adjuntos.js";
import { obtenerConfig } from "../../servicios/configuracion.js";
import { procesarOcurrencia, textoAviso } from "../../servicios/disparador.js";
import { enviador } from "../../servicios/enviador.js";
import {
  actualizarRecordatorio,
  borrarRecordatorio,
  confirmarOcurrencia,
  crearEnvioInmediato,
  crearRecordatorio,
  duplicarRecordatorio,
  ErrorUsuario,
  eventosEntre,
  insistenciaEfectiva,
  marcarHecho,
  obtenerRecordatorio,
  pausarRecordatorio,
  posponerOcurrencia,
  reanudarRecordatorio,
} from "../../servicios/recordatorios.js";

const Id = z.object({ id: z.coerce.number().int().positive() });
const Fecha = z.string().transform((s, ctx) => {
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) ctx.addIssue({ code: "custom", message: "Fecha inválida" });
  return d;
});

const Datos = z.object({
  titulo: z.string().trim().min(1, "Falta el título").max(200),
  descripcion: z.string().max(2000).nullish(),
  fechaHora: Fecha,
  rrule: z.string().nullish(),
  avisosPreviosMin: z.array(z.number().int().positive().max(60 * 24 * 60)).max(10).optional(),
  avisarEnHora: z.boolean().optional(),
  insistenciaModo: z.enum(["global", "propia", "off"]).optional(),
  insistenciaIntervaloMin: z.number().int().min(1).max(24 * 60).nullish(),
  insistenciaTope: z.number().int().min(0).max(50).nullish(),
  insistirPrevios: z.boolean().nullish(),
  adjuntoId: z.number().int().positive().nullish(),
  listaId: z.number().int().positive().nullish(),
});

export function serializar(r: Recordatorio, cfg: Configuracion) {
  const ins = insistenciaEfectiva(r, cfg);
  return {
    ...r,
    repeticion: r.rrule ? describirRrule(r.rrule, r.fechaHora) : null,
    cuando: describirCuando(r),
    proxima: r.proximaInstancia ?? r.fechaHora,
    insistenciaEfectiva: ins,
    adjuntoUrl: r.adjuntoId ? `/api/adjuntos/${r.adjuntoId}` : null,
  };
}

const FILTROS: Record<string, SQL | undefined> = {
  activos: eq(recordatorio.estado, "activo"),
  pausados: eq(recordatorio.estado, "pausado"),
  cumplidos: eq(recordatorio.estado, "cumplido"),
  no_confirmados: eq(recordatorio.estado, "no_confirmado"),
  recurrentes: and(isNotNull(recordatorio.rrule), inArray(recordatorio.estado, ["activo", "pausado"])),
  con_foto: isNotNull(recordatorio.adjuntoId),
  todos: undefined,
};

export const rutasRecordatorios: FastifyPluginAsync = async (app) => {
  app.get("/recordatorios", async (req) => {
    const { filtro = "activos", q } = z.object({ filtro: z.string().optional(), q: z.string().optional() }).parse(req.query);
    const cond: (SQL | undefined)[] = [ne(recordatorio.estado, "borrado"), FILTROS[filtro]];
    if (q?.trim()) cond.push(or(ilike(recordatorio.titulo, `%${q.trim()}%`), ilike(recordatorio.descripcion, `%${q.trim()}%`)));
    const filas = await db
      .select()
      .from(recordatorio)
      .where(and(...cond))
      .orderBy(desc(recordatorio.id))
      .limit(500);
    const cfg = await obtenerConfig();
    // Los activos primero por próxima fecha; el resto por más reciente.
    const lista = filas.map((r) => serializar(r, cfg));
    lista.sort((a, b) => {
      const pa = a.estado === "activo" ? 0 : a.estado === "pausado" ? 1 : 2;
      const pb = b.estado === "activo" ? 0 : b.estado === "pausado" ? 1 : 2;
      if (pa !== pb) return pa - pb;
      if (pa < 2) return new Date(a.proxima).getTime() - new Date(b.proxima).getTime();
      return b.id - a.id;
    });
    return lista;
  });

  app.get("/recordatorios/:id", async (req, reply) => {
    const { id } = Id.parse(req.params);
    const r = await obtenerRecordatorio(id);
    if (!r) return reply.code(404).send({ error: "No existe" });
    const ocs = await db.select().from(ocurrencia).where(eq(ocurrencia.recordatorioId, id)).orderBy(desc(ocurrencia.programadaPara)).limit(200);
    return { ...serializar(r, await obtenerConfig()), ocurrencias: ocs };
  });

  app.post("/recordatorios", async (req) => {
    const d = Datos.parse(req.body);
    const r = await crearRecordatorio({ ...d, origen: "panel" });
    return serializar(r, await obtenerConfig());
  });

  app.put("/recordatorios/:id", async (req) => {
    const { id } = Id.parse(req.params);
    const d = Datos.partial().parse(req.body);
    const r = await actualizarRecordatorio(id, d);
    return serializar(r, await obtenerConfig());
  });

  app.patch("/recordatorios/:id/mover", async (req) => {
    const { id } = Id.parse(req.params);
    const { fechaHora } = z.object({ fechaHora: Fecha }).parse(req.body);
    const actual = await obtenerRecordatorio(id);
    if (!actual) throw new ErrorUsuario("No existe");
    if (actual.rrule) throw new ErrorUsuario("Los recurrentes se cambian desde el editor.");
    const r = await actualizarRecordatorio(id, { fechaHora });
    return serializar(r, await obtenerConfig());
  });

  app.delete("/recordatorios/:id", async (req) => {
    const { id } = Id.parse(req.params);
    await borrarRecordatorio(id);
    return { ok: true };
  });

  app.post("/recordatorios/:id/:accion", async (req) => {
    const { id, accion } = z
      .object({ id: z.coerce.number().int(), accion: z.enum(["pausar", "reanudar", "duplicar", "hecho", "enviar-ahora"]) })
      .parse(req.params);
    switch (accion) {
      case "pausar":
        await pausarRecordatorio(id);
        break;
      case "reanudar":
        await reanudarRecordatorio(id);
        break;
      case "duplicar":
        return serializar(await duplicarRecordatorio(id), await obtenerConfig());
      case "hecho":
        await marcarHecho(id);
        break;
      case "enviar-ahora": {
        if (!enviador().conectado()) throw new ErrorUsuario("WhatsApp no está conectado.");
        const r = await obtenerRecordatorio(id);
        if (r?.estado !== "activo") throw new ErrorUsuario("Solo se pueden enviar recordatorios activos.");
        const oc = await crearEnvioInmediato(id);
        await procesarOcurrencia(oc.id);
        break;
      }
    }
    return { ok: true };
  });

  app.post("/ocurrencias/:id/confirmar", async (req) => {
    const { id } = Id.parse(req.params);
    return { ok: !!(await confirmarOcurrencia(id)) };
  });

  app.post("/ocurrencias/:id/posponer", async (req) => {
    const { id } = Id.parse(req.params);
    const { minutos } = z.object({ minutos: z.number().int().min(1).max(60 * 24 * 30) }).parse(req.body);
    return { ok: !!(await posponerOcurrencia(id, new Date(Date.now() + minutos * 60_000))) };
  });

  // ───── Fotos ─────
  app.post("/adjuntos", async (req) => {
    const archivo = await req.file();
    if (!archivo) throw new ErrorUsuario("No llegó ningún archivo.");
    if (!MIMES_IMAGEN.includes(archivo.mimetype)) throw new ErrorUsuario("Solo fotos (JPG, PNG, WEBP o GIF).");
    const datos = await archivo.toBuffer();
    const cfg = await obtenerConfig();
    if (datos.length > cfg.fotoMaxMb * 1024 * 1024) throw new ErrorUsuario(`La foto supera los ${cfg.fotoMaxMb} MB.`);
    const a = await guardarImagen(datos, archivo.mimetype);
    return { id: a.id, url: `/api/adjuntos/${a.id}` };
  });

  app.delete("/recordatorios/:id/adjunto", async (req) => {
    const { id } = Id.parse(req.params);
    const r = await obtenerRecordatorio(id);
    if (!r?.adjuntoId) return { ok: true };
    const adjuntoId = r.adjuntoId;
    await actualizarRecordatorio(id, { adjuntoId: null });
    const otros = await db.select({ id: recordatorio.id }).from(recordatorio).where(eq(recordatorio.adjuntoId, adjuntoId)).limit(1);
    if (!otros.length) await borrarAdjunto(adjuntoId);
    return { ok: true };
  });

  app.get("/adjuntos/:id", async (req, reply) => {
    const { id } = Id.parse(req.params);
    const a = await obtenerAdjunto(id);
    if (!a || !fs.existsSync(a.rutaArchivo)) return reply.code(404).send({ error: "No existe" });
    return reply.header("Content-Type", a.mime).header("Cache-Control", "private, max-age=86400").send(fs.createReadStream(a.rutaArchivo));
  });

  // ───── Calendario ─────
  app.get("/calendario", async (req) => {
    const { desde, hasta } = z.object({ desde: Fecha, hasta: Fecha }).parse(req.query);
    const eventos = await eventosEntre(desde, hasta, ["activo", "pausado", "cumplido", "no_confirmado"]);
    return eventos
      .filter((e) => e.recordatorio.rrule || e.recordatorio.estado !== "borrado")
      .map((e) => ({
        id: `${e.recordatorio.id}-${e.cuando.getTime()}`,
        recordatorioId: e.recordatorio.id,
        titulo: e.recordatorio.titulo,
        inicio: e.cuando,
        estado: e.recordatorio.estado,
        recurrente: !!e.recordatorio.rrule,
        conFoto: !!e.recordatorio.adjuntoId,
      }));
  });

  // ───── Vista previa del mensaje ─────
  app.post("/vista-previa", async (req) => {
    const d = Datos.partial().parse(req.body);
    const cfg = await obtenerConfig();
    const fecha = d.fechaHora ?? new Date();
    const rec = {
      id: 0,
      titulo: d.titulo || "Título del recordatorio",
      descripcion: d.descripcion ?? null,
      fechaHora: fecha,
      rrule: normalizarRrule(d.rrule),
      proximaInstancia: fecha,
      avisosPreviosMin: d.avisosPreviosMin ?? [],
      avisarEnHora: d.avisarEnHora ?? true,
      insistenciaModo: d.insistenciaModo ?? "global",
      insistenciaIntervaloMin: d.insistenciaIntervaloMin ?? null,
      insistenciaTope: d.insistenciaTope ?? null,
      insistirPrevios: d.insistirPrevios ?? null,
      estado: "activo",
      origen: "panel",
      adjuntoId: d.adjuntoId ?? null,
      listaId: d.listaId ?? null,
      creadoEn: new Date(),
      actualizadoEn: new Date(),
    } satisfies Recordatorio;
    const ins = insistenciaEfectiva(rec, cfg);
    const base: Ocurrencia = {
      id: 0,
      recordatorioId: 0,
      instancia: fecha,
      programadaPara: fecha,
      tipo: "principal",
      minutosAntes: 0,
      proximoEnvioEn: fecha,
      insiste: ins.activa,
      intervaloMin: ins.intervalo,
      tope: ins.tope,
      enviadaEn: null,
      ultimoEnvioEn: null,
      intentos: 0,
      confirmadaEn: null,
      pospuestaHasta: null,
      estado: "pendiente",
      atrasada: false,
      waMessageId: null,
      creadoEn: new Date(),
    };
    const previos = (rec.avisosPreviosMin.length ? [...rec.avisosPreviosMin].sort((a, b) => b - a) : []).map((m) => ({
      cuando: aLocal(new Date(fecha.getTime() - m * 60_000)).toISO(),
      texto: textoAviso(
        { ...base, tipo: "previo", minutosAntes: m, programadaPara: new Date(fecha.getTime() - m * 60_000), insiste: ins.activa && ins.previos },
        rec,
        cfg,
        new Date(fecha.getTime() - m * 60_000),
      ).texto,
    }));
    return {
      confirmacion: describirCuando(rec),
      previos,
      aviso: rec.avisarEnHora || !previos.length ? textoAviso(base, rec, cfg, fecha).texto : null,
      insistencia: ins.activa ? textoAviso({ ...base, intentos: 1 }, rec, cfg, fecha).texto : null,
      insistenciaResumen: ins.activa ? `Insiste cada ${ins.intervalo} min, hasta ${ins.tope} veces.` : "Sin insistencia.",
    };
  });
};
