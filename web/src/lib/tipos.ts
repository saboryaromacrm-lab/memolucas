export type EstadoRecordatorio = "activo" | "pausado" | "cumplido" | "no_confirmado" | "borrado";
export type ModoInsistencia = "global" | "propia" | "off";

export type Recordatorio = {
  id: number;
  titulo: string;
  descripcion: string | null;
  fechaHora: string;
  rrule: string | null;
  proximaInstancia: string | null;
  avisosPreviosMin: number[];
  avisarEnHora: boolean;
  insistenciaModo: ModoInsistencia;
  insistenciaIntervaloMin: number | null;
  insistenciaTope: number | null;
  insistirPrevios: boolean | null;
  estado: EstadoRecordatorio;
  origen: "whatsapp" | "panel" | "foto" | "enlace";
  adjuntoId: number | null;
  chat: string | null;
  grupoNombre: string | null;
  creadoEn: string;
  actualizadoEn: string;
  repeticion: string | null;
  cuando: string;
  proxima: string;
  insistenciaEfectiva: { activa: boolean; intervalo: number; tope: number; previos: boolean };
  adjuntoUrl: string | null;
};

export type Ocurrencia = {
  id: number;
  recordatorioId: number;
  instancia: string;
  programadaPara: string;
  tipo: "principal" | "previo";
  minutosAntes: number;
  proximoEnvioEn: string | null;
  insiste: boolean;
  intervaloMin: number;
  tope: number;
  enviadaEn: string | null;
  ultimoEnvioEn: string | null;
  intentos: number;
  confirmadaEn: string | null;
  pospuestaHasta: string | null;
  estado: "pendiente" | "enviada" | "confirmada" | "no_confirmada" | "cancelada";
  atrasada: boolean;
};

export type RecordatorioDetalle = Recordatorio & { ocurrencias: Ocurrencia[] };

export type EstadoWa = "iniciando" | "conectando" | "esperando_qr" | "conectado" | "desconectado" | "sesion_cerrada";

export type InfoWhatsapp = {
  estado: EstadoWa;
  qr: string | null;
  numeroVinculado: string | null;
  numeroVinculadoTexto: string | null;
  desconectadoDesde: string | null;
  ultimoError: string | null;
  numeroAutorizado: string;
  numeroAutorizadoTexto: string;
  ultimoMensajeRecibido: string | null;
  alerta: boolean;
  minutosCaido: number;
};

/** Tu WhatsApp personal (el que lee el asistente). */
export type InfoPersonal = {
  estado: EstadoWa;
  qr: string | null;
  numeroVinculado: string | null;
  numeroVinculadoTexto: string | null;
  ultimoError: string | null;
  chats: number;
  mensajes: number;
  programados: { id: number; enviarEn: string; para: string; texto: string }[];
};

export type Plantillas = {
  confirmacion: string;
  aviso: string;
  previo: string;
  insistencia: string;
  atrasado: string;
  resumen: string;
};

export type Configuracion = {
  nombreUsuario: string;
  numeroAutorizado: string;
  zonaHoraria: string;
  horaDefecto: string;
  horaTarde: string;
  horaNoche: string;
  insistenciaActiva: boolean;
  insistenciaIntervaloMin: number;
  insistenciaTope: number;
  insistirPrevios: boolean;
  avisarEnHoraDefecto: boolean;
  silencioActivo: boolean;
  silencioDesde: string;
  silencioHasta: string;
  silencioDias: number[];
  botSilenciadoHasta: string | null;
  resumenActivo: boolean;
  resumenHora: string;
  resumenDias: number[];
  resumenIncluirPendientes: boolean;
  iaModelo: string;
  iaEsfuerzo: "low" | "medium" | "high";
  plantillas: Partial<Plantillas>;
  sesionDuracionDias: number;
  maxIntentosLogin: number;
  bloqueoMinutos: number;
  fotoMaxMb: number;
  limpiezaFotosActiva: boolean;
  limpiezaFotosDias: number;
  demoraMinMs: number;
  demoraMaxMs: number;
  alertaDesconexionMin: number;
  minutosAtrasado: number;
  audioModelo: string;
  audioMaxSegundos: number;
  usarEncuestas: boolean;
  suscripcionesDiasAviso: number;
  tarjetasDiasAviso: number;
  agenteTopeUsd: number;
  groqKeyPropia: boolean;
  groqKeyEntorno: boolean;
  apiKeyPropia: boolean;
  apiKeyEntorno: boolean;
  apiKeyDisponible: boolean;
  modelos: { id: string; nombre: string; entrada: number; salida: number }[];
  esfuerzos: string[];
  plantillasDefecto: Plantillas;
};

