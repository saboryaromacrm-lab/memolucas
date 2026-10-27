import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { grupo } from "../db/schema.js";
import { mismoNumero } from "./numeros.js";

type Participante = { id: string; lid?: string; phoneNumber?: string };

const numero = (jid: string | undefined) => (jid && /@s\.whatsapp\.net$/.test(jid) ? jid.split("@")[0].split(":")[0] : null);

/** ¿El dueño está en el grupo? El bot solo funciona en grupos donde está él. */
export function esMiembro(participantes: Participante[], numeroAutorizado: string, lidAutorizado: string | null): boolean {
  if (!numeroAutorizado) return false;
  return participantes.some((p) => {
    const pn = numero(p.phoneNumber) ?? numero(p.id);
    if (pn && mismoNumero(pn, numeroAutorizado)) return true;
    const lid = p.lid ?? (p.id.endsWith("@lid") ? p.id : null);
    return !!lidAutorizado && !!lid && lid.split(":")[0].replace(/@lid$/, "") === lidAutorizado.split(":")[0].replace(/@lid$/, "");
  });
}

export async function guardarGrupo(jid: string, nombre: string) {
  await db
    .insert(grupo)
    .values({ jid, nombre })
    .onConflictDoUpdate({ target: grupo.jid, set: { nombre, actualizadoEn: sql`now()` } });
}
