# Memolucas

Bot personal de recordatorios por WhatsApp, con panel web en **https://memolucas.saboryaroma.com**.

Le escribís al bot como a una persona (*"recordame mañana a las 10 pagar la luz"*, *"todos los lunes a las 8 sacar la basura"*, o le mandás la foto de una factura) y te avisa por WhatsApp a la hora indicada. Si no confirmás, insiste.

## Qué hace

**Por WhatsApp**
- Entiende texto libre con IA (Claude): recordatorios únicos, relativos (*"en 2 horas"*), recurrentes (*"el 10 de cada mes"*, *"cada 3 días"*), con avisos previos (*"avisame 1 hora antes y el día anterior"*) y sin hora (usa la hora por defecto).
- **Fotos**: lee facturas, turnos, entradas o invitaciones, propone el recordatorio (*"¿Te lo recuerdo el 29/10 a las 10:00?"*) y al avisarte reenvía la foto.
- **Confirmar**: *listo*, *hecho*, ✅ o reaccionar con 👍/✅ al aviso. Si no confirmás, insiste cada 60 min (configurable) hasta un tope y lo marca "no confirmado".
- **Posponer**: *"posponé 15 min"*, *"mañana"*, *"en 2 horas"*.
- **Editar, borrar, pausar y reanudar**: *"cambiá lo del dentista a las 11"*, *"borrá lo de la basura"*.
- **Comandos rápidos sin IA**: `hoy`, `mañana`, `semana`, `lista`, `listo`, `ayuda`, `silencio 2h` / `silencio off`.
- Solo responde a **tu número**. Todo lo demás (otros números, grupos) se ignora y queda en el log.
- Antes de responder pone "escribiendo…" con una demora corta al azar, para que se vea natural.

**Panel web** (claro, se adapta al celular, instalable como app)
- **Inicio**: estado de WhatsApp en vivo, lo de hoy y mañana, pendientes sin confirmar, contadores y gasto de IA del mes.
- **Recordatorios**: búsqueda, filtros (activos, pausados, cumplidos, no confirmados, recurrentes, con foto) y acciones (editar, pausar, reanudar, duplicar, marcar hecho, enviar ahora, borrar).
- **Calendario**: vistas de mes, semana y día; arrastrás para cambiar la fecha y tocás un hueco para crear.
- **Editor**:
  - repetición visual (diaria, semanal con días, mensual, cada N días, anual o RRULE);
  - avisos previos;
  - insistencia propia;
  - foto adjunta;
  - vista previa del mensaje tal como llega.
- **WhatsApp**:
  - vinculación por QR (se renueva solo) o por código;
  - estado y último mensaje;
  - reconectar, desvincular y mensaje de prueba;
  - número autorizado.
- **Configuración** (todo dinámico, se aplica al instante):
  - general;
  - insistencia;
  - horario de silencio;
  - resumen diario;
  - IA (modelo, esfuerzo, API key, probar conexión);
  - plantillas de mensajes;
  - seguridad (PIN, sesión, bloqueo);
  - respaldo JSON;
  - opciones avanzadas.
- **Historial** de mensajes con filtros, y **Logs** del sistema (últimas 500 entradas).
- Todo lo que se crea por WhatsApp aparece en el panel sin recargar, y viceversa.

**Ingreso al panel**: solo PIN. El PIN inicial es **1953**. Se cambia en *Configuración → Seguridad*. Después de 5 intentos fallidos se bloquea 15 minutos (configurable).

## Resiliencia

- Arranca solo al reiniciar el VPS (PM2) y espera a que PostgreSQL esté listo.
- Corre las migraciones de la base automáticamente.
- Las tareas programadas viven en PostgreSQL (pg-boss): sobreviven a reinicios.
- Si WhatsApp se corta, reconecta con espera creciente (5 s, 10 s, 30 s, 1 min, 5 min).
- Si se cerró la sesión desde el teléfono, el panel pide un QR nuevo.
- Lo que debió llegar mientras la app o WhatsApp estaban caídos se manda al volver, con el aviso **"⏰ Atrasado"**.
- Si WhatsApp está caído más de 10 minutos (configurable), el panel lo marca en rojo.
- Healthcheck en `GET /health`.

## Tecnología

Node.js 22 + TypeScript, Fastify, PostgreSQL con Drizzle ORM y pg-boss, Baileys (WhatsApp), Claude (`@anthropic-ai/sdk`), React + Vite + Tailwind CSS y FullCalendar.

Un solo proceso sirve el bot, el scheduler, la API y el panel.

---

## Instalación en el VPS de Hostinger

Se hace una sola vez, por SSH en el VPS (Ubuntu). Convive con las otras apps del servidor: usa el puerto **3100**, su propia base PostgreSQL y su propio sitio de Nginx.

### 0. Antes de empezar: el chip del bot

