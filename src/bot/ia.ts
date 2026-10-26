import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { gte, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.js";
import { usoIa, type Configuracion } from "../db/schema.js";
import { entorno } from "../entorno.js";
import { descifrar } from "../lib/cifrado.js";
import { ahora, nombreDia } from "../lib/fechas.js";
import { registrar } from "../lib/log.js";

export const MODELOS = [
  { id: "claude-haiku-5-5", nombre: "Claude Haiku 5.5", entrada: 0.1, salida: 0.5 },
  { id: "claude-sonnet-5-5", nombre: "Claude Sonnet 5.5", entrada: 2, salida: 10 },
  { id: "claude-opus-5-5", nombre: "Claude Opus 5.5", entrada: 4, salida: 20 },
] as const;

export const ESFUERZOS = ["low", "medium", "high"] as const;
type Esfuerzo = (typeof ESFUERZOS)[number];

export class ErrorIA extends Error {}

const clientes = new Map<string, Anthropic>();
export function claveApi(cfg: Configuracion): string {
  const propia = cfg.iaApiKeyCifrada ? descifrar(cfg.iaApiKeyCifrada) : null;
  return propia || entorno.anthropicApiKey;
}
function cliente(cfg: Configuracion): Anthropic {
  const clave = claveApi(cfg);
  if (!clave) throw new ErrorIA("No hay API key de Claude configurada");
  let c = clientes.get(clave);
  if (!c) {
    c = new Anthropic({ apiKey: clave, timeout: 60_000, maxRetries: 2 });
    clientes.set(clave, c);
  }
  return c;
}

async function registrarUso(modelo: string, entrada: number, salida: number) {
  const precio = MODELOS.find((m) => m.id === modelo) ?? MODELOS[0];
  const costo = (entrada * precio.entrada + salida * precio.salida) / 1_000_000;
  await db.insert(usoIa).values({ modelo, tokensEntrada: entrada, tokensSalida: salida, costoUsd: costo.toFixed(6) });
}

export async function gastoDelMes() {
  const inicio = ahora().startOf("month").toJSDate();
  const [fila] = await db
    .select({
      costo: sql<string>`coalesce(sum(${usoIa.costoUsd}), 0)`,
      llamadas: sql<number>`count(*)::int`,
      entrada: sql<number>`coalesce(sum(${usoIa.tokensEntrada}), 0)::int`,
      salida: sql<number>`coalesce(sum(${usoIa.tokensSalida}), 0)::int`,
    })
    .from(usoIa)
    .where(gte(usoIa.creadoEn, inicio));
  return { costoUsd: Number(fila.costo), llamadas: fila.llamadas, tokensEntrada: fila.entrada, tokensSalida: fila.salida };
}

const esfuerzoDe = (cfg: Configuracion): Esfuerzo =>
  (ESFUERZOS as readonly string[]).includes(cfg.iaEsfuerzo) ? (cfg.iaEsfuerzo as Esfuerzo) : "low";

async function pedir<T extends z.ZodType>(
  cfg: Configuracion,
  esquema: T,
  system: string,
  messages: Anthropic.MessageParam[],
): Promise<z.infer<T>> {
  const inicio = Date.now();
  try {
    const r = await cliente(cfg).messages.parse({
      model: cfg.iaModelo,
      max_tokens: 4000,
      system,
      messages,
      output_config: { effort: esfuerzoDe(cfg), format: zodOutputFormat(esquema) },
    });
    await registrarUso(cfg.iaModelo, r.usage.input_tokens, r.usage.output_tokens);
    if (r.stop_reason === "refusal") throw new ErrorIA("El modelo rechazó el pedido");
    if (r.stop_reason === "max_tokens") throw new ErrorIA("La respuesta del modelo quedó cortada");
    if (!r.parsed_output) throw new ErrorIA("La respuesta del modelo no tiene el formato esperado");
    return r.parsed_output as z.infer<T>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await registrar("error", "ia", `Falló la IA (${cfg.iaModelo}, ${Date.now() - inicio} ms): ${msg}`);
    throw err instanceof ErrorIA ? err : new ErrorIA(msg);
  }
}

// ───────────── Interpretación de mensajes ─────────────

const Campos = z.object({
  titulo: z.string().nullable(),
  descripcion: z.string().nullable(),
  fecha_hora: z.string().nullable().describe("ISO 8601 con offset, ej. 2026-10-24T09:00:00-03:00"),
  recurrencia: z.string().nullable().describe("RRULE sin DTSTART, ej. FREQ=WEEKLY;BYDAY=MO"),
  avisos_previos_min: z.array(z.number()).nullable(),
});

export const EsquemaInterpretacion = z.object({
  intencion: z.enum([
    "crear_recordatorio",
    "listar",
    "confirmar",
    "posponer",
    "editar",
    "borrar",
    "pausar",
    "reanudar",
    "aceptar_propuesta",
    "rechazar_propuesta",
    "ayuda",
    "charla",
    "desconocido",
  ]),
  recordatorios: z.array(Campos).describe("Para crear_recordatorio: uno por cada recordatorio pedido"),
  cambios: Campos.extend({ quitar_recurrencia: z.boolean() }).nullable().describe("Para editar: solo lo que cambia, el resto null"),
  recordatorio_ids: z.array(z.number()).describe("IDs de la lista de recordatorios a los que se refiere"),
  referencia: z.string().nullable(),
  listar_desde: z.string().nullable(),
  listar_hasta: z.string().nullable(),
  posponer_minutos: z.number().nullable(),
  posponer_hasta: z.string().nullable(),
  falta_info: z.string().nullable().describe("Qué falta para poder hacerlo, ej. 'hora' o 'fecha'"),
  respuesta: z.string().nullable().describe("Texto para el usuario cuando hace falta preguntar o charlar"),
  confianza: z.number(),
});
export type Interpretacion = z.infer<typeof EsquemaInterpretacion>;

export type ContextoInterpretacion = {
  recordatoriosActivos: string;
  esperandoConfirmacion: string;
  propuestaPendiente: string | null;
  respondiendoA: string | null;
  historial: Anthropic.MessageParam[];
};

function promptSistema(cfg: Configuracion, ctx: ContextoInterpretacion): string {
  const t = ahora();
  return `Sos el asistente de recordatorios personal de ${cfg.nombreUsuario}, por WhatsApp. Hablás en español rioplatense, breve y amable (voseo: "dale", "listo", "avisame").
La fecha y hora actual es ${nombreDia(t.weekday)} ${t.toFormat("dd/MM/yyyy HH:mm")} (${cfg.zonaHoraria}, offset ${t.toFormat("ZZ")}).
Hora por defecto si no se indica: ${cfg.horaDefecto}. "A la tarde" = ${cfg.horaTarde}. "A la noche" = ${cfg.horaNoche}. "A la mañana" = ${cfg.horaDefecto}.

Tu tarea es interpretar el último mensaje del usuario y devolver SIEMPRE el JSON de intención.
Reglas:
- No inventes fechas. Si falta algo esencial (por ejemplo, "recordame llamar a Juan" sin ningún día), usá falta_info y en "respuesta" preguntá corto, ej. "¿Para cuándo te lo recuerdo?".
- Si hay día pero no hora, usá la hora por defecto. "Mañana", "pasado", "el finde" (sábado), "el lunes" (el próximo) se resuelven con la fecha actual.
- Relativos ("en 2 horas", "en 5 minutos") se calculan desde la hora actual exacta.
- fecha_hora siempre en ISO 8601 con offset. Para recurrentes, fecha_hora es la primera vez y recurrencia es una RRULE (sin DTSTART), ej. "todos los lunes a las 8" → FREQ=WEEKLY;BYDAY=MO;BYHOUR=8;BYMINUTE=0; "el 10 de cada mes" → FREQ=MONTHLY;BYMONTHDAY=10; "cada 3 días" → FREQ=DAILY;INTERVAL=3.
- "Avisame 1 hora antes y el día anterior" → avisos_previos_min [60, 1440]; fecha_hora es la del evento.
- Títulos cortos y claros, en infinitivo o sustantivo ("Llamar al dentista", "Pagar la luz"), sin "recordame".
- Para editar un recurrente al que le cambia la hora o los días, devolvé en cambios.recurrencia la RRULE completa actualizada y en cambios.fecha_hora la próxima vez.
- Para editar, borrar, pausar, reanudar o posponer algo puntual, poné en recordatorio_ids los IDs de la lista de abajo que coinciden; si hay más de uno posible, poné todos los candidatos.
- confirmar: "listo", "hecho", "ya está", "ya lo hice" sobre un aviso enviado.
- posponer: "posponé 15 min" → posponer_minutos 15; "mañana" o "a las 18" → posponer_hasta en ISO.
- listar: "¿qué tengo hoy/el jueves/esta semana?" → listar_desde y listar_hasta en ISO (inicio y fin del período).
- Si hay una propuesta pendiente y el usuario acepta ("sí", "dale", "ok") → aceptar_propuesta; si no la quiere → rechazar_propuesta; si la corrige ("mejor el 28") → crear_recordatorio con los datos corregidos.
- Para ayuda, charla o desconocido, poné en "respuesta" un texto corto que guíe (qué puede hacer el bot).
- confianza entre 0 y 1.

Recordatorios activos (ID | título | próxima vez | repetición):
${ctx.recordatoriosActivos || "(ninguno)"}

Avisos enviados esperando confirmación:
${ctx.esperandoConfirmacion || "(ninguno)"}

Propuesta pendiente de respuesta:
${ctx.propuestaPendiente ?? "(ninguna)"}${ctx.respondiendoA ? `\n\n${ctx.respondiendoA}` : ""}`;
}

export async function interpretar(cfg: Configuracion, texto: string, ctx: ContextoInterpretacion): Promise<Interpretacion> {
  const mensajes: Anthropic.MessageParam[] = [...ctx.historial, { role: "user", content: texto }];
  return pedir(cfg, EsquemaInterpretacion, promptSistema(cfg, ctx), unirTurnos(mensajes));
}

/** La API pide turnos alternados: junta mensajes seguidos del mismo rol. */
function unirTurnos(ms: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  const r: Anthropic.MessageParam[] = [];
  for (const m of ms) {
    const ultimo = r.at(-1);
    if (ultimo && ultimo.role === m.role && typeof ultimo.content === "string" && typeof m.content === "string")
      ultimo.content = `${ultimo.content}\n${m.content}`;
    else r.push({ ...m });
  }
  while (r[0]?.role === "assistant") r.shift();
  return r;
}

// ───────────── Fotos ─────────────

export const EsquemaFoto = z.object({
  tipo: z.enum(["factura", "turno", "entrada", "invitacion", "receta", "otro"]),
  descripcion: z.string().describe("Qué es, en una frase"),
  util: z.boolean().describe("true si tiene datos para armar un recordatorio"),
  titulo: z.string().nullable(),
  fecha_evento: z.string().nullable().describe("Vencimiento o fecha del evento, ISO 8601 con offset"),
  monto: z.string().nullable(),
  lugar: z.string().nullable(),
  propuesta_fecha_hora: z.string().nullable().describe("Cuándo conviene avisar, ISO 8601 con offset"),
  propuesta_avisos_previos_min: z.array(z.number()),
  mensaje: z.string().describe("Mensaje para el usuario proponiendo el recordatorio o preguntando qué hacer"),
});
export type AnalisisFoto = z.infer<typeof EsquemaFoto>;

export async function analizarFoto(cfg: Configuracion, imagen: Buffer, mime: string, epigrafe: string | null): Promise<AnalisisFoto> {
  const t = ahora();
  const system = `Sos el asistente de recordatorios de ${cfg.nombreUsuario} por WhatsApp. Hablás en español rioplatense, breve.
La fecha y hora actual es ${nombreDia(t.weekday)} ${t.toFormat("dd/MM/yyyy HH:mm")} (offset ${t.toFormat("ZZ")}). Hora por defecto: ${cfg.horaDefecto}.
Te mandan una foto (factura, turno, entrada, invitación, etc.). Extraé qué es, la fecha, hora, monto y lugar.
Proponé cuándo avisar:
- Facturas y vencimientos: el día anterior al vencimiento a las 10:00.
- Turnos y eventos con hora: a la hora del evento, con avisos previos de 60 y 1440 minutos.
- Si el texto al pie indica cuándo avisar, respetalo.
En "mensaje" escribí la propuesta, ej.: "Veo una factura de luz que vence el 30/10 por $25.400. ¿Te lo recuerdo el 29/10 a las 10:00?".
Si la foto no tiene datos útiles, util=false y en "mensaje" preguntá qué querés que haga con ella.
No inventes datos que no se vean.`;
  const content: Anthropic.ContentBlockParam[] = [
    { type: "image", source: { type: "base64", media_type: mime as "image/jpeg", data: imagen.toString("base64") } },
    { type: "text", text: epigrafe ? `Texto al pie: ${epigrafe}` : "Sin texto al pie." },
  ];
  return pedir(cfg, EsquemaFoto, system, [{ role: "user", content }]);
}

export async function probarConexion(cfg: Configuracion): Promise<{ ok: boolean; mensaje: string; ms: number }> {
  const inicio = Date.now();
  try {
    const r = await cliente(cfg).messages.create({
      model: cfg.iaModelo,
      max_tokens: 200,
      output_config: { effort: "low" },
      messages: [{ role: "user", content: "Respondé solo: OK" }],
    });
    await registrarUso(cfg.iaModelo, r.usage.input_tokens, r.usage.output_tokens);
    const texto = r.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("").trim();
    return { ok: true, mensaje: `Respondió "${texto.slice(0, 40)}" con ${cfg.iaModelo}`, ms: Date.now() - inicio };
  } catch (err) {
    return { ok: false, mensaje: err instanceof Error ? err.message : String(err), ms: Date.now() - inicio };
  }
}
