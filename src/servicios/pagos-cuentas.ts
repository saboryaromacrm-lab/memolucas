import { asc, desc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { pagoPersona, pagoPersonaPago } from "../db/schema.js";
import { abrir, sellar } from "../lib/cifrado.js";
import { bus } from "../lib/eventos.js";
import { normalizar } from "../lib/textos.js";
import { formaActiva, listarFormas } from "./pagos-formas.js";
import { partesPagadasCon } from "./pagos.js";
import { ErrorUsuario } from "./recordatorios.js";

// Cuentas con personas que pagan cosas por vos (la contadora, un socio…). Lo que pagan va como «Lo pagó: …» en el
// pago (es el gasto); lo que vos les pagás baja lo que les debés (no es otro gasto). Saldo positivo: le debés.

type DatosPersona = { saldoInicial: number };
type DatosPagoPersona = { monto: number; nota: string };

const avisar = () => bus.avisar("pagos");
const redondo = (n: number) => Math.round(n * 100) / 100;
const abrirPersona = (c: string) => abrir<DatosPersona>(c, { saldoInicial: 0 });

/** Cada persona con su saldo y sus movimientos (lo que pagó por vos y lo que le pagaste), del más nuevo al más viejo. */
export async function listarCuentas() {
  const [personas, formas, pagados] = await Promise.all([
    db.select().from(pagoPersona).orderBy(asc(pagoPersona.id)),
    listarFormas(),
    db.select().from(pagoPersonaPago).orderBy(desc(pagoPersonaPago.fecha), desc(pagoPersonaPago.id)),
  ]);
  const formaDe = (personaId: number) => formas.find((f) => f.personaId === personaId);
  const partes = await partesPagadasCon(personas.flatMap((p) => formaDe(p.id)?.id ?? []));
  return personas.map((p) => {
    const forma = formaDe(p.id);
    const { saldoInicial } = abrirPersona(p.datosCifrados);
    const pago = partes
      .filter((x) => x.formaId === forma?.id)
      .map((x) => ({ tipo: "pago" as const, fecha: x.fecha, monto: x.monto, detalle: `${x.nombre} · ${x.lugar}`, periodo: x.periodo, pagoId: x.pagoId }));
    const lePagaste = pagados
      .filter((m) => m.personaId === p.id)
      .map((m) => {
        const d = abrir<DatosPagoPersona>(m.datosCifrados, { monto: 0, nota: "" });
        return { tipo: "lePagaste" as const, id: m.id, fecha: m.fecha, monto: d.monto, nota: d.nota, forma: formas.find((f) => f.id === m.formaId)?.nombre ?? null };
      });
    const total = (l: { monto: number }[]) => l.reduce((s, x) => s + x.monto, 0);
    return {
      id: p.id,
      nombre: p.nombre,
      formaId: forma?.id ?? null,
      saldoInicial,
      saldo: redondo(saldoInicial + total(pago) - total(lePagaste)),
      movimientos: [...pago, ...lePagaste].sort((a, b) => b.fecha.localeCompare(a.fecha)),
    };
  });
}

export type Cuenta = Awaited<ReturnType<typeof listarCuentas>>[number];

const nombreValido = (nombre: string) => {
  const n = nombre.trim();
  if (!n) throw new ErrorUsuario("Falta el nombre de la persona.");
  return n;
};

async function nombreLibre(nombre: string, menos?: number) {
  const igual = (await db.select().from(pagoPersona)).find((p) => p.id !== menos && normalizar(p.nombre) === normalizar(nombre));
  if (igual) throw new ErrorUsuario(`Ya tenés la cuenta de «${igual.nombre}».`);
}

/** saldoInicial: lo que le debés hoy (negativo: lo que tenés a favor). */
export async function crearPersona(d: { nombre: string; saldoInicial: number }) {
  const nombre = nombreValido(d.nombre);
  await nombreLibre(nombre);
  const [p] = await db
    .insert(pagoPersona)
    .values({ nombre, datosCifrados: sellar({ saldoInicial: d.saldoInicial } satisfies DatosPersona) })
    .returning({ id: pagoPersona.id });
  avisar();
  return p;
}

export async function actualizarPersona(id: number, d: { nombre?: string; saldoInicial?: number }) {
  const [p] = await db.select().from(pagoPersona).where(eq(pagoPersona.id, id));
  if (!p) throw new ErrorUsuario("Esa cuenta ya no está.");
  const nombre = d.nombre === undefined ? undefined : nombreValido(d.nombre);
  if (nombre) await nombreLibre(nombre, id);
  await db
    .update(pagoPersona)
    .set({ ...(nombre ? { nombre } : {}), ...(d.saldoInicial !== undefined ? { datosCifrados: sellar({ ...abrirPersona(p.datosCifrados), saldoInicial: d.saldoInicial }) } : {}) })
    .where(eq(pagoPersona.id, id));
  avisar();
}

/** Solo sin movimientos: si ya pagó algo o le pagaste, la cuenta queda (es tu historial). */
export async function borrarPersona(id: number) {
  const cuenta = (await listarCuentas()).find((c) => c.id === id);
  if (!cuenta) return;
  if (cuenta.movimientos.length) throw new ErrorUsuario(`La cuenta de ${cuenta.nombre} tiene movimientos: no se puede borrar.`);
  await db.delete(pagoPersona).where(eq(pagoPersona.id, id));
  avisar();
}

/** Le pagaste (transferencia, efectivo…): baja lo que le debés. Puede ser una parte o más de lo que le debías. */
export async function pagarAPersona(personaId: number, d: { monto: number; fecha: string; formaId: number; nota: string }) {
  const [p] = await db.select().from(pagoPersona).where(eq(pagoPersona.id, personaId));
  if (!p) throw new ErrorUsuario("Esa cuenta ya no está.");
  if (!(d.monto > 0)) throw new ErrorUsuario("Falta cuánto le pagaste.");
  const forma = await formaActiva(d.formaId);
  if (forma.tipo === "tercero") throw new ErrorUsuario("Elegí con qué le pagaste vos (transferencia, efectivo…).");
  const [m] = await db
    .insert(pagoPersonaPago)
    .values({ personaId, fecha: d.fecha, formaId: d.formaId, datosCifrados: sellar({ monto: d.monto, nota: d.nota.trim() } satisfies DatosPagoPersona) })
    .returning({ id: pagoPersonaPago.id });
  avisar();
  return m;
}

export async function borrarPagoAPersona(id: number) {
  await db.delete(pagoPersonaPago).where(eq(pagoPersonaPago.id, id));
  avisar();
}

/** La persona que nombró ("la contadora", "a Juan"). */
export async function buscarPersona(texto: string) {
  const t = normalizar(texto);
  const personas = await db.select().from(pagoPersona);
  return (
    personas.find((p) => normalizar(p.nombre) === t) ??
    personas.find((p) => t.includes(normalizar(p.nombre)) || normalizar(p.nombre).includes(t)) ??
    personas.find((p) => t.split(/\s+/).some((w) => w.length > 3 && normalizar(p.nombre).split(/\s+/).includes(w)))
  );
}
