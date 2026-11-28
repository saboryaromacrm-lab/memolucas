import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { normalizar, plata } from "../lib/textos.js";
import { obtenerConfig } from "../servicios/configuracion.js";
import { comoWebp } from "../servicios/archivos-cifrados.js";
import { DateTime } from "luxon";
import { filasDeFijos, guardarAnalisis, listarFijos, listarLugares, pagosPendientes, resumenPagos, verMes, type Alcance } from "../servicios/pagos.js";
import { dondeVa, type FijoPropuesto } from "../servicios/pagos-cargas.js";
import type { FrecuenciaPago, TipoLugar } from "../db/schema.js";
import { elegirForma, formasActivas, type FormaPago } from "../servicios/pagos-formas.js";
import { nombresDeCategorias } from "../servicios/pagos-categorias.js";
import { MESES_DE, nombreMes, periodoDe, type Moneda } from "../servicios/pagos-reglas.js";
import { hoyIso } from "../lib/fechas.js";
import { ErrorUsuario } from "../servicios/recordatorios.js";
import { gastoDelMes, pedir } from "./ia.js";

// La IA en Pagos: una sola para cargar todo (lo que pagás siempre, los montos de cada mes, lo pagado y lo suelto) a
// partir de lo que dictás o pegás, y el análisis de cada mes.

/** Con el tope de gasto de IA del mes alcanzado, no se usa (igual que el asistente). */
async function conTope() {
  const cfg = await obtenerConfig();
  if (cfg.agenteTopeUsd > 0 && (await gastoDelMes()).costoUsd >= cfg.agenteTopeUsd)
    throw new ErrorUsuario(`Llegaste al tope de IA de este mes (US$ ${cfg.agenteTopeUsd}). Lo podés subir en Configuración → IA.`);
  return cfg;
}

const FRECUENCIAS = Object.keys(MESES_DE) as FrecuenciaPago[];

/** Un archivo para que lo lea la IA: una foto o captura (se achica) o un PDF. */
export type ArchivoIa = { datos: Buffer; mime: string };
export const ARCHIVO_IA_MAX_BYTES = 15 * 1024 * 1024;

/** Lo que se le manda a la IA: el archivo (si hay) y el texto. */
async function contenido(texto: string, archivo?: ArchivoIa): Promise<Anthropic.ContentBlockParam[]> {
  const bloques: Anthropic.ContentBlockParam[] = [];
  if (archivo) {
    if (archivo.datos.length > ARCHIVO_IA_MAX_BYTES) throw new ErrorUsuario("El archivo pesa más de 15 MB.");
    if (archivo.mime === "application/pdf") {
      if (!archivo.datos.subarray(0, 5).toString("latin1").startsWith("%PDF")) throw new ErrorUsuario("Ese archivo no es un PDF.");
      bloques.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: archivo.datos.toString("base64") } });
    } else {
      // Achicada alcanza para leer una tabla, y cuesta menos.
      const imagen = await comoWebp(archivo.datos, { ancho: 1600, alto: 1600 }, 90).catch(() => {
        throw new ErrorUsuario("No pude leer esa imagen: mandá una foto, una captura o un PDF.");
      });
      bloques.push({ type: "image", source: { type: "base64", media_type: "image/webp", data: imagen.data.toString("base64") } });
    }
  }
  bloques.push({ type: "text", text: texto.trim() || "(Sin texto: leé el archivo.)" });
  return bloques;
}

/** Cuándo se paga lo de cada mes: la IA lo propone y se confirma en la revisión. */
const MES_VENCIDO = `Mes vencido: lo que corresponde a un mes se paga el mes siguiente (las cargas sociales y aportes como F-931, IPS u obra social, los sindicatos, IIBB, IVA, Ganancias, y los sueldos). Se pagan el mismo mes: el monotributo, el alquiler, las cuotas, las suscripciones. Si lo dijo o lo dice lo que te dijo de sus negocios, respetalo.`;

