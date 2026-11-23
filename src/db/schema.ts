import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const ts = (nombre: string) => timestamp(nombre, { withTimezone: true });
const creadoEn = () => ts("creado_en").notNull().defaultNow();

/** Acceso al panel: solo PIN (una sola fila). */
export const accesoPanel = pgTable("acceso_panel", {
  id: serial("id").primaryKey(),
  pinHash: text("pin_hash").notNull(),
  intentosFallidos: integer("intentos_fallidos").notNull().default(0),
  bloqueadoHasta: ts("bloqueado_hasta"),
  // Se incrementa al cambiar el PIN para invalidar las sesiones abiertas.
  versionSesion: integer("version_sesion").notNull().default(1),
  creadoEn: creadoEn(),
});

export type Plantillas = {
  confirmacion: string;
  aviso: string;
  previo: string;
  insistencia: string;
  atrasado: string;
  resumen: string;
};

/** Configuración editable desde el panel (una sola fila, id = 1). */
export const configuracion = pgTable("configuracion", {
  id: integer("id").primaryKey().default(1),
  nombreUsuario: text("nombre_usuario").notNull().default("Lucas"),
  numeroAutorizado: text("numero_autorizado").notNull().default(""),
  lidAutorizado: text("lid_autorizado"),
  zonaHoraria: text("zona_horaria").notNull().default("America/Argentina/Buenos_Aires"),
  horaDefecto: text("hora_defecto").notNull().default("09:00"),
  horaTarde: text("hora_tarde").notNull().default("16:00"),
  horaNoche: text("hora_noche").notNull().default("21:00"),

  insistenciaActiva: boolean("insistencia_activa").notNull().default(true),
  insistenciaIntervaloMin: integer("insistencia_intervalo_min").notNull().default(60),
  insistenciaTope: integer("insistencia_tope").notNull().default(5),
  insistirPrevios: boolean("insistir_previos").notNull().default(false),
  avisarEnHoraDefecto: boolean("avisar_en_hora_defecto").notNull().default(true),

  silencioActivo: boolean("silencio_activo").notNull().default(false),
  silencioDesde: text("silencio_desde").notNull().default("23:00"),
  silencioHasta: text("silencio_hasta").notNull().default("07:30"),
  silencioDias: integer("silencio_dias").array().notNull().default([1, 2, 3, 4, 5, 6, 7]),
  botSilenciadoHasta: ts("bot_silenciado_hasta"),

  resumenActivo: boolean("resumen_activo").notNull().default(false),
  resumenHora: text("resumen_hora").notNull().default("08:00"),
  resumenDias: integer("resumen_dias").array().notNull().default([1, 2, 3, 4, 5, 6, 7]),
  resumenIncluirPendientes: boolean("resumen_incluir_pendientes").notNull().default(true),
  resumenUltimoEnvio: text("resumen_ultimo_envio"),

  iaModelo: text("ia_modelo").notNull().default("claude-haiku-5-5"),
  iaEsfuerzo: text("ia_esfuerzo").notNull().default("low"),
  iaApiKeyCifrada: text("ia_api_key_cifrada"),

  plantillas: jsonb("plantillas").$type<Partial<Plantillas>>().notNull().default({}),

  sesionDuracionDias: integer("sesion_duracion_dias").notNull().default(30),
  maxIntentosLogin: integer("max_intentos_login").notNull().default(5),
  bloqueoMinutos: integer("bloqueo_minutos").notNull().default(15),

  fotoMaxMb: integer("foto_max_mb").notNull().default(10),
  limpiezaFotosActiva: boolean("limpieza_fotos_activa").notNull().default(false),
  limpiezaFotosDias: integer("limpieza_fotos_dias").notNull().default(90),

  demoraMinMs: integer("demora_min_ms").notNull().default(1000),
  demoraMaxMs: integer("demora_max_ms").notNull().default(3000),
  alertaDesconexionMin: integer("alerta_desconexion_min").notNull().default(10),
  minutosAtrasado: integer("minutos_atrasado").notNull().default(3),

  groqApiKeyCifrada: text("groq_api_key_cifrada"),
  audioModelo: text("audio_modelo").notNull().default("whisper-large-v3-turbo"),
  audioMaxSegundos: integer("audio_max_segundos").notNull().default(120),

  // Opciones para tocar (encuestas de WhatsApp) en avisos y propuestas.
  usarEncuestas: boolean("usar_encuestas").notNull().default(true),

  /** Cuántos días antes del vencimiento de una suscripción avisa el bot (además del día que vence). */
  suscripcionesDiasAviso: integer("suscripciones_dias_aviso").notNull().default(3),
  /** Cuántos días antes del vencimiento del resumen de una tarjeta avisa el bot (con el saldo y el pago mínimo). */
  tarjetasDiasAviso: integer("tarjetas_dias_aviso").notNull().default(2),
  /** Tope de gasto de IA por mes (US$): al llegar, el asistente deja de usarse y queda lo básico. */
  agenteTopeUsd: integer("agente_tope_usd").notNull().default(10),

  actualizadoEn: ts("actualizado_en").notNull().defaultNow(),
});