- Usá un **chip aparte**, nunca tu número personal. Baileys no es oficial: si WhatsApp bloquea el número, se pierde solo ese chip.
- Activá WhatsApp en un teléfono con ese chip y **usalo un par de días como un número normal** antes de vincularlo.

### 1. DNS

En hPanel, zona DNS de `saboryaroma.com`: creá un registro **A** con nombre `memolucas` que apunte a la IP del VPS.

### 2. Programas (si alguno ya está instalado, se saltea solo)

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs nginx postgresql certbot python3-certbot-nginx git
sudo npm install -g pm2
node -v   # tiene que ser 22.12 o más nuevo
```

### 3. Base de datos

```bash
sudo -u postgres psql -c "CREATE USER memolucas WITH PASSWORD 'una-clave-segura';"
sudo -u postgres psql -c "CREATE DATABASE memolucas OWNER memolucas;"
```

### 4. Código y configuración

```bash
sudo mkdir -p /var/www/memolucas /var/www/memolucas-data
sudo chown -R $USER /var/www/memolucas /var/www/memolucas-data
git clone https://github.com/saboryaromacrm-lab/memolucas.git /var/www/memolucas
cd /var/www/memolucas
cp .env.example .env
nano .env
```

En el `.env` completá:
- `DATABASE_URL`: con la clave del paso 3.
- `ANTHROPIC_API_KEY`: una clave **aparte** para este bot (console.anthropic.com → API Keys).
- `APP_SECRET`: generala con `openssl rand -base64 48`.

Después:

```bash
bash scripts/desplegar.sh
pm2 startup      # copiá y ejecutá el comando que te muestra (arranque automático)
pm2 save
```

### 5. Dominio y HTTPS

```bash
sudo cp deploy/nginx-memolucas.saboryaroma.com.conf /etc/nginx/sites-available/memolucas.saboryaroma.com
sudo ln -s /etc/nginx/sites-available/memolucas.saboryaroma.com /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d memolucas.saboryaroma.com
```

### 6. Primer uso

1. Entrá a **https://memolucas.saboryaroma.com** con el PIN **1953**.
2. En **Inicio → Configuración inicial**, cargá tu número personal (el único que puede hablarle al bot).
3. En **WhatsApp**, escaneá el QR con el teléfono del chip del bot: *Configuración → Dispositivos vinculados → Vincular un dispositivo*. También podés usar la opción *Con código*.
4. Desde tu número personal, mandale **"hola"** o **"ayuda"** al bot.
5. Cambiá el PIN en *Configuración → Seguridad* si querés.

### Instalar el panel en el celular

Entrá a la URL y elegí:
- **Android (Chrome)**: menú ⋮ → *Instalar app*.
- **iPhone (Safari)**: Compartir → *Agregar a pantalla de inicio*.

---

## Actualizar

Manual, en el VPS:

```bash
cd /var/www/memolucas && bash scripts/desplegar.sh
```

**Automático con cada push a `main`**: cargá estos secretos en GitHub (*Settings → Secrets and variables → Actions*):

| Secreto | Valor |
|---|---|
| `VPS_HOST` | IP del VPS |
| `VPS_USER` | usuario SSH (el dueño de `/var/www/memolucas`) |
| `VPS_SSH_KEY` | clave privada SSH (su clave pública tiene que estar en `~/.ssh/authorized_keys` del VPS) |
| `VPS_PORT` | opcional, 22 por defecto |

Mientras no estén cargados, el workflow se saltea sin fallar.

## Si algo no anda

| Problema | Qué hacer |
|---|---|
| El panel no abre | `pm2 status` y `pm2 logs memolucas` |
| El bot no responde | Panel → WhatsApp: ¿está "Conectado"? ¿El número autorizado es el tuyo? Mirá *Logs*. |
| "Uy, no pude procesar eso" | Panel → Configuración → IA → *Probar conexión* (API key o modelo) |
| WhatsApp bloqueó el número | Cambiá el chip, *Desvincular* y escaneá el QR nuevo |
| Estado general | `curl http://127.0.0.1:3100/health` |

Los datos persistentes están en PostgreSQL y en `/var/www/memolucas-data`:
- `auth/`: sesión de WhatsApp.
- `media/`: fotos.

## Desarrollo local

Requisitos: Node 22.12+ y PostgreSQL.

```bash
cp .env.example .env   # DATABASE_URL local, APP_SECRET, ANTHROPIC_API_KEY, DATA_DIR=./data, NODE_ENV=development
npm install
npm run dev            # backend en http://localhost:3100
npm run dev:web        # panel con recarga en http://localhost:5173
```

Comandos útiles:

```bash
npm run typecheck      # tipos
npm test               # pruebas (usa TEST_DATABASE_URL o postgresql://postgres@127.0.0.1:5433/memolucas_test)
npm run db:generar     # nueva migración después de cambiar src/db/schema.ts
```

Con Docker (por ejemplo, Dokploy) también funciona: el `Dockerfile` está listo. Necesita las mismas variables de entorno y un volumen persistente en `/app/data`.
