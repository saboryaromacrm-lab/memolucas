import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { htmlDelBloc, paginaPara } from "../src/http/servidor.js";

describe("el Bloc como app aparte", () => {
  it("la página de /app/bloc lleva el manifiesto, el título y los íconos del Bloc", () => {
    const html = htmlDelBloc(fs.readFileSync("web/index.html", "utf8"));
    expect(html).toContain('<link rel="manifest" href="/bloc.webmanifest" />');
    expect(html).toContain('<meta name="apple-mobile-web-app-title" content="Bloc" />');
    expect(html).toContain('<link rel="apple-touch-icon" href="/bloc-192.png" />');
    expect(html).toContain('<link rel="icon" href="/bloc.svg"');
    expect(html).toContain("<title>Bloc</title>");
    expect(html).toContain('<meta name="app" content="bloc" />');
    expect(html).not.toContain("Memolucas");
  });

  it("en su propia dirección va solo el Bloc; la dirección vieja lleva a la nueva", () => {
    expect(paginaPara("blocdenotas.saboryaroma.com", "/")).toBe("bloc");
    expect(paginaPara("BlocDeNotas.saboryaroma.com", "/cualquier/cosa")).toBe("bloc");
    expect(paginaPara("memolucas.saboryaroma.com", "/app/bloc")).toEqual({ redirigir: "https://blocdenotas.saboryaroma.com/" });
    expect(paginaPara("memolucas.saboryaroma.com", "/app/bloc?x=1")).toEqual({ redirigir: "https://blocdenotas.saboryaroma.com/" });
    expect(paginaPara("memolucas.saboryaroma.com", "/bloc")).toBe("panel");
    expect(paginaPara("memolucas.saboryaroma.com", "/app/blocx")).toBe("panel");
  });

  it("su manifiesto abre directo en el Bloc (es otra app porque está en otra dirección)", () => {
    const bloc = JSON.parse(fs.readFileSync("web/public/bloc.webmanifest", "utf8"));
    expect(bloc).toMatchObject({ id: "/", name: "Bloc", start_url: "/", scope: "/", display: "standalone" });
    for (const i of bloc.icons) expect(fs.existsSync(`web/public${i.src}`)).toBe(true);
  });
});
