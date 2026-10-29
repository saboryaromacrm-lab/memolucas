import { describe, expect, it } from "vitest";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { EsquemaEnlace, EsquemaFoto, EsquemaInterpretacion, EsquemaRespuestaNotas, normalizarInterpretacion } from "../src/bot/ia.js";

// Structured outputs exige objetos cerrados y todos los campos requeridos.
function revisar(nodo: unknown, ruta = "$"): string[] {
  const errores: string[] = [];
  if (!nodo || typeof nodo !== "object") return errores;
  const n = nodo as Record<string, unknown>;
  if (n.type === "object") {
    if (n.additionalProperties !== false) errores.push(`${ruta}: additionalProperties`);
    const props = Object.keys((n.properties as object) ?? {});
    const req = (n.required as string[]) ?? [];
    for (const p of props) if (!req.includes(p)) errores.push(`${ruta}.${p}: no requerido`);
  }
  for (const [k, v] of Object.entries(n)) {
    if (Array.isArray(v)) v.forEach((x, i) => errores.push(...revisar(x, `${ruta}.${k}[${i}]`)));
    else if (typeof v === "object") errores.push(...revisar(v, `${ruta}.${k}`));
  }
  return errores;
}

/** Campos con anyOf o con varios tipos (ej. string|null): la API acepta como máximo 16 por pedido. */
function uniones(nodo: unknown): number {
  if (!nodo || typeof nodo !== "object") return 0;
  const n = nodo as Record<string, unknown>;
  let c = Array.isArray(n.anyOf) || Array.isArray(n.type) ? 1 : 0;
  for (const v of Object.values(n)) if (typeof v === "object") c += Array.isArray(v) ? v.reduce((a: number, x) => a + uniones(x), 0) : uniones(v);
  return c;
}

describe("esquemas para Claude", () => {
  for (const [nombre, e] of Object.entries({ EsquemaInterpretacion, EsquemaFoto, EsquemaEnlace, EsquemaRespuestaNotas })) {
    it(`${nombre} es válido y no supera los límites de la API`, () => {
      const f = zodOutputFormat(e as never) as unknown as { type: string; schema: unknown };
      expect(f.type).toBe("json_schema");
      expect(revisar(f.schema)).toEqual([]);
      expect(uniones(f.schema)).toBeLessThanOrEqual(16);
    });
  }

  it("los vacíos de la IA se convierten en null", () => {
    const vacio = { titulo: "", descripcion: "", fecha_hora: "", recurrencia: "", avisos_previos_min: [], lista: "" };
    const i = normalizarInterpretacion({
      intencion: "crear_recordatorio",
      recordatorios: [{ ...vacio, titulo: "Turno con el doctor", fecha_hora: "2026-10-30T09:00:00-03:00" }],
      hay_cambios: false,
      cambios: { ...vacio, quitar_recurrencia: false },
      recordatorio_ids: [],
      referencia: "",
      listar_desde: "",
      listar_hasta: "",
      posponer_minutos: 0,
      posponer_hasta: "",
      lista: "",
      lista_items: [],
      lista_item_ids: [],
      hay_nota: false,
      nota: { titulo: "", contenido: "", categoria: "" },
      nota_ids: [],
      consulta: "",
      falta_info: "",
      respuesta: "",
      confianza: 0.9,
    });
    expect(i.recordatorios[0]).toEqual({
      titulo: "Turno con el doctor",
      descripcion: null,
      fecha_hora: "2026-10-30T09:00:00-03:00",
      recurrencia: null,
      avisos_previos_min: null,
      lista: null,
    });
    expect(i.cambios).toBeNull();
    expect(i.nota).toBeNull();
    expect(i.posponer_minutos).toBeNull();
    expect(i.falta_info).toBeNull();
  });
});
