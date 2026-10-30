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
  comprasModelo: string;
  comprasModeloReintento: string;
  comprasInstructivo: string;
  comprasEsperaSeg: number;
  comprasDiasArchivo: number;
  erpUrl: string;
  erpEnvioAuto: boolean;
  erpTokenCargado: boolean;
  instructivoComprasDefecto: string;
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
  tipo: "texto" | "imagen" | "reaccion" | "audio" | "encuesta" | "voto" | "otro";
  intencionDetectada: string | null;
  recordatorioId: number | null;
  recordatorioTitulo: string | null;
  adjuntoUrl: string | null;
  chat: string | null;
  autor: string | null;
  creadoEn: string;
};

export type Grupo = { jid: string; nombre: string; compras: boolean };

export type EstadoCompra = "pendiente" | "revisar" | "confirmado" | "descartado";

/** Comprobante de compra en la lista (el JSON completo viene en "datos" al abrirlo). */
export type Compra = {
  id: number;
  estado: EstadoCompra;
  titulo: string;
  proveedor: string;
  fecha: string | null;
  total: string | null;
  moneda: "PES" | "DOL" | "";
  renglones: number;
  clase: "mercaderia" | "gasto" | "mixta" | "dudoso";
  cierra: boolean;
  diferencias: string;
  dudas: string[];
  autor: string | null;
  grupoNombre: string | null;
  modelo: string | null;
  archivos: { url: string; mime: string }[];
  archivosBorrados: boolean;
  confirmadoEn: string | null;
  enviadoEn: string | null;
  envioError: string | null;
  creadoEn: string;
};

export type ComprobanteDatos = {
  archivo: string;
  clase: string;
  motivoClase: string;
  encabezado: Record<string, string | number>;
  renglones: {
    clase: string;
    codigo: string;
    descripcion: string;
    cantidad: number;
    unidad: string;
    unidadesPorBulto: number;
    precioUnitario: number;
    descuentos: number[];
    importe: number;
    alicuotaIva: number;
    cierra: boolean;
  }[];
  pie: {
    subtotal: number;
    bonificacionPct: number;
    bonificacionImporte: number;
    ivas: { alicuota: number; importe: number }[];
    percepciones: { nombre: string; tipo: string; alicuota: number; importe: number }[];
    impuestosInternos: number;
    otrosImpuestos: number;
    total: number;
  };
  pagoQueFigura: { figura: boolean; medio: string; fecha: string; importe: number; referencia: string };
  controles: { sumaRenglones: number; cierraSubtotal: boolean; cierraTotal: boolean; diferencias: string };
  dudas: string[];
};

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
