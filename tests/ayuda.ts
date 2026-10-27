import { sql } from "drizzle-orm";
import { vi } from "vitest";
import { db, migrarBase } from "../src/db/index.js";
import { actualizarConfig, invalidarConfig } from "../src/servicios/configuracion.js";
import { fijarEnviador, type Enviador } from "../src/servicios/enviador.js";

export type Enviado = { texto: string; imagen?: string; id: string; destino?: string | null };

export function enviadorFalso() {
  const enviados: Enviado[] = [];
  let n = 0;
  const e: Enviador & { enviados: Enviado[]; online: boolean } = {
    enviados,
    online: true,
    conectado() {
      return this.online;
    },
    async enviarTexto(texto, destino) {
      const id = `MSG${++n}`;
      enviados.push({ texto, id, destino: destino ?? null });
      return id;
    },
    async enviarImagen(ruta, _mime, texto, destino) {
      const id = `MSG${++n}`;
      enviados.push({ texto, imagen: ruta, id, destino: destino ?? null });
      return id;
    },
  };
  fijarEnviador(e);
  return e;
}

let migrado = false;
export async function baseLimpia() {
  if (!migrado) {
    await migrarBase();
    migrado = true;
  }
  await db.execute(
    sql`truncate table mensaje, ocurrencia, recordatorio, lista_item, lista, nota, grupo, adjunto, borrador_pendiente, log_sistema, uso_ia, configuracion, acceso_panel restart identity cascade`,
  );
  invalidarConfig();
  await actualizarConfig({ numeroAutorizado: "5491112345678" });
}

/** Mueve el reloj (solo Date) para simular el paso del tiempo. */
export function reloj(inicio: Date) {
  vi.useFakeTimers({ toFake: ["Date"], now: inicio });
  return {
    avanzar(min: number) {
      vi.setSystemTime(new Date(Date.now() + min * 60_000));
    },
    ir(d: Date) {
      vi.setSystemTime(d);
    },
  };
}
