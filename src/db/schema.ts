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
import type { proto } from "baileys";

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
  /** La IA no anda por algo que no depende del mensaje (sin crédito, clave, Anthropic caído): desde cuándo y por qué. */
  iaFalla: jsonb("ia_falla").$type<{ motivo: MotivoFallaIA; desde: string }>(),
  /**
   * Crédito de la cuenta de Claude que dijo el usuario (Anthropic no deja consultarlo) y desde cuándo: el saldo es esto
   * menos lo gastado desde entonces. avisado: el último aviso de que se acaba ("7" o "2" días), para no repetirlo.
   */
  iaSaldoUsd: numeric("ia_saldo_usd", { precision: 12, scale: 6, mode: "number" }),
  iaSaldoDesde: ts("ia_saldo_desde"),
  iaSaldoAvisado: text("ia_saldo_avisado").$type<"7" | "2">(),

  /** Pagos: primer mes que se arma solo (el de la primera vez que se abre), días de aviso y los mensajes del mes. */
  pagosDesde: text("pagos_desde"),
  pagosDiasAviso: integer("pagos_dias_aviso").notNull().default(3),
  pagosMensajes: boolean("pagos_mensajes").notNull().default(true),
  /** Lo que la IA de Pagos tiene que saber de tus negocios (qué locales son de qué empresa, cómo se reparte algo…). */
  pagosNotasIa: text("pagos_notas_ia").notNull().default(""),
  /** Mes del que ya se mandó el mensaje del día 1 y el de mitad de mes. */
  pagosMensajeInicio: text("pagos_mensaje_inicio"),
  pagosMensajeMitad: text("pagos_mensaje_mitad"),

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

/**
 * Bloc: pestañas de texto largo, como el Bloc de notas de la compu. Título y texto cifrados. version sube en cada
 * guardado: si llega un guardado hecho sobre una versión vieja (otro dispositivo escribió antes), lo de antes va al
 * historial y no se pierde nada. cerradaEn: en la papelera (30 días).
 */
export const blocPestana = pgTable("bloc_pestana", {
  id: serial("id").primaryKey(),
  tituloCifrado: text("titulo_cifrado").notNull(),
  textoCifrado: text("texto_cifrado").notNull(),
  orden: integer("orden").notNull().default(0),
  version: integer("version").notNull().default(1),
  /** Fijada en pantalla: en la compu, en la ventanita que queda encima de todo; en el celular, arriba del Bloc. */
  fijada: boolean("fijada").notNull().default(false),
  /** Lo resaltado: tramos del texto (desde, hasta), aparte para que el texto quede limpio al copiarlo. */
  resaltados: jsonb("resaltados").$type<{ desde: number; hasta: number }[]>().notNull().default([]),
  cerradaEn: ts("cerrada_en"),
  creadoEn: creadoEn(),
  actualizadoEn: ts("actualizado_en").notNull().defaultNow(),
});

/** Versiones anteriores de cada pestaña (las últimas 30), para recuperar lo que se borró sin querer. */
export const blocVersion = pgTable(
  "bloc_version",
  {
    id: serial("id").primaryKey(),
    pestanaId: integer("pestana_id")
      .notNull()
      .references(() => blocPestana.id, { onDelete: "cascade" }),
    textoCifrado: text("texto_cifrado").notNull(),
    /** Por qué se guardó: un rato de escritura, otro dispositivo, antes de restaurar otra. */
    motivo: text("motivo").$type<"guardado" | "otro_dispositivo" | "antes_de_restaurar">().notNull(),
    creadoEn: creadoEn(),
  },
  (t) => [index("bloc_version_pestana_idx").on(t.pestanaId, t.creadoEn)],
);

/**
 * Imágenes pegadas en una pestaña del Bloc (se ven como miniaturas arriba del texto). Los archivos están cifrados en
 * MEDIA/bloc: "archivo" es el nombre base (<archivo>.bin la grande y <archivo>-mini.bin la miniatura).
 */
