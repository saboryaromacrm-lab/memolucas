import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  Camera,
  Check,
  CheckCircle2,
  ChevronLeft,
  CloudUpload,
  FileText,
  Images,
  Loader2,
  LogOut,
  Pencil,
  Plus,
  RotateCcw,
  Sparkles,
  Trash2,
  WifiOff,
  X,
} from "lucide-react";
import { Boton, useAccion, useAviso } from "../componentes/ui";
import { get, post, put } from "../lib/api";
import { haceCuanto } from "../lib/fechas";
import type { Compra, ComprobanteDatos } from "../lib/tipos";
import { encolar, escuchar, iniciarCola, quitar, subirTodo, type Pendiente } from "./cola";
import { comprimir } from "./imagen";

type Marca = { nombre: string; logo: string | null };
type Lectura = { id: number; estado: "leyendo" | "lista" | "error" | "repetido" | "vacia"; autor: string | null; mensaje: string | null; hojas: number; creadoEn: string };
type Detalle = Compra & { datos: ComprobanteDatos };

const plata = (n: number | string | null, moneda = "PES") =>
  n === null ? "—" : `${moneda === "DOL" ? "US$" : "$"} ${Number(n).toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fechaCorta = (iso: string | null | undefined) => (iso && /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso.split("-").reverse().join("/") : iso || "—");

const ESTADOS: Record<Compra["estado"], [string, string]> = {
  pendiente: ["A confirmar", "bg-sky-50 text-sky-700"],
  revisar: ["A revisar", "bg-amber-100 text-amber-800"],
  confirmado: ["Confirmada", "bg-emerald-50 text-emerald-700"],
  descartado: ["Descartada", "bg-stone-100 text-stone-500"],
};

/** Datos en vivo: se recargan solos cuando cambia algo (SSE) y al volver a la app. */
function useVivo<T>(ruta: string | null) {
  const [datos, setDatos] = useState<T | null>(null);
  const recargar = useCallback(async () => {
    if (!ruta) return;
    try {
      setDatos(await get<T>(ruta));
    } catch {
      // Sin señal: queda lo último que se vio.
    }
  }, [ruta]);
  useEffect(() => {
    void recargar();
    if (!ruta) return;
    const fuente = new EventSource("/api/c/eventos");
    let t: ReturnType<typeof setTimeout> | undefined;
    fuente.addEventListener("cambio", () => {
      clearTimeout(t);
      t = setTimeout(() => void recargar(), 300);
    });
    fuente.onopen = () => void recargar();
    const visible = () => document.visibilityState === "visible" && void recargar();
    document.addEventListener("visibilitychange", visible);
    return () => {
      fuente.close();
      clearTimeout(t);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [ruta, recargar]);
  return { datos, recargar };
}

export function AppCompras() {
  const [sesion, setSesion] = useState<{ nombre: string } | false | null>(null);
  const [marca, setMarca] = useState<Marca>({ nombre: "Compras Coffit", logo: null });
  useEffect(() => {
    void get<Marca>("/api/c/marca").then(setMarca).catch(() => {});
    get<{ nombre: string }>("/api/c/yo")
      .then(setSesion)
      .catch(() => setSesion(false));
    const vencida = () => setSesion(false);
    window.addEventListener("sesion-vencida", vencida);
    return () => window.removeEventListener("sesion-vencida", vencida);
  }, []);
  if (sesion === null)
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <Loader2 className="size-6 animate-spin text-naranja" />
      </div>
    );
  if (!sesion) return <Ingreso marca={marca} onEntrar={setSesion} />;
  return <Principal marca={marca} nombre={sesion.nombre} onSalir={() => setSesion(false)} />;
}

function Logo({ marca, chico }: { marca: Marca; chico?: boolean }) {
  if (marca.logo) return <img src={marca.logo} alt="Coffit" className={chico ? "h-8 w-auto max-w-32 object-contain" : "mx-auto h-20 w-auto max-w-56 object-contain"} />;
  return <span className={`font-black tracking-tight ${chico ? "text-xl" : "text-4xl"}`}>Coffit</span>;
}

function Ingreso({ marca, onEntrar }: { marca: Marca; onEntrar: (s: { nombre: string }) => void }) {
  const [clave, setClave] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [entrando, setEntrando] = useState(false);
  const entrar = async () => {
    setEntrando(true);
    setError(null);
    try {
      onEntrar(await post<{ nombre: string }>("/api/c/ingresar", { clave }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo entrar");
    }
    setEntrando(false);
  };
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-cafe px-6 text-beige">
      <div className="w-full max-w-xs text-center">
        <Logo marca={marca} />
        <p className="mt-2 text-sm font-medium uppercase tracking-[0.2em] text-naranja">Compras</p>
        <input
          className="mt-10 w-full rounded-2xl border-0 bg-white/10 px-4 py-4 text-center text-2xl tracking-[0.5em] text-white outline-none placeholder:tracking-normal placeholder:text-beige/50 focus:ring-2 focus:ring-naranja"
          type="password"
          inputMode="numeric"
          autoComplete="current-password"
          placeholder="Tu clave"
          maxLength={8}
          value={clave}
          onChange={(e) => setClave(e.target.value.replace(/\D/g, ""))}
          onKeyDown={(e) => e.key === "Enter" && clave.length >= 4 && void entrar()}
        />
        {error && <p className="mt-3 text-sm text-orange-300">{error}</p>}
        <button
          className="mt-6 flex w-full items-center justify-center gap-2 rounded-2xl bg-naranja py-4 text-lg font-semibold text-white shadow-lg disabled:opacity-50"
          disabled={clave.length < 4 || entrando}
          onClick={() => void entrar()}
        >
          {entrando && <Loader2 className="size-5 animate-spin" />} Entrar
        </button>
      </div>
    </div>
  );
}

function Principal({ marca, nombre, onSalir }: { marca: Marca; nombre: string; onSalir: () => void }) {
  const { datos, recargar } = useVivo<{ lecturas: Lectura[]; compras: Compra[] }>("/api/c/compras");
  const [filtro, setFiltro] = useState<"abiertas" | "confirmado" | "todas">("abiertas");
  const [abierta, setAbierta] = useState<number | null>(null);
  const accion = useAccion();
  useEffect(() => iniciarCola(), []);

  const compras = useMemo(
    () =>
      (datos?.compras ?? []).filter((c) =>
        filtro === "abiertas" ? c.estado === "pendiente" || c.estado === "revisar" : filtro === "confirmado" ? c.estado === "confirmado" : true,
      ),
    [datos, filtro],
  );
  const abiertas = (datos?.compras ?? []).filter((c) => c.estado === "pendiente" || c.estado === "revisar").length;

  return (
    <div className="mx-auto min-h-dvh max-w-xl pb-10">
      <header className="sticky top-0 z-20 flex items-center gap-3 bg-cafe px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))] text-beige shadow-md">
        <Logo marca={marca} chico />
        <span className="text-xs font-semibold uppercase tracking-[0.2em] text-naranja">Compras</span>
        <span className="ml-auto truncate text-sm text-beige/80">{nombre}</span>
        <button
          aria-label="Salir"
          className="rounded-lg p-1.5 text-beige/70 hover:bg-white/10"
          onClick={async () => {
            await post("/api/c/salir").catch(() => {});
            onSalir();
          }}
        >
          <LogOut className="size-5" />
        </button>
      </header>

      <div className="space-y-4 px-4 pt-4">
        <Cargador />
        <EstadoCola />
        {datos?.lecturas.map((l) => (
          <TarjetaLectura key={l.id} l={l} accion={accion} />
        ))}

        <div className="flex gap-1.5">
          {(
            [
              ["abiertas", `Para revisar${abiertas ? ` (${abiertas})` : ""}`],
              ["confirmado", "Confirmadas"],
              ["todas", "Todas"],
            ] as const
          ).map(([v, t]) => (
            <button
              key={v}
              onClick={() => setFiltro(v)}
              className={`rounded-full px-3.5 py-1.5 text-sm font-medium ${filtro === v ? "bg-cafe text-beige" : "border border-stone-300 bg-white text-stone-600"}`}
            >
              {t}
            </button>
          ))}
        </div>

        {!datos ? (
          <div className="flex justify-center py-10">
            <Loader2 className="size-6 animate-spin text-naranja" />
          </div>
        ) : !compras.length ? (
          <p className="tarjeta px-4 py-8 text-center text-sm text-stone-500">
            {filtro === "abiertas" ? "No hay facturas para revisar 🙌" : "Todavía no hay facturas acá."}
          </p>
        ) : (
          <div className="space-y-2">
            {compras.map((c) => (
              <button key={c.id} onClick={() => setAbierta(c.id)} className="tarjeta flex w-full items-center gap-3 px-4 py-3 text-left active:bg-stone-50">
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-semibold text-stone-800">{c.proveedor || "Proveedor sin datos"}</span>
                  <span className="block truncate text-xs text-stone-500">
                    {c.titulo} · {fechaCorta(c.fecha)}
                    {c.autor && ` · ${c.autor}`}
                  </span>
                  <span className={`mt-1 inline-block rounded-full px-2 py-0.5 text-[11px] font-medium ${ESTADOS[c.estado][1]}`}>{ESTADOS[c.estado][0]}</span>
                </span>
                <span className="shrink-0 text-right">
                  <span className="block font-semibold tabular-nums text-stone-800">{plata(c.total, c.moneda)}</span>
                  <span className={`flex items-center justify-end gap-1 text-xs ${c.cierra ? "text-emerald-700" : "text-amber-700"}`}>
                    {c.cierra ? <CheckCircle2 className="size-3.5" /> : <AlertTriangle className="size-3.5" />}
                    {c.cierra ? "Cierra" : "No cierra"}
                  </span>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {abierta && <VistaComprobante id={abierta} onCerrar={() => (setAbierta(null), void recargar())} />}
    </div>
  );
}

/** Cámara, galería o PDF. Las hojas de una misma factura se juntan antes de leer. */
function Cargador() {
  const [hojas, setHojas] = useState<{ archivo: File; url: string }[]>([]);
  const [preparando, setPreparando] = useState(false);
  const camara = useRef<HTMLInputElement>(null);
  const galeria = useRef<HTMLInputElement>(null);
  const pdf = useRef<HTMLInputElement>(null);
  const avisar = useAviso();

  const agregar = async (lista: FileList | null) => {
    if (!lista?.length) return;
    setPreparando(true);
    const nuevas = await Promise.all([...lista].map(async (f) => {
      const archivo = await comprimir(f);
      return { archivo, url: URL.createObjectURL(archivo) };
    }));
    setHojas((h) => [...h, ...nuevas]);
    setPreparando(false);
  };
  const limpiar = () => {
    hojas.forEach((h) => URL.revokeObjectURL(h.url));
    setHojas([]);
  };
  const leer = async () => {
    await encolar(hojas.map((h) => h.archivo));
    limpiar();
    avisar("Factura enviada: se está leyendo");
  };

  return (
    <section className="tarjeta overflow-hidden">
      <input ref={camara} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => (void agregar(e.target.files), (e.target.value = ""))} />
      <input ref={galeria} type="file" accept="image/*" multiple className="hidden" onChange={(e) => (void agregar(e.target.files), (e.target.value = ""))} />
      <input
        ref={pdf}
        type="file"
        accept="application/pdf"
        className="hidden"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (!f) return;
          await encolar([f]);
          avisar("PDF enviado: se está leyendo");
        }}
      />
      {!hojas.length ? (
        <div className="p-4">
          <button onClick={() => camara.current?.click()} className="flex w-full items-center justify-center gap-3 rounded-2xl bg-naranja py-5 text-lg font-semibold text-white shadow-md active:scale-[0.99]">
            {preparando ? <Loader2 className="size-6 animate-spin" /> : <Camera className="size-6" />} Sacar foto a la factura
          </button>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <button onClick={() => galeria.current?.click()} className="flex items-center justify-center gap-2 rounded-xl border border-stone-300 py-3 text-sm font-medium text-stone-700 active:bg-stone-50">
              <Images className="size-4" /> Galería
            </button>
            <button onClick={() => pdf.current?.click()} className="flex items-center justify-center gap-2 rounded-xl border border-stone-300 py-3 text-sm font-medium text-stone-700 active:bg-stone-50">
              <FileText className="size-4" /> PDF
            </button>
          </div>
        </div>
      ) : (
        <div className="p-4">
          <div className="mb-3 flex items-center justify-between">
            <span className="font-semibold text-stone-800">
              {hojas.length} {hojas.length === 1 ? "hoja" : "hojas"} de la misma factura
            </span>
            <button onClick={limpiar} className="text-sm text-stone-500">
              Cancelar
            </button>
          </div>
          <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
            {hojas.map((h, i) => (
              <div key={h.url} className="relative shrink-0">
                <img src={h.url} alt={`Hoja ${i + 1}`} className="h-28 w-20 rounded-lg border border-stone-200 object-cover" />
                <button
                  aria-label="Quitar hoja"
                  className="absolute -right-1.5 -top-1.5 rounded-full bg-cafe p-1 text-white shadow"
                  onClick={() => {
                    URL.revokeObjectURL(h.url);
                    setHojas((x) => x.filter((y) => y.url !== h.url));
                  }}
                >
                  <X className="size-3" />
                </button>
              </div>
            ))}
            <button onClick={() => camara.current?.click()} className="flex h-28 w-20 shrink-0 flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed border-naranja/60 text-xs font-medium text-naranja">
              {preparando ? <Loader2 className="size-5 animate-spin" /> : <Plus className="size-5" />} Otra hoja
            </button>
          </div>
          <button onClick={() => void leer()} disabled={preparando} className="mt-4 flex w-full items-center justify-center gap-2 rounded-2xl bg-cafe py-4 text-lg font-semibold text-beige shadow-md disabled:opacity-50">
            <Sparkles className="size-5 text-naranja" /> Leer factura
          </button>
        </div>
      )}
    </section>
  );
}

function EstadoCola() {
  const [lista, setLista] = useState<Pendiente[]>([]);
  const [subiendo, setSubiendo] = useState(false);
  const [enLinea, setEnLinea] = useState(navigator.onLine);
  useEffect(() => escuchar((p, s) => (setLista(p), setSubiendo(s))), []);
  useEffect(() => {
    const cambio = () => setEnLinea(navigator.onLine);
    window.addEventListener("online", cambio);
    window.addEventListener("offline", cambio);
    return () => {
      window.removeEventListener("online", cambio);
      window.removeEventListener("offline", cambio);
    };
  }, []);
  if (!lista.length) return null;
  const conError = lista.filter((p) => p.error);
  const esperando = lista.length - conError.length;
  return (
    <div className="space-y-2">
      {esperando > 0 && (
        <div className="flex items-center gap-3 rounded-2xl border border-naranja/40 bg-orange-50 px-4 py-3 text-sm text-stone-700">
          {enLinea ? <CloudUpload className="size-5 shrink-0 text-naranja" /> : <WifiOff className="size-5 shrink-0 text-naranja" />}
          <span className="flex-1">
            {enLinea ? (subiendo ? "Subiendo" : "Por subir") : "Sin señal:"} {esperando} {esperando === 1 ? "factura" : "facturas"}
            {!enLinea && " guardadas en el celular. Se suben solas cuando vuelva la conexión."}
          </span>
          {enLinea && !subiendo && (
            <button className="font-semibold text-naranja" onClick={() => void subirTodo()}>
              Reintentar
            </button>
          )}
        </div>
      )}
      {conError.map((p) => (
        <div key={p.clienteId} className="flex items-center gap-3 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <AlertTriangle className="size-5 shrink-0" />
          <span className="flex-1">No se pudo subir: {p.error}</span>
          <button className="font-semibold" onClick={() => void quitar(p.clienteId)}>
            Quitar
          </button>
        </div>
      ))}
    </div>
  );
}

function TarjetaLectura({ l, accion }: { l: Lectura; accion: ReturnType<typeof useAccion> }) {
  if (l.estado === "leyendo")
    return (
      <div className="tarjeta flex items-center gap-3 px-4 py-3">
        <Loader2 className="size-5 shrink-0 animate-spin text-naranja" />
        <span className="flex-1 text-sm text-stone-700">
          <b>Leyendo factura…</b> ({l.hojas} {l.hojas === 1 ? "hoja" : "hojas"})
          <span className="block text-xs text-stone-500">
            {l.autor && `Cargó ${l.autor} · `}
            {haceCuanto(l.creadoEn)}. Podés seguir cargando otras.
          </span>
        </span>
      </div>
    );
  const error = l.estado === "error";
  return (
    <div className={`rounded-2xl border px-4 py-3 text-sm ${error ? "border-red-200 bg-red-50 text-red-800" : "border-amber-200 bg-amber-50 text-amber-900"}`}>
      <div className="flex gap-2">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" />
        <span className="flex-1">{l.mensaje}</span>
      </div>
      <div className="mt-2 flex justify-end gap-2">
        {error && (
          <Boton chico icono={<RotateCcw className="size-3.5" />} onClick={() => void accion(() => post(`/api/c/lecturas/${l.id}/reintentar`))}>
            Reintentar
          </Boton>
        )}
        <Boton chico variante="fantasma" onClick={() => void accion(() => post(`/api/c/lecturas/${l.id}/cerrar`))}>
          {error ? "Descartar" : "Entendido"}
        </Boton>
      </div>
    </div>
  );
}

function VistaComprobante({ id, onCerrar }: { id: number; onCerrar: () => void }) {
  const { datos: c, recargar } = useVivo<Detalle>(`/api/c/compras/${id}`);
  const [visor, setVisor] = useState<string | null>(null);
  const [corrigiendo, setCorrigiendo] = useState(false);
  const [ocupado, setOcupado] = useState<string | null>(null);
  const accion = useAccion();
  const avisar = useAviso();
  const abierto = c && (c.estado === "pendiente" || c.estado === "revisar");

  const confirmar = async () => {
    setOcupado("conf");
    const r = await accion(() => post<{ envio: { ok: boolean; mensaje: string } | null }>(`/api/c/compras/${id}/confirmar`));
    setOcupado(null);
    if (!r) return;
    if (r.envio && !r.envio.ok) avisar(`Confirmada, pero no se pudo mandar al ERP: ${r.envio.mensaje}`, "error");
    else avisar(r.envio?.ok ? "Confirmada y enviada al ERP ✅" : "Confirmada ✅");
    onCerrar();
  };

  return (
    <div className="fixed inset-0 z-40 overflow-y-auto bg-[#faf5ee]">
      <div className="mx-auto max-w-xl pb-32">
        <header className="sticky top-0 z-10 flex items-center gap-2 bg-cafe px-2 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))] text-beige shadow-md">
          <button aria-label="Volver" onClick={onCerrar} className="rounded-lg p-1.5 hover:bg-white/10">
            <ChevronLeft className="size-6" />
          </button>
          <span className="min-w-0 flex-1 truncate font-semibold">{c ? c.proveedor || "Proveedor sin datos" : "Factura"}</span>
        </header>
        {!c ? (
          <div className="flex justify-center py-16">
            <Loader2 className="size-6 animate-spin text-naranja" />
          </div>
        ) : (
          <div className="space-y-4 px-4 pt-4">
            <div className="flex gap-2 overflow-x-auto">
              {c.archivos.length ? (
                c.archivos.map((a) =>
                  a.mime === "application/pdf" ? (
                    <a key={a.url} href={a.url} target="_blank" rel="noreferrer" className="flex h-36 w-28 shrink-0 flex-col items-center justify-center gap-1 rounded-xl border border-stone-200 bg-white text-xs text-stone-600">
                      <FileText className="size-8 text-red-500" /> Abrir PDF
                    </a>
                  ) : (
                    <button key={a.url} onClick={() => setVisor(a.url)} className="shrink-0">
                      <img src={a.url} alt="Factura" className="h-36 w-28 rounded-xl border border-stone-200 object-cover" />
                    </button>
                  ),
                )
              ) : (
                <p className="text-xs text-stone-500">{c.archivosBorrados ? "La foto ya se borró (se guarda unos días)." : "Sin foto."}</p>
              )}
            </div>

            <div className={`rounded-2xl border px-4 py-3 ${c.cierra ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-amber-200 bg-amber-50 text-amber-900"}`}>
              <div className="flex items-center gap-2 font-semibold">
                {c.cierra ? <CheckCircle2 className="size-5" /> : <AlertTriangle className="size-5" />}
                {c.cierra ? "Las cuentas cierran" : "Las cuentas no cierran"}
              </div>
              {!c.cierra && <p className="mt-1 text-sm">{c.diferencias}</p>}
            </div>
            {c.dudas.length > 0 && (
              <div className="tarjeta px-4 py-3 text-sm text-stone-700">
                <div className="mb-1 font-semibold">Dudas de la lectura</div>
                <ul className="list-disc space-y-0.5 pl-5">
                  {c.dudas.map((d) => (
                    <li key={d}>{d}</li>
                  ))}
                </ul>
              </div>
            )}

            <Resumen c={c} />

            {c.estado === "confirmado" && (
              <p className="text-center text-sm text-stone-500">
                Confirmada{c.enviadoEn ? " y enviada al ERP" : ""}.{c.envioError && !c.enviadoEn ? ` No se pudo mandar al ERP: ${c.envioError}` : ""}
              </p>
            )}
          </div>
        )}
      </div>

      {abierto && (
        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-stone-200 bg-white/95 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 backdrop-blur">
          <div className="mx-auto flex max-w-xl gap-2">
            <button
              aria-label="Descartar"
              disabled={!!ocupado}
              onClick={async () => {
                if (!confirm("¿Descartar esta factura?")) return;
                if (await accion(() => post(`/api/c/compras/${id}/descartar`), "Descartada")) onCerrar();
              }}
              className="rounded-2xl border border-red-200 px-4 text-red-600"
            >
              <Trash2 className="size-5" />
            </button>
            <button onClick={() => setCorrigiendo(true)} disabled={!!ocupado} className="flex flex-1 items-center justify-center gap-2 rounded-2xl border border-stone-300 py-3.5 font-semibold text-stone-700">
              <Pencil className="size-4" /> Corregir
            </button>
            <button onClick={() => void confirmar()} disabled={!!ocupado} className="flex flex-[1.4] items-center justify-center gap-2 rounded-2xl bg-cafe py-3.5 font-semibold text-beige disabled:opacity-60">
              {ocupado === "conf" ? <Loader2 className="size-5 animate-spin" /> : <Check className="size-5 text-naranja" />} Confirmar
            </button>
          </div>
        </div>
      )}

      {visor && <Visor url={visor} onCerrar={() => setVisor(null)} />}
      {corrigiendo && c && <Correccion c={c} onCerrar={() => setCorrigiendo(false)} onListo={() => (setCorrigiendo(false), void recargar())} />}
    </div>
  );
}

