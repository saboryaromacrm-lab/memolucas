import { describe, expect, it } from "vitest";
import { alternarTramo, convertir, moverTramos, siguienteMayuscula, unirTramos } from "../web/src/lib/textoBloc.js";

describe("Bloc: resaltados y mayúsculas", () => {
  it("lo resaltado sigue al texto mientras se escribe", () => {
    const t = "hola mundo lindo";
    const r = [{ desde: 5, hasta: 10 }]; // «mundo»
    expect(moverTramos(t, "che, hola mundo lindo", r)).toEqual([{ desde: 10, hasta: 15 }]); // Escrito antes: se corre.
    expect(moverTramos(t, "hola mundo lindo!!", r)).toEqual(r); // Escrito después: igual.
    expect(moverTramos(t, "hola munndo lindo", r)).toEqual([{ desde: 5, hasta: 11 }]); // Adentro: crece.
    expect(moverTramos(t, "hola lindo", r)).toEqual([]); // Borrado: se va.
    expect(moverTramos(t, "hola mu lindo", r)).toEqual([{ desde: 5, hasta: 7 }]); // Borrado en parte: se achica.
    expect(moverTramos(t, "hola MUNDO lindo", r)).toEqual(r); // Mismo largo (mayúsculas): igual.
  });

  it("resaltar lo seleccionado, o sacarlo si ya estaba resaltado", () => {
    let r = alternarTramo([], 0, 4);
    r = alternarTramo(r, 3, 8); // Se pisa con el anterior: quedan unidos.
    expect(r).toEqual([{ desde: 0, hasta: 8 }]);
    expect(alternarTramo(r, 2, 5)).toEqual([
      { desde: 0, hasta: 2 },
      { desde: 5, hasta: 8 },
    ]);
    expect(alternarTramo(r, 6, 12)).toEqual([{ desde: 0, hasta: 12 }]); // No estaba todo resaltado: se resalta.
    expect(unirTramos([{ desde: 4, hasta: 4 }, { desde: 1, hasta: 2 }, { desde: 2, hasta: 3 }])).toEqual([{ desde: 1, hasta: 3 }]);
  });

  it("mayúsculas, minúsculas, tipo oración y cada palabra", () => {
    const t = "HOLA. ¿CÓMO ESTÁS? bien, gracias\nañoS nuevos";
    expect(convertir(t, "mayusculas")).toBe("HOLA. ¿CÓMO ESTÁS? BIEN, GRACIAS\nAÑOS NUEVOS");
    expect(convertir(t, "minusculas")).toBe("hola. ¿cómo estás? bien, gracias\naños nuevos");
    expect(convertir(t, "oracion")).toBe("Hola. ¿Cómo estás? Bien, gracias\nAños nuevos");
    expect(convertir("sabor y aroma ERP", "palabras")).toBe("Sabor Y Aroma Erp");
    expect([siguienteMayuscula("hola"), siguienteMayuscula("HOLA"), siguienteMayuscula("Hola")]).toEqual(["mayusculas", "oracion", "minusculas"]);
  });
});
