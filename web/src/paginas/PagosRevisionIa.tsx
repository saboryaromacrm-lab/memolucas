import { useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, Pencil, Plus, Trash2 } from "lucide-react";
import { Boton, Modal, useAccion } from "../componentes/ui";
import { post, put } from "../lib/api";
import { ahora } from "../lib/fechas";
import { aCampo, aNumero, plata } from "../lib/numeros";
import { agrupar, describirAlcance, FRECUENCIAS_PAGO, grupoDeAlcance, nombreMes, periodoActual, soloMes, sumarMeses } from "../lib/pagos";
import { sinTildes } from "../lib/textos";
import type { AlcancePago, CampoFijo, ConfigPagos, DestinoMonto, FijoPago, FijoPropuesto, MontoPropuesto, PropuestaPagos, RepartoPago, SueltoPropuesto, TipoLugar } from "../lib/tipos";
import { ModalFijo } from "./PagosFijo";

// La revisión de lo que arma la IA de Pagos (y de una carga que se corrige): los conceptos nuevos, cambiados y
// borrados; los montos de cada mes (cada uno con su mes y, si ya está pagado, con qué y cuándo); los pagos sueltos; el
// resumen contra el total de la imagen; «Así te va a quedar», mes por mes; y, al aplicar, los avisos de lo que no quedó
// pagado y recordar las correcciones para la próxima.

/** A qué pago va un monto: un concepto que ya tenés, uno nuevo de esta revisión (ref) o un pago puntual. */
export type Destino = { fijoId: number } | { ref: string } | { itemId: number; nombre: string; lugar: string };
/** pagadoCon y fechaPago: ya está pagado con esa forma, ese día. */
type Pagado = { pagadoCon: number | null; fechaPago: string | null };

/** elegido: si arranca tildado (de entrada, todo menos lo que se borra). */
export type FilaIa = (
  /** ia: lo que propuso la IA (null si lo agregaste a mano): para saber qué corregiste. */
  | { tipo: "nuevo"; fijo: FijoPropuesto; ref: string; desde: string; ia: FijoPropuesto | null }
  | { tipo: "cambio"; antes: FijoPago; fijo: FijoPropuesto; ia: FijoPropuesto }
  | { tipo: "borrar"; antes: FijoPago }
  | ({ tipo: "monto"; destino: Destino; mes: string; monto: number; antes: number | null; pagado: boolean; original: string; ia: Destino | null } & Pagado)
  | { tipo: "suelto"; suelto: SueltoPropuesto; original: string }
) & { elegido?: boolean };
type Fila = FilaIa & { clave: number; elegido: boolean };

type Alcanzable = { alcance: AlcancePago; lugarId: number | null; tipo: TipoLugar | null; reparto: RepartoPago | null; lugarNuevo?: { nombre: string } };

const CAMPOS_FIJO: CampoFijo[] = ["nombre", "alcance", "categoria", "monto", "variable", "moneda", "vence", "pago", "aviso", "frecuencia", "forma", "cuenta", "nota"];
const ETIQUETA_CAMPO: Record<CampoFijo, string> = {
  nombre: "Nombre",
  alcance: "A qué corresponde",
  categoria: "Categoría",
  monto: "Monto",
  variable: "Tipo de monto",
  moneda: "Moneda",
  vence: "Vencimiento",
  pago: "Cuándo se paga",
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
  suelto: ["Suelto", "bg-violet-100 text-violet-800"],
};

const hoy = () => ahora().toISODate()!;
const fechaCorta = (iso: string) => iso.slice(8, 10) + "/" + iso.slice(5, 7);

const comoPropuesta = ({ id: _, desde: __, estimado: ___, ...f }: FijoPago): FijoPropuesto => f;
const claveAlcance = (a: Alcanzable) =>
  a.lugarNuevo ? `n:${sinTildes(a.lugarNuevo.nombre)}` : a.alcance === "lugar" ? `l:${a.lugarId}` : a.alcance === "general" ? `g:${a.tipo}` : `r:${(a.reparto ?? []).map((r) => r.lugarId).sort().join(",")}`;
const mismoCampo = (a: FijoPropuesto, b: FijoPropuesto, c: CampoFijo) => {
  if (c === "alcance") return claveAlcance(a) === claveAlcance(b) && JSON.stringify(a.reparto) === JSON.stringify(b.reparto);
  const k = c === "vence" ? "dia" : c === "pago" ? "desfase" : c === "aviso" ? "avisoDias" : c === "forma" ? "formaId" : c;
  return a[k] === b[k];
};
/** Qué cambia entre dos versiones de un pago. */
const camposCambiados = (a: FijoPropuesto, b: FijoPropuesto) => CAMPOS_FIJO.filter((c) => !mismoCampo(a, b, c));

