import { beforeEach, describe, expect, it } from "vitest";
import { agregarItems, buscarLista, claveLista, obtenerLista, obtenerOCrearLista, quitarItems } from "../src/servicios/listas.js";
import { crearNota, relacionadas, todasLasNotas } from "../src/servicios/notas.js";
import { baseLimpia } from "./ayuda.js";

describe("listas y notas", () => {
  beforeEach(baseLimpia);

  it("no duplica listas ni ítems", async () => {
    expect(claveLista("la lista del Súper")).toBe("super");
    const a = await obtenerOCrearLista("Súper");
    const b = await obtenerOCrearLista("lista del super");
    expect(b.id).toBe(a.id);
    await agregarItems(a.id, [{ texto: "Leche" }, { texto: "pan", cantidad: "1 kg" }]);
    await agregarItems(a.id, [{ texto: "leche", cantidad: "2" }]);
    const l = (await obtenerLista(a.id))!;
    expect(l.items.map((i) => [i.texto, i.cantidad])).toEqual([
      ["Leche", "2"],
      ["pan", "1 kg"],
    ]);
    await quitarItems([l.items[0].id]);
    expect((await obtenerLista(a.id))!.items).toHaveLength(1);
    expect((await buscarLista("super"))?.id).toBe(a.id);
  });

  it("las notas se leen descifradas y se filtran por la consulta", async () => {
    await crearNota({ titulo: "Clave wifi", contenido: "wifi casa: perro123", categoria: "Claves" });
    await crearNota({ titulo: "Patente", contenido: "AB123CD", categoria: "auto" });
    const ns = await todasLasNotas();
    expect(ns.map((n) => n.categoria).sort()).toEqual(["auto", "claves"]);
    expect(relacionadas(ns, "wifi", 1)[0].titulo).toBe("Clave wifi");
  });
});