const ALCANCES = `Cada pago corresponde a:
- "lugar": lo de un local o la casa (alquiler, luz, gas, internet, ABL de ese lugar).
- "repartido": lo que es de varios locales a la vez y se paga una sola vez (contador, abogado, sistema, seguridad, publicidad): repartir_entre vacío = todos los negocios.
- "general": lo que no tiene lugar físico (tarjeta de crédito, cuota del auto, préstamos, celular, prepaga): tipo "personal" salvo que diga que es del negocio.`;

/** Lo que te dijo de sus negocios (Configuración de Pagos), para el sistema de la IA. */
const notasDe = (notas: string) => (notas.trim() ? `\nLo que te dijo de sus negocios (respetalo siempre):\n${notas.trim()}\n` : "");

/** Lo que la IA puede cambiar de un pago que ya está cargado (también es lo que la pantalla muestra como «antes → después»). */
export const CAMPOS_FIJO = ["nombre", "alcance", "categoria", "monto", "variable", "moneda", "vence", "pago", "aviso", "frecuencia", "forma", "cuenta", "nota"] as const;
export type CampoFijo = (typeof CAMPOS_FIJO)[number];

// Texto libre (no enums): la IA a veces deja vacíos o escribe a su manera; se normaliza después.
const Concepto = z.object({
  alcance: z.string().describe('"lugar" (de un local o la casa), "repartido" (de varios locales a la vez) o "general" (sin lugar físico)'),
  lugar: z.string().describe('Con "lugar": el lugar tal cual figura en la lista, o el nombre de uno nuevo. Si no, ""'),
  tipo: z.string().describe('"negocio" o "personal": de qué es (para "general" y para un lugar nuevo)'),
  repartir_entre: z.array(z.string()).describe('Con "repartido": los lugares de la lista entre los que se reparte; vacío = todos los negocios'),
  nombre: z.string().describe("Qué se paga, corto: Alquiler, Luz, ABL, Sueldos…"),
  categoria: z.string().describe("Una de las categorías de la lista"),
  monto: z.number().describe("En números (650 mil = 650000). 0 si no lo dijo"),
  variable: z.boolean().describe("true si cambia mes a mes (luz, gas, agua) o dijo 'más o menos'"),
  moneda: z.string().describe('"ARS" (pesos) o "USD" (dólares)'),
  dia: z.number().int().describe("Día del mes en que vence (1 a 31), solo si lo dijo ('a mitad de mes' = 15). Si no dijo un día: 0 (no tiene vencimiento)"),
  mes_vencido: z.boolean().describe("true si lo de un mes se paga el mes siguiente (mes vencido); false si se paga el mismo mes"),
  frecuencia: z.string().describe(`Una de: ${FRECUENCIAS.join(", ")}`),
  forma: z.string().describe('Con qué lo paga: una de sus formas de pago, tal cual figura. "" si no lo dijo'),
  cuenta: z.string().describe('Número de cliente, partida o cuenta si lo dijo; si no, ""'),
  nota: z.string().describe('Otro dato útil que dijo; si no, ""'),
  como_figura: z.string().describe('El renglón tal cual figura en la imagen o el texto ("F-931 SYA"); "" si no viene de un renglón'),
});

/** Un monto de un mes: a qué va (un concepto que ya tiene, uno puntual o uno nuevo), de qué mes es y si ya se pagó. */
const MontoIa = z.object({
  concepto: z.string().describe('A qué va: "#id" de lo que paga siempre, "i:id" de un pago puntual de la lista, o el "ref" de uno nuevo'),
  mes: z.string().describe('El mes al que corresponde (el del gasto), "YYYY-MM": lo de octubre es de octubre aunque se pague en noviembre'),
  monto: z.number().describe("En números, sin redondear ($ 2.896.003,34 = 2896003.34)"),
  pagado_por: z.string().describe('Si dice que ya está pagado: con qué, una de sus formas de pago tal cual figura (si lo pagó otra persona, su «Lo pagó: …»). Si no: ""'),
  fecha_pago: z.string().describe('Si ya está pagado y dice cuándo: "YYYY-MM-DD". Si no: ""'),
  como_figura: z.string().describe('El renglón tal cual figura; "" si no viene de un renglón'),
});

