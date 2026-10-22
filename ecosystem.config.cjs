// Configuración de PM2 para el VPS: mantiene la app prendida, la reinicia si se cae
// y la levanta sola al reiniciar el servidor (después de `pm2 startup` y `pm2 save`).
module.exports = {
  apps: [
    {
      name: "memolucas",
      cwd: __dirname,
      script: "dist/index.js",
      node_args: "--env-file=.env",
      env: { NODE_ENV: "production", TZ: "America/Argentina/Buenos_Aires" },
      autorestart: true,
      restart_delay: 5000,
      exp_backoff_restart_delay: 2000,
      max_memory_restart: "700M",
      kill_timeout: 15000,
      time: true,
    },
  ],
};