export const adjunto = pgTable("adjunto", {
  id: serial("id").primaryKey(),
  rutaArchivo: text("ruta_archivo").notNull(),
  mime: text("mime").notNull(),
  tamano: integer("tamano").notNull(),
  descripcionIa: text("descripcion_ia"),
  datosExtraidos: jsonb("datos_extraidos").$type<Record<string, unknown>>(),
  creadoEn: creadoEn(),
});

/** Grupos de WhatsApp donde está el bot (y el dueño). */
export const grupo = pgTable("grupo", {
  jid: text("jid").primaryKey(),
  nombre: text("nombre").notNull(),
  /** Era el grupo de compras: a la primera foto o PDF se le avisa que las facturas ahora van al ERP, y pasa a ser normal. */
  compras: boolean("compras").notNull().default(false),
  creadoEn: creadoEn(),
  actualizadoEn: ts("actualizado_en").notNull().defaultNow(),
});

/** Notas: título y contenido van cifrados con APP_SECRET. */
export const nota = pgTable("nota", {
  id: serial("id").primaryKey(),
  tituloCifrado: text("titulo_cifrado").notNull(),
  contenidoCifrado: text("contenido_cifrado").notNull(),
  categoria: text("categoria").notNull().default("otros"),
  adjuntoId: integer("adjunto_id").references(() => adjunto.id, { onDelete: "set null" }),
  creadoEn: creadoEn(),
  actualizadoEn: ts("actualizado_en").notNull().defaultNow(),
});

/** "Mis links": los accesos que más usás, en el orden que elegís. Concepto y URL van cifrados. */
export const linkGuardado = pgTable("link_guardado", {
  id: serial("id").primaryKey(),
  datosCifrados: text("datos_cifrados").notNull(),
  orden: integer("orden").notNull().default(0),
  creadoEn: creadoEn(),
  actualizadoEn: ts("actualizado_en").notNull().defaultNow(),
});

/** Notas de las calculadoras (ej. la de Bavosi), una por clave, cifradas. */
export const notaCalculadora = pgTable("nota_calculadora", {
  clave: text("clave").primaryKey(),
  textoCifrado: text("texto_cifrado").notNull(),
  actualizadoEn: ts("actualizado_en").notNull().defaultNow(),
});

export type FrecuenciaSuscripcion = "7dias" | "quincenal" | "mensual" | "anual";

/** Servicios que se pagan cada tanto (Netflix, hosting, dominios…) y vencen. */
export const suscripcion = pgTable(
  "suscripcion",
  {
    id: serial("id").primaryKey(),
    nombre: text("nombre").notNull(),
    url: text("url").notNull().default(""),
    fechaInicio: date("fecha_inicio"),
    fechaVto: date("fecha_vto").notNull(),
    monto: numeric("monto", { precision: 14, scale: 2, mode: "number" }).notNull().default(0),
    moneda: text("moneda").$type<"ARS" | "USD">().notNull().default("ARS"),
    frecuencia: text("frecuencia").$type<FrecuenciaSuscripcion>().notNull(),
    observacion: text("observacion").notNull().default(""),
    /** Avisos de este vencimiento ya enviados por WhatsApp (se reinician al renovar o cambiar la fecha). */
    avisoPrevioEnviado: boolean("aviso_previo_enviado").notNull().default(false),
    avisoDiaEnviado: boolean("aviso_dia_enviado").notNull().default(false),
    /** "Recordame mañana": cuándo vuelve a avisar. */
    recordarEn: ts("recordar_en"),
    creadoEn: creadoEn(),
    actualizadoEn: ts("actualizado_en").notNull().defaultNow(),
  },
  (t) => [index("suscripcion_vto_idx").on(t.fechaVto)],
);

// ───────────── Tarjetas de crédito ─────────────
// Los importes y los comercios van cifrados (un JSON por fila, en "datosCifrados"); a la vista quedan solo las fechas
// y los números de cuota que hacen falta para calcular.

