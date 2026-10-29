/** Frases con variantes, para que el bot no suene siempre igual. */
let azar = Math.random;
/** Solo para pruebas: fija la elección. */
export const fijarAzar = (fn: () => number) => {
  azar = fn;
};

export const variar = (opciones: string[]) => opciones[Math.floor(azar() * opciones.length)] ?? opciones[0];

export const frases = {
  intro: () => variar(["Agendado 👌", "Listo, quedó así:", "Hecho, te lo anoto 👇", "Dale 👍"]),
  hecho: (t: string) => variar([`✅ ¡Bien ahí! *${t}*, hecho.`, `✅ Listo, *${t}* tachado.`, `👏 Genial, marqué *${t}* como hecho.`]),
  pospuesto: (t: string, cuando: string) =>
    variar([`⏰ Dale, te vuelvo a avisar ${cuando}: *${t}*.`, `👌 Ok, *${t}* para ${cuando}.`, `⏰ Hecho, te lo recuerdo ${cuando}.`]),
  borrado: (t: string) => variar([`🗑️ Listo, borré *${t}*.`, `🗑️ Chau *${t}*, ya no te lo recuerdo.`]),
  cancelado: (t: string) => variar([`👍 Dale, saco *${t}* de tu agenda.`, `👌 Ok, cancelado *${t}*.`]),
  salteado: (t: string, proximo: string) => variar([`👌 Dale, salteo este. Próximo *${t}*: ${proximo}.`, `👍 Ok, este no. El próximo es ${proximo}.`]),
  pausado: (t: string) => `⏸️ Pausé *${t}*. Cuando quieras, decime "reanudá ${t.toLowerCase()}".`,
  reanudado: (t: string, cuando: string) => `▶️ Volvió *${t}*: ${cuando}.`,
  editado: (t: string) => variar(["✏️ Listo, lo cambié:", "✏️ Hecho, quedó así:", `✏️ Actualicé *${t}*:`]),
  yaCerrado: () => variar(["Ese ya estaba resuelto 👌", "Ese ya lo habíamos cerrado 👌"]),
  nadaPendiente: () => variar(["No tengo ningún aviso esperando 👌", "No hay nada pendiente de confirmar 👌"]),
  errorTecnico: () => variar(["Se me trabó algo 😅 ¿Me lo mandás de nuevo en un ratito?", "Uy, tuve un problema técnico 😅 ¿Me lo repetís?"]),
  noEntendi: () =>
    variar([
      "No te entendí bien 🤔. Probá con algo como _recordame mañana a las 10 pagar la luz_, o escribí *ayuda*.",
      "Mmm, no lo pesqué 🤔. Podés decirme por ejemplo _avisame el viernes a las 9 que tengo turno_.",
    ]),
  otraFecha: () => variar(["Dale, ¿para cuándo? Decime día y hora 🗓️", "Ok, ¿qué día y a qué hora te lo pongo?"]),
  rechazado: () => variar(["Dale, no te lo recuerdo 👍", "Ok, lo dejamos así 👍"]),
};

/** WhatsApp no muestra *negrita* ni _cursiva_ en las encuestas: se sacan los símbolos. */
export const sinFormato = (s: string) => s.replace(/[*_~]/g, "");
