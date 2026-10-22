import { hash, verify } from "@node-rs/argon2";
import { eq, sql } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { db } from "../../db/index.js";
import { accesoPanel } from "../../db/schema.js";
import { entorno, PIN_INICIAL } from "../../entorno.js";
import { registrar } from "../../lib/log.js";
import { obtenerConfig } from "../../servicios/configuracion.js";

const COOKIE = "memolucas_sesion";
let versionCache: number | null = null;

async function acceso() {
  const [fila] = await db.select().from(accesoPanel).limit(1);
  return fila ?? null;
}

/** Crea el acceso con el PIN inicial si todavía no existe. */
export async function asegurarAcceso() {
  if (await acceso()) return;
  await db.insert(accesoPanel).values({ pinHash: await hash(PIN_INICIAL) });
}

export async function versionSesionActual(): Promise<number> {
  if (versionCache === null) versionCache = (await acceso())?.versionSesion ?? 1;
  return versionCache;
}

export const PinValido = z.string().regex(/^\d{4,8}$/, "El PIN tiene que tener de 4 a 8 números");

export async function cambiarPin(actual: string, nuevo: string) {
  const a = await acceso();
  if (!a || !(await verify(a.pinHash, actual))) return false;
  await db
    .update(accesoPanel)
    .set({ pinHash: await hash(PinValido.parse(nuevo)), versionSesion: sql`${accesoPanel.versionSesion} + 1` })
    .where(eq(accesoPanel.id, a.id));
  versionCache = null;
  await registrar("aviso", "panel", "Se cambió el PIN del panel");
  return true;
}

export const rutasAuth: FastifyPluginAsync = async (app) => {
  app.post(
    "/login",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const { pin } = z.object({ pin: z.string() }).parse(req.body);
      const a = await acceso();
      const cfg = await obtenerConfig();
      if (!a) return reply.code(500).send({ error: "Acceso no inicializado" });
      if (a.bloqueadoHasta && a.bloqueadoHasta > new Date()) {
        const min = Math.ceil((a.bloqueadoHasta.getTime() - Date.now()) / 60_000);
        return reply.code(423).send({ error: `Demasiados intentos. Probá de nuevo en ${min} min.` });
      }
      const ok = /^\d{4,8}$/.test(pin) && (await verify(a.pinHash, pin));
      if (!ok) {
        const intentos = a.intentosFallidos + 1;
        const bloquear = intentos >= cfg.maxIntentosLogin;
        await db
          .update(accesoPanel)
          .set({
            intentosFallidos: bloquear ? 0 : intentos,
            bloqueadoHasta: bloquear ? new Date(Date.now() + cfg.bloqueoMinutos * 60_000) : null,
          })
          .where(eq(accesoPanel.id, a.id));
        await registrar("aviso", "panel", bloquear ? `Panel bloqueado ${cfg.bloqueoMinutos} min por PIN incorrecto` : "PIN incorrecto", {
          ip: req.ip,
        });
        if (bloquear) return reply.code(423).send({ error: `Demasiados intentos. Probá de nuevo en ${cfg.bloqueoMinutos} min.` });
        return reply.code(401).send({ error: `PIN incorrecto. Te quedan ${cfg.maxIntentosLogin - intentos} intentos.` });
      }
      await db.update(accesoPanel).set({ intentosFallidos: 0, bloqueadoHasta: null }).where(eq(accesoPanel.id, a.id));
      const dias = cfg.sesionDuracionDias;
      const token = await reply.jwtSign({ v: a.versionSesion }, { expiresIn: `${dias}d` });
      return reply
        .setCookie(COOKIE, token, {
          httpOnly: true,
          secure: entorno.produccion,
          sameSite: "strict",
          path: "/",
          maxAge: dias * 86_400,
        })
        .send({ ok: true });
    },
  );

  app.post("/logout", async (_req, reply) => reply.clearCookie(COOKIE, { path: "/" }).send({ ok: true }));

  app.get("/sesion", async (req) => {
    try {
      const d = await req.jwtVerify<{ v: number }>();
      return { autenticado: d.v === (await versionSesionActual()) };
    } catch {
      return { autenticado: false };
    }
  });
};