/** Una tarjeta, con los datos del último resumen (o cargados a mano). */
export const tarjeta = pgTable("tarjeta", {
  id: serial("id").primaryKey(),
  nombre: text("nombre").notNull(),
  ultimos4: text("ultimos4").notNull().default(""),
  /** Último cierre y su vencimiento. */
  cierre: date("cierre"),
  vencimiento: date("vencimiento"),
  /** Vencimiento del que ya se mandó el aviso por WhatsApp. */
  avisoVtoPara: date("aviso_vto_para"),
  /** Límites, disponibles, saldo y pago mínimo. */
  datosCifrados: text("datos_cifrados").notNull(),
  creadoEn: creadoEn(),
  actualizadoEn: ts("actualizado_en").notNull().defaultNow(),
});

/** Historial de resúmenes importados: uno por tarjeta y fecha de cierre (reimportar lo reemplaza). */
export const tarjetaResumen = pgTable(
  "tarjeta_resumen",
  {
    id: serial("id").primaryKey(),
    tarjetaId: integer("tarjeta_id")
      .notNull()
      .references(() => tarjeta.id, { onDelete: "cascade" }),
    cierre: date("cierre").notNull(),
    vencimiento: date("vencimiento"),
    /** Saldo, pago mínimo, disponibles y cargos del banco (intereses, IVA, comisiones, percepciones). */
    datosCifrados: text("datos_cifrados").notNull(),
    creadoEn: creadoEn(),
  },
  (t) => [uniqueIndex("tarjeta_resumen_cierre_idx").on(t.tarjetaId, t.cierre)],
);

/**
 * Compras en cuotas. cuotaActual es la que se cobró en el cierre "cierreBase"; en cada cierre siguiente avanza sola
 * una más (se calcula, no se guarda), hasta que un resumen nuevo trae el dato real.
 */
export const tarjetaCuota = pgTable(
  "tarjeta_cuota",
  {
    id: serial("id").primaryKey(),
    tarjetaId: integer("tarjeta_id")
      .notNull()
      .references(() => tarjeta.id, { onDelete: "cascade" }),
    fechaCompra: date("fecha_compra"),
    cuotaActual: integer("cuota_actual").notNull(),
    cuotaTotal: integer("cuota_total").notNull(),
    cierreBase: date("cierre_base").notNull(),
    /** Comercio y monto de cada cuota. */
    datosCifrados: text("datos_cifrados").notNull(),
    creadoEn: creadoEn(),
    actualizadoEn: ts("actualizado_en").notNull().defaultNow(),
  },
  (t) => [index("tarjeta_cuota_tarjeta_idx").on(t.tarjetaId)],
);

/** Consumos de un solo pago que se repiten cada mes (Netflix en la tarjeta, por ejemplo), detectados al importar. */
export const tarjetaConsumo = pgTable(
  "tarjeta_consumo",
  {
    id: serial("id").primaryKey(),
    tarjetaId: integer("tarjeta_id")
      .notNull()
      .references(() => tarjeta.id, { onDelete: "cascade" }),
    /** Nombre y monto de cada período ({ "2026-11": 4599 }): un monto por período, sin repetidos. */
    datosCifrados: text("datos_cifrados").notNull(),
    creadoEn: creadoEn(),
    actualizadoEn: ts("actualizado_en").notNull().defaultNow(),
  },
  (t) => [index("tarjeta_consumo_tarjeta_idx").on(t.tarjetaId)],
);

export type EstadoRecordatorio = "activo" | "pausado" | "cumplido" | "no_confirmado" | "borrado";
export type ModoInsistencia = "global" | "propia" | "off";

export const recordatorio = pgTable(
  "recordatorio",
  {
    id: serial("id").primaryKey(),
    titulo: text("titulo").notNull(),
    descripcion: text("descripcion"),
    // Primera fecha (o DTSTART de la recurrencia).
    fechaHora: ts("fecha_hora").notNull(),
    rrule: text("rrule"),
    // Instancia que está programada ahora (la próxima o la que se está avisando).
    proximaInstancia: ts("proxima_instancia"),
    avisosPreviosMin: integer("avisos_previos_min").array().notNull().default([]),
    avisarEnHora: boolean("avisar_en_hora").notNull().default(true),
    insistenciaModo: text("insistencia_modo").$type<ModoInsistencia>().notNull().default("global"),
    insistenciaIntervaloMin: integer("insistencia_intervalo_min"),
    insistenciaTope: integer("insistencia_tope"),
    insistirPrevios: boolean("insistir_previos"),
    estado: text("estado").$type<EstadoRecordatorio>().notNull().default("activo"),
    origen: text("origen").$type<"whatsapp" | "panel" | "foto" | "enlace">().notNull().default("panel"),
    adjuntoId: integer("adjunto_id").references(() => adjunto.id, { onDelete: "set null" }),
    // Grupo donde avisa (null = privado del dueño).
    chat: text("chat"),
    creadoEn: creadoEn(),
    actualizadoEn: ts("actualizado_en").notNull().defaultNow(),
  },
  (t) => [index("recordatorio_estado_idx").on(t.estado)],
);

