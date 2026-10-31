// Cola de subidas: lo que se carga sin señal queda guardado en el celular y se sube solo al volver.

export type Pendiente = { clienteId: string; archivos: File[]; creadoEn: number; error?: string };

const BASE = "compras-coffit";
const TABLA = "pendientes";
let memoria: Pendiente[] = []; // Si el navegador no deja usar IndexedDB.
const oyentes = new Set<(p: Pendiente[], subiendo: boolean) => void>();
let subiendo = false;

function abrirBase(): Promise<IDBDatabase | null> {
  return new Promise((ok) => {
    try {
      const pedido = indexedDB.open(BASE, 1);
      pedido.onupgradeneeded = () => pedido.result.createObjectStore(TABLA, { keyPath: "clienteId" });
      pedido.onsuccess = () => ok(pedido.result);
      pedido.onerror = () => ok(null);
    } catch {
      ok(null);
    }
  });
}

async function tabla<T>(modo: IDBTransactionMode, fn: (t: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  const db = await abrirBase();
  if (!db) return null;
  return new Promise((ok) => {
    const pedido = fn(db.transaction(TABLA, modo).objectStore(TABLA));
    pedido.onsuccess = () => ok(pedido.result);
    pedido.onerror = () => ok(null);
  });
}

export async function pendientes(): Promise<Pendiente[]> {
  const todos = await tabla<Pendiente[]>("readonly", (t) => t.getAll() as IDBRequest<Pendiente[]>);
  return (todos ?? memoria).sort((a, b) => a.creadoEn - b.creadoEn);
}

async function guardar(p: Pendiente) {
  if ((await tabla("readwrite", (t) => t.put(p))) === null) memoria = [...memoria.filter((x) => x.clienteId !== p.clienteId), p];
}

export async function quitar(clienteId: string) {
  await tabla("readwrite", (t) => t.delete(clienteId));
  memoria = memoria.filter((x) => x.clienteId !== clienteId);
  await avisar();
}

async function avisar() {
  const p = await pendientes();
  oyentes.forEach((o) => o(p, subiendo));
}

export function escuchar(fn: (p: Pendiente[], subiendo: boolean) => void) {
  oyentes.add(fn);
  void avisar();
  return () => void oyentes.delete(fn);
}

const nuevoId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

/** Guarda la factura en el celular y trata de subirla enseguida. */
export async function encolar(archivos: File[]) {
  await guardar({ clienteId: nuevoId(), archivos, creadoEn: Date.now() });
  await avisar();
  void subirTodo();
}

/** Sube lo pendiente, de a uno. Si no hay señal, se reintenta después. */
export async function subirTodo() {
  if (subiendo) return;
  subiendo = true;
  await avisar();
  try {
    for (const p of await pendientes()) {
      if (p.error) continue;
      const datos = new FormData();
      datos.append("clienteId", p.clienteId);
      p.archivos.forEach((a, i) => datos.append("archivos", a, a.name || `hoja-${i + 1}.jpg`));
      let r: Response;
      try {
        r = await fetch("/api/c/subir", { method: "POST", body: datos, credentials: "same-origin" });
      } catch {
        break; // Sin señal: se vuelve a probar al recuperar la conexión.
      }
      if (r.ok) await quitar(p.clienteId);
      else if (r.status === 401) {
        window.dispatchEvent(new Event("sesion-vencida"));
        break;
      } else if (r.status >= 500 || r.status === 429 || r.status === 408) break;
      else {
        const cuerpo = await r.json().catch(() => ({}) as { error?: string });
        await guardar({ ...p, error: (cuerpo as { error?: string }).error ?? `Error ${r.status}` });
      }
    }
  } finally {
    subiendo = false;
    await avisar();
  }
}

/** Reintentos automáticos: al volver la señal, al abrir la app y cada tanto. */
export function iniciarCola() {
  window.addEventListener("online", () => void subirTodo());
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && void subirTodo());
  setInterval(() => navigator.onLine && void subirTodo(), 20_000);
  void subirTodo();
}