/** Un pago de una sola vez (no se repite): el plomero, un arreglo. */
const SueltoIa = z.object({
  nombre: z.string().describe("Qué se pagó, corto"),
  lugar: z.string().describe('El lugar tal cual figura en la lista, uno nuevo, o "" si no es de un lugar'),
  tipo: z.string().describe('"negocio" o "personal"'),
  categoria: z.string().describe("Una de las categorías de la lista"),
  monto: z.number(),
  moneda: z.string().describe('"ARS" o "USD"'),
  fecha: z.string().describe('"YYYY-MM-DD": cuándo se pagó (si ya está pagado) o cuándo hay que pagarlo'),
  pagado_por: z.string().describe('Si ya está pagado: con qué (una de sus formas, tal cual). Si no: ""'),
  nota: z.string().describe('Otro dato útil; si no, ""'),
  como_figura: z.string().describe('El renglón tal cual figura; "" si no viene de un renglón'),
});

const EsquemaCarga = z.object({
  nuevos: z
    .array(
      Concepto.extend({
        ref: z.string().describe('Un nombre corto y único ("n1", "n2"…) para usarlo en "montos"'),
        desde: z.string().describe('El primer mes al que corresponde, "YYYY-MM"; "" si no se sabe'),
      }),
    )
    .describe("Lo que se paga siempre (todos los meses o cada tanto) y todavía no está en la lista"),
  cambios: z
    .array(
      z.object({
        id: z.number().int().describe("El id (#) del pago de la lista"),
        campo: z.string().describe(`Uno de: ${CAMPOS_FIJO.join(", ")}`),
        valor: z.string().describe("El valor nuevo, en el formato de ese campo"),
      }),
    )
    .describe("Un renglón por cada campo que cambia de cada pago de la lista"),
  borrar: z.array(z.number().int()).describe("Los id (#) de los pagos de la lista que pidió borrar"),
  montos: z.array(MontoIa).describe("Los montos de cada mes: un renglón por concepto y por mes. Si reparte un monto en varios meses, un renglón por mes con su parte"),
  sueltos: z.array(SueltoIa).describe("Los pagos de una sola vez, que no se repiten"),
  total: z.number().describe("Si te pasó un resumen con un total general (no un subtotal), ese total; si no, 0"),
  mensaje: z.string().describe('Lo que no pudiste hacer y por qué (no entendiste, no encontraste lo que nombró), corto y con voseo. Si hiciste todo: ""'),
});

type Lugar = Awaited<ReturnType<typeof listarLugares>>[number];
type Fijo = Awaited<ReturnType<typeof listarFijos>>[number];

const tipoDe = (texto: string): TipoLugar => (/personal|casa/i.test(texto) ? "personal" : "negocio");

/** A qué corresponde, a partir de lo que escribió la IA. Un lugar que no está en la lista se propone como nuevo. */
function resolverAlcance(lugares: Lugar[], alcanceIa: string, lugar: string, tipoTexto: string, entre: string[]): Pick<FijoPropuesto, keyof Alcance | "lugarNuevo"> {
  const tipo = tipoDe(`${tipoTexto} ${lugar}`);
  const buscar = (nombre: string) => lugares.find((l) => normalizar(l.nombre) === normalizar(nombre));
  const alcance = normalizar(alcanceIa);
  if (alcance.startsWith("repart")) {
    const elegidos = entre.map(buscar).filter((l) => l !== undefined);
    const todos = elegidos.length >= 2 ? elegidos : lugares.filter((l) => l.tipo === "negocio");
    return todos.length >= 2
      ? { alcance: "repartido", lugarId: null, tipo: null, reparto: todos.map((l) => ({ lugarId: l.id, porcentaje: null })) }
      : { alcance: "general", lugarId: null, tipo: "negocio", reparto: null };
  }
  if (alcance.startsWith("general") || !lugar.trim()) return { alcance: "general", lugarId: null, tipo, reparto: null };
  const existe = buscar(lugar);
  return { alcance: "lugar", lugarId: existe?.id ?? null, tipo: null, reparto: null, lugarNuevo: existe ? undefined : { nombre: lugar.trim(), tipo } };
}

