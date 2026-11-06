import { useEffect, useState } from "react";
import { BarChart3, Loader2, LogOut, Package, Receipt, Settings, Upload } from "lucide-react";
import { get, post } from "../lib/api";
import { Cargar } from "./Cargar";
import { escuchar, iniciarCola } from "./cola";
import { useAncho, useRecordado, useVivo, type Destino } from "./comun";
import { Configuracion } from "./Configuracion";
import { Facturas } from "./Facturas";
import { Metricas } from "./Metricas";
import { Productos } from "./Productos";

type Marca = { nombre: string; logo: string | null };
/** El ícono de la app (con el logo), tal como lo pone el servidor en la página. */
const ICONO = document.querySelector<HTMLLinkElement>('link[rel="apple-touch-icon"]')?.href;
/** metricas: si puede ver Métricas. */
type Sesion = { nombre: string; metricas: boolean };

export function AppCompras() {
  const [sesion, setSesion] = useState<Sesion | false | null>(null);
  const [marca, setMarca] = useState<Marca>({ nombre: "Compras Coffit", logo: null });
  useEffect(() => {
    void get<Marca>("/api/c/marca").then(setMarca).catch(() => {});
    get<Sesion>("/api/c/yo")
      .then(setSesion)
      .catch(() => setSesion(false));
    const vencida = () => setSesion(false);
    window.addEventListener("sesion-vencida", vencida);
    return () => window.removeEventListener("sesion-vencida", vencida);
  }, []);
  // Mientras abre: el ícono de la app sobre café.
  if (sesion === null)
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-cafe">
        {ICONO && <img src={ICONO} alt="" className="size-24 rounded-3xl shadow-lg" />}
        <Loader2 className="size-6 animate-spin text-naranja" />
      </div>
    );
  if (!sesion) return <Ingreso marca={marca} onEntrar={setSesion} />;
  return <Principal marca={marca} sesion={sesion} onSalir={() => setSesion(false)} />;
}

function Logo({ marca, chico }: { marca: Marca; chico?: boolean }) {
  if (marca.logo) return <img src={marca.logo} alt="Coffit" className={chico ? "inline-block h-8 w-auto max-w-full object-contain lg:max-w-32" : "mx-auto h-20 w-auto max-w-56 object-contain"} />;
  return <span className={`font-black tracking-tight ${chico ? "text-xl" : "text-4xl"}`}>Coffit</span>;
}

