/** Lo que el resto de la app necesita de WhatsApp (permite probar sin conexión real). */
export interface Enviador {
  conectado(): boolean;
  /** Envía al número autorizado, o al grupo indicado. Devuelve el id del mensaje de WhatsApp. */
  enviarTexto(texto: string, destino?: string | null): Promise<string | null>;
  enviarImagen(ruta: string, mime: string, epigrafe: string, destino?: string | null): Promise<string | null>;
  /** Encuesta de WhatsApp (opciones para tocar). Devuelve su id y la clave para descifrar los votos. */
  enviarEncuesta(nombre: string, opciones: string[], destino?: string | null): Promise<{ id: string | null; secreto: string }>;
}

let actual: Enviador = {
  conectado: () => false,
  enviarTexto: async () => null,
  enviarImagen: async () => null,
  enviarEncuesta: async () => ({ id: null, secreto: "" }),
};

export const fijarEnviador = (e: Enviador) => {
  actual = e;
};
export const enviador = (): Enviador => actual;
