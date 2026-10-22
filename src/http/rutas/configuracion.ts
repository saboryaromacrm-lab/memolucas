import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { cambiarPin } from "./auth.js";
import { claveApi, ESFUERZOS, gastoDelMes, MODELOS, probarConexion } from "../../bot/ia.js";
import { entorno } from "../../entorno.js";
import { cifrar } from "../../lib/cifrado.js";
import { actualizarConfig, obtenerConfig, PLANTILLAS_DEFECTO } from "../../servicios/configuracion.js";
import { ErrorUsuario } from "../../servicios/recordatorios.js";

const Hora = z.string().regex(/^([01]?\d|2[0-3]):[0-5]\d$/, "Hora inválida (HH:MM)");
const Dias = z.array(z.number().int().min(1).max(7)).max(7);

const Cambios = z
  .object({
    nombreUsuario: z.string().trim().min(1).max(60),
    zonaHoraria: z.string().min(3),
    horaDefecto: Hora,
    horaTarde: Hora,
    horaNoche: Hora,
    insistenciaActiva: z.boolean(),
    insistenciaIntervaloMin: z.number().int().min(1).max(24 * 60),
    insistenciaTope: z.number().int().min(0).max(50),
    insistirPrevios: z.boolean(),
    avisarEnHoraDefecto: z.boolean(),
    silencioActivo: z.boolean(),
    silencioDesde: Hora,
    silencioHasta: Hora,
    silencioDias: Dias,
    botSilenciadoHasta: z.string().nullable().transform((s) => (s ? new Date(s) : null)),
    resumenActivo: z.boolean(),
    resumenHora: Hora,
    resumenDias: Dias,
    resumenIncluirPendientes: z.boolean(),
    iaModelo: z.string().min(3).max(80),
    iaEsfuerzo: z.enum(ESFUERZOS),
    plantillas: z.record(z.string(), z.string().max(2000)),
    sesionDuracionDias: z.number().int().min(1).max(365),
    maxIntentosLogin: z.number().int().min(1).max(50),
    bloqueoMinutos: z.number().int().min(1).max(24 * 60),
    fotoMaxMb: z.number().int().min(1).max(50),
    limpiezaFotosActiva: z.boolean(),
    limpiezaFotosDias: z.number().int().min(1).max(3650),
    demoraMinMs: z.number().int().min(0).max(30_000),
    demoraMaxMs: z.number().int().min(0).max(30_000),
    alertaDesconexionMin: z.number().int().min(1).max(24 * 60),
    minutosAtrasado: z.number().int().min(1).max(24 * 60),
  })
  .partial();

export async function configPublica() {
  const cfg = await obtenerConfig();
  const { iaApiKeyCifrada, ...resto } = cfg;
  return {
    ...resto,
    apiKeyPropia: !!iaApiKeyCifrada,
    apiKeyEntorno: !!entorno.anthropicApiKey,
    apiKeyDisponible: !!claveApi(cfg),
    modelos: MODELOS,
    esfuerzos: ESFUERZOS,
    plantillasDefecto: PLANTILLAS_DEFECTO,
  };
}

export const rutasConfiguracion: FastifyPluginAsync = async (app) => {
  app.get("/configuracion", async () => configPublica());

  app.put("/configuracion", async (req) => {
    const c = Cambios.parse(req.body);
    if (c.demoraMinMs !== undefined && c.demoraMaxMs !== undefined && c.demoraMaxMs < c.demoraMinMs)
      throw new ErrorUsuario("La demora máxima no puede ser menor que la mínima.");
    await actualizarConfig(c);
    return configPublica();
  });

  app.put("/configuracion/api-key", async (req) => {
    const { clave } = z.object({ clave: z.string().trim().nullable() }).parse(req.body);
    if (clave && !clave.startsWith("sk-ant-")) throw new ErrorUsuario("Eso no parece una API key de Claude (empieza con sk-ant-).");
    await actualizarConfig({ iaApiKeyCifrada: clave ? cifrar(clave) : null });
    return configPublica();
  });

  app.post("/configuracion/probar-ia", async () => probarConexion(await obtenerConfig()));

  app.put("/configuracion/pin", async (req, reply) => {
    const { actual, nuevo } = z.object({ actual: z.string(), nuevo: z.string() }).parse(req.body);
    if (!/^\d{4,8}$/.test(nuevo)) throw new ErrorUsuario("El PIN nuevo tiene que tener de 4 a 8 números.");
    if (!(await cambiarPin(actual, nuevo))) throw new ErrorUsuario("El PIN actual no es correcto.");
    // La sesión actual también se invalida: hay que volver a ingresar.
    return reply.clearCookie("memolucas_sesion", { path: "/" }).send({ ok: true });
  });

  app.get("/uso-ia", async () => gastoDelMes());
};
