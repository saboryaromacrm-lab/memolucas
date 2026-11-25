import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { htmlDelBloc } from "../src/http/servidor.js";

describe("el Bloc como app aparte", () => {
  it("la página de /app/bloc lleva el manifiesto, el título y los íconos del Bloc", () => {
    const html = htmlDelBloc(fs.readFileSync("web/index.html", "utf8"));
    expect(html).toContain('<link rel="manifest" href="/bloc.webmanifest" />');
    expect(html).toContain('<meta name="apple-mobile-web-app-title" content="Bloc" />');
    expect(html).toContain('<link rel="apple-touch-icon" href="/bloc-192.png" />');
    expect(html).toContain('<link rel="icon" href="/bloc.svg"');
    expect(html).toContain("<title>Bloc</title>");
    expect(html).not.toContain("Memolucas");
  });

  it("su manifiesto es otra app (otro id) que abre directo en el Bloc", () => {
    const bloc = JSON.parse(fs.readFileSync("web/public/bloc.webmanifest", "utf8"));
    const panel = JSON.parse(fs.readFileSync("web/public/manifest.webmanifest", "utf8"));
    expect(bloc).toMatchObject({ id: "/app/bloc", name: "Bloc", start_url: "/app/bloc", scope: "/app/bloc", display: "standalone" });
    expect(panel.id).toBe("/");
    for (const i of bloc.icons) expect(fs.existsSync(`web/public${i.src}`)).toBe(true);
  });
});
