/** Lo que el resto de la app necesita de WhatsApp (permite probar sin conexión real). */
export interface Enviador {
  conectado(): boolean;
  /** Envía al número autorizado. Devuelve el id del mensaje de WhatsApp. */
  enviarTexto(texto: string): Promise<string | null>;
  enviarImagen(ruta: string, mime: string, epigrafe: string): Promise<string | null>;
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
