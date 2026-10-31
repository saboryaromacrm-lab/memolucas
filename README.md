# Memolucas

Bot personal de recordatorios por WhatsApp, con panel web en **https://memolucas.saboryaroma.com**.

Le escribís al bot como a una persona (*"recordame mañana a las 10 pagar la luz"*, *"todos los lunes a las 8 sacar la basura"*), le mandás la foto de una factura o el link de un evento, y te avisa por WhatsApp a la hora indicada. Si no confirmás, insiste.

## Qué hace

**Por WhatsApp**
- Entiende texto libre con IA (Claude): recordatorios únicos, relativos (*"en 2 horas"*), recurrentes (*"el 10 de cada mes"*, *"cada 3 días"*), con avisos previos (*"avisame 1 hora antes y el día anterior"*) y sin hora (usa la hora por defecto).
- **Fotos**: lee facturas, turnos, entradas o invitaciones, propone el recordatorio (*"¿Te lo recuerdo el 29/10 a las 10:00?"*) y al avisarte reenvía la foto.
- **Links** (Instagram, TikTok, YouTube, webs de entradas, recetas, notas, tiendas…):
  - lee el título, la descripción, el texto y la imagen de portada;
  - te dice de qué se trata, saca su conjetura y te propone o te pregunta cuándo recordártelo;
  - con *"recordame el viernes ver esto"* lo crea directo;
  - el aviso trae el link y la imagen de portada.
  Si el sitio no deja leer el link (pasa con Instagram), te pide una captura de pantalla y le agrega el link al recordatorio.
- **Opciones para tocar** (encuestas de WhatsApp): el aviso trae *✅ Hecho · ⏰ En 15 min · ⏰ En 1 h · 📅 Mañana*; las propuestas de fotos y links, *✅ Dale · ✏️ Otra fecha · ❌ No*; y si hay varios recordatorios parecidos, te deja elegir cuál. Escribir sigue funcionando igual. Se apaga en Configuración → Mensajes.
- **Confirmar**: *listo*, *hecho*, ✅, reaccionar con 👍/✅ al aviso o tocar *✅ Hecho*. Si no confirmás, insiste cada 60 min (configurable) hasta un tope y lo marca "no confirmado".
- **Posponer**: *"posponé 15 min"*, *"mañana"*, *"en 2 horas"*.
- **Responder al aviso**: *"no voy"* o *"se suspendió"* lo cancela (si se repite, saltea solo esa vez); *"lo pasaron al lunes"* lo cambia.
- **Pregunta lo que falta**: a un turno sin hora le pregunta la hora, y a un evento sin aviso previo le ofrece uno.
- **Compras (facturas de proveedores)**: en el grupo marcado como "de compras" (o por privado, con "factura" en el pie o mandando el PDF) lee facturas, notas de crédito y débito, remitos, tickets y papeles internos con el instructivo de Coffit, y los pasa al JSON que carga el ERP.
  - Junta las fotos de la misma persona que llegan seguidas (varias hojas) y pone 👀 al recibirlas.
  - Rehace las cuentas por su lado (cada renglón, subtotal y total). Si no cierran, relee con un modelo más potente; si siguen sin cerrar, queda "a revisar" con la diferencia.
  - Responde con un resumen y las opciones ✅ Confirmar · ✏️ Corregir · ❌ Descartar. Para corregir alcanza con escribir, por ejemplo, "el renglón 3 son 12 unidades".
  - Avisa si el comprobante ya estaba cargado.
  - Al confirmar lo manda por POST al ERP (`{ comprobantes: [...] }`, con la clave como `Authorization: Bearer`). Sin dirección, queda en el panel para copiar o descargar el JSON.
  - Las fotos y PDF se borran a los 30 días (configurable); los datos quedan. Todo se configura en Configuración → Compras, incluso el instructivo.
- **Panel de compras de Coffit** (en `comprascoff.saboryaroma.com`, aparte de Memolucas, pensado para el celular):
  - cada persona entra con su propia clave, que se da de alta desde Memolucas (Configuración → Compras → Personas con acceso);
  - saca foto a la factura (o elige de la galería o sube un PDF), agrega las hojas que haga falta y toca "Leer factura";
  - la lectura es la misma que la del bot (instructivo, controles, relectura, repetidos) y corre en segundo plano: se puede seguir cargando;
  - sin señal, las fotos quedan guardadas en el celular y se suben solas al volver la conexión;
  - para corregir: escribir qué está mal (lo aplica la IA) o editar los datos en un formulario; después confirmar (se manda al ERP) o descartar;
  - colores de Coffit (marrón, naranja y beige); el logo se sube desde Memolucas y también arma el ícono de la app;
  - las facturas del panel y las del grupo de WhatsApp son una sola lista.
