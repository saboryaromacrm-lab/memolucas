import { describe, expect, it } from "vitest";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { EsquemaFoto, EsquemaInterpretacion } from "../src/bot/ia.js";

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

describe("esquemas para Claude", () => {
  it("son válidos para salida estructurada", () => {
    for (const e of [EsquemaInterpretacion, EsquemaFoto]) {
      const f = zodOutputFormat(e) as unknown as { type: string; schema: unknown };
      expect(f.type).toBe("json_schema");
      expect(revisar(f.schema)).toEqual([]);
    }
  });
});