/** Lo que armó la IA (o lo que aplicó una carga que se corrige), como renglones de la revisión. */
export function filasDePropuesta(
  p: Pick<PropuestaPagos, "nuevos"> & {
    cambios: { antes: FijoPago; despues: FijoPropuesto }[];
    borrar: FijoPago[];
    montos: (DestinoMonto & Omit<MontoPropuesto, "pagadoCon" | "fechaPago" | keyof DestinoMonto> & { pagadoCon?: number | null; fechaPago?: string | null })[];
    sueltos: (Omit<SueltoPropuesto, "pagadoCon"> & { pagadoCon?: number | null })[];
  },
  elegirBorrados = false,
): FilaIa[] {
  return [
    ...p.cambios.map((c) => ({ tipo: "cambio" as const, antes: c.antes, fijo: c.despues, ia: c.despues })),
    ...p.nuevos.map(({ ref, desde, ...fijo }) => ({ tipo: "nuevo" as const, fijo, ref, desde, ia: fijo })),
    ...p.borrar.map((antes) => ({ tipo: "borrar" as const, antes, ...(elegirBorrados ? { elegido: true } : {}) })),
    ...p.montos.map(({ mes, monto, nombre, lugar, antes, pagado, pagadoCon, fechaPago, original, ...a }) => {
      const destino: Destino = "fijoId" in a ? { fijoId: a.fijoId } : "ref" in a ? { ref: a.ref } : { itemId: a.itemId, nombre, lugar };
      return { tipo: "monto" as const, destino, mes, monto, antes, pagado, original: original ?? "", ia: destino, pagadoCon: pagadoCon ?? null, fechaPago: fechaPago ?? null };
    }),
    ...p.sueltos.map(({ original, pagadoCon, ...suelto }) => ({ tipo: "suelto" as const, suelto: { ...suelto, pagadoCon: pagadoCon ?? null }, original: original ?? "" })),
  ];
}

