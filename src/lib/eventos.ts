import { EventEmitter } from "node:events";

export type TipoCambio = "recordatorios" | "whatsapp" | "configuracion" | "mensajes" | "logs" | "notas" | "compras";

/** Bus interno: avisa al panel (por SSE) que algo cambió para que se actualice solo. */
class Bus extends EventEmitter {
  avisar(tipo: TipoCambio, datos?: unknown) {
    this.emit("cambio", { tipo, datos });
  }
}

export const bus = new Bus();
bus.setMaxListeners(100);
