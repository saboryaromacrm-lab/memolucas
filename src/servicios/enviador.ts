/** Lo que el resto de la app necesita de WhatsApp (permite probar sin conexión real). */
export interface Enviador {
  conectado(): boolean;
  /** Envía al número autorizado, o al grupo indicado. Devuelve el id del mensaje de WhatsApp. */
  enviarTexto(texto: string, destino?: string | null): Promise<string | null>;
  enviarImagen(ruta: string, mime: string, epigrafe: string, destino?: string | null): Promise<string | null>;
}

let actual: Enviador = {
  conectado: () => false,
  enviarTexto: async () => null,
  enviarImagen: async () => null,
};

export const fijarEnviador = (e: Enviador) => {
  actual = e;
};
export const enviador = (): Enviador => actual;