export type EstadoOcurrencia = "pendiente" | "enviada" | "confirmada" | "no_confirmada" | "cancelada";

export const ocurrencia = pgTable(
  "ocurrencia",
  {
    id: serial("id").primaryKey(),
    recordatorioId: integer("recordatorio_id")
      .notNull()
      .references(() => recordatorio.id, { onDelete: "cascade" }),
    // Hora del evento (la instancia) a la que pertenece este aviso.
    instancia: ts("instancia").notNull(),
    programadaPara: ts("programada_para").notNull(),
    tipo: text("tipo").$type<"principal" | "previo">().notNull(),
    minutosAntes: integer("minutos_antes").notNull().default(0),
    // Próximo envío pendiente (primer aviso, insistencia o pospuesto). Null = nada más que enviar.
    proximoEnvioEn: ts("proximo_envio_en"),
    insiste: boolean("insiste").notNull().default(false),
    intervaloMin: integer("intervalo_min").notNull().default(60),
    tope: integer("tope").notNull().default(5),
    enviadaEn: ts("enviada_en"),
    ultimoEnvioEn: ts("ultimo_envio_en"),
    intentos: integer("intentos").notNull().default(0),
    confirmadaEn: ts("confirmada_en"),
    pospuestaHasta: ts("pospuesta_hasta"),
    estado: text("estado").$type<EstadoOcurrencia>().notNull().default("pendiente"),
    atrasada: boolean("atrasada").notNull().default(false),
    waMessageId: text("wa_message_id"),
    creadoEn: creadoEn(),
  },
  (t) => [
    index("ocurrencia_envio_idx").on(t.estado, t.proximoEnvioEn),
    index("ocurrencia_recordatorio_idx").on(t.recordatorioId),
  ],
);

export const mensaje = pgTable(
  "mensaje",
  {
    id: serial("id").primaryKey(),
    direccion: text("direccion").$type<"entrante" | "saliente">().notNull(),
    texto: text("texto"),
    tipo: text("tipo").$type<"texto" | "imagen" | "reaccion" | "audio" | "encuesta" | "voto" | "otro">().notNull().default("texto"),
    waMessageId: text("wa_message_id"),
    intencionDetectada: text("intencion_detectada"),
    recordatorioId: integer("recordatorio_id").references(() => recordatorio.id, { onDelete: "set null" }),
    ocurrenciaId: integer("ocurrencia_id").references(() => ocurrencia.id, { onDelete: "set null" }),
    adjuntoId: integer("adjunto_id").references(() => adjunto.id, { onDelete: "set null" }),
    /** Aviso de vencimiento de una suscripción (para contestarle "renovada" citándolo). */
    suscripcionId: integer("suscripcion_id").references(() => suscripcion.id, { onDelete: "set null" }),
    // Grupo (null = privado) y quién lo escribió en el grupo.
    chat: text("chat"),
    autor: text("autor"),
    creadoEn: creadoEn(),
  },
  (t) => [index("mensaje_creado_idx").on(t.creadoEn), index("mensaje_wa_idx").on(t.waMessageId)],
);

/** Propuestas que esperan respuesta ("¿te lo recuerdo el 29?"). */
export const borradorPendiente = pgTable("borrador_pendiente", {
  id: serial("id").primaryKey(),
  tipo: text("tipo").$type<"foto">().notNull().default("foto"),
  datos: jsonb("datos").$type<Record<string, unknown>>().notNull(),
  chat: text("chat"),
  expiraEn: ts("expira_en").notNull(),
  creadoEn: creadoEn(),
});

export type AccionEncuesta =
  | { tipo: "aviso"; ocurrenciaId: number }
  | { tipo: "propuesta"; borradorId: number }
  | { tipo: "elegir"; ids: number[]; interpretacion: Record<string, unknown> }
  | { tipo: "suscripcion"; suscripcionId: number };

