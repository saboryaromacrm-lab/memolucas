import path from "node:path";

/** Variables de entorno. Todo lo demás se configura desde el panel. */
export const entorno = {
  produccion: process.env.NODE_ENV === "production",
  puerto: Number(process.env.PORT ?? 3100),
  host: process.env.HOST ?? "127.0.0.1",
  databaseUrl: process.env.DATABASE_URL ?? "postgresql://localhost:5432/memolucas",
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  groqApiKey: process.env.GROQ_API_KEY ?? "",
  appSecret: process.env.APP_SECRET ?? "",
  dataDir: path.resolve(process.env.DATA_DIR ?? "./data"),
};

export const rutas = {
  auth: path.join(entorno.dataDir, "auth"),
  media: path.join(entorno.dataDir, "media"),
};

/** PIN de ingreso inicial del panel. Se puede cambiar desde Configuración → Seguridad. */
export const PIN_INICIAL = "1953";

export function validarEntorno(): string[] {
  const faltan: string[] = [];
  if (!process.env.DATABASE_URL) faltan.push("DATABASE_URL");
  if (entorno.appSecret.length < 32) faltan.push("APP_SECRET (32 caracteres o más)");
  return faltan;
}
