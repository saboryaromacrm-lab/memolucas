import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { WAMessage } from "baileys";
import { db } from "../src/db/index.js";
import { linkGuardado } from "../src/db/schema.js";
import { pedidoDeLinks } from "../src/bot/comandos.js";
import { Procesador } from "../src/bot/procesador.js";
import { textoSinUrls } from "../src/servicios/enlaces.js";
import { listarLinks } from "../src/servicios/links.js";
import { baseLimpia, panelConSesion } from "./ayuda.js";

// Guardar y buscar links no pasa por la IA ni por el análisis de links.
vi.mock("../src/bot/ia.js", async (orig) => ({ ...(await orig<object>()), interpretar: () => Promise.reject(new Error("no debería usar la IA")) }));
vi.mock("../src/servicios/enlaces.js", async (orig) => ({ ...(await orig<object>()), leerEnlace: () => Promise.reject(new Error("no debería leer el link")) }));

const pedido = (t: string) => pedidoDeLinks(textoSinUrls(t), /https?:\/\//.test(t));

describe("mis links", () => {
  let app: FastifyInstance;
  let headers: Record<string, string>;

  beforeEach(async () => {
    await baseLimpia();
    ({ app, headers } = await panelConSesion());
  });
  afterEach(async () => app.close());

  it("se agregan (cifrados), se editan, se ordenan con flechitas y se borran", async () => {
    const crear = (concepto: string, url: string) => app.inject({ method: "POST", url: "/api/links", headers, payload: { concepto, url } });
    await crear("Home banking", "https://home.banco.com/login");
    const { id } = (await crear("Tienda Coffit", "tiendacoffit.saboryaroma.com")).json();
    await crear("Correo", "https://mail.google.com");
    expect((await crear("Raro", "no es un link")).statusCode).toBe(400);
    expect((await crear("", "https://x.com")).statusCode).toBe(400);

    let lista = (await app.inject({ url: "/api/links", headers })).json();
    expect(lista.map((l: { concepto: string; url: string }) => [l.concepto, l.url])).toEqual([
      ["Home banking", "https://home.banco.com/login"],
      ["Tienda Coffit", "https://tiendacoffit.saboryaroma.com/"],
      ["Correo", "https://mail.google.com/"],
    ]);
    expect((await db.select().from(linkGuardado)).some((f) => f.datosCifrados.includes("banco"))).toBe(false);

    await app.inject({ method: "POST", url: `/api/links/${id}/mover`, headers, payload: { paso: -1 } });
    await app.inject({ method: "PUT", url: `/api/links/${id}`, headers, payload: { concepto: "ERP Coffit", url: "https://tiendacoffit.saboryaroma.com/luclorenzo" } });
    lista = (await app.inject({ url: "/api/links", headers })).json();
    expect(lista.map((l: { concepto: string }) => l.concepto)).toEqual(["ERP Coffit", "Home banking", "Correo"]);
    await app.inject({ method: "DELETE", url: `/api/links/${id}`, headers });
    expect((await listarLinks()).map((l) => l.concepto)).toEqual(["Home banking", "Correo"]);
    expect((await app.inject({ url: "/api/links" })).statusCode).toBe(401);
  });

  it("entiende los pedidos por WhatsApp", () => {
    expect(pedido("guardá en mis links el home banking: https://home.banco.com")).toEqual({ tipo: "guardar", concepto: "Home banking" });
    expect(pedido("anotame el link del banco https://home.banco.com")).toEqual({ tipo: "guardar", concepto: "Banco" });
    expect(pedido("agregá a links https://x.com")).toEqual({ tipo: "guardar", concepto: "" });
    expect(pedido("¿cuál era el link del home banking?")).toMatchObject({ tipo: "buscar" });
    expect(pedido("mis links")).toEqual({ tipo: "todos" });
    // Un link compartido o una charla no son pedidos de links.
    expect(pedido("mirá esto https://youtube.com/watch?v=1")).toBeNull();
    expect(pedido("recordame mañana pagar la luz")).toBeNull();
  });

  it("por WhatsApp se guarda y se busca", async () => {
    const respuestas: string[] = [];
    const bot = new Procesador({
      responder: async (t: string) => (respuestas.push(t), `OUT${respuestas.length}`),
      responderImagen: async () => null,
      responderEncuesta: async () => ({ id: null, secreto: "" }),
      descifrarVoto: () => null,
      descargarMedia: async () => Buffer.alloc(0),
      reaccionar: async () => {},
    });
    let n = 0;
    const texto = (t: string): WAMessage => ({ key: { id: `IN${++n}`, remoteJid: "5491112345678@s.whatsapp.net" }, message: { conversation: t } });

    await bot.procesar(texto("guardá en mis links el home banking: https://home.banco.com/login"));
    expect(respuestas.at(-1)).toBe("Guardado en tus links 👌\n🔗 *Home banking*\nhttps://home.banco.com/login");
    await bot.procesar(texto("agregá a mis links https://www.afip.gob.ar"));
    expect(respuestas.at(-1)).toContain("🔗 *afip.gob.ar*");
    await bot.procesar(texto("¿cuál era el link del home banking?"));
    expect(respuestas.at(-1)).toBe("🔗 *Home banking*\nhttps://home.banco.com/login");
    await bot.procesar(texto("mis links"));
    expect(respuestas.at(-1)).toBe("🔗 Tus links (2):\n• *Home banking*: https://home.banco.com/login\n• *afip.gob.ar*: https://www.afip.gob.ar/");
  });
});
