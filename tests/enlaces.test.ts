import dns from "node:dns/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { abrirCompartido, decodificarEntidades, extraerUrls, ipPrivada, leerEnlace, motivoSinSesion, parsearHtml, textoSinUrls, verificarDestino } from "../src/servicios/enlaces.js";
import { esLinkDeVideo } from "../src/servicios/videos.js";

/** Facebook de mentira: cada dirección responde lo que diga el mapa (un HTML o una redirección). */
function webFalsa(paginas: Record<string, string | { a: string }>) {
  vi.spyOn(dns, "lookup").mockResolvedValue([{ address: "157.240.1.35", family: 4 }] as never);
  const pedidos: { url: string; agente: string }[] = [];
  vi.stubGlobal("fetch", async (u: URL, op: { headers: Record<string, string> }) => {
    pedidos.push({ url: u.toString(), agente: op.headers["user-agent"] });
    const p = paginas[u.toString()];
    if (p === undefined) return new Response("no", { status: 404 });
    if (typeof p !== "string") return new Response(null, { status: 302, headers: { location: p.a } });
    return new Response(p, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
  });
  return pedidos;
}
const pagina = (meta: Record<string, string>) => `<html><head>${Object.entries(meta).map(([k, v]) => `<meta property="${k}" content="${v}">`).join("")}</head><body>menú</body></html>`;

describe("links", () => {
  it("encuentra los links del mensaje", () => {
    expect(extraerUrls("mirá esto https://www.instagram.com/p/ABC123/?igsh=xx, buenísimo")).toEqual(["https://www.instagram.com/p/ABC123/?igsh=xx"]);
    expect(extraerUrls("www.passline.com/eventos/recital y nada más")).toEqual(["https://www.passline.com/eventos/recital"]);
    expect(extraerUrls("recordame el viernes a las 10")).toEqual([]);
    expect(textoSinUrls("recordame el viernes ver esto https://youtu.be/xyz")).toBe("recordame el viernes ver esto");
  });

  it("lee metadatos, evento y texto de una página", () => {
    const html = `<!doctype html><html><head>
      <meta charset="utf-8"><title>Fallback</title>
      <meta property="og:title" content="Recital de La Banda &amp; amigos">
      <meta property="og:description" content="Entradas a la venta. Funci&oacute;n &#250;nica">
      <meta property="og:image" content="/img/portada.jpg">
      <script type="application/ld+json">{"@context":"https://schema.org","@type":"MusicEvent","name":"La Banda en vivo",
        "startDate":"2026-11-15T21:00:00-03:00","location":{"@type":"Place","name":"Movistar Arena","address":{"addressLocality":"CABA"}}}</script>
      <style>.x{}</style></head><body><script>var a=1;</script><h1>La Banda</h1><p>Sábado 15/11 a las 21 hs.</p></body></html>`;
    const d = parsearHtml(html, "https://entradas.com/evento/1");
    expect(d.titulo).toBe("Recital de La Banda & amigos");
    expect(d.descripcion).toBe("Entradas a la venta. Función única");
    expect(d.imagen).toBe("https://entradas.com/img/portada.jpg");
    expect(d.evento).toEqual({ nombre: "La Banda en vivo", inicio: "2026-11-15T21:00:00-03:00", lugar: "Movistar Arena — CABA" });
    expect(d.texto).toContain("Sábado 15/11 a las 21 hs.");
    expect(d.texto).not.toContain("var a");
  });

  it("decodifica entidades", () => {
    expect(decodificarEntidades("&iexcl;Hola&#33; &quot;ñ&quot; &#x1F600;")).toBe('¡Hola! "ñ" 😀');
  });

  it("no lee direcciones internas del servidor", async () => {
    expect(ipPrivada("127.0.0.1")).toBe(true);
    expect(ipPrivada("10.0.1.5")).toBe(true);
    expect(ipPrivada("172.20.0.3")).toBe(true);
    expect(ipPrivada("192.168.1.1")).toBe(true);
    expect(ipPrivada("169.254.169.254")).toBe(true);
    expect(ipPrivada("::1")).toBe(true);
    expect(ipPrivada("8.8.8.8")).toBe(false);
    await expect(verificarDestino(new URL("http://127.0.0.1/admin"))).rejects.toThrow();
    await expect(verificarDestino(new URL("http://localhost:3000/"))).rejects.toThrow();
    await expect(verificarDestino(new URL("file:///etc/passwd"))).rejects.toThrow();
  });

  describe("Facebook e Instagram", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    });

    it("un link de «Compartir» se abre para saber qué es: un reel se resume como video", async () => {
      const pedidos = webFalsa({ "https://www.facebook.com/share/1FYA6MBX6K/": { a: "https://www.facebook.com/reel/987654321/" }, "https://www.facebook.com/reel/987654321/": pagina({ "og:title": "Reel" }) });
      const destino = await abrirCompartido("https://www.facebook.com/share/1FYA6MBX6K/");
      expect(destino).toBe("https://www.facebook.com/reel/987654321/");
      expect(esLinkDeVideo(destino)).toBe(true);
      // A Facebook se le pide como un navegador común (a un bot solo le muestra «Iniciá sesión»).
      expect(pedidos[0].agente).toContain("Chrome/");
      // Si la página dice su dirección real (sin redirigir), se usa esa.
      webFalsa({ "https://www.facebook.com/share/ABC/": pagina({ "og:url": "https://www.facebook.com/Cafeteria/posts/pfbid123" }) });
      expect(await abrirCompartido("https://www.facebook.com/share/ABC/")).toBe("https://www.facebook.com/Cafeteria/posts/pfbid123");
      // Cualquier otro link vuelve tal cual, sin abrirlo.
      expect(await abrirCompartido("https://entradas.com/x")).toBe("https://entradas.com/x");
    });

    it("una publicación pública se lee (texto e imagen); de cualquier otro sitio, el bot se presenta como bot", async () => {
      const pedidos = webFalsa({
        "https://www.facebook.com/share/p/XYZ/": { a: "https://www.facebook.com/Cafeteria/posts/pfbid123" },
        "https://www.facebook.com/Cafeteria/posts/pfbid123": pagina({ "og:title": "Cafetería del Centro", "og:description": "Sábado 6/12 a las 18: cata de café de especialidad. Cupos limitados." }),
      });
      const c = await leerEnlace("https://www.facebook.com/share/p/XYZ/");
      expect(c).toMatchObject({ legible: true, titulo: "Cafetería del Centro", descripcion: "Sábado 6/12 a las 18: cata de café de especialidad. Cupos limitados.", texto: null, motivo: null });
      expect(pedidos.every((p) => p.agente.includes("Chrome/"))).toBe(true);
      const otros = webFalsa({ "https://entradas.com/x": pagina({ "og:title": "Recital" }) });
      await leerEnlace("https://entradas.com/x");
      expect(otros[0].agente).toContain("MemolucasBot");
    });

    it("lo de un grupo, Marketplace o privado: no se lee y dice por qué", async () => {
      webFalsa({
        "https://www.facebook.com/share/G1/": { a: "https://www.facebook.com/login/?next=https%3A%2F%2Fwww.facebook.com%2Fgroups%2F123%2Fpermalink%2F456%2F" },
        "https://www.facebook.com/login/?next=https%3A%2F%2Fwww.facebook.com%2Fgroups%2F123%2Fpermalink%2F456%2F": pagina({ "og:title": "Log into Facebook", "og:description": "Log into Facebook to start sharing and connecting with your friends." }),
      });
      const c = await leerEnlace("https://www.facebook.com/share/G1/");
      expect(c).toMatchObject({ legible: false, titulo: null, motivo: "Es de un grupo de Facebook: sin iniciar sesión no se puede ver." });
      // La pantalla de ingreso sin redirección también se reconoce.
      webFalsa({ "https://www.facebook.com/Algo/posts/1": pagina({ "og:title": "Facebook", "og:description": "Iniciá sesión en Facebook para empezar a compartir." }) });
      expect(await leerEnlace("https://www.facebook.com/Algo/posts/1")).toMatchObject({ legible: false, motivo: "Facebook no lo muestra sin iniciar sesión (puede ser privado o de un grupo)." });
      expect(motivoSinSesion("https://www.facebook.com/marketplace/item/1/")).toBe("Es de Marketplace: Facebook no lo muestra sin iniciar sesión.");
      expect(motivoSinSesion("https://www.instagram.com/p/ABC/")).toBe("Instagram no deja ver esa publicación sin iniciar sesión.");
      expect(motivoSinSesion("https://entradas.com/x")).toBeNull();
    });

    it("una publicación pública de Instagram (/p/) se lee con su texto", async () => {
      webFalsa({ "https://www.instagram.com/p/ABC/": pagina({ "og:title": "Cafetería del Centro en Instagram: \"Cata el sábado 6/12\"", "og:description": "120 Me gusta - Cata de café el sábado 6/12 a las 18." }) });
      expect(await leerEnlace("https://www.instagram.com/p/ABC/")).toMatchObject({ legible: true, descripcion: "120 Me gusta - Cata de café el sábado 6/12 a las 18.", motivo: null });
    });
  });
});