export type Evento = { recordatorio: Recordatorio; cuando: string };

export type EstadoPanel = {
  whatsapp: InfoWhatsapp;
  configInicialPendiente: boolean;
  nombre: string;
  silenciadoHasta: string | null;
  hoy: Evento[];
  manana: Evento[];
  pendientes: { ocurrencia: Ocurrencia; recordatorio: Recordatorio }[];
  contadores: { activos: number; cumplidosSemana: number; noConfirmados: number };
  ia: {
    costoUsd: number;
    llamadas: number;
    tokensEntrada: number;
    tokensSalida: number;
    modelo: string;
    /** La IA no anda (sin crédito, la clave o Anthropic caído) y cuántos mensajes esperan. */
    falla: { motivo: "sin_credito" | "clave" | "caido"; desde: string; causa: string; guardados: number } | null;
    /** Saldo aproximado de la cuenta de Claude (null si nunca se cargó); dias: para cuántos alcanza (null si no gasta). */
    credito: { saldoUsd: number; porDiaUsd: number; dias: number | null } | null;
  };
};

export type Mensaje = {
  id: number;
  direccion: "entrante" | "saliente";
  texto: string | null;
  tipo: "texto" | "imagen" | "reaccion" | "audio" | "encuesta" | "voto" | "otro";
  intencionDetectada: string | null;
  recordatorioId: number | null;
  recordatorioTitulo: string | null;
  adjuntoUrl: string | null;
  chat: string | null;
  autor: string | null;
  creadoEn: string;
};

export type Grupo = { jid: string; nombre: string };

export type Log = { id: number; nivel: "info" | "aviso" | "error"; origen: string; mensaje: string; detalle: unknown; creadoEn: string };


export type Nota = {
  id: number;
  titulo: string;
  contenido: string;
  categoria: string;
  adjuntoId: number | null;
  adjuntoUrl: string | null;
  creadoEn: string;
  actualizadoEn: string;
};

export type FrecuenciaSuscripcion = "7dias" | "quincenal" | "mensual" | "anual";
export type Suscripcion = {
  id: number;
  nombre: string;
  url: string;
  fechaInicio: string | null;
  fechaVto: string;
  monto: number;
  moneda: "ARS" | "USD";
  frecuencia: FrecuenciaSuscripcion;
  observacion: string;
  /** Con qué tarjeta se paga; sinTarjeta: con otro medio. */
  tarjetaId: number | null;
  sinTarjeta: boolean;
};
/** Con qué tarjeta parece pagarse una suscripción (aparece en sus débitos). */
export type SugerenciaTarjeta = { tarjetaId: number; tarjeta: string; comoAparece: string };

