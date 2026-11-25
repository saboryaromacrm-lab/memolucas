import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db/index.js";
import { blocImagen } from "../src/db/schema.js";
import { rutas } from "../src/entorno.js";
import { IMAGENES_MAX } from "../src/servicios/bloc.js";
import { baseLimpia, panelConSesion } from "./ayuda.js";

/** Una imagen de prueba: una captura de 3000×2000 (se achica a 1600) o ruido, que pesa mucho. */
const captura = () => sharp({ create: { width: 3000, height: 2000, channels: 3, background: "#128C7E" } }).png().toBuffer();
const pesada = () => {
  const lado = 1500;
  const ruido = Buffer.alloc(lado * lado * 3);
  for (let i = 0; i < ruido.length; i++) ruido[i] = (i * 2654435761) >>> 24;
  return sharp(ruido, { raw: { width: lado, height: lado, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer();
};
const carpeta = () => path.join(rutas.media, "bloc");
const archivos = () => (fs.existsSync(carpeta()) ? fs.readdirSync(carpeta()) : []);

describe("imágenes del Bloc", () => {
  let app: FastifyInstance;
  let headers: Record<string, string>;
  let pestana: number;
  beforeEach(async () => {
    await baseLimpia();
    fs.rmSync(carpeta(), { recursive: true, force: true });
    ({ app, headers } = await panelConSesion());
    pestana = (await app.inject({ method: "POST", url: "/api/bloc", headers, payload: { titulo: "Capturas" } })).json().id;
  });
  afterEach(() => app.close());

  const pegar = (datos: Buffer, tipo = "image/png", id = pestana) =>
    app.inject({ method: "POST", url: `/api/bloc/${id}/imagenes`, headers: { ...headers, "content-type": tipo }, payload: datos });

  it("se pega, se achica, se guarda cifrada con su miniatura y se lista con la pestaña", async () => {
    const r = await pegar(await captura());
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ancho: 1600, alto: 1067 });
    const [p] = (await app.inject({ url: "/api/bloc", headers })).json();
    expect(p.imagenes).toEqual([r.json()]);

    // En el disco, cifradas: ni WebP ni PNG reconocibles.
    expect(archivos()).toHaveLength(2);
    for (const a of archivos()) expect(fs.readFileSync(path.join(carpeta(), a)).subarray(0, 12).toString("latin1")).not.toMatch(/RIFF|PNG/);

    const grande = await app.inject({ url: `/api/bloc/imagenes/${r.json().id}`, headers });
    expect(grande.headers["content-type"]).toBe("image/webp");
    expect(await sharp(grande.rawPayload).metadata()).toMatchObject({ format: "webp", width: 1600 });
    const mini = await app.inject({ url: `/api/bloc/imagenes/${r.json().id}?mini=1`, headers });
    expect((await sharp(mini.rawPayload).metadata()).height).toBe(160);
    expect((await app.inject({ url: `/api/bloc/imagenes/${r.json().id}` })).statusCode).toBe(401);
  });

  it("acepta hasta 15 MB (más que el resto de la API) y avisa si no es una imagen", async () => {
    const datos = await pesada();
    expect(datos.length).toBeGreaterThan(5 * 1024 * 1024);
    expect((await pegar(datos)).statusCode).toBe(200);
    expect((await pegar(Buffer.alloc(16 * 1024 * 1024), "image/png")).statusCode).toBe(413);
    const mal = await pegar(Buffer.from("esto no es una imagen"), "image/jpeg");
    expect(mal.statusCode).toBe(400);
    expect(mal.json().error).toContain("No pude leer esa imagen");
  });

  it("se borra con sus archivos; la papelera las conserva y al borrar la pestaña se van", async () => {
    const a = (await pegar(await captura())).json();
    const b = (await pegar(await captura())).json();
    expect((await app.inject({ method: "DELETE", url: `/api/bloc/imagenes/${a.id}`, headers })).statusCode).toBe(200);
    expect(archivos()).toHaveLength(2);

    await app.inject({ method: "DELETE", url: `/api/bloc/${pestana}`, headers }); // A la papelera: la imagen queda.
    expect((await pegar(await captura())).json().error).toContain("papelera");
    await app.inject({ method: "POST", url: `/api/bloc/${pestana}/restaurar`, headers });
    expect((await app.inject({ url: "/api/bloc", headers })).json()[0].imagenes.map((i: { id: number }) => i.id)).toEqual([b.id]);

    await app.inject({ method: "DELETE", url: `/api/bloc/${pestana}`, headers });
    await app.inject({ method: "DELETE", url: `/api/bloc/${pestana}/definitivo`, headers });
    expect(await db.select().from(blocImagen)).toHaveLength(0);
    expect(archivos()).toHaveLength(0);
  });

  it(`hasta ${IMAGENES_MAX} por pestaña`, async () => {
    const chica = await sharp({ create: { width: 10, height: 10, channels: 3, background: "#fff" } }).png().toBuffer();
    for (let i = 0; i < IMAGENES_MAX; i++) expect((await pegar(chica)).statusCode).toBe(200);
    expect((await pegar(chica)).json().error).toContain(`hasta ${IMAGENES_MAX} imágenes`);
  });
});