- **Notas cifradas**: *"anotá que la clave del wifi es…"*, *"anotá comprar leche y pan"*, *"¿cuál era la clave del wifi?"*.
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

- Corre en Dokploy: arranca solo al reiniciar el VPS y espera a que PostgreSQL esté listo.
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

## Instalación en el VPS (Dokploy)

El VPS usa **Dokploy**: Memolucas corre como una app más, junto a las otras, con su propia base PostgreSQL.

### 0. Antes de empezar: el chip del bot

- Usá un **chip aparte**, nunca tu número personal. Baileys no es oficial: si WhatsApp bloquea el número, se pierde solo ese chip.
- Activá WhatsApp en un teléfono con ese chip y **usalo un par de días como un número normal** antes de vincularlo.

### 1. DNS

En hPanel, zona DNS de `saboryaroma.com`: creá un registro **A** con nombre `memolucas` que apunte a la IP del VPS.

### 2. Base de datos

En Dokploy:
1. **Create Project** `memolucas` → **Create Service → Database → PostgreSQL**.
2. Datos: Database `memolucas`, User `memolucas`, y una contraseña de **solo letras y números**.
3. Tocá **Deploy**.
4. Copiá la **Internal Connection URL**.

### 3. Aplicación

**Create Service → Application** `memolucas`:

| Pestaña | Qué cargar |
|---|---|
| General | Provider GitHub, repo `memolucas`, branch `main`, Build Type **Dockerfile** |
| Environment | ver abajo |
| Advanced → Volumes | Volume Mount `memolucas-data` en `/app/data` (sesión de WhatsApp y fotos) |
| Domains | Host `memolucas.saboryaroma.com`, path `/`, Container Port `3000`, HTTPS con Let's Encrypt |

Variables de entorno:

```
NODE_ENV=production
TZ=America/Argentina/Buenos_Aires
DATA_DIR=/app/data
DATABASE_URL=<Internal Connection URL del paso 2>
APP_SECRET=<generala con: openssl rand -hex 48>
ANTHROPIC_API_KEY=<opcional: también se puede cargar desde el panel>
```

Tocá **Deploy** y activá **Autodeploy**: con cada cambio en `main` se actualiza solo.

### 4. Primer uso

1. Entrá a **https://memolucas.saboryaroma.com** con el PIN **1953**.
2. **Configuración → IA**: cargá la API key de Claude (console.anthropic.com → API Keys, copiala con el botón de copiar) y tocá *Probar conexión*.
3. **Inicio → Configuración inicial**: cargá tu número personal, que es el único que puede hablarle al bot.
4. **WhatsApp**: escaneá el QR con el teléfono del chip del bot (*Configuración → Dispositivos vinculados → Vincular un dispositivo*), o usá *Con código*.
5. Desde tu número, mandale **"ayuda"** al bot.

### Instalar el panel en el celular

Entrá a la URL y elegí:
- **Android (Chrome)**: menú ⋮ → *Instalar app*.
- **iPhone (Safari)**: Compartir → *Agregar a pantalla de inicio*.

## Si algo no anda

| Problema | Qué hacer |
|---|---|
| "Bad Gateway" | Dokploy → memolucas → **Logs**. Si dice *"la base no responde"*, revisá `DATABASE_URL` (Internal URL) y redesplegá. |
| El bot no responde | Panel → WhatsApp: ¿está "Conectado"? ¿El número autorizado es el tuyo? Mirá *Logs*. |
| "Uy, no pude procesar eso" | Panel → Configuración → IA → *Probar conexión* (API key o modelo) |
| WhatsApp bloqueó el número | Cambiá el chip, *Desvincular* y escaneá el QR nuevo |
| Estado general | `https://memolucas.saboryaroma.com/health` |

Los datos persistentes están en la base PostgreSQL de Dokploy y en el volumen `memolucas-data`:
- `auth/`: sesión de WhatsApp.
- `media/`: fotos e imágenes de links.

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