const monedaDe = (texto: string): Moneda => (/usd|d[oó]lar|u\$s|us\$/i.test(texto) ? "USD" : "ARS");
const frecuenciaDe = (texto: string) => FRECUENCIAS.find((f) => normalizar(texto).startsWith(f.slice(0, 5)));
const diaDe = (n: number) => (n >= 1 ? Math.min(31, Math.round(n)) : null);
/** Un número escrito a la argentina o no: «850.000», «1.234,56», «70,5» o «850000». NaN si no hay número. */
function numeroDe(texto: string) {
  const t = texto.replace(/[^\d.,-]/g, "");
  if (!/\d/.test(t)) return NaN;
  if (t.includes(",")) return Number(t.replace(/\./g, "").replace(",", "."));
  return Number(/^-?\d{1,3}(\.\d{3})+$/.test(t) ? t.replace(/\./g, "") : t);
}

/** Un pago nuevo, tal como lo escribió la IA, listo para revisar. */
/** La categoría de tu lista con ese nombre (sin importar mayúsculas ni tildes); si no está, «Otros». */
const categoriaDe = (categorias: string[], nombre: string) => categorias.find((c) => normalizar(c) === normalizar(nombre));

const nuevoDesde = (p: z.infer<typeof Concepto>, lugares: Lugar[], formas: FormaPago[], categorias: string[]): FijoPropuesto => ({
  ...resolverAlcance(lugares, p.alcance, p.lugar, p.tipo, p.repartir_entre),
  nombre: p.nombre,
  categoria: categoriaDe(categorias, p.categoria) ?? "Otros",
  monto: Math.max(0, p.monto),
  variable: p.variable,
  moneda: monedaDe(p.moneda),
  dia: diaDe(p.dia),
  desfase: p.mes_vencido ? 1 : 0,
  frecuencia: frecuenciaDe(p.frecuencia) ?? "mensual",
  formaId: elegirForma(formas, p.forma)?.id ?? null,
  cuenta: p.cuenta,
  avisoDias: null,
  nota: p.nota,
  ...(p.como_figura.trim() ? { original: p.como_figura.trim() } : {}),
});

const textoAlcance = (f: Alcance, lugares: Lugar[]) => {
  const nombre = (id: number | null) => lugares.find((l) => l.id === id)?.nombre ?? "?";
  if (f.alcance === "general") return `general: ${f.tipo ?? "personal"}`;
  if (f.alcance === "repartido") return `repartido: ${(f.reparto ?? []).map((r) => nombre(r.lugarId) + (r.porcentaje === null ? "" : ` ${r.porcentaje} %`)).join(", ")}`;
  return `lugar: ${nombre(f.lugarId)}`;
};

/** Cómo ve la IA cada pago cargado: con los mismos formatos con que propone los cambios. */
const textoFijo = (f: Fijo, lugares: Lugar[], formas: FormaPago[]) =>
  [
    `#${f.id}`,
    `nombre: ${f.nombre}`,
    `alcance: ${textoAlcance(f, lugares)}`,
    `categoria: ${f.categoria}`,
    `monto: ${f.monto}`,
    `variable: ${f.variable ? "si" : "no"}`,
    `moneda: ${f.moneda}`,
    `vence: ${f.dia ?? 0}`,
    `pago: ${f.desfase ? "mes siguiente" : "mismo mes"}`,
    `aviso: ${f.avisoDias === null ? "general" : f.avisoDias < 0 ? "no" : f.avisoDias}`,
    `frecuencia: ${f.frecuencia}`,
    f.formaId && `forma: ${formas.find((x) => x.id === f.formaId)?.nombre ?? "?"}`,
    f.cuenta && `cuenta: ${f.cuenta}`,
    f.nota && `nota: ${f.nota}`,
  ]
    .filter(Boolean)
    .join(" | ");