/** Encuestas que manda el bot: la clave para descifrar los votos y qué hacer con cada opción. */
export const encuesta = pgTable(
  "encuesta",
  {
    id: serial("id").primaryKey(),
    waMessageId: text("wa_message_id").notNull(),
    chat: text("chat"),
    secreto: text("secreto").notNull(),
    opciones: jsonb("opciones").$type<string[]>().notNull(),
    accion: jsonb("accion").$type<AccionEncuesta>().notNull(),
    respondidaEn: ts("respondida_en"),
    creadoEn: creadoEn(),
  },
  (t) => [uniqueIndex("encuesta_wa_idx").on(t.waMessageId)],
);

export const logSistema = pgTable(
  "log_sistema",
  {
    id: serial("id").primaryKey(),
    nivel: text("nivel").$type<"info" | "aviso" | "error">().notNull(),
    origen: text("origen").notNull(),
    mensaje: text("mensaje").notNull(),
    detalle: jsonb("detalle"),
    creadoEn: creadoEn(),
  },
  (t) => [index("log_creado_idx").on(t.creadoEn)],
);

export const usoIa = pgTable("uso_ia", {
  id: serial("id").primaryKey(),
  modelo: text("modelo").notNull(),
  tokensEntrada: integer("tokens_entrada").notNull(),
  tokensSalida: integer("tokens_salida").notNull(),
  costoUsd: numeric("costo_usd", { precision: 12, scale: 6 }).notNull(),
  creadoEn: creadoEn(),
});

// ───────────── Tu WhatsApp (el personal, vinculado aparte del bot) ─────────────
// Lo lee el asistente: chats y contactos, los mensajes de los últimos 7 días (texto cifrado) y los mensajes que
// le pediste programar. Al desvincularlo se borra todo.

/** Chats y contactos. nombre: el de tu agenda; apodo: el que se puso la persona en WhatsApp. */
export const waChat = pgTable("wa_chat", {
  jid: text("jid").primaryKey(),
  nombre: text("nombre"),
  apodo: text("apodo"),
  esGrupo: boolean("es_grupo").notNull().default(false),
  ultimoMensajeEn: ts("ultimo_mensaje_en"),
});

/** Mensajes: texto y autor cifrados. guardarHasta: 7 días después de enviado (1 día si se trajo de más atrás). */
export const waMensaje = pgTable(
  "wa_mensaje",
  {
    id: serial("id").primaryKey(),
    waId: text("wa_id").notNull(),
    chatJid: text("chat_jid").notNull(),
    /** El chat como lo nombra WhatsApp (puede ser un LID): hace falta para pedir mensajes más viejos. */
    remoteJid: text("remote_jid").notNull(),
    deMi: boolean("de_mi").notNull(),
    datosCifrados: text("datos_cifrados").notNull(),
    enviadoEn: ts("enviado_en").notNull(),
    guardarHasta: ts("guardar_hasta").notNull(),
  },
  (t) => [uniqueIndex("wa_mensaje_unico").on(t.chatJid, t.waId), index("wa_mensaje_chat_idx").on(t.chatJid, t.enviadoEn), index("wa_mensaje_hasta_idx").on(t.guardarHasta)],
);

export type EstadoProgramado = "pendiente" | "enviado" | "vencido" | "error";

/** Mensajes que confirmaste para mandar más tarde desde tu WhatsApp. */
export const waProgramado = pgTable(
  "wa_programado",
  {
    id: serial("id").primaryKey(),
    chatJid: text("chat_jid").notNull(),
    /** { texto, para } */
    datosCifrados: text("datos_cifrados").notNull(),
    enviarEn: ts("enviar_en").notNull(),
    estado: text("estado").$type<EstadoProgramado>().notNull().default("pendiente"),
    creadoEn: creadoEn(),
  },
  (t) => [index("wa_programado_idx").on(t.estado, t.enviarEn)],
);

export type Recordatorio = typeof recordatorio.$inferSelect;
export type Ocurrencia = typeof ocurrencia.$inferSelect;
export type Configuracion = typeof configuracion.$inferSelect;
export type Adjunto = typeof adjunto.$inferSelect;
export type Nota = typeof nota.$inferSelect;
export type Grupo = typeof grupo.$inferSelect;
export type Suscripcion = typeof suscripcion.$inferSelect;
export type Tarjeta = typeof tarjeta.$inferSelect;
export type TarjetaCuota = typeof tarjetaCuota.$inferSelect;
