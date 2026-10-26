import { and, count, desc, eq, gte, ilike, lt, lte, ne, type SQL } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { db } from "../../db/index.js";
import { logSistema, mensaje, ocurrencia, recordatorio } from "../../db/schema.js";
import { ahora } from "../../lib/fechas.js";
import { gastoDelMes } from "../../bot/ia.js";
import { obtenerConfig } from "../../servicios/configuracion.js";
import { rangoHoy, rangoManana } from "../../servicios/listados.js";
import { crearRecordatorio, eventosEntre, pendientesSinConfirmar } from "../../servicios/recordatorios.js";
import { serializar } from "./recordatorios.js";
import { infoWhatsapp } from "./whatsapp.js";

export const rutasPanel: FastifyPluginAsync = async (app) => {
  app.get("/estado", async () => {
    const cfg = await obtenerConfig();
    const hoy = rangoHoy();
    const manana = rangoManana();
    const inicioSemana = ahora().startOf("week").toJSDate();
    const haceSieteDias = new Date(Date.now() - 7 * 86_400_000);
    const [activos] = await db.select({ n: count() }).from(recordatorio).where(eq(recordatorio.estado, "activo"));
    const [cumplidos] = await db
      .select({ n: count() })
      .from(ocurrencia)
      .where(and(eq(ocurrencia.estado, "confirmada"), gte(ocurrencia.confirmadaEn, inicioSemana)));
    const [noConf] = await db
      .select({ n: count() })
      .from(ocurrencia)
      .where(and(eq(ocurrencia.estado, "no_confirmada"), gte(ocurrencia.programadaPara, haceSieteDias)));
    const evento = (e: Awaited<ReturnType<typeof eventosEntre>>[number]) => ({
      recordatorio: serializar(e.recordatorio, cfg),
      cuando: e.cuando,
    });
    return {
      whatsapp: await infoWhatsapp(),
      configInicialPendiente: !cfg.numeroAutorizado,
      nombre: cfg.nombreUsuario,
      silenciadoHasta: cfg.botSilenciadoHasta && cfg.botSilenciadoHasta > new Date() ? cfg.botSilenciadoHasta : null,
      hoy: (await eventosEntre(hoy.desde, hoy.hasta)).map(evento),
      manana: (await eventosEntre(manana.desde, manana.hasta)).map(evento),
      pendientes: (await pendientesSinConfirmar()).map((p) => ({ ocurrencia: p.ocurrencia, recordatorio: serializar(p.recordatorio, cfg) })),
      contadores: { activos: activos.n, cumplidosSemana: cumplidos.n, noConfirmados: noConf.n },
      ia: { ...(await gastoDelMes()), modelo: cfg.iaModelo },
    };
  });

  app.get("/historial", async (req) => {
    const q = z
      .object({ desde: z.string().optional(), hasta: z.string().optional(), texto: z.string().optional(), antesDe: z.coerce.number().optional() })
      .parse(req.query);
    const cond: SQL[] = [];
    if (q.desde) cond.push(gte(mensaje.creadoEn, new Date(q.desde)));
    if (q.hasta) cond.push(lte(mensaje.creadoEn, new Date(q.hasta)));
    if (q.texto?.trim()) cond.push(ilike(mensaje.texto, `%${q.texto.trim()}%`));
    if (q.antesDe) cond.push(lt(mensaje.id, q.antesDe));
    const filas = await db
      .select({ mensaje, titulo: recordatorio.titulo })
      .from(mensaje)
      .leftJoin(recordatorio, eq(mensaje.recordatorioId, recordatorio.id))
      .where(cond.length ? and(...cond) : undefined)
      .orderBy(desc(mensaje.id))
      .limit(200);
    return filas.map((f) => ({ ...f.mensaje, recordatorioTitulo: f.titulo, adjuntoUrl: f.mensaje.adjuntoId ? `/api/adjuntos/${f.mensaje.adjuntoId}` : null }));
  });

  app.get("/logs", async (req) => {
    const { nivel } = z.object({ nivel: z.enum(["info", "aviso", "error"]).optional() }).parse(req.query);
    return db
      .select()
      .from(logSistema)
      .where(nivel ? eq(logSistema.nivel, nivel) : undefined)
      .orderBy(desc(logSistema.id))
      .limit(500);
  });

  // ───── Respaldo ─────
  app.get("/respaldo", async (_req, reply) => {
    const recs = await db.select().from(recordatorio).where(ne(recordatorio.estado, "borrado")).orderBy(recordatorio.id);
    const datos = {
      app: "memolucas",
      version: 1,
      exportadoEn: new Date().toISOString(),
      recordatorios: recs.map((r) => ({
        titulo: r.titulo,
        descripcion: r.descripcion,
        fechaHora: r.fechaHora.toISOString(),
        rrule: r.rrule,
        avisosPreviosMin: r.avisosPreviosMin,
        avisarEnHora: r.avisarEnHora,
        insistenciaModo: r.insistenciaModo,
        insistenciaIntervaloMin: r.insistenciaIntervaloMin,
        insistenciaTope: r.insistenciaTope,
        insistirPrevios: r.insistirPrevios,
        estado: r.estado,
        origen: r.origen,
      })),
    };
    const nombre = `memolucas-respaldo-${ahora().toFormat("yyyy-MM-dd")}.json`;
    return reply.header("Content-Disposition", `attachment; filename="${nombre}"`).type("application/json").send(JSON.stringify(datos, null, 2));
  });

  app.post("/respaldo", async (req) => {
    const Item = z.object({
      titulo: z.string().min(1),
      descripcion: z.string().nullish(),
      fechaHora: z.string(),
      rrule: z.string().nullish(),
      avisosPreviosMin: z.array(z.number().int().positive()).optional(),
      avisarEnHora: z.boolean().optional(),
      insistenciaModo: z.enum(["global", "propia", "off"]).optional(),
      insistenciaIntervaloMin: z.number().int().nullish(),
      insistenciaTope: z.number().int().nullish(),
      insistirPrevios: z.boolean().nullish(),
      estado: z.enum(["activo", "pausado", "cumplido", "no_confirmado"]).optional(),
      origen: z.enum(["whatsapp", "panel", "foto"]).optional(),
    });
    const { recordatorios } = z.object({ recordatorios: z.array(Item).max(5000) }).parse(req.body);
    let programados = 0;
    let archivados = 0;
    for (const it of recordatorios) {
      const fechaHora = new Date(it.fechaHora);
      if (Number.isNaN(fechaHora.getTime())) continue;
      const base = {
        titulo: it.titulo,
        descripcion: it.descripcion ?? null,
        fechaHora,
        rrule: it.rrule ?? null,
        avisosPreviosMin: it.avisosPreviosMin ?? [],
        avisarEnHora: it.avisarEnHora ?? true,
        insistenciaModo: it.insistenciaModo ?? "global",
        insistenciaIntervaloMin: it.insistenciaIntervaloMin ?? null,
        insistenciaTope: it.insistenciaTope ?? null,
        insistirPrevios: it.insistirPrevios ?? null,
        origen: it.origen ?? "panel",
      } as const;
      const activo = (it.estado ?? "activo") === "activo";
      if (activo && (base.rrule || fechaHora.getTime() > Date.now())) {
        try {
          await crearRecordatorio(base);
          programados++;
          continue;
        } catch {
          // Si no se puede programar, se guarda como archivado.
        }
      }
      await db.insert(recordatorio).values({ ...base, estado: activo ? "cumplido" : (it.estado ?? "cumplido") });
      archivados++;
    }
    return { ok: true, programados, archivados };
  });
};
