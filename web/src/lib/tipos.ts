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
  listaId: number | null;
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
  ia: { costoUsd: number; llamadas: number; tokensEntrada: number; tokensSalida: number; modelo: string };
};

export type Mensaje = {
  id: number;
  direccion: "entrante" | "saliente";
  texto: string | null;
  tipo: "texto" | "imagen" | "reaccion" | "otro";
  intencionDetectada: string | null;
  recordatorioId: number | null;
  recordatorioTitulo: string | null;
  adjuntoUrl: string | null;
  creadoEn: string;
};

export type Log = { id: number; nivel: "info" | "aviso" | "error"; origen: string; mensaje: string; detalle: unknown; creadoEn: string };

export type ListaItem = { id: number; listaId: number; texto: string; cantidad: string | null; creadoEn: string };
export type Lista = { id: number; nombre: string; clave: string; creadoEn: string; actualizadoEn: string; items: ListaItem[] };

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