export const blocImagen = pgTable(
  "bloc_imagen",
  {
    id: serial("id").primaryKey(),
    pestanaId: integer("pestana_id")
      .notNull()
      .references(() => blocPestana.id, { onDelete: "cascade" }),
    archivo: text("archivo").notNull(),
    ancho: integer("ancho").notNull(),
    alto: integer("alto").notNull(),
    bytes: integer("bytes").notNull(),
    creadoEn: creadoEn(),
  },
  (t) => [index("bloc_imagen_pestana_idx").on(t.pestanaId)],
);

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
    /** Con qué tarjeta se paga (suma al próximo resumen de esa tarjeta). sinTarjeta: se paga con otro medio. */
    tarjetaId: integer("tarjeta_id").references(() => tarjeta.id, { onDelete: "set null" }),
    sinTarjeta: boolean("sin_tarjeta").notNull().default(false),
    /** Es del negocio (en Pagos cuenta como "General · negocio"; si no, personal). */
    negocio: boolean("negocio").notNull().default(false),
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
  /** Cierre del que ya se mandó el aviso de "esto te viene en el resumen". */
  avisoCierrePara: date("aviso_cierre_para"),
  /** Límites, disponibles, saldo y pago mínimo. */
  datosCifrados: text("datos_cifrados").notNull(),
  /** Es del negocio (en Pagos cuenta como "General · negocio"; si no, personal). */
  negocio: boolean("negocio").notNull().default(false),
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

/**
 * Compras en un pago que cargaste (en el panel o pidiéndoselo al asistente) para estimar el próximo resumen. Al
 * importar el resumen que ya las trae, se borran solas. Descripción y monto van cifrados.
 */
