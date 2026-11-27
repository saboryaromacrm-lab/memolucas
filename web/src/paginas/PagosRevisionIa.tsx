import { useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, Pencil, Plus } from "lucide-react";
import { Boton, Modal, useAccion } from "../componentes/ui";
import { post, put } from "../lib/api";
import { aCampo, aNumero, plata } from "../lib/numeros";
import { agrupar, describirAlcance, FRECUENCIAS_PAGO, grupoDeAlcance, nombreMes } from "../lib/pagos";
import { sinTildes } from "../lib/textos";
import type { AlcancePago, CampoFijo, ConfigPagos, FijoPago, FijoPropuesto, RepartoPago, TipoLugar } from "../lib/tipos";
import { ModalFijo } from "./PagosFijo";

// La revisión de lo que propone la IA de Pagos (en Configuración y en «Cargar con IA» del mes): el mes, cada renglón
// con todos sus datos y cómo figuraba, editarlo con el formulario completo, avisos de duplicados, agregar a mano, el
// resumen por lugar contra el total de la imagen y, al aplicar, recordar las correcciones para la próxima.

/** A qué pago va un monto: al de un concepto de todos los meses o a un pago puntual del mes leído. */
export type Destino = { fijoId: number } | { itemId: number; nombre: string; lugar: string };

export type FilaIa =
  /** ia: lo que propuso la IA (null si lo agregaste a mano): para saber qué corregiste. */
  | { tipo: "nuevo"; fijo: FijoPropuesto; ia: FijoPropuesto | null }
  | { tipo: "cambio"; antes: FijoPago; fijo: FijoPropuesto; ia: FijoPropuesto }
  | { tipo: "borrar"; antes: FijoPago }
  | { tipo: "monto"; destino: Destino; monto: number; antes: number | null; pagado: boolean; original: string; ia: Destino | null };
/** pagadoCon: ya está pagado con esa forma («Lo pagó: Contadora»): al aplicar queda pagado. */
type Fila = FilaIa & { clave: number; elegido: boolean; pagadoCon?: number };

type Alcanzable = { alcance: AlcancePago; lugarId: number | null; tipo: TipoLugar | null; reparto: RepartoPago | null; lugarNuevo?: { nombre: string } };

export const CAMPOS_FIJO: CampoFijo[] = ["nombre", "alcance", "categoria", "monto", "variable", "moneda", "vence", "aviso", "frecuencia", "forma", "cuenta", "nota"];
const ETIQUETA_CAMPO: Record<CampoFijo, string> = {
  nombre: "Nombre",
  alcance: "A qué corresponde",
  categoria: "Categoría",
  monto: "Monto",
  variable: "Tipo de monto",
  moneda: "Moneda",
  vence: "Vencimiento",
  aviso: "Aviso",
  frecuencia: "Frecuencia",
  forma: "Forma de pago",
  cuenta: "Cuenta",
  nota: "Nota",
};
const INSIGNIA: Record<Fila["tipo"], [string, string]> = {
  nuevo: ["Nuevo", "bg-emerald-100 text-emerald-800"],
  cambio: ["Cambia", "bg-sky-100 text-sky-800"],
  borrar: ["Borrar", "bg-red-100 text-red-700"],
  monto: ["Monto", "bg-sky-100 text-sky-800"],
};

export const comoPropuesta = ({ id: _, desde: __, ...f }: FijoPago): FijoPropuesto => f;
const claveAlcance = (a: Alcanzable) =>
  a.lugarNuevo ? `n:${sinTildes(a.lugarNuevo.nombre)}` : a.alcance === "lugar" ? `l:${a.lugarId}` : a.alcance === "general" ? `g:${a.tipo}` : `r:${(a.reparto ?? []).map((r) => r.lugarId).sort().join(",")}`;
const mismoCampo = (a: FijoPropuesto, b: FijoPropuesto, c: CampoFijo) => {
  if (c === "alcance") return claveAlcance(a) === claveAlcance(b) && JSON.stringify(a.reparto) === JSON.stringify(b.reparto);
  const k = c === "vence" ? "dia" : c === "aviso" ? "avisoDias" : c === "forma" ? "formaId" : c;
  return a[k] === b[k];
};
/** Qué cambia entre dos versiones de un pago. */
export const camposCambiados = (a: FijoPropuesto, b: FijoPropuesto) => CAMPOS_FIJO.filter((c) => !mismoCampo(a, b, c));

