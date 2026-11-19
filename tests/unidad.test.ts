import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { detectarComando, esAfirmativo, esNegativo } from "../src/bot/comandos.js";
import { finDeSilencio, formatearCuando } from "../src/lib/fechas.js";
import { describirRrule, instanciasEntre, normalizarRrule, siguienteInstancia } from "../src/lib/recurrencia.js";
import { describirMinutos } from "../src/lib/textos.js";
import { mismoNumero, mostrarNumero, normalizarNumero } from "../src/whatsapp/numeros.js";
import { renderizar } from "../src/servicios/configuracion.js";

const Z = "America/Argentina/Buenos_Aires";
const local = (iso: string) => DateTime.fromISO(iso, { zone: Z }).toJSDate();

describe("números", () => {
  it("normaliza formatos argentinos", () => {
    expect(normalizarNumero("+54 9 11 1234-5678")).toBe("5491112345678");
    expect(normalizarNumero("+54 11 1234-5678")).toBe("5491112345678");
    expect(normalizarNumero("11 1234 5678")).toBe("5491112345678");
    expect(normalizarNumero("011 15 1234-5678")).toBe("5491112345678");
    expect(normalizarNumero("0351 15 412-3456")).toBe("5493514123456");
    expect(normalizarNumero("+1 415 555 0100")).toBe("14155550100");
  });
  it("compara con y sin el 9", () => {
    expect(mismoNumero("5491112345678", "541112345678")).toBe(true);
    expect(mismoNumero("5491112345678", "5491187654321")).toBe(false);
    expect(mostrarNumero("5491112345678")).toBe("+54 9 11 1234-5678");
  });
});

describe("recurrencia", () => {
  it("todos los lunes a las 8", () => {
    const dtstart = local("2026-10-26T08:00");
    const sig = siguienteInstancia("FREQ=WEEKLY;BYDAY=MO", dtstart, local("2026-10-26T09:00"));
    expect(DateTime.fromJSDate(sig!).setZone(Z).toISO()).toBe("2026-11-02T08:00:00.000-03:00");
  });
  it("el 10 de cada mes, con BYHOUR", () => {
    const rr = normalizarRrule("RRULE:FREQ=MONTHLY;BYMONTHDAY=10;BYHOUR=9;BYMINUTE=0")!;
    const sig = siguienteInstancia(rr, local("2026-10-22T09:00"), local("2026-10-22T12:00"), true);
    expect(DateTime.fromJSDate(sig!).setZone(Z).toFormat("yyyy-MM-dd HH:mm")).toBe("2026-11-10 09:00");
  });
  it("cada 3 días", () => {
    const xs = instanciasEntre("FREQ=DAILY;INTERVAL=3", local("2026-10-22T10:00"), local("2026-10-22T00:00"), local("2026-10-31T00:00"));
    expect(xs.map((d) => DateTime.fromJSDate(d).setZone(Z).day)).toEqual([22, 25, 28]);
  });
  it("describe en castellano", () => {
    expect(describirRrule("FREQ=WEEKLY;BYDAY=MO", local("2026-10-26T08:00"))).toBe("todos los lunes a las 8:00");
    expect(describirRrule("FREQ=MONTHLY;BYMONTHDAY=10", local("2026-11-10T09:00"))).toBe("el 10 de cada mes a las 9:00");
    expect(describirRrule("FREQ=DAILY;INTERVAL=3", local("2026-10-22T10:00"))).toBe("cada 3 días a las 10:00");
    expect(describirRrule("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR", local("2026-10-22T07:30"))).toBe("de lunes a viernes a las 7:30");
  });
  it("rechaza reglas inválidas", () => {
    expect(normalizarRrule("cualquier cosa")).toBeNull();
    expect(normalizarRrule("DTSTART:20261022T090000\nRRULE:FREQ=DAILY")).toBe("FREQ=DAILY");
  });
});

describe("fechas", () => {
  it("silencio que cruza la medianoche", () => {
    const v = { activo: true, desde: "23:00", hasta: "07:30", dias: [1, 2, 3, 4, 5, 6, 7] };
    const fin = finDeSilencio(local("2026-10-23T02:00"), v);
    expect(DateTime.fromJSDate(fin!).setZone(Z).toFormat("dd HH:mm")).toBe("23 07:30");
    expect(finDeSilencio(local("2026-10-23T12:00"), v)).toBeNull();
    expect(finDeSilencio(local("2026-10-23T23:15"), v)).not.toBeNull();
  });
  it("formatea relativo", () => {
    const ref = DateTime.fromISO("2026-10-22T10:00", { zone: Z });
    expect(formatearCuando(local("2026-10-22T18:30"), ref)).toBe("hoy a las 18:30");
    expect(formatearCuando(local("2026-10-23T09:00"), ref)).toBe("mañana a las 9:00");
    expect(formatearCuando(local("2026-10-30T09:00"), ref)).toBe("el viernes 30/10 a las 9:00");
  });
  it("minutos en palabras", () => {
    expect(describirMinutos(60)).toBe("1 hora");
    expect(describirMinutos(1440)).toBe("1 día");
    expect(describirMinutos(90)).toBe("1 hora y 30 minutos");
  });
});