function Resumen({ c }: { c: Detalle }) {
  const d = c.datos;
  const m = String(d.encabezado.moneda || "PES");
  return (
    <>
      <section className="tarjeta grid grid-cols-2 gap-3 px-4 py-3 text-sm">
        <Dato t="Comprobante" v={c.titulo} />
        <Dato t="Fecha" v={fechaCorta(String(d.encabezado.fecha))} />
        <Dato t="Proveedor" v={c.proveedor || "—"} />
        <Dato t="CUIT" v={String(d.encabezado.cuitEmisor || "—")} />
      </section>
      <section className="tarjeta divide-y divide-stone-100">
        {d.renglones.map((r, i) => (
          <div key={i} className={`flex gap-3 px-4 py-2.5 text-sm ${r.cierra ? "" : "bg-amber-50"}`}>
            <span className="w-5 shrink-0 text-xs text-stone-400">{i + 1}</span>
            <span className="min-w-0 flex-1">
              <span className="block text-stone-800">{r.descripcion}</span>
              <span className="block text-xs text-stone-500">
                {r.cantidad} {r.unidad} × {plata(r.precioUnitario, m)}
                {r.descuentos.length ? ` − ${r.descuentos.join("+")}%` : ""}
              </span>
            </span>
            <span className="shrink-0 text-right font-medium tabular-nums">
              {plata(r.importe, m)}
              {!r.cierra && <AlertTriangle className="ml-auto mt-0.5 size-3.5 text-amber-600" />}
            </span>
          </div>
        ))}
      </section>
      <section className="tarjeta space-y-1 px-4 py-3 text-sm">
        {d.pie.subtotal > 0 && <Linea t="Subtotal" v={plata(d.pie.subtotal, m)} />}
        {d.pie.bonificacionImporte > 0 && <Linea t="Bonificación" v={`− ${plata(d.pie.bonificacionImporte, m)}`} />}
        {d.pie.ivas.map((x) => (
          <Linea key={`iva${x.alicuota}`} t={`IVA ${x.alicuota}%`} v={plata(x.importe, m)} />
        ))}
        {d.pie.impuestosInternos > 0 && <Linea t="Impuestos internos" v={plata(d.pie.impuestosInternos, m)} />}
        {d.pie.percepciones.map((x) => (
          <Linea key={x.nombre} t={x.nombre} v={plata(x.importe, m)} />
        ))}
        {d.pie.otrosImpuestos > 0 && <Linea t="Otros impuestos" v={plata(d.pie.otrosImpuestos, m)} />}
        <div className="flex justify-between border-t border-stone-200 pt-1.5 text-base font-bold text-stone-900">
          <span>Total</span>
          <span className="tabular-nums">{plata(d.pie.total, m)}</span>
        </div>
      </section>
    </>
  );
}

