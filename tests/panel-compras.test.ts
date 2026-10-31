import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import sharp from "sharp";
import { db } from "../src/db/index.js";
import { comprobante, lecturaCompras } from "../src/db/schema.js";
import type { Comprobante } from "../src/lib/comprobantes.js";
import { crearServidor } from "../src/http/servidor.js";
import { asegurarAcceso } from "../src/http/rutas/auth.js";
import { guardarImagen } from "../src/servicios/adjuntos.js";
import { actualizarConfig } from "../src/servicios/configuracion.js";
import { crearUsuario, esperarLecturas } from "../src/servicios/panel-compras.js";
import { baseLimpia } from "./ayuda.js";
import { facturaDePrueba } from "./fabrica.js";

const leerComprobantes = vi.fn<(...a: unknown[]) => Promise<Comprobante[]>>();
vi.mock("../src/bot/ia-compras.js", async (orig) => ({
  ...(await orig<object>()),
  leerComprobantes: (...a: unknown[]) => leerComprobantes(...a),
}));

const HOST = "comprascoff.saboryaroma.com";

/** Arma un multipart a mano (inject no trae FormData de archivos). */
function multipart(campos: Record<string, string>, archivos: { nombre: string; mime: string; datos: Buffer }[]) {
  const limite = "----prueba123";
  const partes: Buffer[] = [];
  for (const [k, v] of Object.entries(campos)) partes.push(Buffer.from(`--${limite}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  for (const a of archivos)
    partes.push(
      Buffer.from(`--${limite}\r\nContent-Disposition: form-data; name="archivos"; filename="${a.nombre}"\r\nContent-Type: ${a.mime}\r\n\r\n`),
      a.datos,
      Buffer.from("\r\n"),
    );
  partes.push(Buffer.from(`--${limite}--\r\n`));
  return { payload: Buffer.concat(partes), headers: { "content-type": `multipart/form-data; boundary=${limite}` } };
}

describe("panel de compras", () => {
  let app: FastifyInstance;
  let foto: Buffer;

  beforeAll(async () => {
    foto = await sharp({ create: { width: 40, height: 60, channels: 3, background: "#fff" } }).jpeg().toBuffer();
  });
  beforeEach(async () => {
    await baseLimpia();
    await asegurarAcceso();
    app = await crearServidor();
    leerComprobantes.mockReset();
  });
  afterEach(async () => app?.close());

  async function entrar(clave = "4321") {
    const r = await app.inject({ method: "POST", url: "/api/c/ingresar", headers: { host: HOST }, payload: { clave } });
    const cookie = r.cookies.find((c) => c.name === "compras_sesion");
    return { r, cookie: cookie ? `compras_sesion=${cookie.value}` : "" };
  }

  it("cada persona entra con su clave; la clave incorrecta no", async () => {
    await crearUsuario("Martín", "4321");
    const mal = await entrar("1111");
    expect(mal.r.statusCode).toBe(400);
    expect(mal.r.json().error).toContain("Clave incorrecta");
    const { r, cookie } = await entrar();
    expect(r.json()).toEqual({ nombre: "Martín" });
    const yo = await app.inject({ url: "/api/c/yo", headers: { host: HOST, cookie } });
    expect(yo.json()).toEqual({ nombre: "Martín" });
  });

  it("no se pueden repetir claves", async () => {
    await crearUsuario("Martín", "4321");
    await expect(crearUsuario("Sofi", "4321")).rejects.toThrow("ya la usa otra persona");
  });

  it("sube las hojas, las lee en segundo plano y queda en la lista; confirmar funciona", async () => {
    await crearUsuario("Martín", "4321");
    const { cookie } = await entrar();
    leerComprobantes.mockResolvedValue([facturaDePrueba()]);
    const m = multipart({ clienteId: "subida-0001" }, [
      { nombre: "a.jpg", mime: "image/jpeg", datos: foto },
      { nombre: "b.jpg", mime: "image/jpeg", datos: foto },
    ]);
    const r = await app.inject({ method: "POST", url: "/api/c/subir", headers: { host: HOST, cookie, ...m.headers }, payload: m.payload });
    expect(r.statusCode).toBe(200);
    expect(r.json().estado).toBe("leyendo");
    await esperarLecturas();
    expect((leerComprobantes.mock.calls[0][1] as unknown[]).length).toBe(2);

    // Reintentar la misma subida (ej. se cortó la señal) no la duplica.
    const otra = await app.inject({ method: "POST", url: "/api/c/subir", headers: { host: HOST, cookie, ...m.headers }, payload: m.payload });
    expect(otra.json().id).toBe(r.json().id);
    expect(await db.select().from(lecturaCompras)).toHaveLength(1);

    const lista = (await app.inject({ url: "/api/c/compras", headers: { host: HOST, cookie } })).json();
    expect(lista.lecturas).toHaveLength(0);
    expect(lista.compras).toHaveLength(1);
    expect(lista.compras[0]).toMatchObject({ proveedor: "Distribuidora del Café SA", autor: "Martín", origen: "panel", cierra: true });
    expect(lista.compras[0].archivos[0].url).toMatch(/^\/api\/c\/adjuntos\/\d+$/);

    const img = await app.inject({ url: lista.compras[0].archivos[0].url, headers: { host: HOST, cookie } });
    expect(img.statusCode).toBe(200);

    const conf = await app.inject({ method: "POST", url: `/api/c/compras/${lista.compras[0].id}/confirmar`, headers: { host: HOST, cookie } });
    expect(conf.statusCode).toBe(200);
    const [fila] = await db.select().from(comprobante);
    expect(fila.estado).toBe("confirmado");
  });

  it("si la lectura falla queda el aviso con reintentar", async () => {
    await crearUsuario("Martín", "4321");
    const { cookie } = await entrar();
    leerComprobantes.mockRejectedValueOnce(new Error("caída")).mockResolvedValueOnce([facturaDePrueba()]);
    const m = multipart({ clienteId: "subida-0002" }, [{ nombre: "a.jpg", mime: "image/jpeg", datos: foto }]);
    await app.inject({ method: "POST", url: "/api/c/subir", headers: { host: HOST, cookie, ...m.headers }, payload: m.payload });
    await esperarLecturas();
    let lista = (await app.inject({ url: "/api/c/compras", headers: { host: HOST, cookie } })).json();
    expect(lista.lecturas[0]).toMatchObject({ estado: "error" });
    await app.inject({ method: "POST", url: `/api/c/lecturas/${lista.lecturas[0].id}/reintentar`, headers: { host: HOST, cookie } });
    await esperarLecturas();
    lista = (await app.inject({ url: "/api/c/compras", headers: { host: HOST, cookie } })).json();
    expect(lista.lecturas).toHaveLength(0);
    expect(lista.compras).toHaveLength(1);
  });

  it("la persona del panel de compras no ve otros archivos ni entra al panel principal", async () => {
    await crearUsuario("Martín", "4321");
    const { cookie } = await entrar();
    const personal = await guardarImagen(foto, "image/jpeg");
    const r = await app.inject({ url: `/api/c/adjuntos/${personal.id}`, headers: { host: HOST, cookie } });
    expect(r.statusCode).toBe(404);
    // Con su sesión puesta en la cookie del panel principal, tampoco entra.
    const valor = cookie.split("=")[1];
    const principal = await app.inject({ url: "/api/recordatorios", headers: { cookie: `memolucas_sesion=${valor}` } });
    expect(principal.statusCode).toBe(401);
    // Y en la dirección de compras no existe la API principal.
    const enCompras = await app.inject({ url: "/api/recordatorios", headers: { host: HOST } });
    expect(enCompras.statusCode).toBe(404);
  });

  it("desactivar a una persona cierra su sesión", async () => {
    const u = await crearUsuario("Martín", "4321");
    const { cookie } = await entrar();
    const { actualizarUsuario } = await import("../src/servicios/panel-compras.js");
    await actualizarUsuario(u.id, { activo: false });
    const yo = await app.inject({ url: "/api/c/yo", headers: { host: HOST, cookie } });
    expect(yo.statusCode).toBe(401);
  });

  it("el ícono y el manifest se arman solos (con o sin logo)", async () => {
    const icono = await app.inject({ url: "/api/c/icono/192.png", headers: { host: HOST } });
    expect(icono.headers["content-type"]).toBe("image/png");
    const logo = await guardarImagen(await sharp({ create: { width: 300, height: 100, channels: 3, background: "#e07a2c" } }).png().toBuffer(), "image/png");
    await actualizarConfig({ comprasLogoAdjuntoId: logo.id });
    const conLogo = await app.inject({ url: "/api/c/icono/512.png", headers: { host: HOST } });
    expect((await sharp(conLogo.rawPayload).metadata()).width).toBe(512);
    const manifest = (await app.inject({ url: "/api/c/manifest.webmanifest", headers: { host: HOST } })).json();
    expect(manifest.name).toBe("Compras Coffit");
    expect((await app.inject({ url: "/api/c/marca", headers: { host: HOST } })).json().logo).toContain("/api/c/logo");
  });
});