describe("comandos rápidos", () => {
  it("detecta los comandos", () => {
    expect(detectarComando("Hoy")).toEqual({ tipo: "listar", rango: "hoy" });
    expect(detectarComando("mañana")).toEqual({ tipo: "listar", rango: "manana" });
    expect(detectarComando("Lista")).toEqual({ tipo: "listar", rango: "todos" });
    expect(detectarComando("Listo!")).toEqual({ tipo: "confirmar", explicito: true });
    expect(detectarComando("✅")).toEqual({ tipo: "confirmar", explicito: false });
    expect(detectarComando("silencio 2h")).toEqual({ tipo: "silencio", minutos: 120 });
    expect(detectarComando("silencio 30 min")).toEqual({ tipo: "silencio", minutos: 30 });
    expect(detectarComando("silencio off")).toEqual({ tipo: "fin_silencio" });
    expect(detectarComando("mañana a las 10 pagar la luz")).toBeNull();
  });
  it("respuestas a propuestas", () => {
    expect(esAfirmativo("Dale!")).toBe(true);
    expect(esAfirmativo("sí")).toBe(true);
    expect(esNegativo("no")).toBe(true);
    expect(esAfirmativo("mejor el 28")).toBe(false);
  });
  it("plantillas", () => {
    expect(renderizar("Hola {nombre}, {x}", { nombre: "Lucas" })).toBe("Hola Lucas, ");
  });
});

describe("grupos", async () => {
  const { esMiembro } = await import("../src/whatsapp/grupos.js");
  it("el bot solo funciona si el dueño está en el grupo", () => {
    const yo = "5491112345678";
    expect(esMiembro([{ id: "5491112345678@s.whatsapp.net" }], yo, null)).toBe(true);
    expect(esMiembro([{ id: "123@lid", phoneNumber: "541112345678@s.whatsapp.net" }], yo, null)).toBe(true);
    expect(esMiembro([{ id: "999@lid" }], yo, "999@lid")).toBe(true);
    expect(esMiembro([{ id: "5491187654321@s.whatsapp.net" }, { id: "111@lid" }], yo, "999@lid")).toBe(false);
  });
});

describe("votos de encuestas", async () => {
  const { aesEncryptGCM, hmacSign, proto } = await import("baileys");
  const { whatsapp } = await import("../src/whatsapp/conexion.js");
  const { hashOpcion, opcionElegida } = await import("../src/servicios/encuestas.js");

  /** Cifra un voto igual que WhatsApp (el bot lo creó con su LID y vota el dueño). */
  function cifrar(secreto: Buffer, pollMsgId: string, creador: string, votante: string, opcion: string) {
    const bin = (s: string) => Buffer.from(s);
    const firma = Buffer.concat([bin(pollMsgId), bin(creador), bin(votante), bin("Poll Vote"), new Uint8Array([1])]);
    const clave = hmacSign(firma, hmacSign(secreto, new Uint8Array(32), "sha256"), "sha256");
    const iv = Buffer.alloc(12, 7);
    const datos = proto.Message.PollVoteMessage.encode({ selectedOptions: [hashOpcion(opcion)] }).finish();
    return { encPayload: aesEncryptGCM(datos, clave, iv, bin(`${pollMsgId}\u0000${votante}`)), encIv: iv };
  }

  it("descifra el voto probando número y LID", () => {
    const secreto = Buffer.alloc(32, 3);
    (whatsapp as unknown as { sock: unknown }).sock = { user: { id: "5491100000000:12@s.whatsapp.net", lid: "777000:12@lid" } };
    const vote = cifrar(secreto, "POLL1", "777000@lid", "888000@lid", "⏰ En 1 h");
    const msg = { key: { id: "V1", remoteJid: "888000@lid", remoteJidAlt: "5491112345678@s.whatsapp.net" }, message: { pollUpdateMessage: { pollCreationMessageKey: { id: "POLL1" }, vote } } };
    const votadas = whatsapp.descifrarVoto(msg as never, secreto.toString("base64"));
    expect(opcionElegida(["✅ Hecho", "⏰ En 15 min", "⏰ En 1 h"], votadas!)).toBe(2);
    expect(whatsapp.descifrarVoto(msg as never, Buffer.alloc(32, 9).toString("base64"))).toBeNull();
    (whatsapp as unknown as { sock: unknown }).sock = null;
  });
});
