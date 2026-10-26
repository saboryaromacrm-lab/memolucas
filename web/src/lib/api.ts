export class ErrorApi extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

type Opciones = { metodo?: string; cuerpo?: unknown; formulario?: FormData };

/** fetch con cookies, JSON y manejo de errores (401 → vuelve al login). */
export async function api<T = unknown>(ruta: string, op: Opciones = {}): Promise<T> {
  const r = await fetch(ruta, {
    method: op.metodo ?? (op.cuerpo || op.formulario ? "POST" : "GET"),
    credentials: "same-origin",
    headers: op.cuerpo !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: op.formulario ?? (op.cuerpo !== undefined ? JSON.stringify(op.cuerpo) : undefined),
  });
  const tipo = r.headers.get("content-type") ?? "";
  const datos = tipo.includes("application/json") ? await r.json() : await r.text();
  if (!r.ok) {
    if (r.status === 401 && !ruta.startsWith("/api/auth/")) window.dispatchEvent(new Event("sesion-vencida"));
    const msg = typeof datos === "object" && datos && "error" in datos ? String((datos as { error: string }).error) : `Error ${r.status}`;
    throw new ErrorApi(msg, r.status);
  }
  return datos as T;
}

export const get = <T,>(ruta: string) => api<T>(ruta);
export const post = <T,>(ruta: string, cuerpo: unknown = {}) => api<T>(ruta, { metodo: "POST", cuerpo });
export const put = <T,>(ruta: string, cuerpo: unknown) => api<T>(ruta, { metodo: "PUT", cuerpo });
export const patch = <T,>(ruta: string, cuerpo: unknown) => api<T>(ruta, { metodo: "PATCH", cuerpo });
export const del = <T,>(ruta: string) => api<T>(ruta, { metodo: "DELETE" });