export type CuotaTarjeta = {
  id: number;
  comercio: string;
  montoCuota: number;
  montoTotal: number;
  fechaCompra: string | null;
  cuotaTotal: number;
  /** La cuota que ya se cobró (avanza sola en cada cierre). */
  actual: number;
  restantes: number;
  finalizada: boolean;
  ultimoCierre: string;
};
export type LineaResumen = {
  tipo: "cuota" | "suscripcion" | "debito" | "compra" | "saldo";
  descripcion: string;
  detalle: string | null;
  monto: number;
  moneda: "ARS" | "USD";
  id: number | null;
};
/** Lo que se estima del próximo resumen (sin impuestos ni intereses). */
export type ProximoResumen = {
  cierre: string;
  vencimiento: string | null;
  lineas: LineaResumen[];
  totalArs: number;
  totalUsd: number;
  /** Cierre de un resumen que todavía no se importó. */
  sinImportar: string | null;
  /** Cierre del último resumen del que no se marcó cuánto se pagó. */
  faltaPago: string | null;
  pagado: number | null;
};
export type Tarjeta = {
  id: number;
  nombre: string;
  ultimos4: string;
  cierre: string | null;
  vencimiento: string | null;
  limiteCompra: number;
  limiteCuotas: number;
  disponibleCompra: number;
  disponibleCuotas: number;
  saldo: number;
  pagoMinimo: number;
  usoLimite: number | null;
  proximoResumen: ProximoResumen;
  totalAdeudado: number;
  ultimoResumen: { cierre: string; vencimiento: string | null } | null;
  cantidadResumenes: number;
  cuotas: CuotaTarjeta[];
  finalizadas: CuotaTarjeta[];
  proyeccion: { mes: string; cuotas: number; libera: number; disponible: number; terminan: string[] }[];
  consumos: { id: number; nombre: string; periodo: string | null; monto: number; anterior: number | null; variacion: number | null }[];
};

export type Link = { id: number; concepto: string; url: string };

// ───────────── Pagos ─────────────

export type Moneda = "ARS" | "USD";
export type Totales = { ARS: number; USD: number };
export type TipoLugar = "negocio" | "personal";
export type EstadoPago = "pendiente" | "parcial" | "pagado" | "omitido";
export type FrecuenciaPago = "mensual" | "bimestral" | "trimestral" | "cuatrimestral" | "semestral" | "anual" | "unica";

export type LugarPago = { id: number; nombre: string; tipo: TipoLugar; orden: number; fijos?: number };

export type ItemPago = {
  id: number;
  periodo: string;
  vence: string;
  nombre: string;
  lugarId: number | null;
  lugar: string;
  tipo: TipoLugar;
  categoria: string;
  moneda: Moneda;
  estado: EstadoPago;
  monto: number;
  esperado: number;
  boleta: number | null;
  pagado: number;
  falta: number;
  pagos: { monto: number; fecha: string }[];
  vencido: boolean;
  medio: string;
  pagadoEn: string | null;
  cuenta: string;
  nota: string;
  origen: "fijo" | "suscripcion" | "tarjeta" | "suelto";
  fijoId: number | null;
  /** Tipo del comprobante (image/webp o application/pdf), o null si no tiene. */
  comprobante: string | null;
};

export type MesPagos = {
  periodo: string;
  nombre: string;
  items: ItemPago[];
  totales: { total: Totales; pagado: Totales; falta: Totales; cantidad: number; pendientes: number; vencidos: number };
  alertas: string[];
  analisis: { texto: string; creadoEn: string } | null;
  lugares: LugarPago[];
  primerMes: string;
};

export type GrupoPagos = { nombre: string; total: Totales; pagado: Totales };
export type CortePagos = { total: Totales; pagado: Totales; porLugar: GrupoPagos[]; porCategoria: GrupoPagos[]; porTipo: GrupoPagos[] };
export type ResumenPagos = { periodo: string; meses: { periodo: string; total: Totales; pagado: Totales }[]; mes: CortePagos; anterior: CortePagos; anio: CortePagos & { desde: string } };

export type FijoPago = {
  id: number;
  lugarId: number;
  nombre: string;
  categoria: string;
  monto: number;
  variable: boolean;
  moneda: Moneda;
  dia: number;
  frecuencia: FrecuenciaPago;
  desde: string;
  medio: string;
  cuenta: string;
  avisoDias: number | null;
  nota: string;
};

export type ConfigPagos = { lugares: LugarPago[]; fijos: FijoPago[]; categorias: string[]; medios: string[]; diasAviso: number; mensajes: boolean };
