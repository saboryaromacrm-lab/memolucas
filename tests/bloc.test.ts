import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { db } from "../src/db/index.js";
import { blocPestana, blocVersion } from "../src/db/schema.js";
import { agregarAlBloc, listarBloc, papeleraBloc, purgarBloc, verBloc, VERSIONES_MAX } from "../src/servicios/bloc.js";
import { baseLimpia, panelConSesion, reloj } from "./ayuda.js";

describe("Bloc", () => {
  let app: FastifyInstance;
  let headers: Record<string, string>;
  beforeEach(async () => {
    await baseLimpia();
    reloj(new Date("2026-11-25T13:00:00Z"));
    ({ app, headers } = await panelConSesion());
  });
  afterEach(async () => {
    await app.close();
    vi.useRealTimers();
  });

  const api = async (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: object) => {
    const r = await app.inject({ method, url: `/api/bloc${url}`, headers, payload });
    return { status: r.statusCode, json: r.body ? r.json() : null };
  };
  const pestanas = async () => (await api("GET", "")).json as { id: number; titulo: string; texto: string; version: number }[];

  it("pestañas que se guardan solas, cifradas, en el orden elegido", async () => {
    const a = (await api("POST", "", { titulo: "ERP SABOR Y AROMA", texto: "tengo miedo que me hackeen" })).json;
    const b = (await api("POST", "", {})).json;
    expect(b).toMatchObject({ titulo: "Sin título", texto: "", version: 1 });
    expect((await api("PUT", `/${a.id}`, { texto: "pedir doble autenticación", version: 1 })).json).toEqual({ version: 2, conflicto: false });
    await api("PUT", `/${b.id}`, { titulo: "COFFIT COST", version: 1 });
    await api("POST", "/orden", { ids: [b.id, a.id] });
    expect((await pestanas()).map((p) => [p.titulo, p.texto])).toEqual([
      ["COFFIT COST", ""],
      ["ERP SABOR Y AROMA", "pedir doble autenticación"],
    ]);
    expect(JSON.stringify(await db.select().from(blocPestana))).not.toContain("autenticación");
    expect((await app.inject({ url: "/api/bloc" })).statusCode).toBe(401);
  });

  it("fijar en pantalla queda guardado y no cambia la versión (no pisa lo que se está escribiendo)", async () => {
    const p = (await api("POST", "", { titulo: "Claves del día", texto: "llamar al contador" })).json;
    expect(p.fijada).toBe(false);
    expect((await api("PUT", `/${p.id}/fijada`, { fijada: true })).status).toBe(200);
    expect((await pestanas())[0]).toMatchObject({ fijada: true, version: 1 });
    await api("PUT", `/${p.id}/fijada`, { fijada: false });
    expect((await pestanas())[0]).toMatchObject({ fijada: false });
    expect((await api("PUT", "/999/fijada", { fijada: true })).status).toBe(400);
  });

  it("lo resaltado se guarda con el texto y se saca al restaurar otra versión", async () => {
    const p = (await api("POST", "", { titulo: "Prompts", texto: "hola mundo" })).json;
    expect(p.resaltados).toEqual([]);
    await api("PUT", `/${p.id}`, { texto: "hola mundo lindo", resaltados: [{ desde: 5, hasta: 10 }], version: 1 });
    expect((await pestanas())[0]).toMatchObject({ texto: "hola mundo lindo", resaltados: [{ desde: 5, hasta: 10 }] });
    expect((await api("PUT", `/${p.id}`, { resaltados: [{ desde: -1, hasta: 2 }], version: 2 })).status).toBe(400);
    // Pasados 5 minutos de escritura, la versión anterior queda en el historial; al volver a ella, no coincide lo resaltado.
    vi.setSystemTime(new Date("2026-11-25T13:10:00Z"));
    await api("PUT", `/${p.id}`, { texto: "otro texto", version: 2 });
    const [v] = (await api("GET", `/${p.id}/versiones`)).json;
    await api("POST", `/${p.id}/versiones/${v.id}/restaurar`);
    expect((await pestanas())[0]).toMatchObject({ texto: "hola mundo lindo", resaltados: [] });
  });

  it("si otro dispositivo escribió antes, gana lo último y lo pisado queda en el historial", async () => {
    const p = (await api("POST", "", { titulo: "Notas", texto: "hola" })).json;
    // La compu guarda sobre la versión 1…
    expect((await api("PUT", `/${p.id}`, { texto: "hola desde la compu", version: 1 })).json).toEqual({ version: 2, conflicto: false });
    // …y el celular, que todavía tenía la versión 1, guarda encima: aviso de conflicto, nada se pierde.
    expect((await api("PUT", `/${p.id}`, { texto: "hola desde el celu", version: 1 })).json).toEqual({ version: 3, conflicto: true });
    expect((await pestanas())[0].texto).toBe("hola desde el celu");
    const versiones = (await api("GET", `/${p.id}/versiones`)).json;
    expect(versiones.map((v: { motivo: string; texto: string }) => [v.motivo, v.texto])).toEqual([
      ["otro_dispositivo", "hola desde la compu"],
      ["guardado", "hola"],
    ]);
    // Volver a una versión deja lo de ahora en el historial (se puede deshacer).
    const r = (await api("POST", `/${p.id}/versiones/${versiones[0].id}/restaurar`)).json;
    expect(r).toMatchObject({ texto: "hola desde la compu", version: 4 });
    expect((await api("GET", `/${p.id}/versiones`)).json[0]).toMatchObject({ motivo: "antes_de_restaurar", texto: "hola desde el celu" });
  });

  it("el historial toma una foto cada 5 minutos de escritura y guarda las últimas 30", async () => {
    const p = (await api("POST", "", { texto: "v0" })).json;
    const guardar = async (texto: string, version: number) => (await api("PUT", `/${p.id}`, { texto, version })).json.version as number;
    // Escribiendo seguido: una sola foto (lo que había antes de empezar).
    let version = await guardar("v1", 1);
    vi.setSystemTime(Date.now() + 60_000);
    version = await guardar("v2", version);
    expect((await api("GET", `/${p.id}/versiones`)).json.map((v: { texto: string }) => v.texto)).toEqual(["v0"]);
    // De a ratos largos: una foto por vez, y quedan las últimas 30.
    for (let i = 3; i <= 45; i++) {
      vi.setSystemTime(Date.now() + 6 * 60_000);
      version = await guardar(`v${i}`, version);
    }
    const versiones = (await api("GET", `/${p.id}/versiones`)).json;
    expect(versiones.length).toBe(VERSIONES_MAX);
    expect([versiones[0].texto, versiones.at(-1).texto]).toEqual(["v44", "v15"]);
    expect(await db.select().from(blocVersion)).toHaveLength(VERSIONES_MAX);
  });

  it("cerrar va a la papelera: se restaura, se borra, y a los 30 días se va sola", async () => {
    const a = (await api("POST", "", { titulo: "Vieja", texto: "x" })).json;
    const b = (await api("POST", "", { titulo: "Otra" })).json;
    await api("DELETE", `/${a.id}`);
    await api("DELETE", `/${b.id}`);
    expect((await pestanas()).length).toBe(0);
    expect((await api("GET", "/papelera")).json.map((p: { titulo: string }) => p.titulo).sort()).toEqual(["Otra", "Vieja"]);
    expect((await api("PUT", `/${a.id}`, { texto: "y", version: 1 })).status).toBe(400);
    await api("POST", `/${a.id}/restaurar`);
    expect((await pestanas()).map((p) => p.titulo)).toEqual(["Vieja"]);
    vi.setSystemTime(Date.now() + 31 * 86_400_000);
    await purgarBloc();
    // (la sesión del panel ya venció: se mira directo)
    expect(await papeleraBloc()).toEqual([]);
    expect((await listarBloc()).map((p) => p.titulo)).toEqual(["Vieja"]);
  });

  it("el asistente lee las pestañas y agrega texto al final (o crea la pestaña)", async () => {
    await api("POST", "", { titulo: "ERP SABOR Y AROMA", texto: "Revisar seguridad\n" });
    expect(await agregarAlBloc("erp", "Botón «Ver carta online»")).toEqual({ titulo: "ERP SABOR Y AROMA", creada: false });
    expect(await verBloc("ERP")).toEqual({ titulo: "ERP SABOR Y AROMA", texto: "Revisar seguridad\nBotón «Ver carta online»" });
    expect(await agregarAlBloc("Compras", "yerba")).toEqual({ titulo: "Compras", creada: true });
    expect((await verBloc()).map((p) => p.titulo)).toEqual(["ERP SABOR Y AROMA", "Compras"]);
    await expect(verBloc("nada")).rejects.toThrow("No hay una pestaña «nada»");
  });
});