export function RevisionIa({
  modo,
  config,
  filas: iniciales,
  periodo: periodoInicial,
  periodoLeido,
  totalImagen,
  mensaje,
  onCerrar,
  onListo,
}: {
  /** config: arma y cambia lo de todos los meses. mes: carga los montos de un mes. */
  modo: "config" | "mes";
  config: ConfigPagos;
  filas: FilaIa[];
  periodo: string;
  /** El mes que se leyó (los pagos puntuales de ese mes solo valen en ese mes). */
  periodoLeido?: string;
  totalImagen: number | null;
  mensaje: string;
  onCerrar: () => void;
  onListo: () => void;
}) {
  const [periodo, setPeriodo] = useState(periodoInicial);
  const [filas, setFilas] = useState<Fila[]>(() => iniciales.map((f, k) => ({ ...f, clave: k, elegido: f.tipo !== "borrar" })));
  const [editando, setEditando] = useState<{ clave: number | null; inicial?: FijoPropuesto } | null>(null);
  const [recordar, setRecordar] = useState<string | null>(null);
  const [plegados, setPlegados] = useState<Set<string>>(new Set());
  const accion = useAccion();
  const siguiente = Math.max(0, ...filas.map((f) => f.clave)) + 1;
  // Quienes pagan cosas por vos (Cuentas): en el mes se puede marcar que ya lo pagaron.
  const terceros = modo === "mes" ? config.formas.filter((f) => f.tipo === "tercero" && !f.archivada) : [];

  const alcTexto = (a: Alcanzable) => (a.lugarNuevo ? a.lugarNuevo.nombre : describirAlcance(a, config.lugares));
  const fijoDe = (id: number) => config.fijos.find((f) => f.id === id);
  const nombreDestino = (d: Destino) => {
    if ("itemId" in d) return `${d.nombre} · ${d.lugar}`;
    const f = fijoDe(d.fijoId);
    return f ? `${f.nombre} · ${alcTexto(f)}` : "Pago borrado";
  };
  /** Un pago puntual (no de todos los meses) solo se puede cargar en el mes leído. */
  const fueraDeMes = (f: Fila) => f.tipo === "monto" && "itemId" in f.destino && periodo !== periodoLeido;
  const valeAplicar = (f: Fila) => f.elegido && !fueraDeMes(f) && !(f.tipo === "monto" && "fijoId" in f.destino && !fijoDe(f.destino.fijoId));
  const aplicables = filas.filter(valeAplicar);
  const parecido = (f: FijoPropuesto) => config.fijos.find((x) => sinTildes(x.nombre) === sinTildes(f.nombre) && claveAlcance(x) === claveAlcance(f));
  const detalle = (f: FijoPropuesto) =>
    [
      f.categoria,
      f.monto ? `${f.variable ? "~ " : ""}${plata(f.monto, f.moneda)}` : "sin monto",
      f.variable ? "variable" : "fijo",
      f.dia ? `vence el ${f.dia}` : "sin vencimiento",
      FRECUENCIAS_PAGO[f.frecuencia].toLowerCase(),
      config.formas.find((x) => x.id === f.formaId)?.nombre,
      f.cuenta,
      f.nota,
    ]
      .filter(Boolean)
      .join(" · ");
  const valorCampo = (c: CampoFijo, f: FijoPropuesto) =>
    ({
      nombre: f.nombre,
      alcance: alcTexto(f) + (f.lugarNuevo ? " (lugar nuevo)" : ""),
      categoria: f.categoria,
      monto: f.monto ? plata(f.monto, f.moneda) : "sin monto",
      variable: f.variable ? "cambia mes a mes" : "fijo",
      moneda: f.moneda === "USD" ? "dólares" : "pesos",
      vence: f.dia ? `día ${f.dia}` : "sin vencimiento",
      aviso: f.avisoDias === null ? `${config.diasAviso} días antes` : f.avisoDias < 0 ? "no avisar" : f.avisoDias === 0 ? "el día que vence" : `${f.avisoDias} días antes`,
      frecuencia: FRECUENCIAS_PAGO[f.frecuencia].toLowerCase(),
      forma: config.formas.find((x) => x.id === f.formaId)?.nombre ?? "sin forma fija",
      cuenta: f.cuenta,
      nota: f.nota,
    })[c] || "—";

  const cambiar = (clave: number, cambio: (f: Fila) => Fila) => setFilas((fs) => fs.map((f) => (f.clave === clave ? cambio(f) : f)));
  const todos = (elegido: boolean) => setFilas((fs) => fs.map((f) => ({ ...f, elegido })));

  /** Lo que se guarda del formulario: corrige un renglón o agrega uno nuevo. */
  const alGuardarFormulario = (fijo: FijoPropuesto) => {
    const clave = editando?.clave ?? null;
    if (clave === null) return setFilas((fs) => [...fs, { tipo: "nuevo", fijo, ia: null, clave: siguiente, elegido: true }]);
    cambiar(clave, (f) => (f.tipo === "nuevo" || f.tipo === "cambio" ? { ...f, fijo } : f.tipo === "monto" ? { tipo: "nuevo", fijo, ia: null, clave: f.clave, elegido: true, pagadoCon: f.pagadoCon } : f));
  };
  /** «Usar ese»: en vez de crear un duplicado, va al que ya tenés. */
  const usarExistente = (fila: Fila & { tipo: "nuevo" }, existente: FijoPago) =>
    cambiar(fila.clave, () =>
      modo === "mes"
        ? { tipo: "monto", destino: { fijoId: existente.id }, monto: fila.fijo.monto, antes: null, pagado: false, original: fila.fijo.original ?? fila.fijo.nombre, ia: null, clave: fila.clave, elegido: true, pagadoCon: fila.pagadoCon }
        : { tipo: "cambio", antes: existente, fijo: { ...comoPropuesta(existente), monto: fila.fijo.monto }, ia: comoPropuesta(existente), clave: fila.clave, elegido: true },
    );
  /** «Es un pago nuevo»: el monto deja de ir a un pago que ya tenés y se arma uno nuevo (se abre el formulario). */
  const pasarANuevo = (fila: Fila & { tipo: "monto" }) =>
    setEditando({
      clave: fila.clave,
      inicial: {
        alcance: "general",
        lugarId: null,
        tipo: "negocio",
        reparto: null,
        nombre: fila.original || nombreDestino(fila.destino).split(" · ")[0],
        categoria: "Impuestos y tasas",
        monto: fila.monto,
        variable: true,
        moneda: "ARS",
        dia: null,
        frecuencia: "mensual",
        formaId: null,
        cuenta: "",
        avisoDias: null,
        nota: "",
        ...(fila.original ? { original: fila.original } : {}),
      },
    });

  // Lo que suma lo elegido, en total y por lugar (un repartido suma su parte en cada uno).
  const montoDe = (f: Fila) => (f.tipo === "monto" ? f.monto : f.tipo === "nuevo" ? f.fijo.monto : f.tipo === "cambio" && !mismoCampo(f.antes, f.fijo, "monto") ? f.fijo.monto : 0);
  const porLugar = new Map<string, number>();
  const sumar = (nombre: string, monto: number) => porLugar.set(nombre, (porLugar.get(nombre) ?? 0) + monto);
  for (const f of aplicables) {
    const monto = montoDe(f);
    if (!monto) continue;
    const a: Alcanzable | null = f.tipo === "monto" ? ("fijoId" in f.destino ? (fijoDe(f.destino.fijoId) ?? null) : null) : f.tipo === "borrar" ? null : f.fijo;
    if (!a) sumar(f.tipo === "monto" && "itemId" in f.destino ? f.destino.lugar : "Otros", monto);
    else if (a.alcance === "repartido" && a.reparto?.length) {
      const iguales = a.reparto.every((r) => r.porcentaje === null);
      for (const r of a.reparto) sumar(config.lugares.find((l) => l.id === r.lugarId)?.nombre ?? "Lugar borrado", (monto * (iguales ? 100 / a.reparto.length : (r.porcentaje ?? 0))) / 100);
    } else sumar(a.alcance === "general" ? `General · ${a.tipo ?? "personal"}` : alcTexto(a), monto);
  }
  const total = [...porLugar.values()].reduce((s, x) => s + x, 0);

  /** Lo que corregiste, en palabras, para que la IA lo tenga en cuenta la próxima. */
  const correcciones = () =>
    aplicables.flatMap((f) => {
      if (f.tipo === "monto") return f.ia && JSON.stringify(f.ia) !== JSON.stringify(f.destino) && f.original ? [`«${f.original}» es «${nombreDestino(f.destino)}».`] : [];
      if (f.tipo === "borrar") return [];
      if (!f.ia) return f.fijo.original ? [`«${f.fijo.original}» es un pago aparte: «${f.fijo.nombre}» (${alcTexto(f.fijo)}).`] : [];
      const ia = f.ia;
      const partes = camposCambiados(ia, f.fijo).flatMap((c) => {
        const n = f.fijo;
        if (c === "nombre") return [`se llama «${n.nombre}»`];
        if (c === "alcance") return [`va en ${alcTexto(n)}`];
        if (c === "categoria") return [`es de la categoría ${n.categoria}`];
        if (c === "vence") return [n.dia ? `vence el día ${n.dia}` : "no tiene vencimiento"];
        if (c === "variable") return [n.variable ? "su monto cambia cada mes" : "su monto es fijo"];
        if (c === "frecuencia") return [`se paga ${FRECUENCIAS_PAGO[n.frecuencia].toLowerCase()}`];
        if (c === "forma") return [n.formaId ? `se paga con ${valorCampo("forma", n)}` : "no tiene forma de pago fija"];
        return [];
      });
      return partes.length ? [`«${f.fijo.original ?? ia.nombre}»: ${partes.join(", ")}.`] : [];
    });

  const aplicar = async () => {
    const elegidas = aplicables;
    const ok =
      modo === "config"
        ? await accion(
            () =>
              post("/api/pagos/fijos/aplicar", {
                nuevos: elegidas.flatMap((f) => (f.tipo === "nuevo" ? [{ ...f.fijo, desde: periodo }] : [])),
                cambios: elegidas.flatMap((f) => (f.tipo === "cambio" ? [{ id: f.antes.id, ...f.fijo }] : [])),
                borrar: elegidas.flatMap((f) => (f.tipo === "borrar" ? [f.antes.id] : [])),
              }),
            `Listo: ${elegidas.length} ${elegidas.length === 1 ? "cambio aplicado" : "cambios aplicados"}`,
          )
        : await accion(
            () =>
              post("/api/pagos/mes/aplicar", {
                periodo,
                montos: elegidas.flatMap((f) =>
                  f.tipo === "monto" && (f.monto !== f.antes || f.pagadoCon)
                    ? [{ ...("fijoId" in f.destino ? { fijoId: f.destino.fijoId } : { itemId: f.destino.itemId }), monto: f.monto, ...(f.pagadoCon ? { pagadoCon: f.pagadoCon } : {}) }]
                    : [],
                ),
                nuevos: elegidas.flatMap((f) => (f.tipo === "nuevo" ? [{ ...f.fijo, ...(f.pagadoCon ? { pagadoCon: f.pagadoCon } : {}) }] : [])),
              }),
            `Listo: cargado en ${nombreMes(periodo).toLowerCase()}`,
          );
    if (!ok) return;
    const lineas = correcciones();
    if (lineas.length) setRecordar(lineas.join("\n"));
    else onListo();
  };

  // Agrupado por a qué corresponde (los lugares en tu orden, después repartidos y general) y adentro por categoría.
  const alcanceDe = (f: Fila): Alcanzable | null =>
    f.tipo === "monto" ? ("fijoId" in f.destino ? (fijoDe(f.destino.fijoId) ?? null) : null) : f.tipo === "borrar" ? f.antes : f.fijo;
  const grupoDeFila = (f: Fila) => {
    const a = alcanceDe(f);
    if (a) return grupoDeAlcance(a, config.lugares);
    const lugar = f.tipo === "monto" && "itemId" in f.destino ? f.destino.lugar : "Otros";
    return { clave: `i:${lugar}`, titulo: lugar, orden: 950 };
  };
  const categoriaDe = (f: Fila) =>
    f.tipo === "monto" ? ("fijoId" in f.destino ? (fijoDe(f.destino.fijoId)?.categoria ?? "Sin categoría") : "Sin categoría") : f.tipo === "borrar" ? f.antes.categoria : f.fijo.categoria;
  const plegar = (clave: string) => setPlegados((p) => (p.has(clave) ? new Set([...p].filter((x) => x !== clave)) : new Set([...p, clave])));

  const renglon = (f: Fila) => {
    const [insignia, color] = INSIGNIA[f.tipo];
    const fuera = fueraDeMes(f);
    const dup = f.tipo === "nuevo" ? parecido(f.fijo) : undefined;
    const original = f.tipo === "monto" ? f.original : f.tipo === "borrar" ? "" : (f.fijo.original ?? "");
    return (
      <li key={f.clave} className={`flex items-start gap-3 px-3 py-2.5 text-sm ${fuera ? "opacity-60" : ""}`}>
        <input
          type="checkbox"
          className="mt-1 size-4 accent-marca-oscuro"
          checked={f.elegido && !fuera}
          disabled={fuera}
          onChange={(e) => cambiar(f.clave, (x) => ({ ...x, elegido: e.target.checked }))}
          aria-label={`${insignia}: ${f.tipo === "monto" ? nombreDestino(f.destino) : f.tipo === "borrar" ? f.antes.nombre : f.fijo.nombre}`}
        />
        <div className="min-w-0 flex-1 space-y-0.5">
          {f.tipo === "monto" ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${color}`}>{insignia}</span>
              <select
                className="campo order-last h-9 min-w-0 basis-full py-0 text-sm sm:order-none sm:basis-0 sm:flex-1"
                value={"fijoId" in f.destino ? `f:${f.destino.fijoId}` : `i:${f.destino.itemId}`}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === "nuevo") return pasarANuevo(f);
                  cambiar(f.clave, (x) => (x.tipo === "monto" ? { ...x, destino: v.startsWith("f:") ? { fijoId: Number(v.slice(2)) } : x.destino, antes: null } : x));
                }}
                aria-label="A qué pago va"
              >
                {"itemId" in f.destino && <option value={`i:${f.destino.itemId}`}>{nombreDestino(f.destino)}</option>}
                {[...config.fijos]
                  .sort((a, b) => a.nombre.localeCompare(b.nombre))
                  .map((x) => (
                    <option key={x.id} value={`f:${x.id}`}>
                      {x.nombre} · {alcTexto(x)}
                    </option>
                  ))}
                <option value="nuevo">➕ Es un pago nuevo…</option>
              </select>
              <input
                className="campo h-9 min-w-0 flex-1 py-0 text-right tabular-nums sm:w-36 sm:flex-none"
                inputMode="decimal"
                defaultValue={aCampo(f.monto, true)}
                onBlur={(e) => {
                  const n = aNumero(e.target.value);
                  if (n !== null) cambiar(f.clave, (x) => (x.tipo === "monto" ? { ...x, monto: n } : x));
                }}
                aria-label="Monto"
              />
            </div>
          ) : (
            <div className="font-medium text-slate-900">
              <span className={`mr-1.5 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${color}`}>{insignia}</span>
              {/* El lugar está en el encabezado del grupo. */}
              {f.tipo === "nuevo" ? f.fijo.nombre : f.antes.nombre}
              {f.tipo === "nuevo" && f.fijo.lugarNuevo && <span className="ml-1.5 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-amber-800">Lugar nuevo</span>}
            </div>
          )}

          {f.tipo === "nuevo" && <div className="text-xs text-slate-500">{detalle(f.fijo)}</div>}
          {f.tipo === "cambio" &&
            camposCambiados(f.antes, f.fijo).map((c) => (
              <div key={c} className="text-xs text-slate-500">
                {ETIQUETA_CAMPO[c]}: <span className="text-slate-400 line-through">{valorCampo(c, comoPropuesta(f.antes))}</span> → <span className="font-medium text-slate-800">{valorCampo(c, f.fijo)}</span>
              </div>
            ))}
          {f.tipo === "borrar" && <div className="text-xs text-red-600">Se borra con sus pagos pendientes; lo pagado queda en el historial.</div>}
          {f.tipo === "monto" && (
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
              {f.antes !== null && periodo === periodoLeido && (f.antes === f.monto ? <span>Ya tenía ese monto (sin cambios)</span> : <span>Antes: {plata(f.antes)}</span>)}
              {f.pagado && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-amber-800">Ya pagado</span>}
              {fuera && <span className="text-amber-700">Es un pago puntual de {nombreMes(periodoLeido!).toLowerCase()}: no se puede cargar en otro mes.</span>}
            </div>
          )}
          {original && (
            <div className="text-xs text-slate-400">
              En la imagen: «{original}»{f.tipo === "nuevo" && f.ia ? ` ${plata(f.ia.monto, f.ia.moneda)}` : ""}
            </div>
          )}
          {terceros.length > 0 && (f.tipo === "monto" || f.tipo === "nuevo") && !(f.tipo === "monto" && f.pagado) && (
            <label className="flex flex-wrap items-center gap-1.5 text-xs text-slate-600">
              Ya lo pagó:
              <select
                className="campo h-8 w-auto py-0 text-xs"
                value={f.pagadoCon ?? ""}
                onChange={(e) => cambiar(f.clave, (x) => ({ ...x, pagadoCon: e.target.value ? Number(e.target.value) : undefined }))}
                aria-label="Ya lo pagó"
              >
                <option value="">nadie (queda para pagar)</option>
                {terceros.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.nombre.replace(/^Lo pagó: /, "")}
                  </option>
                ))}
              </select>
            </label>
          )}
          {dup && (
            <div className="flex flex-wrap items-center gap-2 text-xs text-amber-700">
              <AlertTriangle className="size-3.5" /> Ya tenés «{dup.nombre} · {alcTexto(dup)}».
              <button type="button" className="font-medium underline" onClick={() => usarExistente(f as Fila & { tipo: "nuevo" }, dup)}>
                Usar ese en vez de crear otro
              </button>
            </div>
          )}
        </div>
        {(f.tipo === "nuevo" || f.tipo === "cambio") && (
          <button type="button" onClick={() => setEditando({ clave: f.clave, inicial: f.fijo })} aria-label="Corregir" title="Corregir cualquier dato" className="flex size-9 shrink-0 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100">
            <Pencil className="size-4" />
          </button>
        )}
      </li>
    );
  };

  if (recordar !== null)
    return (
      <Modal
        abierto
        onCerrar={onListo}
        titulo="¿Lo recuerdo para la próxima?"
        ancho="max-w-lg"
        pie={
          <>
            <Boton onClick={onListo}>No</Boton>
            <Boton
              variante="primario"
              disabled={!recordar.trim()}
              onClick={() => void accion(() => put("/api/pagos/ajustes", { notasIa: `${config.notasIa}\n${recordar.trim()}`.trim() }), "La IA lo va a tener en cuenta").then((r) => r && onListo())}
            >
              Recordar
            </Boton>
          </>
        }
      >
        <p className="mb-2 text-sm text-slate-500">Corregiste estas cosas. Si las recuerdo, se suman a «Lo que la IA tiene que saber» (Configuración) y la próxima vez ya lo hace así. Podés cambiar el texto.</p>
        <textarea className="campo min-h-32" value={recordar} onChange={(e) => setRecordar(e.target.value)} />
      </Modal>
    );

  const coincide = totalImagen !== null && Math.abs(total - totalImagen) < 1;
  return (
    <Modal
      abierto
      onCerrar={onCerrar}
      titulo={`Revisá lo que propone la IA (${filas.length})`}
      ancho="max-w-4xl"
      pie={
        <>
          <Boton onClick={onCerrar}>Cancelar</Boton>
          <Boton variante="primario" disabled={!aplicables.length} onClick={() => void aplicar()}>
            Aplicar {aplicables.length}
          </Boton>
        </>
      }
    >
      <div className="space-y-3">
        <label className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm">
          <span className="font-medium text-slate-800">{modo === "mes" ? "Mes de los montos:" : "Los pagos nuevos arrancan en:"}</span>
          <input className="campo h-9 w-auto py-0" type="month" value={periodo} onChange={(e) => e.target.value && setPeriodo(e.target.value)} aria-label="Mes" />
          <span className="text-xs text-slate-500">{modo === "mes" ? "Cada monto va al pago de ese mes, y lo nuevo se paga desde ese mes." : `${nombreMes(periodo)} y los meses que siguen.`}</span>
        </label>
        {mensaje && <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">{mensaje}</p>}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-slate-500">Destildá lo que no va y tocá el lápiz para corregir cualquier dato. Lo que se borra viene destildado.</p>
          <div className="flex gap-1">
            <Boton variante="fantasma" chico onClick={() => todos(true)}>
              Elegir todos
            </Boton>
            <Boton variante="fantasma" chico onClick={() => todos(false)}>
              Ninguno
            </Boton>
          </div>
        </div>

        <div className="space-y-3">
          {agrupar(filas, grupoDeFila).map((g) => {
            const elegidas = g.items.filter((f) => f.elegido).length;
            const abierto = !plegados.has(g.clave);
            return (
              <section key={g.clave} className="overflow-hidden rounded-lg border border-slate-200">
                <header className="flex items-center gap-3 bg-slate-50 px-3 py-2 text-sm">
                  <input
                    type="checkbox"
                    className="size-4 accent-marca-oscuro"
                    checked={elegidas === g.items.length}
                    ref={(el) => void (el && (el.indeterminate = elegidas > 0 && elegidas < g.items.length))}
                    onChange={(e) => setFilas((fs) => fs.map((f) => (g.items.includes(f) ? { ...f, elegido: e.target.checked } : f)))}
                    aria-label={`Elegir todo ${g.titulo}`}
                  />
                  <button type="button" onClick={() => plegar(g.clave)} className="flex min-w-0 flex-1 items-center gap-2 text-left" aria-expanded={abierto}>
                    <span className="min-w-0 flex-1 font-semibold text-slate-800">{g.titulo}</span>
                    <span className="shrink-0 text-xs text-slate-500">
                      {g.items.length} · {plata(g.items.filter(valeAplicar).reduce((t, f) => t + montoDe(f), 0))}
                    </span>
                    <ChevronDown className={`size-4 shrink-0 text-slate-400 transition ${abierto ? "" : "-rotate-90"}`} />
                  </button>
                </header>
                {abierto &&
                  agrupar(g.items, (f) => ({ clave: categoriaDe(f), titulo: categoriaDe(f), orden: 0 })).map((sub) => (
                    <div key={sub.clave} className="border-t border-slate-100">
                      <h4 className="px-3 pb-0.5 pt-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">{sub.titulo}</h4>
                      <ul className="divide-y divide-slate-100">{sub.items.map(renglon)}</ul>
                    </div>
                  ))}
              </section>
            );
          })}
        </div>

        <div className="flex flex-wrap gap-2">
          <Boton chico icono={<Plus className="size-3.5" />} onClick={() => setEditando({ clave: null })}>
            Agregar otro pago
          </Boton>
          {modo === "mes" && config.fijos.length > 0 && (
            <Boton
              chico
              icono={<Plus className="size-3.5" />}
              onClick={() => setFilas((fs) => [...fs, { tipo: "monto", destino: { fijoId: config.fijos[0].id }, monto: 0, antes: null, pagado: false, original: "", ia: null, clave: siguiente, elegido: true }])}
            >
              Monto a un pago que ya tengo
            </Boton>
          )}
        </div>

        {total > 0 && (
          <section className="rounded-lg border border-slate-200 p-3 text-sm">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="font-medium text-slate-800">Vas a cargar {plata(total)}</span>
              {totalImagen !== null &&
                (coincide ? (
                  <span className="flex items-center gap-1 text-emerald-700">
                    <CheckCircle2 className="size-4" /> Igual que el total de la imagen
                  </span>
                ) : (
                  <span className="flex items-center gap-1 text-amber-700">
                    <AlertTriangle className="size-4" /> La imagen dice {plata(totalImagen)}: revisá que no falte o sobre nada
                  </span>
                ))}
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {[...porLugar.entries()]
                .sort((a, b) => b[1] - a[1])
                .map(([nombre, monto]) => (
                  <span key={nombre} className="rounded-md bg-slate-100 px-2 py-1 text-xs text-slate-700">
                    {nombre}: <b className="tabular-nums">{plata(monto)}</b>
                  </span>
                ))}
            </div>
          </section>
        )}
      </div>

      {editando && <ModalFijo fijo={null} inicial={editando.inicial} config={config} onCerrar={() => setEditando(null)} onPropuesta={alGuardarFormulario} />}
    </Modal>
  );
}