function Ingreso({ marca, onEntrar }: { marca: Marca; onEntrar: (s: Sesion) => void }) {
  const [clave, setClave] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [entrando, setEntrando] = useState(false);
  const entrar = async () => {
    setEntrando(true);
    setError(null);
    try {
      onEntrar(await post<Sesion>("/api/c/ingresar", { clave }));
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

const PESTANA = "compras-pestana";
const PESTANAS = [
  ["cargar", "Cargar", Upload],
  ["facturas", "Facturas", Receipt],
  ["productos", "Productos", Package],
  ["metricas", "Métricas", BarChart3],
  // Con guion opcional: en la barra angosta de la tablet se corta en dos renglones.
  ["configuracion", "Configu\u00ADración", Settings],
] as const;

type Pestana = (typeof PESTANAS)[number][0];

/** El numerito de una pestaña: sobre el ícono, o al final del renglón en la barra ancha (className). */
function Aviso({ n, className = "absolute -right-2.5 -top-1.5" }: { n?: number; className?: string }) {
  if (!n) return null;
  return (
    <span className={`${className} min-w-4 rounded-full bg-naranja px-1 text-center text-[10px] font-bold leading-4 text-white ring-2 ring-white`}>
      {n > 99 ? "99+" : n}
    </span>
  );
}

/**
 * Celular: barra arriba con el logo y pestañas abajo, al alcance del pulgar, con Cargar en el medio.
 * Compu y tablet: barra lateral.
 */
function Principal({ marca, sesion: { nombre, metricas }, onSalir }: { marca: Marca; sesion: Sesion; onSalir: () => void }) {
  const ancho = useAncho();
  const pestanas = PESTANAS.filter(([v]) => v !== "metricas" || metricas);
  const [pestana, elegir] = useRecordado(PESTANA, pestanas.map(([v]) => v));
  // Un toque en Métricas abre otra pestaña con un filtro o una ficha; "vez" la vuelve a montar con eso.
  const [destino, setDestino] = useState<{ d: Destino; vez: number } | null>(null);
  const ir = (d: Destino) => {
    setDestino((x) => ({ d, vez: (x?.vez ?? 0) + 1 }));
    elegir(d.pestana);
  };
  const abrir = (p: Pestana) => {
    setDestino(null);
    elegir(p);
  };
  const d = destino?.d;
  // Las fotos sin subir se siguen subiendo aunque se esté en otra pestaña.
  useEffect(() => iniciarCola(), []);
  // Avisos: facturas para revisar, y lo que se está leyendo o espera señal.
  const { datos: cuentas } = useVivo<{ paraRevisar: number; leyendo: number }>("/api/c/contadores");
  const [enCola, setEnCola] = useState(0);
  useEffect(() => escuchar((p) => setEnCola(p.length)), []);
  const avisos: Partial<Record<Pestana, number>> = { cargar: (cuentas?.leyendo ?? 0) + enCola, facturas: cuentas?.paraRevisar };
  const salir = async () => {
    await post("/api/c/salir").catch(() => {});
    onSalir();
  };
  const contenido = {
    cargar: <Cargar key={destino?.vez} ancho={ancho} archivos={d?.pestana === "cargar" ? d.archivos : undefined} ir={ir} />,
    facturas: <Facturas key={destino?.vez} ancho={ancho} inicial={d?.pestana === "facturas" ? d : undefined} ir={ir} />,
    productos: <Productos key={destino?.vez} ancho={ancho} inicial={d?.pestana === "productos" ? d : undefined} />,
    metricas: <Metricas ancho={ancho} ir={ir} />,
    configuracion: <Configuracion key={destino?.vez} ancho={ancho} proveedorId={d?.pestana === "configuracion" ? d.proveedorId : undefined} />,
  }[pestana];

  if (ancho === "movil") {
    const otras = pestanas.filter(([v]) => v !== "cargar");
    const medio = Math.ceil(otras.length / 2);
    const botonDeAbajo = ([v, t, Icono]: (typeof pestanas)[number]) => (
      <button
        key={v}
        onClick={() => abrir(v)}
        className={`flex min-w-0 flex-1 flex-col items-center gap-0.5 py-2.5 text-[11px] font-semibold ${pestana === v ? "text-cafe" : "text-stone-400"}`}
      >
        <span className={`relative rounded-full px-4 py-1 ${pestana === v ? "bg-marca-suave text-naranja" : ""}`}>
          <Icono className="size-5" />
          <Aviso n={avisos[v]} />
        </span>
        {t}
      </button>
    );
    return (
      <div className="min-h-dvh pb-[calc(4.5rem+env(safe-area-inset-bottom))]">
        <header className="sticky top-0 z-20 flex items-center gap-3 bg-cafe px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))] text-beige shadow-md">
          <Logo marca={marca} chico />
          <span className="text-xs font-semibold uppercase tracking-[0.2em] text-naranja">Compras</span>
          <span className="ml-auto truncate text-sm text-beige/80">{nombre}</span>
          <button aria-label="Salir" className="rounded-lg p-1.5 text-beige/70 hover:bg-white/10" onClick={() => void salir()}>
            <LogOut className="size-5" />
          </button>
        </header>
        <main className="px-4 pt-4">{contenido}</main>
        <nav className="fixed inset-x-0 bottom-0 z-30 flex items-end border-t border-stone-200 bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur">
          {otras.slice(0, medio).map(botonDeAbajo)}
          {/* Cargar, el botón grande del medio. */}
          <button
            onClick={() => abrir("cargar")}
            className={`flex flex-1 flex-col items-center gap-0.5 pb-2.5 text-[11px] font-semibold ${pestana === "cargar" ? "text-cafe" : "text-stone-500"}`}
          >
            <span className="relative -mt-6 flex size-14 items-center justify-center rounded-full bg-naranja text-white shadow-lg ring-4 ring-white">
              <Upload className="size-6" />
              <Aviso n={avisos.cargar} />
            </span>
            Cargar
          </button>
          {otras.slice(medio).map(botonDeAbajo)}
        </nav>
      </div>
    );
  }

  return (
    <div className="min-h-dvh pl-20 lg:pl-60">
      {/* En tablet la barra es angosta (solo íconos); desde 1024 px lleva los nombres. */}
      <aside className="fixed inset-y-0 left-0 z-30 flex w-20 flex-col bg-cafe px-3 py-5 text-beige lg:w-60 lg:px-4">
        <div className="text-center lg:px-2 lg:text-left">
          <Logo marca={marca} chico />
          <div className="mt-1 hidden text-xs font-semibold uppercase tracking-[0.2em] text-naranja lg:block">Compras</div>
        </div>
        <nav className="mt-8 space-y-1">
          {pestanas.map(([v, t, Icono]) => (
            <button
              key={v}
              onClick={() => abrir(v)}
              title={t}
              className={`flex w-full flex-col items-center gap-1 rounded-xl px-2 py-2.5 text-[11px] font-semibold transition lg:flex-row lg:gap-3 lg:px-3 lg:text-sm ${pestana === v ? "bg-white/10 text-white shadow-[inset_3px_0_0_var(--color-naranja)]" : "text-beige/70 hover:bg-white/5 hover:text-white"}`}
            >
              <span className="relative">
                <Icono className={`size-5 ${pestana === v ? "text-naranja" : ""}`} />
                <Aviso n={avisos[v]} className="absolute -right-2.5 -top-1.5 lg:hidden" />
              </span>
              {t}
              <Aviso n={avisos[v]} className="ml-auto hidden lg:inline" />
            </button>
          ))}
        </nav>
        <div className="mt-auto flex flex-col items-center gap-2 rounded-xl bg-white/5 px-2 py-2.5 lg:flex-row lg:px-3">
          <span title={nombre} className="flex size-8 shrink-0 items-center justify-center rounded-full bg-naranja text-sm font-bold text-white">
            {nombre.charAt(0).toUpperCase()}
          </span>
          <span className="hidden min-w-0 flex-1 truncate text-sm lg:block">{nombre}</span>
          <button aria-label="Salir" title="Salir" className="rounded-lg p-1.5 text-beige/70 hover:bg-white/10 hover:text-white" onClick={() => void salir()}>
            <LogOut className="size-4" />
          </button>
        </div>
      </aside>
      {/* En la compu la pantalla no se desplaza: la lista y el detalle tienen su propio desplazamiento. */}
      <main className={ancho === "pc" ? "h-dvh overflow-hidden p-6" : "p-5"}>{contenido}</main>
    </div>
  );
}