const Dato = ({ t, v }: { t: string; v: string }) => (
  <div className="min-w-0">
    <div className="etiqueta">{t}</div>
    <div className="break-words text-stone-800">{v}</div>
  </div>
);
const Linea = ({ t, v }: { t: string; v: string }) => (
  <div className="flex justify-between text-stone-600">
    <span>{t}</span>
    <span className="tabular-nums">{v}</span>
  </div>
);

/** Foto a pantalla completa: se toca para ampliar y se recorre con el dedo. */
function Visor({ url, onCerrar }: { url: string; onCerrar: () => void }) {
  const [grande, setGrande] = useState(false);
  return (
    <div className="fixed inset-0 z-50 overflow-auto bg-black">
      <button aria-label="Cerrar" onClick={onCerrar} className="fixed right-3 top-[max(0.75rem,env(safe-area-inset-top))] z-10 rounded-full bg-white/15 p-2 text-white">
        <X className="size-6" />
      </button>
      <img src={url} alt="Factura" onClick={() => setGrande(!grande)} className={grande ? "w-[250%] max-w-none" : "min-h-dvh w-full object-contain"} />
      {!grande && <p className="fixed inset-x-0 bottom-4 text-center text-xs text-white/60">Tocá la foto para ampliarla</p>}
    </div>
  );
}