const FORMATOS = `Formatos del valor de cada campo en "cambios":
- nombre, categoria, cuenta, nota: el texto nuevo ("" para vaciarlo).
- forma: una de sus formas de pago, tal cual figura ("" para que no tenga una fija).
- alcance: "lugar: <lugar>", "repartido: <lugar>, <lugar>" (sin lugares = todos los negocios) o "general: negocio" / "general: personal".
- monto: el número (650 mil = 650000). variable: "si" (cambia mes a mes) o "no". moneda: "ARS" o "USD".
- vence: el día del mes (1 a 31), o "0" para sacarle el vencimiento.
- pago: "mes siguiente" (lo de un mes se paga el siguiente: mes vencido) o "mismo mes".
- aviso: los días antes del vencimiento (0 = el mismo día), "no" para no avisar, o "general" para el aviso de siempre.
- frecuencia: una de ${FRECUENCIAS.join(", ")}.`;

/** Aplica un campo que cambió la IA. Lo que no se entiende se ignora (devuelve null). */
function conCampo(f: FijoPropuesto, campo: CampoFijo, valor: string, lugares: Lugar[], formas: FormaPago[], categorias: string[]): FijoPropuesto | null {
  const v = valor.trim();
  const numero = numeroDe(v);
  switch (campo) {
    case "nombre":
      return v ? { ...f, nombre: v } : null;
    case "categoria":
    {
      const categoria = categoriaDe(categorias, v);
      return categoria ? { ...f, categoria } : null;
    }
    case "forma": {
      if (!v) return { ...f, formaId: null };
      const forma = elegirForma(formas, v);
      return forma ? { ...f, formaId: forma.id } : null;
    }
    case "cuenta":
    case "nota":
      return { ...f, [campo]: v };
    case "monto":
      return Number.isFinite(numero) && numero >= 0 ? { ...f, monto: numero } : null;
    case "variable":
      return { ...f, variable: /^(s[ií]|true|variable|cambia)/i.test(v) };
    case "moneda":
      return { ...f, moneda: monedaDe(v) };
    case "vence":
      return Number.isFinite(numero) ? { ...f, dia: diaDe(numero) } : null;
    case "pago":
      return /siguiente|vencido|despu/i.test(v) ? { ...f, desfase: 1 } : /mismo/i.test(v) ? { ...f, desfase: 0 } : null;
    case "aviso":
      if (/general|siempre/i.test(v)) return { ...f, avisoDias: null };
      if (/^no/i.test(v)) return { ...f, avisoDias: -1 };
      return Number.isFinite(numero) && numero >= 0 ? { ...f, avisoDias: Math.min(30, Math.round(numero)) } : null;
    case "frecuencia": {
      const frecuencia = frecuenciaDe(v);
      return frecuencia ? { ...f, frecuencia } : null;
    }
    case "alcance": {
      const [tipoAlcance, resto = ""] = v.split(/:(.*)/s);
      const nombres = resto.split(",").map((x) => x.trim()).filter(Boolean);
      const a = resolverAlcance(lugares, tipoAlcance, nombres[0] ?? "", resto, nombres);
      // Repartido entre los mismos lugares: se respetan los porcentajes que ya tenía.
      const mismos = a.alcance === "repartido" && f.alcance === "repartido" && a.reparto?.length === f.reparto?.length && a.reparto?.every((r) => f.reparto?.some((x) => x.lugarId === r.lugarId));
      return mismos ? f : { ...f, lugarNuevo: undefined, ...a };
    }
  }
}

/** Si el campo quedó distinto (lo que la IA «cambia» por el mismo valor no se muestra). */
function cambio(a: FijoPropuesto, b: FijoPropuesto, campo: CampoFijo) {
  if (campo === "alcance")
    return a.alcance !== b.alcance || a.lugarId !== b.lugarId || a.tipo !== b.tipo || JSON.stringify(a.reparto) !== JSON.stringify(b.reparto) || a.lugarNuevo?.nombre !== b.lugarNuevo?.nombre;
  const clave = campo === "vence" ? "dia" : campo === "pago" ? "desfase" : campo === "aviso" ? "avisoDias" : campo === "forma" ? "formaId" : campo;
  return a[clave] !== b[clave];
}

const comoEntrada = ({ id: _, desde: __, estimado: ___, ...f }: Fijo): FijoPropuesto => f;