export const tarjetaGasto = pgTable(
  "tarjeta_gasto",
  {
    id: serial("id").primaryKey(),
    tarjetaId: integer("tarjeta_id")
      .notNull()
      .references(() => tarjeta.id, { onDelete: "cascade" }),
    fecha: date("fecha").notNull(),
    moneda: text("moneda").$type<"ARS" | "USD">().notNull().default("ARS"),
    datosCifrados: text("datos_cifrados").notNull(),
    creadoEn: creadoEn(),
  },
  (t) => [index("tarjeta_gasto_tarjeta_idx").on(t.tarjetaId, t.fecha)],
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

// ───────────── Pagos ─────────────
// Lo que pagás mes a mes en cada lugar (locales, casa, auto…). Nombres, montos, números de cliente y notas van
// cifrados (un JSON por fila en "datosCifrados"); a la vista quedan las fechas, lugares y categorías para ordenar.

export type TipoLugar = "negocio" | "personal";

export const pagoLugar = pgTable("pago_lugar", {
  id: serial("id").primaryKey(),
  nombre: text("nombre").notNull(),
  tipo: text("tipo").$type<TipoLugar>().notNull().default("negocio"),
  orden: integer("orden").notNull().default(0),
  creadoEn: creadoEn(),
});

/** tercero: «Lo pagó: …» (otra persona lo pagó por vos: queda en su cuenta corriente). */
export type TipoFormaPago = "transferencia" | "efectivo" | "debito_automatico" | "billetera" | "credito" | "debito" | "otro" | "tercero";

/**
 * Personas que pagan cosas por vos (la contadora, un socio…): cada una tiene su cuenta corriente. Lo que pagan va con
 * la forma de pago «Lo pagó: …» (se crea sola); lo que vos les pagás, en pago_persona_pago.
 */
export const pagoPersona = pgTable("pago_persona", {
  id: serial("id").primaryKey(),
  nombre: text("nombre").notNull(),
  /** El saldo al empezar (lo que le debías; negativo, lo que tenías a favor). */
  datosCifrados: text("datos_cifrados").notNull(),
  creadoEn: creadoEn(),
});

/** Lo que le pagaste a una persona (transferencia, efectivo…): baja lo que le debés. No es un gasto: el gasto es lo que ella pagó. */
export const pagoPersonaPago = pgTable(
  "pago_persona_pago",
  {
    id: serial("id").primaryKey(),
    personaId: integer("persona_id")
      .notNull()
      .references(() => pagoPersona.id, { onDelete: "cascade" }),
    fecha: date("fecha").notNull(),
    formaId: integer("forma_id").references(() => pagoForma.id, { onDelete: "set null" }),
    /** Monto y nota. */
    datosCifrados: text("datos_cifrados").notNull(),
    creadoEn: creadoEn(),
  },
  (t) => [index("pago_persona_pago_persona_idx").on(t.personaId)],
);

/**
 * Con qué se paga (Transferencia Galicia, Efectivo, Visa Santander…). Las tarjetas de la sección Tarjetas aparecen solas
 * (tarjetaId). Las que ya se usaron no se borran: se archivan, así el historial sigue mostrando con qué se pagó.
 */
export const pagoForma = pgTable("pago_forma", {
  id: serial("id").primaryKey(),
  nombre: text("nombre").notNull(),
  tipo: text("tipo").$type<TipoFormaPago>().notNull().default("otro"),
  orden: integer("orden").notNull().default(0),
  archivada: boolean("archivada").notNull().default(false),
  tarjetaId: integer("tarjeta_id")
    .unique()
    .references(() => tarjeta.id, { onDelete: "set null" }),
  /** «Lo pagó: …»: la persona que lo pagó por vos (aparece sola, una por persona). */
  personaId: integer("persona_id")
    .unique()
    .references(() => pagoPersona.id, { onDelete: "cascade" }),
  creadoEn: creadoEn(),
});

/** Las categorías de Pagos (Alquiler, Servicios…): se editan en Configuración. Los pagos guardan el nombre. */
export const pagoCategoria = pgTable("pago_categoria", {
  id: serial("id").primaryKey(),
  nombre: text("nombre").notNull(),
  orden: integer("orden").notNull().default(0),
  creadoEn: creadoEn(),
});

export type FrecuenciaPago = "mensual" | "bimestral" | "trimestral" | "cuatrimestral" | "semestral" | "anual" | "unica";
/**
 * A qué corresponde un pago: un lugar (el alquiler del local), repartido entre varios (el contador, entre los locales)
 * o general, sin lugar físico (la tarjeta, la cuota del auto), que igual es de negocio o personal.
 */
export type AlcancePago = "lugar" | "repartido" | "general";
/** Entre qué lugares se reparte: sin porcentajes, en partes iguales. */
export type RepartoPago = { lugarId: number; porcentaje: number | null }[];

/** Lo que se paga siempre (alquiler, luz, sueldos…): cada mes que le toca aparece solo en la lista del mes. */
export const pagoFijo = pgTable("pago_fijo", {
  id: serial("id").primaryKey(),
  /** Solo con alcance "lugar". */
  lugarId: integer("lugar_id").references(() => pagoLugar.id, { onDelete: "restrict" }),
  alcance: text("alcance").$type<AlcancePago>().notNull().default("lugar"),
  /** Con alcance "general": de negocio o personal. */
  tipo: text("tipo").$type<TipoLugar>(),
  /** Con alcance "repartido". */
  reparto: jsonb("reparto").$type<RepartoPago>(),
  categoria: text("categoria").notNull(),
  frecuencia: text("frecuencia").$type<FrecuenciaPago>().notNull().default("mensual"),
  /** Día del mes en que vence (si el mes es más corto, el último día). null: no tiene vencimiento. */
  dia: integer("dia"),
  /** Primer mes en que se paga ("2026-11"): de ahí cuenta la frecuencia. */
  desde: text("desde").notNull(),
  moneda: text("moneda").$type<"ARS" | "USD">().notNull().default("ARS"),
  /** Variable (luz, gas): el monto es un estimado y se sugiere con lo de los meses anteriores. */
  variable: boolean("variable").notNull().default(false),
  /** Con qué se paga siempre (la que aparece marcada al tocar «Pagado»). */
  formaId: integer("forma_id").references(() => pagoForma.id, { onDelete: "set null" }),
  /** Días antes para avisar por WhatsApp: null = los de Configuración; -1 = no avisar. */
  avisoDias: integer("aviso_dias"),
  /** Nombre, monto, número de cliente o cuenta y nota. */
  datosCifrados: text("datos_cifrados").notNull(),
  creadoEn: creadoEn(),
  actualizadoEn: ts("actualizado_en").notNull().defaultNow(),
});

export type EstadoPago = "pendiente" | "parcial" | "pagado" | "omitido";

/**
 * Cada pago de cada mes: los que salen de los fijos, de las suscripciones y de los resúmenes de las tarjetas, y los
 * sueltos. Guarda el nombre, el lugar y la categoría del momento (si después cambia el fijo, el historial no cambia).
 */
export const pagoMes = pgTable(
  "pago_mes",
  {
    id: serial("id").primaryKey(),
    periodo: text("periodo").notNull(),
    /** null: no tiene vencimiento (nunca queda vencido ni se avisa antes). */
    vence: date("vence"),
    lugarId: integer("lugar_id").references(() => pagoLugar.id, { onDelete: "restrict" }),
    alcance: text("alcance").$type<AlcancePago>().notNull().default("lugar"),
    tipo: text("tipo").$type<TipoLugar>(),
    reparto: jsonb("reparto").$type<RepartoPago>(),
    categoria: text("categoria").notNull(),
    moneda: text("moneda").$type<"ARS" | "USD">().notNull().default("ARS"),
    estado: text("estado").$type<EstadoPago>().notNull().default("pendiente"),
    fijoId: integer("fijo_id").references(() => pagoFijo.id, { onDelete: "set null" }),
    suscripcionId: integer("suscripcion_id").references(() => suscripcion.id, { onDelete: "set null" }),
    tarjetaId: integer("tarjeta_id").references(() => tarjeta.id, { onDelete: "set null" }),
    /** Pagado: con qué se pagó. Sin pagar: la que aparece marcada al tocar «Pagado» (la del fijo o la última usada). */
    formaId: integer("forma_id").references(() => pagoForma.id, { onDelete: "set null" }),
    /** Último pago (el de la parte que completó, si fue en partes). */
    pagadoEn: date("pagado_en"),
    avisoPrevioEnviado: boolean("aviso_previo_enviado").notNull().default(false),
    avisoDiaEnviado: boolean("aviso_dia_enviado").notNull().default(false),
    /** Comprobante (foto o PDF), cifrado en MEDIA/pagos. */
    comprobante: text("comprobante"),
    comprobanteMime: text("comprobante_mime"),
    /** Nombre, monto esperado, el de la boleta, los pagos (monto y fecha de cada parte), cuenta y nota. */
    datosCifrados: text("datos_cifrados").notNull(),
    creadoEn: creadoEn(),
    actualizadoEn: ts("actualizado_en").notNull().defaultNow(),
  },
  (t) => [
    index("pago_mes_periodo_idx").on(t.periodo),
    uniqueIndex("pago_mes_fijo_idx").on(t.fijoId, t.periodo),
    uniqueIndex("pago_mes_suscripcion_idx").on(t.suscripcionId, t.vence),
    uniqueIndex("pago_mes_tarjeta_idx").on(t.tarjetaId, t.vence),
  ],
);

/** Una fila de pago_fijo o pago_mes guardada tal cual (las fechas como texto), para volverla a como estaba. */
export type FilaGuardada<T> = { [K in keyof T]: T[K] extends Date ? string : T[K] extends Date | null ? string | null : T[K] };

/**
 * Qué hizo una carga con IA y cómo estaba antes, para deshacerla. creados: los conceptos que creó (pagadoCon: lo
 * dejó pagado con esa forma); cambiados: los que cambió, como estaban; borrados: los que borró, con sus pagos sin
 * pagar que se fueron y los ya pagados que siguieron (historial); meses: los pagos del mes que tocó, como estaban. Las
 * reconstruidas (de antes del registro) no tienen huellas: lo tocado después se sabe por la fecha.
 */
export type RegistroCarga = {
  lugares: number[];
  categorias: string[];
  creados: { id: number; pagadoCon?: number }[];
  cambiados: FilaGuardada<typeof pagoFijo.$inferSelect>[];
  borrados: { fijo: FilaGuardada<typeof pagoFijo.$inferSelect>; filas: FilaGuardada<typeof pagoMes.$inferSelect>[]; historial: number[] }[];
  meses: { antes: FilaGuardada<typeof pagoMes.$inferSelect>; pagadoCon?: number }[];
  /** Cómo quedó cada cosa que tocó ("f:id" un concepto, "m:id" un pago del mes): si cambió, la tocaste después. */
  huellas?: Record<string, string>;
};

/**
 * Cada vez que aplicás lo que propuso la IA (los conceptos de Configuración o los montos de un mes): lo que le pasaste
 * (texto y archivo, cifrados) y lo que hizo, para verlo, deshacerlo o corregirlo. borrador: la IA ya leyó, todavía no
 * aplicaste. reconstruida: de antes de este registro (solo se sabe lo que creó).
 */
export const pagoCarga = pgTable("pago_carga", {
  id: serial("id").primaryKey(),
  tipo: text("tipo").$type<"config" | "mes">().notNull(),
  /** El mes de los montos (mes) o desde cuándo van los conceptos nuevos (config). */
  periodo: text("periodo"),
  estado: text("estado").$type<"borrador" | "aplicada">().notNull().default("borrador"),
  reconstruida: boolean("reconstruida").notNull().default(false),
  /** Lo que escribiste y el detalle de lo que hizo. */
  datosCifrados: text("datos_cifrados").notNull().default(""),
  registro: jsonb("registro").$type<RegistroCarga>(),
  /** La foto o el PDF (cifrado en MEDIA/pagos-cargas); se borra a los 12 meses. */
  archivo: text("archivo"),
  archivoMime: text("archivo_mime"),
  aplicadaEn: ts("aplicada_en"),
  creadoEn: creadoEn(),
});

/** El análisis de la IA de cada mes (al cerrarlo, o cuando se pide). */
export const pagoAnalisis = pgTable("pago_analisis", {
  periodo: text("periodo").primaryKey(),
  textoCifrado: text("texto_cifrado").notNull(),
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

export type Canal = "whatsapp" | "panel";
/** Por qué no anda la IA cuando no depende del mensaje. */
export type MotivoFallaIA = "sin_credito" | "clave" | "caido";

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
    /** Dónde fue la charla: WhatsApp o el Asistente del panel (son conversaciones separadas). */
    canal: text("canal").$type<Canal>().notNull().default("whatsapp"),
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

/**
 * Mensajes de WhatsApp que llegaron mientras la IA no andaba: se hacen solos cuando vuelve (los de más de 24 h no).
 * clave: la del mensaje original, para reaccionarle.
 */
export const iaPendiente = pgTable("ia_pendiente", {
  id: serial("id").primaryKey(),
  mensajeId: integer("mensaje_id")
    .notNull()
    .references(() => mensaje.id, { onDelete: "cascade" }),
  clave: jsonb("clave").$type<proto.IMessageKey>().notNull(),
  /** El aviso que citaba (para "posponelo una hora" respondiendo a un aviso). */
  ocurrenciaId: integer("ocurrencia_id").references(() => ocurrencia.id, { onDelete: "set null" }),
  creadoEn: creadoEn(),
});

export type AccionEncuesta =
  | { tipo: "aviso"; ocurrenciaId: number }
  | { tipo: "propuesta"; borradorId: number }
  | { tipo: "elegir"; ids: number[]; interpretacion: Record<string, unknown> }
  | { tipo: "suscripcion"; suscripcionId: number }
  /** "¿Es el ABL de Casa?" (foto de un comprobante): el borrador tiene el pago y la foto. */
  | { tipo: "pago"; borradorId: number }
  /** "¿Con qué pagaste…?": cada opción es una forma de pago (formaIds, en el orden de las opciones). */
  | { tipo: "formaPago"; borradorId: number; formaIds: number[] };

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

/**
 * Chats y contactos. nombre: el de tu agenda; apodo: el que se puso la persona en WhatsApp; alias: como le decís vos
 * al asistente ("Maca"), siempre ese chat.
 */
export const waChat = pgTable("wa_chat", {
  jid: text("jid").primaryKey(),
  nombre: text("nombre"),
  apodo: text("apodo"),
  alias: text("alias"),
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
export type PagoMes = typeof pagoMes.$inferSelect;
export type TarjetaCuota = typeof tarjetaCuota.$inferSelect;
