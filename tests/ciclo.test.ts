import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { DateTime } from "luxon";
import { db } from "../src/db/index.js";
import { ocurrencia, recordatorio } from "../src/db/schema.js";
import { actualizarConfig } from "../src/servicios/configuracion.js";
import { ocurrenciasVencidas, procesarOcurrencia } from "../src/servicios/disparador.js";
import {
  avanzarRecurrente,
  confirmarOcurrencia,
  crearRecordatorio,
  obtenerRecordatorio,
  posponerOcurrencia,
  recurrentesParaAvanzar,
} from "../src/servicios/recordatorios.js";
import { baseLimpia, enviadorFalso, reloj } from "./ayuda.js";

const Z = "America/Argentina/Buenos_Aires";
const local = (iso: string) => DateTime.fromISO(iso, { zone: Z }).toJSDate();

/** Lo mismo que hace el barrido cada minuto. */
async function barrer() {
  for (const id of await ocurrenciasVencidas()) await procesarOcurrencia(id);
  for (const r of await recurrentesParaAvanzar()) await avanzarRecurrente(r);
}

const ocs = async (recId: number) => db.select().from(ocurrencia).where(eq(ocurrencia.recordatorioId, recId)).orderBy(ocurrencia.id);

describe("ciclo de un recordatorio", () => {
  let wa: ReturnType<typeof enviadorFalso>;
  let t: ReturnType<typeof reloj>;

  beforeEach(async () => {
    await baseLimpia();
    wa = enviadorFalso();
    t = reloj(local("2026-10-22T08:00"));
  });
  afterEach(() => vi.useRealTimers());

  it("llega a la hora, insiste cada 60 min hasta el tope y queda no confirmado", async () => {
    await actualizarConfig({ insistenciaTope: 2 });
    const r = await crearRecordatorio({ titulo: "Pagar la luz", fechaHora: local("2026-10-23T10:00") });
    await barrer();
    expect(wa.enviados).toHaveLength(0);

    t.ir(local("2026-10-23T10:00"));
    await barrer();
    expect(wa.enviados).toHaveLength(1);
    expect(wa.enviados[0].texto).toContain("Pagar la luz");

    t.avanzar(30);
    await barrer();
    expect(wa.enviados).toHaveLength(1);
    t.avanzar(30);
    await barrer();
    expect(wa.enviados).toHaveLength(2);
    expect(wa.enviados[1].texto).toContain("Te sigo recordando");
    t.avanzar(60);
    await barrer();
    expect(wa.enviados).toHaveLength(3);
    t.avanzar(60);
    await barrer();
    expect(wa.enviados).toHaveLength(3); // Llegó al tope: no insiste más.
    const [oc] = await ocs(r.id);
    expect(oc.estado).toBe("no_confirmada");
    expect((await obtenerRecordatorio(r.id))!.estado).toBe("no_confirmado");
  });

  it("'listo' corta la insistencia y lo marca cumplido", async () => {
    const r = await crearRecordatorio({ titulo: "Llamar al dentista", fechaHora: local("2026-10-22T09:00") });
    t.ir(local("2026-10-22T09:00"));
    await barrer();
    const [oc] = await ocs(r.id);
    await confirmarOcurrencia(oc.id);
    t.avanzar(120);
    await barrer();
    expect(wa.enviados).toHaveLength(1);
    expect((await obtenerRecordatorio(r.id))!.estado).toBe("cumplido");
  });

  it("posponer 15 min lo vuelve a mandar", async () => {
    const r = await crearRecordatorio({ titulo: "Sacar la ropa", fechaHora: local("2026-10-22T09:00") });
    t.ir(local("2026-10-22T09:00"));
    await barrer();
    const [oc] = await ocs(r.id);
    await posponerOcurrencia(oc.id, new Date(Date.now() + 15 * 60_000));
    t.avanzar(10);
    await barrer();
    expect(wa.enviados).toHaveLength(1);
    t.avanzar(5);
    await barrer();
    expect(wa.enviados).toHaveLength(2);
    expect(wa.enviados[1].texto).toContain("Sacar la ropa");
    expect(wa.enviados[1].texto).not.toContain("Atrasado");
  });

  it("aviso previo 1 hora antes y a la hora del turno", async () => {
    await actualizarConfig({ insistenciaActiva: false });
    const r = await crearRecordatorio({ titulo: "Turno médico", fechaHora: local("2026-10-29T10:00"), avisosPreviosMin: [60] });
    const lista = await ocs(r.id);
    expect(lista.map((o) => o.tipo)).toEqual(["previo", "principal"]);
    t.ir(local("2026-10-29T09:00"));
    await barrer();
    expect(wa.enviados).toHaveLength(1);
    expect(wa.enviados[0].texto).toContain("En 1 hora");
    t.ir(local("2026-10-29T10:00"));
    await barrer();
    expect(wa.enviados).toHaveLength(2);
    expect((await obtenerRecordatorio(r.id))!.estado).toBe("cumplido");
  });

  it("recurrente: todos los lunes a las 8 se repite", async () => {
    await actualizarConfig({ insistenciaActiva: false });
    const r = await crearRecordatorio({ titulo: "Sacar la basura", fechaHora: local("2026-10-26T08:00"), rrule: "FREQ=WEEKLY;BYDAY=MO" });
    t.ir(local("2026-10-26T08:00"));
    await barrer();
    expect(wa.enviados).toHaveLength(1);
    const rec = await obtenerRecordatorio(r.id);
    expect(DateTime.fromJSDate(rec!.proximaInstancia!).setZone(Z).toFormat("yyyy-MM-dd HH:mm")).toBe("2026-11-02 08:00");
    t.ir(local("2026-11-02T08:00"));
    await barrer();
    expect(wa.enviados).toHaveLength(2);
    expect(rec!.estado).toBe("activo");
  });

  it("si WhatsApp estaba caído, llega como atrasado al reconectar", async () => {
    const r = await crearRecordatorio({ titulo: "Regar plantas", fechaHora: local("2026-10-22T09:00") });
    wa.online = false;
    t.ir(local("2026-10-22T09:00"));
    await barrer();
    expect(wa.enviados).toHaveLength(0);
    t.ir(local("2026-10-22T11:00"));
    wa.online = true;
    await barrer();
    expect(wa.enviados).toHaveLength(1);
    expect(wa.enviados[0].texto).toContain("Atrasado");
    const [oc] = await ocs(r.id);
    expect(oc.atrasada).toBe(true);
  });

  it("horario de silencio: lo posterga hasta que termina", async () => {
    await actualizarConfig({ silencioActivo: true, silencioDesde: "23:00", silencioHasta: "07:30" });
    await crearRecordatorio({ titulo: "Algo nocturno", fechaHora: local("2026-10-22T23:30") });
    t.ir(local("2026-10-22T23:30"));
    await barrer();
    expect(wa.enviados).toHaveLength(0);
    t.ir(local("2026-10-23T07:30"));
    await barrer();
    expect(wa.enviados).toHaveLength(1);
  });

  it("no deja crear en el pasado", async () => {
    await expect(crearRecordatorio({ titulo: "Viejo", fechaHora: local("2026-10-21T10:00") })).rejects.toThrow("ya pasó");
  });

  it("pausar evita el envío", async () => {
    const r = await crearRecordatorio({ titulo: "Pausable", fechaHora: local("2026-10-22T09:00") });
    await db.update(recordatorio).set({ estado: "pausado" }).where(eq(recordatorio.id, r.id));
    t.ir(local("2026-10-22T09:00"));
    await barrer();
    expect(wa.enviados).toHaveLength(0);
  });
});
