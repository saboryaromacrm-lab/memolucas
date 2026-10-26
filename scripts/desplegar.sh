#!/usr/bin/env bash
# Actualiza Memolucas en el VPS: baja el código, compila y reinicia sin cortar.
# Uso: bash scripts/desplegar.sh   (desde la carpeta del proyecto)
set -euo pipefail
cd "$(dirname "$0")/.."

RAMA="${RAMA:-main}"
echo "→ Bajando cambios de $RAMA…"
git fetch origin "$RAMA"
git checkout "$RAMA"
git reset --hard "origin/$RAMA"

echo "→ Instalando dependencias…"
npm ci --include=dev --no-audit --no-fund

echo "→ Compilando…"
npm run build

echo "→ Reiniciando (las migraciones de la base corren solas al arrancar)…"
pm2 startOrReload ecosystem.config.cjs --update-env
pm2 save

sleep 5
if curl -fsS http://127.0.0.1:3100/health > /dev/null; then
  echo "✓ Memolucas actualizado y funcionando"
else
  echo "✗ La app no responde en /health. Revisá: pm2 logs memolucas" >&2
  exit 1
fi
