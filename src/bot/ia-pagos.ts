import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { normalizar, plata } from "../lib/textos.js";
import { obtenerConfig } from "../servicios/configuracion.js";
import { comoWebp } from "../servicios/archivos-cifrados.js";
import { guardarAnalisis, listarFijos, listarLugares, pagosQueCorresponden, resumenPagos, verMes, type Alcance } from "../servicios/pagos.js";
import type { FijoPropuesto } from "../servicios/pagos-cargas.js";
import type { FrecuenciaPago, TipoLugar } from "../db/schema.js";
import { elegirForma, formasActivas, type FormaPago } from "../servicios/pagos-formas.js";
import { nombresDeCategorias } from "../servicios/pagos-categorias.js";
import { MESES_DE, nombreMes, type Moneda } from "../servicios/pagos-reglas.js";
import { hoyIso } from "../lib/fechas.js";
import { ErrorUsuario } from "../servicios/recordatorios.js";
import { gastoDelMes, pedir } from "./ia.js";

// La IA en Pagos: arma y cambia la lista de lo que pagás a partir de lo que dictás, y analiza cada mes.

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

const EsquemaArmado = z.object({
  nuevos: z.array(Concepto).describe("Los pagos que no están en la lista y hay que agregar"),
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

/**
 * Lo que dictaste o pegaste, armado contra lo que ya tenés cargado: pagos nuevos, cambios a los que están y los que
 * pediste borrar. No guarda nada: lo revisás y se aplica con `aplicarFijos`.
 */
export async function armarFijosConIa(texto: string, archivo?: ArchivoIa) {
  const cfg = await conTope();
  const [lugares, fijos, formas, categorias] = await Promise.all([listarLugares(), listarFijos(), formasActivas(), nombresDeCategorias()]);
  const system = `Llevás la lista de pagos que ${cfg.nombreUsuario} hace siempre (sus locales, su casa, sus cosas). Te escribe o dicta como le sale, o te pasa una foto o un PDF: puede querer agregar pagos, cambiar los que tiene o borrarlos.
Lugares que ya tiene: ${lugares.map((l) => `${l.nombre} (${l.tipo})`).join(", ") || "ninguno"}.
Categorías (usá una de estas): ${categorias.join(", ")}.
Formas de pago que tiene: ${formas.map((f) => f.nombre).join(", ") || "ninguna"}.${notasDe(cfg.pagosNotasIa)}
${ALCANCES}
${MES_VENCIDO}

Pagos que ya tiene cargados:
${fijos.map((f) => textoFijo(f, lugares, formas)).join("\n") || "ninguno"}

Qué hacer:
- Lo que no está en la lista va en "nuevos": un pago por cosa ("luz y gas en casa" son dos). "La luz de todos los locales" es una luz por cada local (no repartido).
- Lo que ya está y quiere cambiar va en "cambios", solo los campos que cambian. "Todos" o "todos los de X" se refiere a cada pago de la lista que corresponda.
- Lo que pide borrar va en "borrar". Nunca borres ni cambies algo que no pidió.
- Si nombra un pago que ya está, es un cambio (no uno nuevo). No inventes montos ni datos que no dijo.
${FORMATOS}`;
  const r = await pedir(cfg, EsquemaArmado, system, [{ role: "user", content: await contenido(texto, archivo) }]);

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
  const nuevos = r.nuevos.map((p) => nuevoDesde(p, lugares, formas, categorias));
  const vacio = !nuevos.length && !cambios.length && !borrar.length;
  return {
    nuevos,
    cambios,
    borrar,
    totalImagen: r.total > 0 ? r.total : null,
    mensaje: r.mensaje.trim() || (vacio ? "No encontré nada para agregar, cambiar ni borrar. Probá decirlo de otra forma." : ""),
  };
}

const EsquemaMes = z.object({
  montos: z
    .array(z.object({ id: z.number().int().describe("El id (#) del pago del mes"), monto: z.number(), como_figura: z.string().describe("El renglón tal cual figura") }))
    .describe("Los renglones que son pagos del mes que ya están, con el monto que figura"),
  nuevos: z.array(Concepto).describe("Los renglones que no están entre los pagos del mes: se crean como pago fijo, con el monto que figura"),
  total: z.number().describe("El total general que figura (no un subtotal); 0 si no hay"),
  mensaje: z.string().describe('Lo que no pudiste leer o no entendiste, corto y con voseo. Si leíste todo: ""'),
});

/**
 * Los montos que corresponden a un mes (el gasto: lo de octubre, aunque se pague en noviembre) a partir de un archivo
 * o un texto (el resumen de impuestos de la contadora, por ejemplo): a qué pago de ese mes va cada monto, qué pagos hay
 * que crear y si la suma da el total que figura. No guarda nada: lo revisás y se aplica con `aplicarMes`.
 */
export async function cargarMesConIa(periodo: string, texto: string, archivo?: ArchivoIa) {
  const cfg = await conTope();
  const [lugares, formas, pagos, categorias] = await Promise.all([listarLugares(), formasActivas(), pagosQueCorresponden(periodo), nombresDeCategorias()]);
  const items = pagos.filter((i) => i.estado !== "omitido");
  const system = `Cargás los montos que corresponden a ${nombreMes(periodo)} (el mes del gasto, aunque se paguen el mes siguiente) en los pagos de ${cfg.nombreUsuario} (sus locales, su casa, sus cosas), a partir de lo que te pasa: una foto, captura o PDF (por ejemplo el resumen de impuestos que le manda la contadora) o un texto.
Lugares que tiene: ${lugares.map((l) => `${l.nombre} (${l.tipo})`).join(", ") || "ninguno"}.
Categorías (usá una de estas): ${categorias.join(", ")}.
Formas de pago que tiene: ${formas.map((f) => f.nombre).join(", ") || "ninguna"}.${notasDe(cfg.pagosNotasIa)}
${ALCANCES}
${MES_VENCIDO}

Pagos que corresponden a ${nombreMes(periodo)} (id | pago · lugar | monto actual | estado):
${items.map((i) => `#${i.id} | ${i.nombre} · ${i.alcance === "repartido" ? i.partes.map((p) => p.lugar).join(", ") : i.lugar} | ${i.monto} ${i.moneda} | ${i.estado}`).join("\n") || "ninguno"}

Qué hacer:
- Cada renglón con un monto es un pago. Los subtotales y el total no son pagos: el total general va en "total".
- Un título o bloque con el nombre de un negocio dice a qué corresponden los renglones de abajo.
- Si el renglón es uno de los pagos del mes (el mismo concepto y del mismo negocio), va en "montos" con su id. Si no, va en "nuevos".
- Los nuevos: nombre corto y legible, en mayúsculas y minúsculas y sin la sigla del negocio ("F-931 SYA" → "F-931", "CENTRO EMPL COMERCIO" → "Centro de Empleados de Comercio"); mensuales y variables (los impuestos y cargas cambian cada mes); dia 0 salvo que figure el vencimiento; mes_vencido según la regla de arriba.
- Montos en números, sin redondear ($ 2.896.003,34 = 2896003.34). No inventes nada que no figure.`;
  const r = await pedir(cfg, EsquemaMes, system, [{ role: "user", content: await contenido(texto, archivo) }]);

  const porId = new Map(items.map((i) => [i.id, i]));
  const vistos = new Set<number>();
  const montos = r.montos
    .filter((m) => porId.has(m.id) && m.monto >= 0 && !vistos.has(m.id) && !!vistos.add(m.id))
    .map((m) => {
      const i = porId.get(m.id)!;
      // A qué va: al concepto de todos los meses (así sirve aunque cambies el mes) o, si no sale de uno, a ese pago.
      return { ...(i.fijoId ? { fijoId: i.fijoId } : { itemId: i.id }), monto: m.monto, antes: i.monto, nombre: i.nombre, lugar: i.lugar, pagado: i.estado === "pagado", original: m.como_figura.trim() };
    });
  const nuevos = r.nuevos.map((p) => nuevoDesde(p, lugares, formas, categorias));
  return {
    periodo,
    /** Todo lo que leyó, también lo que ya tenía ese monto (así la suma se compara con el total). */
    montos,
    nuevos,
    totalImagen: r.total > 0 ? r.total : null,
    mensaje: r.mensaje.trim() || (!montos.length && !nuevos.length ? "No encontré montos para cargar. Probá con otra foto o decilo con texto." : ""),
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
