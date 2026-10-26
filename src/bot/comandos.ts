import { normalizar } from "../lib/textos.js";

export type Comando =
  | { tipo: "listar"; rango: "hoy" | "manana" | "semana" | "todos" }
  | { tipo: "confirmar"; explicito: boolean }
  | { tipo: "ayuda" }
  | { tipo: "listas" }
  | { tipo: "notas" }
  | { tipo: "silencio"; minutos: number }
  | { tipo: "fin_silencio" };

const EMOJIS_OK = ["✅", "👍", "👌", "✔️", "☑️", "👍🏻", "👍🏼", "👍🏽", "👍🏾", "👍🏿"];

/** Comandos que se resuelven sin IA (más rápido y sin costo). */
export function detectarComando(texto: string): Comando | null {
  const crudo = texto.trim();
  if (EMOJIS_OK.includes(crudo)) return { tipo: "confirmar", explicito: false };
  const t = normalizar(crudo);
  if (t === "hoy") return { tipo: "listar", rango: "hoy" };
  if (t === "manana") return { tipo: "listar", rango: "manana" };
  if (t === "semana") return { tipo: "listar", rango: "semana" };
  if (t === "lista" || t === "listar" || t === "todos") return { tipo: "listar", rango: "todos" };
  if (/^(listo|hecho|ya esta|ya lo hice|hecho ✅|listo ✅)$/.test(t)) return { tipo: "confirmar", explicito: true };
  if (/^(ok|oka|okey|ya)$/.test(t)) return { tipo: "confirmar", explicito: false };
  if (/^(ayuda|menu|help|\?)$/.test(t) || crudo === "?") return { tipo: "ayuda" };
  if (t === "listas" || t === "mis listas") return { tipo: "listas" };
  if (t === "notas" || t === "mis notas") return { tipo: "notas" };
  if (/^silencio (off|no|fin|apagado|desactivar)$/.test(t)) return { tipo: "fin_silencio" };
  const s = /^silencio (\d+)\s*(h|hs|hora|horas|m|min|mins|minuto|minutos)?$/.exec(t);
  if (s) {
    const n = Number(s[1]);
    const enMinutos = s[2]?.startsWith("m") ?? false;
    return { tipo: "silencio", minutos: Math.min(enMinutos ? n : n * 60, 7 * 24 * 60) };
  }
  return null;
}

export const esAfirmativo = (texto: string) =>
  /^(si|sii+|dale|ok|oka|okey|de una|perfecto|joya|genial|bueno|va|si dale|dale si|si por favor|confirmo|👍|✅)$/.test(normalizar(texto)) ||
  EMOJIS_OK.includes(texto.trim());
export const esNegativo = (texto: string) => /^(no|nop|nah|cancelar|cancela|cancelalo|no gracias|dejalo|deja)$/.test(normalizar(texto));

export const EMOJIS_CONFIRMACION = EMOJIS_OK;

export const TEXTO_AYUDA = `👋 Soy *Memolucas*, tu bot de recordatorios. Escribime como le hablarías a alguien:

• _Recordame mañana a las 10 pagar la luz_
• _Avisame en 2 horas que saque la ropa_
• _Todos los lunes a las 8 sacar la basura_
• _Tengo turno el jueves a las 10, avisame 1 hora antes_
• Mandame una *foto* de una factura o turno y te propongo el recordatorio.
• Mandame un *audio* y lo entiendo igual que si me escribieras.
• Mandame un *link* (Instagram, TikTok, YouTube, entradas, recetas, notas…): te digo de qué se trata y te propongo cuándo recordártelo.

🛒 *Listas*: _agregá leche y 2 kg de pan a la lista del súper_ · _ya compré la leche_ · _pasame la lista del súper_ · _recordame la lista del súper el sábado a las 10_

🗒️ *Notas*: _anotá que la clave del wifi es…_ · _¿cuál era la clave del wifi?_ · foto + _guardala como nota_

Comandos rápidos:
• *hoy* / *mañana* / *semana* / *lista* (recordatorios) · *listas* · *notas*
• *listo* (o ✅) para confirmar el último aviso
• *posponé 15 min*, *mañana*, *en 2 horas*
• _Cambiá lo del dentista a las 11_ · _Borrá lo de la basura_ · _Pausá el de regar_
• *silencio 2h* para no recibir avisos un rato (*silencio off* para cortarlo)`;
