import { Procesador } from "./bot/procesador.js";
import { esperarBase, migrarBase, pool } from "./db/index.js";
import { entorno, validarEntorno } from "./entorno.js";
import { asegurarAcceso } from "./http/rutas/auth.js";
import { crearServidor } from "./http/servidor.js";
import { logger, registrar } from "./lib/log.js";
import { obtenerConfig } from "./servicios/configuracion.js";
import { fijarEnviador } from "./servicios/enviador.js";
import { retomarLecturas } from "./servicios/panel-compras.js";
import { barrer, detenerScheduler, iniciarScheduler } from "./servicios/scheduler.js";
import { whatsapp } from "./whatsapp/conexion.js";

async function arrancar() {
  const faltan = validarEntorno();
  if (faltan.length && entorno.produccion) {
    logger.fatal(`Faltan variables de entorno: ${faltan.join(", ")}`);
    process.exit(1);
  }

  // 1) Base de datos (espera a que esté lista) y migraciones.
  await esperarBase();
  await migrarBase();
  await obtenerConfig();
  await asegurarAcceso();

  // 2) Scheduler (pg-boss): las tareas viven en PostgreSQL y sobreviven a reinicios.
  await iniciarScheduler();

  // 3) Panel y API.
  const app = await crearServidor();
  await app.listen({ port: entorno.puerto, host: entorno.host });
  logger.info(`Panel escuchando en http://${entorno.host}:${entorno.puerto}`);

  // 4) WhatsApp con la sesión guardada. Al conectar, se envía lo atrasado.
  fijarEnviador(whatsapp);
  const procesador = new Procesador(whatsapp);
  whatsapp.onMensaje((msg, r) => procesador.procesar(msg, { grupo: r.grupo, autor: r.autor }));
  // Al reconectar, se da unos segundos a WhatsApp para sincronizar y se manda lo pendiente.
  whatsapp.onConectado(() => setTimeout(() => void barrer(), 5000));
  whatsapp.iniciar().catch((err) => void registrar("error", "whatsapp", "No se pudo iniciar WhatsApp", err));

  // 5) Lo que debió dispararse mientras la app estaba apagada, y las facturas que quedaron a medio leer.
  void barrer();
  void retomarLecturas();
  await registrar("info", "sistema", "Memolucas arrancó");

  let cerrando = false;
  const apagar = async (senal: string) => {
    if (cerrando) return;
    cerrando = true;
    logger.info(`Recibí ${senal}, cerrando…`);
    const limite = setTimeout(() => process.exit(1), 15_000);
    try {
      await app.close();
      await whatsapp.detener();
      await detenerScheduler();
      await pool.end();
    } finally {
      clearTimeout(limite);
      process.exit(0);
    }
  };
  process.on("SIGTERM", () => void apagar("SIGTERM"));
  process.on("SIGINT", () => void apagar("SIGINT"));
}

process.on("unhandledRejection", (err) => void registrar("error", "sistema", "Promesa rechazada sin manejar", err));

arrancar().catch((err) => {
  logger.fatal(err, "No se pudo arrancar");
  process.exit(1);
});