const esMes = (m: string) => /^\d{4}-(0[1-9]|1[0-2])$/.test(m);
const esFecha = (f: string) => /^\d{4}-\d{2}-\d{2}$/.test(f) && DateTime.fromISO(f).isValid;

/**
 * La IA de Pagos, una sola para todo: lo que dictás, escribís o pegás (una foto o un PDF), armado contra lo que ya
 * tenés: conceptos nuevos, cambios y borrados; montos de uno o varios meses (cada uno con el mes al que corresponde y,
 * si ya se pagó, con qué y cuándo) y pagos sueltos. No guarda nada: lo revisás y se aplica con `aplicarCarga`.
 */
export async function armarConIa(texto: string, archivo?: ArchivoIa) {
  const cfg = await conTope();
  const [lugares, fijos, formas, categorias, pendientes] = await Promise.all([listarLugares(), listarFijos(), formasActivas(), nombresDeCategorias(), pagosPendientes()]);
  const hoy = hoyIso();
  const puntuales = pendientes.filter((i) => !i.fijoId);
  const system = `Llevás los pagos de ${cfg.nombreUsuario} (sus locales, su casa, sus cosas). Hoy es ${hoy}. Te escribe o dicta como le sale, o te pasa una foto o un PDF (por ejemplo el resumen de impuestos que le manda la contadora): puede querer agregar, cambiar o borrar lo que paga siempre, cargar montos de uno o varios meses, marcar lo que ya está pagado o anotar pagos sueltos.
Lugares que ya tiene: ${lugares.map((l) => `${l.nombre} (${l.tipo})`).join(", ") || "ninguno"}.
Categorías (usá una de estas): ${categorias.join(", ")}.
Formas de pago que tiene: ${formas.map((f) => f.nombre).join(", ") || "ninguna"}.${notasDe(cfg.pagosNotasIa)}
${ALCANCES}
${MES_VENCIDO}

Lo que paga siempre:
${fijos.map((f) => textoFijo(f, lugares, formas)).join("\n") || "nada todavía"}

Pagos puntuales sin pagar (suscripciones, tarjetas, sueltos):
${puntuales.map((i) => `i:${i.id} | ${i.nombre} · ${i.lugar} | ${i.monto} ${i.moneda} | corresponde a ${i.periodo}`).join("\n") || "ninguno"}

Qué hacer:
- Lo que se paga siempre y no está en la lista va en "nuevos": un pago por cosa ("luz y gas en casa" son dos; "la luz de todos los locales" es una por local). Si nombra uno que ya está, es un cambio, no uno nuevo.
- Lo que quiere cambiar de lo que ya está va en "cambios", solo los campos que cambian. Lo que pide borrar, en "borrar". Nunca cambies ni borres algo que no pidió.
- Cada monto de un mes va en "montos", con el mes al que corresponde (el del gasto). Si reparte un pago en varios meses, un renglón por mes con su parte. Un monto de un concepto nuevo lleva su "ref".
- Un resumen con montos (el de la contadora): cada renglón con un monto es un pago; los subtotales y el total no (el total general va en "total"). Un título con el nombre de un negocio dice de qué negocio son los renglones de abajo. Si es uno de lo que paga siempre (el mismo concepto y del mismo negocio), el monto va a ese "#id"; si no, es uno nuevo (mensual y variable, con nombre corto y legible, sin la sigla del negocio: "F-931 SYA" → "F-931").
- Si dice que ya está pagado (o quién lo pagó: "lo pagó la contadora"), poné "pagado_por" y, si la dice, "fecha_pago".
- Lo de una sola vez, que no se repite, va en "sueltos".
- No inventes montos, fechas ni datos que no dijo.
${FORMATOS}`;
  const r = await pedir(cfg, EsquemaCarga, system, [{ role: "user", content: await contenido(texto, archivo) }]);

  // Conceptos: los nuevos (cada uno con su ref), los cambios y los borrados.
  const porId = new Map(fijos.map((f) => [f.id, f]));
  const pedidos = new Map<number, { campo: CampoFijo; valor: string }[]>();
  for (const c of r.cambios) {
    const campo = CAMPOS_FIJO.find((x) => x === normalizar(c.campo));
    if (campo && porId.has(c.id)) pedidos.set(c.id, [...(pedidos.get(c.id) ?? []), { campo, valor: c.valor }]);
  }
  const borrar = [...new Set(r.borrar)].filter((id) => porId.has(id) && !pedidos.has(id));
  const cambios = [...pedidos].flatMap(([id, lista]) => {
    const antes = comoEntrada(porId.get(id)!);
    const despues = lista.reduce((f, { campo, valor }) => conCampo(f, campo, valor, lugares, formas, categorias) ?? f, antes);
    const campos = CAMPOS_FIJO.filter((c) => cambio(antes, despues, c));
    return campos.length ? [{ id, despues, campos }] : [];
  });
  const refs = new Set<string>();
  const nuevos = r.nuevos.map((p, k) => {
    const ref = p.ref.trim() && !refs.has(p.ref.trim()) ? p.ref.trim() : `n${k + 1}`;
    refs.add(ref);
    return { ...nuevoDesde(p, lugares, formas, categorias), ref, refIa: p.ref.trim(), desde: esMes(p.desde) ? p.desde : "" };
  });

  // Montos: a qué pago van y cómo están hoy (lo que había y si ya estaba pagado).
  const meses = [...new Set(r.montos.map((m) => m.mes).filter(esMes))];
  const filas = await filasDeFijos(fijos.map((f) => f.id), meses);
  const vistos = new Set<string>();
  const sinDestino: string[] = [];
  const montos = r.montos.flatMap((m) => {
    const c = m.concepto.trim();
    const fijo = porId.get(Number(/^#?(\d+)$/.exec(c)?.[1]));
    const puntual = puntuales.find((i) => `i:${i.id}` === c.replace(/\s/g, ""));
    const nuevo = nuevos.find((n) => n.refIa === c || n.ref === c);
    const mes = puntual?.periodo ?? (esMes(m.mes) ? m.mes : periodoDe(hoy));
    const destino = fijo ? { fijoId: fijo.id } : puntual ? { itemId: puntual.id } : nuevo ? { ref: nuevo.ref } : null;
    const clave = `${JSON.stringify(destino)}|${mes}`;
    if (!destino || !(m.monto >= 0) || vistos.has(clave)) {
      if (!destino) sinDestino.push(m.como_figura.trim() || c);
      return [];
    }
    vistos.add(clave);
    const fila = fijo ? filas.find((x) => x.fijoId === fijo.id && x.periodo === mes) : undefined;
    const info = fijo
      ? { nombre: fijo.nombre, lugar: dondeVa(fijo, lugares), antes: fila?.monto ?? fijo.estimado, pagado: fila?.estado === "pagado" }
      : puntual
        ? { nombre: puntual.nombre, lugar: puntual.lugar, antes: puntual.monto, pagado: false }
        : { nombre: nuevo!.nombre, lugar: nuevo!.lugarNuevo?.nombre ?? dondeVa(nuevo!, lugares), antes: null, pagado: false };
    return [{ ...destino, mes, monto: m.monto, ...info, pagadoCon: elegirForma(formas, m.pagado_por)?.id ?? null, fechaPago: esFecha(m.fecha_pago) ? m.fecha_pago : null, original: m.como_figura.trim() }];
  });

  // Los nuevos: desde el primer mes de sus montos (si no lo dijo) y, si siempre lo pagó la misma (la contadora), con esa forma.
  for (const n of nuevos) {
    const suyos = montos.filter((m) => "ref" in m && m.ref === n.ref);
    n.desde ||= suyos.map((m) => m.mes).sort()[0] ?? periodoDe(hoy);
    const formasSuyas = [...new Set(suyos.map((m) => m.pagadoCon))];
    if (n.formaId === null && formasSuyas.length === 1 && formasSuyas[0]) n.formaId = formasSuyas[0];
  }

  const sueltos = r.sueltos.flatMap((s) => {
    if (!s.nombre.trim() || !(s.monto > 0)) return [];
    const { reparto: _, ...a } = resolverAlcance(lugares, s.lugar.trim() ? "lugar" : "general", s.lugar, s.tipo, []);
    return [
      {
        ...a,
        alcance: a.alcance === "lugar" ? ("lugar" as const) : ("general" as const),
        nombre: s.nombre.trim(),
        categoria: categoriaDe(categorias, s.categoria) ?? "Otros",
        monto: s.monto,
        moneda: monedaDe(s.moneda),
        fecha: esFecha(s.fecha) ? s.fecha : hoy,
        pagadoCon: elegirForma(formas, s.pagado_por)?.id ?? null,
        nota: s.nota.trim(),
        original: s.como_figura.trim(),
      },
    ];
  });

  const vacio = !nuevos.length && !cambios.length && !borrar.length && !montos.length && !sueltos.length;
  const avisoSinDestino = sinDestino.length ? `No supe a qué pago van: ${sinDestino.join(", ")}.` : "";
  return {
    nuevos: nuevos.map(({ refIa: _, ...n }) => n),
    cambios,
    borrar,
    montos,
    sueltos,
    totalImagen: r.total > 0 ? r.total : null,
    mensaje: [r.mensaje.trim(), avisoSinDestino].filter(Boolean).join(" ") || (vacio ? "No encontré nada para cargar, cambiar ni borrar. Probá decirlo de otra forma o con otra foto." : ""),
  };
}

const EsquemaAnalisis = z.object({ vinetas: z.array(z.string()).describe("De 3 a 6 viñetas cortas") });

/** El análisis del mes (lo pide el panel, o sale solo el día 1 por el mes que cerró). Se guarda para verlo en Pagos. */
export async function analizarMesPagos(periodo: string): Promise<string> {
  const cfg = await conTope();
  const [mes, resumen] = await Promise.all([verMes(periodo), resumenPagos(periodo, "pago")]);
  if (!mes.items.length) throw new ErrorUsuario(`No hay pagos en ${nombreMes(periodo)} para analizar.`);
  const montos = (t: { ARS: number; USD: number }) => [plata(t.ARS), t.USD ? plata(t.USD, "USD") : ""].filter(Boolean).join(" + ");
  const datos = [
    `Mes: ${mes.nombre}. Hoy es ${hoyIso()}.`,
    `Total ${montos(mes.totales.total)}; pagado ${montos(mes.totales.pagado)}; falta ${montos(mes.totales.falta)}; vencidos ${mes.totales.vencidos}.`,
    `Mes anterior: total ${montos(resumen.anterior.total)}.`,
    `Últimos meses (total): ${resumen.meses
      .slice(-6)
      .map((m) => `${m.periodo} ${montos(m.total)}`)
      .join(" · ")}.`,
    "Por lugar este mes: " + resumen.mes.porLugar.map((g) => `${g.nombre} ${montos(g.total)}`).join(", "),
    "Por categoría este mes: " + resumen.mes.porCategoria.map((g) => `${g.nombre} ${montos(g.total)}`).join(", "),
    "Pagos (nombre | lugar | vence | monto | pagado | estado):",
    ...mes.items.map((i) => `${i.nombre} | ${i.lugar} | ${i.vence ?? "sin vencimiento"} | ${plata(i.monto, i.moneda)} | ${plata(i.pagado, i.moneda)} | ${i.estado}${i.vencido ? " (vencido)" : ""}`),
    mes.alertas.length ? `Alertas calculadas: ${mes.alertas.join(" ")}` : "",
  ].join("\n");
  const system = `Sos el asistente de finanzas de ${cfg.nombreUsuario} (tiene locales, su casa y sus cosas). Analizás sus pagos del mes en español rioplatense, con voseo.
Escribí de 3 a 6 viñetas cortas y concretas: cómo viene el mes contra el anterior, subas o montos raros, lo que falta o venció, qué lugar o categoría pesa más, y un consejo práctico si lo hay.
Usá solo los números que te paso (no inventes). Montos como "$ 96.200". Sin saludos ni títulos.`;
  const r = await pedir(cfg, EsquemaAnalisis, system, [{ role: "user", content: datos }]);
  const texto = r.vinetas.map((v) => `• ${v.trim()}`).join("\n");
  await guardarAnalisis(periodo, texto);
  return texto;
}