export function RevisionIa({
  config,
  filas: iniciales,
  totalImagen,
  mensaje,
  cargaId,
  propios,
  onCerrar,
  onListo,
}: {
  config: ConfigPagos;
  filas: FilaIa[];
  totalImagen: number | null;
  mensaje: string;
  /** La lectura de la IA (así lo aplicado queda en «Cargas con IA»). */
  cargaId?: number;
  /** Corregir una carga: los conceptos que creó (no cuentan como parecidos ni como destino). Al guardar, se deshace lo que hizo y se aplica esto. */
  propios?: number[];
  onCerrar: () => void;
  onListo: () => void;
}) {
  const [filas, setFilas] = useState<Fila[]>(() => iniciales.map((f, k) => ({ ...f, clave: k, elegido: f.elegido ?? f.tipo !== "borrar" })));
  const [editando, setEditando] = useState<{ clave: number | null; inicial?: FijoPropuesto } | null>(null);
  // De entrada, la fecha de pago que leyó la IA (si leyó alguna); si no, hoy.
  const [fechaTodos, setFechaTodos] = useState(() => iniciales.flatMap((f) => (f.tipo === "monto" && f.fechaPago ? [f.fechaPago] : []))[0] ?? hoy());
  const [avisos, setAvisos] = useState<string[] | null>(null);
  const [recordar, setRecordar] = useState<string | null>(null);
  const [plegados, setPlegados] = useState<Set<string>>(new Set());
  const accion = useAccion();
  const siguiente = Math.max(0, ...filas.map((f) => f.clave)) + 1;
  const corrigiendo = !!propios;
  /** Los conceptos que ya tenés (al corregir, sin los que creó esa carga: se van a volver a crear). */
  const tuyos = config.fijos.filter((f) => !propios?.includes(f.id));
  const formas = config.formas.filter((f) => !f.archivada);
  const nuevos = filas.filter((f): f is Fila & { tipo: "nuevo" } => f.tipo === "nuevo");

  const alcTexto = (a: Alcanzable) => (a.lugarNuevo ? a.lugarNuevo.nombre : describirAlcance(a, config.lugares));
  const fijoDe = (id: number) => tuyos.find((f) => f.id === id);
  const nuevoDe = (ref: string) => nuevos.find((n) => n.ref === ref);
  /** El concepto al que va un monto (uno tuyo o uno nuevo de esta revisión); null si es un pago puntual o ya no está. */
  const conceptoDe = (d: Destino): FijoPropuesto | null => ("fijoId" in d ? (fijoDe(d.fijoId) ?? null) : "ref" in d ? (nuevoDe(d.ref)?.fijo ?? null) : null);
  const nombreDestino = (d: Destino) => {
    if ("itemId" in d) return `${d.nombre} · ${d.lugar}`;
    const c = conceptoDe(d);
    return c ? `${c.nombre} · ${alcTexto(c)}` : "Pago borrado";
  };
  const alcanceSuelto = (s: SueltoPropuesto): Alcanzable => ({ ...s, reparto: null });
  /** Por qué un renglón no se puede aplicar (null si se puede). */
  const impedimento = (f: Fila) => {
    if (f.tipo !== "monto") return null;
    if ("fijoId" in f.destino && !fijoDe(f.destino.fijoId)) return "Ese pago ya no está.";
    if ("ref" in f.destino && !nuevoDe(f.destino.ref)?.elegido) return "Va a un pago nuevo que no está elegido.";
    return null;
  };
  const valeAplicar = (f: Fila) => f.elegido && !impedimento(f);
  const aplicables = filas.filter(valeAplicar);
  const conPagados = aplicables.some((f) => (f.tipo === "monto" && f.pagadoCon) || (f.tipo === "suelto" && f.suelto.pagadoCon));
  const parecido = (f: FijoPropuesto) => tuyos.find((x) => sinTildes(x.nombre) === sinTildes(f.nombre) && claveAlcance(x) === claveAlcance(f));
  const nombreForma = (id: number | null) => (id ? (formas.find((x) => x.id === id)?.nombre ?? "una forma archivada") : "");
  const detalle = (f: FijoPropuesto) =>
    [
      f.categoria,
      f.monto ? `${f.variable ? "~ " : ""}${plata(f.monto, f.moneda)}` : "sin monto",
      f.variable ? "variable" : "fijo",
      f.dia ? `vence el ${f.dia}` : "sin vencimiento",
      f.desfase ? "se paga el mes siguiente" : "se paga el mismo mes",
      FRECUENCIAS_PAGO[f.frecuencia].toLowerCase(),
      f.formaId ? `forma fija: ${nombreForma(f.formaId)}` : "",
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
      pago: f.desfase ? "el mes siguiente (mes vencido)" : "el mismo mes",
      aviso: f.avisoDias === null ? `${config.diasAviso} días antes` : f.avisoDias < 0 ? "no avisar" : f.avisoDias === 0 ? "el día que vence" : `${f.avisoDias} días antes`,
      frecuencia: FRECUENCIAS_PAGO[f.frecuencia].toLowerCase(),
      forma: nombreForma(f.formaId) || "sin forma fija",
      cuenta: f.cuenta,
      nota: f.nota,
    })[c] || "—";

  const cambiar = (clave: number, cambio: (f: Fila) => Fila) => setFilas((fs) => fs.map((f) => (f.clave === clave ? cambio(f) : f)));
  const todos = (elegido: boolean) => setFilas((fs) => fs.map((f) => ({ ...f, elegido })));
  const conPago = (f: Fila, pagadoCon: number | null): Fila =>
    f.tipo === "monto" ? { ...f, pagadoCon, fechaPago: pagadoCon ? (f.fechaPago ?? fechaTodos) : null } : f.tipo === "suelto" ? { ...f, suelto: { ...f.suelto, pagadoCon } } : f;
  /** La misma fecha de pago para todo lo que ya está pagado (los sueltos, la suya). */
  const fechaParaTodos = () =>
    setFilas((fs) => fs.map((f) => (f.tipo === "monto" && f.pagadoCon ? { ...f, fechaPago: fechaTodos } : f.tipo === "suelto" && f.suelto.pagadoCon ? { ...f, suelto: { ...f.suelto, fecha: fechaTodos } } : f)));

  /** Lo que se guarda del formulario: corrige un renglón o agrega un pago nuevo (que se repite). */
  const alGuardarFormulario = (fijo: FijoPropuesto) => {
    const clave = editando?.clave ?? null;
    const nuevo = (ref: string): Fila => ({ tipo: "nuevo", fijo, ref, desde: periodoActual(), ia: null, clave: siguiente, elegido: true });
    if (clave === null) return setFilas((fs) => [...fs, nuevo(`m${siguiente}`)]);
    const fila = filas.find((f) => f.clave === clave);
    if (fila?.tipo === "monto") {
      // «Es un pago nuevo»: el monto pasa a ir al nuevo, que empieza en el mes del monto.
      const ref = `m${siguiente}`;
      return setFilas((fs) => [...fs.map((f) => (f.clave === clave && f.tipo === "monto" ? { ...f, destino: { ref } } : f)), { ...nuevo(ref), desde: fila.mes }]);
    }
    cambiar(clave, (f) => (f.tipo === "nuevo" || f.tipo === "cambio" ? { ...f, fijo } : f));
  };
  /** «Usar ese»: en vez de crear un duplicado, sus montos van al que ya tenés (si no tiene montos, se le cambia el monto). */
  const usarExistente = (fila: Fila & { tipo: "nuevo" }, existente: FijoPago) => {
    const conMontos = filas.some((f) => f.tipo === "monto" && "ref" in f.destino && f.destino.ref === fila.ref);
    setFilas((fs) =>
      conMontos
        ? fs.filter((f) => f.clave !== fila.clave).map((f) => (f.tipo === "monto" && "ref" in f.destino && f.destino.ref === fila.ref ? { ...f, destino: { fijoId: existente.id }, antes: null } : f))
        : fs.map((f) => (f.clave === fila.clave ? { tipo: "cambio", antes: existente, fijo: { ...comoPropuesta(existente), monto: fila.fijo.monto }, ia: comoPropuesta(existente), clave: f.clave, elegido: true } : f)),
    );
  };
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
        desfase: 0,
        frecuencia: "mensual",
        formaId: null,
        cuenta: "",
        avisoDias: null,
        nota: "",
        ...(fila.original ? { original: fila.original } : {}),
      },
    });

  // Lo que suma lo elegido (montos, sueltos y los nuevos sin montos), en total y por lugar (un repartido, su parte en cada uno).
  const montoDe = (f: Fila) => {
    if (f.tipo === "monto" || f.tipo === "suelto") return f.tipo === "monto" ? f.monto : f.suelto.monto;
    if (f.tipo === "nuevo") return filas.some((x) => x.tipo === "monto" && "ref" in x.destino && x.destino.ref === f.ref) ? 0 : f.fijo.monto;
    return f.tipo === "cambio" && !mismoCampo(f.antes, f.fijo, "monto") ? f.fijo.monto : 0;
  };
  const alcanceDe = (f: Fila): Alcanzable | null => (f.tipo === "monto" ? conceptoDe(f.destino) : f.tipo === "borrar" ? f.antes : f.tipo === "suelto" ? alcanceSuelto(f.suelto) : f.fijo);
  const porLugar = new Map<string, number>();
  const sumar = (nombre: string, monto: number) => porLugar.set(nombre, (porLugar.get(nombre) ?? 0) + monto);
  for (const f of aplicables) {
    const monto = montoDe(f);
    if (!monto) continue;
    const a = alcanceDe(f);
    if (!a) sumar(f.tipo === "monto" && "itemId" in f.destino ? f.destino.lugar : "Otros", monto);
    else if (a.alcance === "repartido" && a.reparto?.length) {
      const iguales = a.reparto.every((r) => r.porcentaje === null);
      for (const r of a.reparto) sumar(config.lugares.find((l) => l.id === r.lugarId)?.nombre ?? "Lugar borrado", (monto * (iguales ? 100 / a.reparto.length : (r.porcentaje ?? 0))) / 100);
    } else sumar(a.alcance === "general" ? `General · ${a.tipo ?? "personal"}` : alcTexto(a), monto);
  }
  const total = [...porLugar.values()].reduce((s, x) => s + x, 0);

  /** «Así te va a quedar»: lo que vas a ver en cada mes (el de pago) y si queda pagado. */
  const quedan = new Map<string, string[]>();
  const anotar = (mes: string, texto: string) => quedan.set(mes, [...(quedan.get(mes) ?? []), texto]);
  for (const f of aplicables) {
    if (f.tipo === "monto") {
      const c = conceptoDe(f.destino);
      const mesPago = sumarMeses(f.mes, c?.desfase ?? 0);
      const de = mesPago !== f.mes ? ` (de ${soloMes(f.mes)})` : "";
      anotar(mesPago, `${nombreDestino(f.destino).split(" · ")[0]}${de}: ${plata(f.monto)} — ${f.pagadoCon ? `pagado el ${fechaCorta(f.fechaPago ?? fechaTodos)} con ${nombreForma(f.pagadoCon)}` : f.pagado ? "ya estaba pagado" : "para pagar"}`);
    } else if (f.tipo === "suelto") {
      const s = f.suelto;
      anotar(s.fecha.slice(0, 7), `${s.nombre} (suelto): ${plata(s.monto, s.moneda)} — ${s.pagadoCon ? `pagado el ${fechaCorta(s.fecha)} con ${nombreForma(s.pagadoCon)}` : `para pagar el ${fechaCorta(s.fecha)}`}`);
    }
  }
  const nuevosSinMonto = aplicables.filter((f): f is Fila & { tipo: "nuevo" } => f.tipo === "nuevo" && !filas.some((x) => x.tipo === "monto" && "ref" in x.destino && x.destino.ref === f.ref));

  /** Lo que corregiste, en palabras, para que la IA lo tenga en cuenta la próxima. */
  const correcciones = () =>
    aplicables.flatMap((f) => {
      if (f.tipo === "monto") return f.ia && JSON.stringify(f.ia) !== JSON.stringify(f.destino) && f.original ? [`«${f.original}» es «${nombreDestino(f.destino)}».`] : [];
      if (f.tipo === "borrar" || f.tipo === "suelto") return [];
      if (!f.ia) return f.fijo.original ? [`«${f.fijo.original}» es un pago aparte: «${f.fijo.nombre}» (${alcTexto(f.fijo)}).`] : [];
      const n = f.fijo;
      const partes = camposCambiados(f.ia, n).flatMap((c) => {
        if (c === "nombre") return [`se llama «${n.nombre}»`];
        if (c === "alcance") return [`va en ${alcTexto(n)}`];
        if (c === "categoria") return [`es de la categoría ${n.categoria}`];
        if (c === "vence") return [n.dia ? `vence el día ${n.dia}` : "no tiene vencimiento"];
        if (c === "pago") return [n.desfase ? "se paga el mes siguiente al que corresponde" : "se paga el mismo mes al que corresponde"];
        if (c === "variable") return [n.variable ? "su monto cambia cada mes" : "su monto es fijo"];
        if (c === "frecuencia") return [`se paga ${FRECUENCIAS_PAGO[n.frecuencia].toLowerCase()}`];
        if (c === "forma") return [n.formaId ? `se paga con ${valorCampo("forma", n)}` : "no tiene forma de pago fija"];
        return [];
      });
      return partes.length ? [`«${n.original ?? f.ia.nombre}»: ${partes.join(", ")}.`] : [];
    });

  const terminar = () => {
    const lineas = correcciones();
    if (lineas.length) setRecordar(lineas.join("\n"));
    else onListo();
  };
  const aplicar = async () => {
    const carga = {
      nuevos: aplicables.flatMap((f) => (f.tipo === "nuevo" ? [{ ...f.fijo, ref: f.ref, desde: f.desde }] : [])),
      cambios: aplicables.flatMap((f) => (f.tipo === "cambio" ? [{ id: f.antes.id, ...f.fijo }] : [])),
      borrar: aplicables.flatMap((f) => (f.tipo === "borrar" ? [f.antes.id] : [])),
      // A un pago que ya tenés, solo si cambia el monto o queda pagado.
      montos: aplicables.flatMap((f) => {
        if (f.tipo !== "monto" || ("ref" in f.destino ? false : f.monto === f.antes && !f.pagadoCon)) return [];
        const destino = "fijoId" in f.destino ? { fijoId: f.destino.fijoId } : "ref" in f.destino ? { ref: f.destino.ref } : { itemId: f.destino.itemId };
        return [{ ...destino, mes: f.mes, monto: f.monto, ...(f.pagadoCon ? { pagadoCon: f.pagadoCon, fechaPago: f.fechaPago ?? fechaTodos } : {}) }];
      }),
      sueltos: aplicables.flatMap((f) => {
        if (f.tipo !== "suelto") return [];
        const { pagadoCon, original: _, ...s } = f.suelto;
        return [{ ...s, ...(pagadoCon ? { pagadoCon } : {}) }];
      }),
    };
    const r = await accion(
      () => post<{ avisos: string[] }>(corrigiendo ? `/api/pagos/cargas/${cargaId}/corregir` : "/api/pagos/ia/aplicar", corrigiendo ? carga : { ...carga, ...(cargaId ? { cargaId } : {}) }),
      corrigiendo ? "Listo: carga corregida" : "Listo: cargado",
    );
    if (!r) return;
    if (r.avisos.length) setAvisos(r.avisos);
    else terminar();
  };

  // Agrupado: primero los conceptos (por lugar), después cada mes (por lugar).
  const grupoDeFila = (f: Fila) => {
    if (f.tipo === "monto") return { clave: `m:${f.mes}`, titulo: nombreMes(f.mes), orden: Number(f.mes.replace("-", "")) };
    if (f.tipo === "suelto") return { clave: `m:${f.suelto.fecha.slice(0, 7)}`, titulo: nombreMes(f.suelto.fecha.slice(0, 7)), orden: Number(f.suelto.fecha.slice(0, 7).replace("-", "")) };
    return { clave: "conceptos", titulo: "Lo que pagás siempre", orden: 0 };
  };
  const lugarDeFila = (f: Fila) => {
    const a = alcanceDe(f);
    return a ? grupoDeAlcance(a, config.lugares) : { clave: "otros", titulo: f.tipo === "monto" && "itemId" in f.destino ? f.destino.lugar : "Otros", orden: 950 };
  };
  const plegar = (clave: string) => setPlegados((p) => (p.has(clave) ? new Set([...p].filter((x) => x !== clave)) : new Set([...p, clave])));

  const campoMonto = (valor: number, alCambiar: (n: number) => void) => (
    <input
      className="campo h-9 min-w-0 flex-1 py-0 text-right tabular-nums sm:w-32 sm:flex-none"
      inputMode="decimal"
      defaultValue={aCampo(valor, true)}
      onBlur={(e) => {
        const n = aNumero(e.target.value);
        if (n !== null) alCambiar(n);
      }}
      aria-label="Monto"
    />
  );
  /** «Pagado con» (todas tus formas) y, si está pagado, la fecha. */
  const campoPagado = (f: Fila, pagadoCon: number | null, fecha: string | null, alCambiarFecha: (fecha: string) => void) => (
    <div className="flex flex-wrap items-center gap-1.5 text-xs text-slate-600">
      <select className="campo h-8 w-auto py-0 text-xs" value={pagadoCon ?? ""} onChange={(e) => cambiar(f.clave, (x) => conPago(x, e.target.value ? Number(e.target.value) : null))} aria-label="Pagado con">
        <option value="">Sin pagar (queda para pagar)</option>
        {formas.map((x) => (
          <option key={x.id} value={x.id}>
            Pagado con {x.nombre}
          </option>
        ))}
      </select>
      {pagadoCon && (
        <input className="campo h-8 w-auto py-0 text-xs" type="date" value={fecha ?? fechaTodos} max={hoy()} onChange={(e) => e.target.value && alCambiarFecha(e.target.value)} aria-label="Fecha de pago" />
      )}
    </div>
  );

  const renglon = (f: Fila) => {
    const [insignia, color] = INSIGNIA[f.tipo];
    const motivo = impedimento(f);
    const dup = f.tipo === "nuevo" ? parecido(f.fijo) : undefined;
    const original = f.tipo === "monto" || f.tipo === "suelto" ? f.original : f.tipo === "borrar" ? "" : (f.fijo.original ?? "");
    const etiqueta = f.tipo === "monto" ? nombreDestino(f.destino) : f.tipo === "borrar" ? f.antes.nombre : f.tipo === "suelto" ? f.suelto.nombre : f.fijo.nombre;
    return (
      <li key={f.clave} className={`flex items-start gap-3 px-3 py-2.5 text-sm ${motivo ? "opacity-60" : ""}`}>
        <input type="checkbox" className="mt-1 size-4 accent-marca-oscuro" checked={f.elegido} onChange={(e) => cambiar(f.clave, (x) => ({ ...x, elegido: e.target.checked }))} aria-label={`${insignia}: ${etiqueta}`} />
        <div className="min-w-0 flex-1 space-y-1">
          {f.tipo === "monto" ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${color}`}>{insignia}</span>
              <select
                className="campo order-last h-9 min-w-0 basis-full py-0 text-sm sm:order-none sm:basis-0 sm:flex-1"
                value={"fijoId" in f.destino ? `f:${f.destino.fijoId}` : "ref" in f.destino ? `r:${f.destino.ref}` : `i:${f.destino.itemId}`}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === "nuevo") return pasarANuevo(f);
                  const destino: Destino = v.startsWith("f:") ? { fijoId: Number(v.slice(2)) } : v.startsWith("r:") ? { ref: v.slice(2) } : f.destino;
                  cambiar(f.clave, (x) => (x.tipo === "monto" ? { ...x, destino, antes: null } : x));
                }}
                aria-label="A qué pago va"
              >
                {"itemId" in f.destino && <option value={`i:${f.destino.itemId}`}>{nombreDestino(f.destino)}</option>}
                {nuevos.map((n) => (
                  <option key={n.ref} value={`r:${n.ref}`}>
                    {n.fijo.nombre} · {alcTexto(n.fijo)} (nuevo)
                  </option>
                ))}
                {[...tuyos]
                  .sort((a, b) => a.nombre.localeCompare(b.nombre))
                  .map((x) => (
                    <option key={x.id} value={`f:${x.id}`}>
                      {x.nombre} · {alcTexto(x)}
                    </option>
                  ))}
                <option value="nuevo">➕ Es un pago nuevo…</option>
              </select>
              <input
                className="campo h-9 w-auto py-0"
                type="month"
                value={f.mes}
                disabled={"itemId" in f.destino}
                onChange={(e) => e.target.value && cambiar(f.clave, (x) => (x.tipo === "monto" ? { ...x, mes: e.target.value, antes: null } : x))}
                aria-label="Mes al que corresponde"
                title="Mes al que corresponde (el del gasto)"
              />
              {campoMonto(f.monto, (n) => cambiar(f.clave, (x) => (x.tipo === "monto" ? { ...x, monto: n } : x)))}
            </div>
          ) : f.tipo === "suelto" ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${color}`}>{insignia}</span>
              <input className="campo h-9 min-w-0 flex-1 py-0" value={f.suelto.nombre} onChange={(e) => cambiar(f.clave, (x) => (x.tipo === "suelto" ? { ...x, suelto: { ...x.suelto, nombre: e.target.value } } : x))} aria-label="Qué se pagó" />
              <select
                className="campo h-9 w-auto py-0 text-sm"
                value={f.suelto.lugarNuevo ? "" : f.suelto.alcance === "lugar" ? `l:${f.suelto.lugarId}` : `g:${f.suelto.tipo ?? "personal"}`}
                onChange={(e) => {
                  const v = e.target.value;
                  const a = v.startsWith("l:") ? { alcance: "lugar" as const, lugarId: Number(v.slice(2)), tipo: null } : { alcance: "general" as const, lugarId: null, tipo: v.slice(2) as TipoLugar };
                  cambiar(f.clave, (x) => (x.tipo === "suelto" ? { ...x, suelto: { ...x.suelto, ...a, lugarNuevo: undefined } } : x));
                }}
                aria-label="De qué es"
              >
                {f.suelto.lugarNuevo && <option value="">{f.suelto.lugarNuevo.nombre} (lugar nuevo)</option>}
                {config.lugares.map((l) => (
                  <option key={l.id} value={`l:${l.id}`}>
                    {l.nombre}
                  </option>
                ))}
                <option value="g:negocio">General · negocio</option>
                <option value="g:personal">General · personal</option>
              </select>
              <input className="campo h-9 w-auto py-0" type="date" value={f.suelto.fecha} onChange={(e) => e.target.value && cambiar(f.clave, (x) => (x.tipo === "suelto" ? { ...x, suelto: { ...x.suelto, fecha: e.target.value } } : x))} aria-label="Fecha" />
              {campoMonto(f.suelto.monto, (n) => cambiar(f.clave, (x) => (x.tipo === "suelto" ? { ...x, suelto: { ...x.suelto, monto: n } } : x)))}
            </div>
          ) : (
            <div className="font-medium text-slate-900">
              <span className={`mr-1.5 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${color}`}>{insignia}</span>
              {etiqueta}
              {f.tipo === "nuevo" && f.fijo.lugarNuevo && <span className="ml-1.5 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-amber-800">Lugar nuevo</span>}
            </div>
          )}

          {f.tipo === "nuevo" && (
            <>
              <div className="text-xs text-slate-500">{detalle(f.fijo)}</div>
              <label className="flex flex-wrap items-center gap-1.5 text-xs text-slate-600">
                Primer mes al que corresponde:
                <input className="campo h-8 w-auto py-0 text-xs" type="month" value={f.desde} onChange={(e) => e.target.value && cambiar(f.clave, (x) => (x.tipo === "nuevo" ? { ...x, desde: e.target.value } : x))} />
              </label>
            </>
          )}
          {f.tipo === "cambio" &&
            camposCambiados(f.antes, f.fijo).map((c) => (
              <div key={c} className="text-xs text-slate-500">
                {ETIQUETA_CAMPO[c]}: <span className="text-slate-400 line-through">{valorCampo(c, comoPropuesta(f.antes))}</span> → <span className="font-medium text-slate-800">{valorCampo(c, f.fijo)}</span>
              </div>
            ))}
          {f.tipo === "borrar" && <div className="text-xs text-red-600">Se borra con sus pagos pendientes; lo pagado queda en el historial.</div>}
          {f.tipo === "monto" && (
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
              {f.antes !== null && (f.antes === f.monto ? <span>Ya tenía ese monto</span> : <span>Antes: {plata(f.antes)}</span>)}
              {(() => {
                const c = conceptoDe(f.destino);
                return c?.desfase ? <span>se paga en {soloMes(sumarMeses(f.mes, 1))}</span> : null;
              })()}
              {f.pagado && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-amber-800">Ya pagado</span>}
              {motivo && <span className="text-amber-700">{motivo}</span>}
            </div>
          )}
          {f.tipo === "monto" && !f.pagado && campoPagado(f, f.pagadoCon, f.fechaPago, (fecha) => cambiar(f.clave, (x) => (x.tipo === "monto" ? { ...x, fechaPago: fecha } : x)))}
          {f.tipo === "suelto" && campoPagado(f, f.suelto.pagadoCon, f.suelto.fecha, (fecha) => cambiar(f.clave, (x) => (x.tipo === "suelto" ? { ...x, suelto: { ...x.suelto, fecha } } : x)))}
          {original && (
            <div className="text-xs text-slate-400">
              En la imagen: «{original}»{f.tipo === "nuevo" && f.ia ? ` ${plata(f.ia.monto, f.ia.moneda)}` : ""}
            </div>
          )}
          {dup && f.tipo === "nuevo" && (
            <div className="flex flex-wrap items-center gap-2 text-xs text-amber-700">
              <AlertTriangle className="size-3.5" /> Ya tenés «{dup.nombre} · {alcTexto(dup)}».
              <button type="button" className="font-medium underline" onClick={() => usarExistente(f, dup)}>
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
        {f.tipo === "suelto" && !f.original && (
          <button type="button" onClick={() => setFilas((fs) => fs.filter((x) => x.clave !== f.clave))} aria-label="Sacar" title="Sacar este pago" className="flex size-9 shrink-0 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100">
            <Trash2 className="size-4" />
          </button>
        )}
      </li>
    );
  };

  if (avisos)
    return (
      <Modal abierto onCerrar={terminar} titulo="Revisá esto" ancho="max-w-lg" pie={<Boton variante="primario" onClick={terminar}>Entendido</Boton>}>
        <p className="mb-2 text-sm text-slate-600">Se aplicó todo, pero esto no quedó como lo marcaste:</p>
        <ul className="list-disc space-y-1 pl-5 text-sm text-amber-800">
          {avisos.map((a) => (
            <li key={a}>{a}</li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-slate-500">Lo podés arreglar en Este mes, o deshacer la carga desde «Cargas con IA».</p>
      </Modal>
    );

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
        <p className="mb-2 text-sm text-slate-500">Corregiste estas cosas. Si las recuerdo, se suman a «Lo que la IA tiene que saber» y la próxima vez ya lo hace así. Podés cambiar el texto.</p>
        <textarea className="campo min-h-32" value={recordar} onChange={(e) => setRecordar(e.target.value)} />
      </Modal>
    );

  const coincide = totalImagen !== null && Math.abs(total - totalImagen) < 1;
  const cambiosYBorrados = aplicables.filter((f) => f.tipo === "cambio" || f.tipo === "borrar");
  return (
    <Modal
      abierto
      onCerrar={onCerrar}
      titulo={corrigiendo ? `Corregí la carga (${filas.length})` : `Revisá lo que propone la IA (${filas.length})`}
      ancho="max-w-4xl"
      pie={
        <>
          <Boton onClick={onCerrar}>Cancelar</Boton>
          <Boton variante="primario" disabled={!aplicables.length} onClick={() => void aplicar()}>
            {corrigiendo ? "Guardar la corrección" : `Aplicar ${aplicables.length}`}
          </Boton>
        </>
      }
    >
      <div className="space-y-3">
        {mensaje && <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">{mensaje}</p>}
        {conPagados && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm">
            <span className="font-medium text-slate-800">Fecha de pago:</span>
            <input className="campo h-9 w-auto py-0" type="date" value={fechaTodos} max={hoy()} onChange={(e) => e.target.value && setFechaTodos(e.target.value)} aria-label="Fecha de pago para todos" />
            <Boton chico onClick={fechaParaTodos}>
              Ponérsela a todo lo pagado
            </Boton>
            <span className="text-xs text-slate-500">La fecha real del pago (puede ser de otro mes que el del gasto).</span>
          </div>
        )}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-slate-500">
            {corrigiendo
              ? "Es lo que hizo la carga. Destildá lo que no va y corregí lo que quieras: al guardar se deshace lo anterior y queda esto."
              : "Cada monto va al mes al que corresponde (el del gasto). Destildá lo que no va y tocá el lápiz para corregir. Lo que se borra viene destildado."}
          </p>
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
                  agrupar(g.items, lugarDeFila).map((sub) => (
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
            Pago que se repite
          </Boton>
          {tuyos.length > 0 && (
            <Boton
              chico
              icono={<Plus className="size-3.5" />}
              onClick={() =>
                setFilas((fs) => [...fs, { tipo: "monto", destino: { fijoId: tuyos[0].id }, mes: periodoActual(), monto: 0, antes: null, pagado: false, original: "", ia: null, pagadoCon: null, fechaPago: null, clave: siguiente, elegido: true }])
              }
            >
              Monto a un pago que ya tengo
            </Boton>
          )}
          <Boton
            chico
            icono={<Plus className="size-3.5" />}
            onClick={() =>
              setFilas((fs) => [
                ...fs,
                { tipo: "suelto", suelto: { alcance: "general", lugarId: null, tipo: "personal", nombre: "Pago", categoria: "Otros", monto: 0, moneda: "ARS", fecha: hoy(), pagadoCon: null, nota: "" }, original: "", clave: siguiente, elegido: true },
              ])
            }
          >
            Pago suelto
          </Boton>
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

        {(quedan.size > 0 || nuevosSinMonto.length > 0 || cambiosYBorrados.length > 0) && (
          <section className="rounded-lg border border-teal-200 bg-teal-50/50 p-3 text-sm">
            <h3 className="font-semibold text-marca-profundo">Así te va a quedar</h3>
            <div className="mt-1 space-y-2">
              {[...quedan.entries()]
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([mes, lineas]) => (
                  <div key={mes}>
                    <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">En {nombreMes(mes).toLowerCase()}</div>
                    <ul className="list-disc pl-5 text-slate-700">
                      {lineas.map((l, k) => (
                        <li key={k}>{l}</li>
                      ))}
                    </ul>
                  </div>
                ))}
              {nuevosSinMonto.length > 0 && (
                <p className="text-slate-700">
                  Todos los meses, desde lo que elegiste: {nuevosSinMonto.map((n) => `${n.fijo.nombre} (desde ${soloMes(n.desde)}, se paga ${n.fijo.desfase ? "el mes siguiente" : "el mismo mes"})`).join(" · ")}.
                </p>
              )}
              {cambiosYBorrados.length > 0 && (
                <p className="text-slate-700">
                  También: {cambiosYBorrados.map((f) => (f.tipo === "cambio" ? `cambia ${f.fijo.nombre}` : f.tipo === "borrar" ? `se borra ${f.antes.nombre}` : "")).join(" · ")}.
                </p>
              )}
            </div>
          </section>
        )}
      </div>

      {editando && <ModalFijo fijo={null} inicial={editando.inicial} config={config} onCerrar={() => setEditando(null)} onPropuesta={alGuardarFormulario} />}
    </Modal>
  );
}
