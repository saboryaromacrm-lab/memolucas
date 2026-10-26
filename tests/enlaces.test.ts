import { describe, expect, it } from "vitest";
import { decodificarEntidades, extraerUrls, ipPrivada, parsearHtml, textoSinUrls, verificarDestino } from "../src/servicios/enlaces.js";

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
});