/** Corregir: escribiendo (lo aplica la IA) o tocando los datos. */
function Correccion({ c, onCerrar, onListo }: { c: Detalle; onCerrar: () => void; onListo: () => void }) {
  const [modo, setModo] = useState<"escribir" | "editar">("escribir");
  const [texto, setTexto] = useState("");
  const [d, setD] = useState<ComprobanteDatos>(() => structuredClone(c.datos));
  const [guardando, setGuardando] = useState(false);
  const accion = useAccion();

  const enviar = async () => {
    setGuardando(true);
    const ok =
      modo === "escribir"
        ? await accion(() => post(`/api/c/compras/${c.id}/corregir`, { texto }), "Corregida")
        : await accion(() => put(`/api/c/compras/${c.id}`, { datos: d }), "Guardada");
    setGuardando(false);
    if (ok) onListo();
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-[#faf5ee]">
      <header className="flex items-center gap-2 bg-cafe px-2 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))] text-beige">
        <button aria-label="Cerrar" onClick={onCerrar} className="rounded-lg p-1.5">
          <X className="size-6" />
        </button>
        <span className="flex-1 font-semibold">Corregir</span>
      </header>
      <div className="mx-auto w-full max-w-xl flex-1 overflow-y-auto px-4 py-4">
        <div className="mb-4 grid grid-cols-2 gap-1 rounded-xl bg-stone-200/70 p-1 text-sm font-medium">
          {(["escribir", "editar"] as const).map((v) => (
            <button key={v} onClick={() => setModo(v)} className={`rounded-lg py-2 ${modo === v ? "bg-white shadow-sm" : "text-stone-500"}`}>
              {v === "escribir" ? "Escribir qué está mal" : "Editar los datos"}
            </button>
          ))}
        </div>
        {modo === "escribir" ? (
          <div className="space-y-2">
            <textarea
              className="campo min-h-36"
              autoFocus
              placeholder="Ej.: el renglón 3 son 12 unidades · el total es 15.300,50 · falta la percepción de IIBB de 896,90"
              value={texto}
              onChange={(e) => setTexto(e.target.value)}
            />
            <p className="text-xs text-stone-500">La IA vuelve a mirar la foto, aplica la corrección y rehace las cuentas.</p>
          </div>
        ) : (
          <Formulario d={d} setD={setD} />
        )}
      </div>
      <div className="border-t border-stone-200 bg-white px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3">
        <button
          onClick={() => void enviar()}
          disabled={guardando || (modo === "escribir" && texto.trim().length < 2)}
          className="mx-auto flex w-full max-w-xl items-center justify-center gap-2 rounded-2xl bg-cafe py-4 font-semibold text-beige disabled:opacity-50"
        >
          {guardando && <Loader2 className="size-5 animate-spin" />}
          {modo === "escribir" ? (guardando ? "Corrigiendo… (puede tardar un poco)" : "Corregir") : "Guardar cambios"}
        </button>
      </div>
    </div>
  );
}

/** "1.234,56", "1234.56" o "1234,56" → 1234.56. */
function aNumero(s: string): number {
  const t = s.replace(/[\s$]/g, "");
  if (!t) return 0;
  const n = t.includes(",") ? Number(t.replace(/\./g, "").replace(",", ".")) : Number(t);
  return Number.isFinite(n) ? n : 0;
}

function Numero({ valor, onChange, etiqueta }: { valor: number; onChange: (n: number) => void; etiqueta: string }) {
  const [texto, setTexto] = useState(String(valor).replace(".", ","));
  useEffect(() => setTexto(String(valor).replace(".", ",")), [valor]);
  return (
    <label className="block min-w-0">
      <span className="etiqueta">{etiqueta}</span>
      <input className="campo tabular-nums" inputMode="decimal" value={texto} onChange={(e) => setTexto(e.target.value)} onBlur={() => onChange(aNumero(texto))} />
    </label>
  );
}

function Texto({ valor, onChange, etiqueta, tipo = "text" }: { valor: string; onChange: (s: string) => void; etiqueta: string; tipo?: string }) {
  return (
    <label className="block min-w-0">
      <span className="etiqueta">{etiqueta}</span>
      <input className="campo" type={tipo} value={valor} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

function Grupo({ titulo, children }: { titulo: string; children: ReactNode }) {
  return (
    <section className="tarjeta space-y-3 p-4">
      <h3 className="font-semibold text-stone-800">{titulo}</h3>
      {children}
    </section>
  );
}

function Formulario({ d, setD }: { d: ComprobanteDatos; setD: (f: (d: ComprobanteDatos) => ComprobanteDatos) => void }) {
  const e = d.encabezado;
  const enc = (k: string, v: string | number) => setD((x) => ({ ...x, encabezado: { ...x.encabezado, [k]: v } }));
  const ren = (i: number, cambios: Partial<ComprobanteDatos["renglones"][number]>) =>
    setD((x) => ({ ...x, renglones: x.renglones.map((r, j) => (j === i ? { ...r, ...cambios } : r)) }));
  const pie = (cambios: Partial<ComprobanteDatos["pie"]>) => setD((x) => ({ ...x, pie: { ...x.pie, ...cambios } }));
  return (
    <div className="space-y-4 pb-4">
      <Grupo titulo="Comprobante">
        <Texto etiqueta="Proveedor" valor={String(e.razonSocialEmisor)} onChange={(v) => enc("razonSocialEmisor", v)} />
        <div className="grid grid-cols-2 gap-3">
          <Texto etiqueta="CUIT" valor={String(e.cuitEmisor)} onChange={(v) => enc("cuitEmisor", v)} />
          <Texto etiqueta="Fecha" tipo="date" valor={String(e.fecha)} onChange={(v) => enc("fecha", v)} />
          <label className="block">
            <span className="etiqueta">Tipo</span>
            <select className="campo" value={String(e.tipo)} onChange={(ev) => enc("tipo", ev.target.value)}>
              {[
                ["factura", "Factura"],
                ["nota_credito", "Nota de crédito"],
                ["nota_debito", "Nota de débito"],
                ["remito", "Remito"],
                ["liquidacion", "Liquidación"],
                ["ticket", "Ticket"],
                ["otro", "Otro"],
              ].map(([v, t]) => (
                <option key={v} value={v}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="etiqueta">Letra</span>
            <select className="campo" value={String(e.letra)} onChange={(ev) => enc("letra", ev.target.value)}>
              {["A", "B", "C", "M", "X", ""].map((l) => (
                <option key={l} value={l}>
                  {l || "—"}
                </option>
              ))}
            </select>
          </label>
          <Texto etiqueta="Punto de venta" valor={String(e.puntoVenta)} onChange={(v) => enc("puntoVenta", v)} />
          <Texto etiqueta="Número" valor={String(e.numero)} onChange={(v) => enc("numero", v)} />
        </div>
      </Grupo>

      {d.renglones.map((r, i) => (
        <Grupo key={i} titulo={`Renglón ${i + 1}`}>
          <Texto etiqueta="Descripción" valor={r.descripcion} onChange={(v) => ren(i, { descripcion: v })} />
          <div className="grid grid-cols-2 gap-3">
            <Numero etiqueta="Cantidad" valor={r.cantidad} onChange={(n) => ren(i, { cantidad: n })} />
            <Numero etiqueta="Precio unitario" valor={r.precioUnitario} onChange={(n) => ren(i, { precioUnitario: n })} />
            <Texto
              etiqueta="Descuentos % (ej. 10+5)"
              valor={r.descuentos.join("+")}
              onChange={(v) => ren(i, { descuentos: v.split("+").map((x) => aNumero(x)).filter((x) => x > 0) })}
            />
            <Numero etiqueta="Importe" valor={r.importe} onChange={(n) => ren(i, { importe: n })} />
          </div>
          <button className="flex items-center gap-1 text-xs font-medium text-red-600" onClick={() => setD((x) => ({ ...x, renglones: x.renglones.filter((_, j) => j !== i) }))}>
            <Trash2 className="size-3.5" /> Quitar renglón
          </button>
        </Grupo>
      ))}
      <button
        className="flex w-full items-center justify-center gap-1.5 rounded-xl border-2 border-dashed border-stone-300 py-3 text-sm font-medium text-stone-600"
        onClick={() =>
          setD((x) => ({
            ...x,
            renglones: [
              ...x.renglones,
              { clase: "mercaderia", codigo: "", descripcion: "", cantidad: 1, unidad: "UN", unidadesPorBulto: 0, precioUnitario: 0, descuentos: [], importe: 0, alicuotaIva: 0, cierra: true },
            ],
          }))
        }
      >
        <Plus className="size-4" /> Agregar renglón
      </button>

      <Grupo titulo="Totales">
        <div className="grid grid-cols-2 gap-3">
          <Numero etiqueta="Subtotal" valor={d.pie.subtotal} onChange={(n) => pie({ subtotal: n })} />
          <Numero etiqueta="Bonificación $" valor={d.pie.bonificacionImporte} onChange={(n) => pie({ bonificacionImporte: n })} />
          <Numero etiqueta="Impuestos internos" valor={d.pie.impuestosInternos} onChange={(n) => pie({ impuestosInternos: n })} />
          <Numero etiqueta="Otros impuestos" valor={d.pie.otrosImpuestos} onChange={(n) => pie({ otrosImpuestos: n })} />
        </div>
        {d.pie.ivas.map((x, i) => (
          <div key={`iva${i}`} className="grid grid-cols-2 gap-3">
            <Numero etiqueta="IVA %" valor={x.alicuota} onChange={(n) => pie({ ivas: d.pie.ivas.map((y, j) => (j === i ? { ...y, alicuota: n } : y)) })} />
            <Numero etiqueta={`Importe IVA ${x.alicuota}%`} valor={x.importe} onChange={(n) => pie({ ivas: d.pie.ivas.map((y, j) => (j === i ? { ...y, importe: n } : y)) })} />
          </div>
        ))}
        <button className="text-xs font-medium text-naranja" onClick={() => pie({ ivas: [...d.pie.ivas, { alicuota: 21, importe: 0 }] })}>
          + Agregar IVA
        </button>
        {d.pie.percepciones.map((x, i) => (
          <div key={`per${i}`} className="grid grid-cols-2 gap-3">
            <Texto etiqueta="Percepción" valor={x.nombre} onChange={(v) => pie({ percepciones: d.pie.percepciones.map((y, j) => (j === i ? { ...y, nombre: v } : y)) })} />
            <Numero etiqueta="Importe" valor={x.importe} onChange={(n) => pie({ percepciones: d.pie.percepciones.map((y, j) => (j === i ? { ...y, importe: n } : y)) })} />
          </div>
        ))}
        <button className="text-xs font-medium text-naranja" onClick={() => pie({ percepciones: [...d.pie.percepciones, { nombre: "Percepción IIBB", tipo: "iibb", alicuota: 0, importe: 0 }] })}>
          + Agregar percepción
        </button>
        <Numero etiqueta="Total" valor={d.pie.total} onChange={(n) => pie({ total: n })} />
      </Grupo>
      <p className="text-xs text-stone-500">Al guardar se rehacen las cuentas para ver si cierran.</p>
    </div>
  );
}
