import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
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
    tipo: text("tipo").$type<"texto" | "imagen" | "reaccion" | "otro">().notNull().default("texto"),
    waMessageId: text("wa_message_id"),
    intencionDetectada: text("intencion_detectada"),
    recordatorioId: integer("recordatorio_id").references(() => recordatorio.id, { onDelete: "set null" }),
    ocurrenciaId: integer("ocurrencia_id").references(() => ocurrencia.id, { onDelete: "set null" }),
    adjuntoId: integer("adjunto_id").references(() => adjunto.id, { onDelete: "set null" }),
    creadoEn: creadoEn(),
  },
  (t) => [index("mensaje_creado_idx").on(t.creadoEn), index("mensaje_wa_idx").on(t.waMessageId)],
);

/** Propuestas que esperan respuesta ("¿te lo recuerdo el 29?"). */
export const borradorPendiente = pgTable("borrador_pendiente", {
  id: serial("id").primaryKey(),
  tipo: text("tipo").$type<"foto">().notNull().default("foto"),
  datos: jsonb("datos").$type<Record<string, unknown>>().notNull(),
  expiraEn: ts("expira_en").notNull(),
  creadoEn: creadoEn(),
});

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

export type Recordatorio = typeof recordatorio.$inferSelect;
export type Ocurrencia = typeof ocurrencia.$inferSelect;
export type Configuracion = typeof configuracion.$inferSelect;
export type Adjunto = typeof adjunto.$inferSelect;
