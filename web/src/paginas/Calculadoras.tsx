import { useEffect, useRef, useState, type ReactNode } from "react";
import { DateTime } from "luxon";
import { Eraser, Plus, X } from "lucide-react";
import { Boton, Encabezado } from "../componentes/ui";
import { get, put } from "../lib/api";
import { bavosi, encadenar, proporcion, variacion, type OperacionPct } from "../lib/calculos";
import { ahora, hora } from "../lib/fechas";
import { aNumero, pct, plata } from "../lib/numeros";
import { useRecordado } from "../lib/recordado";

/** Cada calculadora recuerda lo que se escribió (en este navegador). */
export function Calculadoras() {
  return (
    <div>
      <Encabezado titulo="Calculadoras" subtitulo="Las cuentas se hacen mientras escribís. Los números van como en Argentina: 1.234,56." />
      {/* Dos columnas que se llenan solas (sin huecos entre tarjetas de distinto alto). */}
      <div className="gap-4 lg:columns-2 [&>*]:mb-4 [&>*]:break-inside-avoid">
        <Dias />
        <Bavosi />
        <Aumento />
        <Proporcion />
        <Encadenados />
      </div>
    </div>
  );
}

// ───────────── Piezas comunes ─────────────

function Tarjeta({ titulo, acciones, children }: { titulo: string; acciones?: ReactNode; children: ReactNode }) {
  return (
    <section className="tarjeta p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="font-semibold text-slate-900">{titulo}</h2>
        {acciones}
      </div>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

/** Campo de número que acepta "1.234,56"; se guarda el texto tal cual se escribió. */
function Numero({ etiqueta, valor, onChange, sufijo }: { etiqueta: string; valor: string; onChange: (v: string) => void; sufijo?: string }) {
  return (
    <label className="block min-w-0">
      <span className="etiqueta">{etiqueta}</span>
      <span className="relative block">
        <input className={`campo ${sufijo ? "pr-8" : ""}`} inputMode="decimal" value={valor} onChange={(e) => onChange(e.target.value)} />
        {sufijo && <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-slate-400">{sufijo}</span>}
      </span>
    </label>
  );
}

/** Un resultado; "-" si todavía no se puede calcular. */
function Resultado({ titulo, valor, destacado }: { titulo: string; valor: string | null; destacado?: boolean }) {
  return (
    <div className={`flex items-baseline justify-between gap-3 ${destacado ? "rounded-lg bg-marca-suave px-3 py-2 font-semibold text-marca-profundo" : "text-sm"}`}>
      <span className={destacado ? "" : "text-slate-500"}>{titulo}</span>
      <span className="tabular-nums">{valor ?? "-"}</span>
    </div>
  );
}

const Limpiar = ({ onClick }: { onClick: () => void }) => (
  <Boton chico icono={<Eraser className="size-3.5" />} onClick={onClick}>
    Limpiar
  </Boton>
);

/** Un número o null, para que un cálculo con algún dato vacío muestre "-". */
const n = aNumero;

// ───────────── 📅 Días ─────────────

function Dias() {
  const [d, set] = useRecordado("calc-dias", { inicio: ahora().toISODate()!, dias: "" });
  const dias = n(d.dias);
  const fin = d.inicio && dias !== null ? DateTime.fromISO(d.inicio).setLocale("es").plus({ days: Math.trunc(dias) }) : null;
  return (
    <Tarjeta titulo="📅 Días">
      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="etiqueta">Fecha de inicio</span>
          <input type="date" className="campo" value={d.inicio} onChange={(e) => set({ ...d, inicio: e.target.value })} />
        </label>
        <Numero etiqueta="Más días" valor={d.dias} onChange={(v) => set({ ...d, dias: v })} />
      </div>
      <Resultado titulo="Fecha final" valor={fin?.isValid ? fin.toFormat("cccc dd/MM/yyyy") : null} destacado />
    </Tarjeta>
  );
}

// ───────────── 🧮 Bavosi ─────────────

const BAVOSI = { precio: "", descuento: "0", iva: "21", flete: "0", markup: "0", cantidad: "1" };

function Bavosi() {
  const [d, set] = useRecordado("calc-bavosi", BAVOSI);
  const precio = n(d.precio);
  const r = precio === null ? null : bavosi({ precio, descuento: n(d.descuento) ?? 0, iva: n(d.iva) ?? 0, flete: n(d.flete) ?? 0, markup: n(d.markup) ?? 0, cantidad: n(d.cantidad) ?? 1 });
  const campo = (k: keyof typeof BAVOSI, etiqueta: string, sufijo?: string) => <Numero etiqueta={etiqueta} valor={d[k]} sufijo={sufijo} onChange={(v) => set({ ...d, [k]: v })} />;
  const p = (v: number | undefined) => (v === undefined ? null : plata(v));
  return (
    <Tarjeta titulo="🧮 Bavosi" acciones={<Limpiar onClick={() => set(BAVOSI)} />}>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {campo("precio", "Precio", "$")}
        {campo("descuento", "Descuento", "%")}
        {campo("iva", "IVA", "%")}
        {campo("flete", "Flete", "%")}
        {campo("markup", "Markup", "%")}
        {campo("cantidad", "Cantidad")}
      </div>
      <div className="space-y-1.5 border-t border-slate-100 pt-3">
        <Resultado titulo="Con descuento" valor={p(r?.conDescuento)} />
        <Resultado titulo="Con IVA" valor={p(r?.conIva)} />
        <Resultado titulo="Mi costo" valor={p(r?.miCosto)} />
        <Resultado titulo="Total final" valor={p(r?.total)} />
        <Resultado titulo="Costo unitario" valor={p(r?.unitario)} destacado />
      </div>
      <NotaGuardada clave="bavosi" />
    </Tarjeta>
  );
}

/** Nota que se guarda sola (cifrada) al dejar de escribir. "Limpiar" no la borra. */
function NotaGuardada({ clave }: { clave: string }) {
  const [texto, setTexto] = useState<string | null>(null);
  const [estado, setEstado] = useState("");
  const espera = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    get<{ texto: string }>(`/api/calculadoras/notas/${clave}`)
      .then((r) => setTexto(r.texto))
      .catch(() => setEstado("No se pudo cargar la nota"));
    return () => {
      if (espera.current) clearTimeout(espera.current);
    };
  }, [clave]);
  const cambiar = (v: string) => {
    setTexto(v);
    setEstado("Guardando…");
    if (espera.current) clearTimeout(espera.current);
    espera.current = setTimeout(() => {
      put<{ actualizadoEn: string }>(`/api/calculadoras/notas/${clave}`, { texto: v })
        .then((r) => setEstado(`Guardado ✓ ${hora(r.actualizadoEn)}`))
        .catch(() => setEstado("No se pudo guardar: probá de nuevo"));
    }, 800);
  };
  return (
    <label className="block">
      <span className="etiqueta flex justify-between">
        Nota <span className="font-normal normal-case tracking-normal text-slate-400">{estado}</span>
      </span>
      <textarea className="campo min-h-20" disabled={texto === null} value={texto ?? ""} onChange={(e) => cambiar(e.target.value)} placeholder="Se guarda sola, cifrada." />
    </label>
  );
}

// ───────────── 📊 Aumento % ─────────────

const AUMENTO = { anterior: "", nuevo: "", base: "", porcentaje: "" };

function Aumento() {
  const [d, set] = useRecordado("calc-aumento", AUMENTO);
  const [anterior, nuevo, base, porcentaje] = [n(d.anterior), n(d.nuevo), n(d.base), n(d.porcentaje)];
  const cambio = anterior !== null && nuevo !== null ? variacion(anterior, nuevo) : null;
  const aplicado = base !== null && porcentaje !== null ? base * (1 + porcentaje / 100) : null;
  return (
    <Tarjeta titulo="📊 Aumento %" acciones={<Limpiar onClick={() => set(AUMENTO)} />}>
      <p className="text-xs font-medium text-slate-500">¿Cuánto aumentó?</p>
      <div className="grid grid-cols-2 gap-3">
        <Numero etiqueta="Anterior" valor={d.anterior} onChange={(v) => set({ ...d, anterior: v })} />
        <Numero etiqueta="Nuevo" valor={d.nuevo} onChange={(v) => set({ ...d, nuevo: v })} />
      </div>
      <Resultado titulo="Variación" valor={cambio === null ? null : `${pct(cambio, true)} (${plata(nuevo! - anterior!)})`} destacado />
      <p className="border-t border-slate-100 pt-3 text-xs font-medium text-slate-500">Aplicar un % a un valor</p>
      <div className="grid grid-cols-2 gap-3">
        <Numero etiqueta="Valor" valor={d.base} onChange={(v) => set({ ...d, base: v })} />
        <Numero etiqueta="Porcentaje" sufijo="%" valor={d.porcentaje} onChange={(v) => set({ ...d, porcentaje: v })} />
      </div>
      <Resultado titulo="Resultado" valor={aplicado === null ? null : `${plata(aplicado)} (${plata(aplicado - base!)})`} destacado />
    </Tarjeta>
  );
}

// ───────────── 📐 Proporción % ─────────────

const PROPORCION = { parte: "", total: "" };

function Proporcion() {
  const [d, set] = useRecordado("calc-proporcion", PROPORCION);
  const [parte, total] = [n(d.parte), n(d.total)];
  const r = parte !== null && total !== null ? proporcion(parte, total) : null;
  return (
    <Tarjeta titulo="📐 Proporción %" acciones={<Limpiar onClick={() => set(PROPORCION)} />}>
      <div className="grid grid-cols-2 gap-3">
        <Numero etiqueta="Parte" valor={d.parte} onChange={(v) => set({ ...d, parte: v })} />
        <Numero etiqueta="Total" valor={d.total} onChange={(v) => set({ ...d, total: v })} />
      </div>
      <Resultado titulo="Representa" valor={r === null ? null : pct(r)} destacado />
    </Tarjeta>
  );
}

// ───────────── 🔗 Porcentajes encadenados ─────────────

type OperacionEscrita = { tipo: OperacionPct["tipo"]; valor: string };
const ENCADENADOS = { base: "", dividir: "", operaciones: [{ tipo: "+", valor: "" }] as OperacionEscrita[] };

function Encadenados() {
  const [d, set] = useRecordado("calc-encadenados", ENCADENADOS);
  const base = n(d.base);
  const validas = d.operaciones.flatMap((o) => (n(o.valor) === null ? [] : [{ tipo: o.tipo, valor: n(o.valor)! }]));
  const pasos = base === null ? [] : encadenar(base, validas);
  const final = base === null ? null : (pasos.at(-1)?.resultado ?? base);
  const divisor = n(d.dividir);
  const cambiar = (i: number, op: Partial<OperacionEscrita>) => set({ ...d, operaciones: d.operaciones.map((o, j) => (j === i ? { ...o, ...op } : o)) });
  return (
    <Tarjeta titulo="🔗 Porcentajes encadenados" acciones={<Limpiar onClick={() => set(ENCADENADOS)} />}>
      <Numero etiqueta="Precio base" sufijo="$" valor={d.base} onChange={(v) => set({ ...d, base: v })} />
      <div className="space-y-2">
        <span className="etiqueta">Aumentos y descuentos, en orden (cada uno sobre el resultado anterior)</span>
        {d.operaciones.map((o, i) => (
          <div key={i} className="flex items-center gap-2">
            <div className="flex shrink-0 overflow-hidden rounded-lg border border-slate-300">
              {(["+", "-"] as const).map((t) => (
                <button key={t} onClick={() => cambiar(i, { tipo: t })} className={`w-9 py-2 text-sm font-semibold ${o.tipo === t ? (t === "+" ? "bg-red-50 text-red-700" : "bg-marca-suave text-marca-profundo") : "bg-white text-slate-400"}`}>
                  {t === "+" ? "+" : "−"}
                </button>
              ))}
            </div>
            <span className="relative block min-w-0 flex-1">
              <input className="campo pr-8" inputMode="decimal" aria-label={`Porcentaje ${i + 1}`} value={o.valor} onChange={(e) => cambiar(i, { valor: e.target.value })} />
              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-slate-400">%</span>
            </span>
            <button aria-label="Quitar" onClick={() => set({ ...d, operaciones: d.operaciones.filter((_, j) => j !== i) })} className="rounded-lg p-2 text-slate-400 hover:bg-red-50 hover:text-red-600">
              <X className="size-4" />
            </button>
          </div>
        ))}
        <Boton chico icono={<Plus className="size-3.5" />} onClick={() => set({ ...d, operaciones: [...d.operaciones, { tipo: "+", valor: "" }] })}>
          Agregar %
        </Boton>
      </div>
      {pasos.length > 0 && (
        <ol className="space-y-1 border-t border-slate-100 pt-3 text-sm">
          {pasos.map((p, i) => (
            <li key={i} className="flex justify-between gap-3">
              <span className="text-slate-500">
                {i + 1}. {p.tipo === "+" ? "+" : "−"}
                {pct(p.valor)}
              </span>
              <span className="tabular-nums">{plata(p.resultado)}</span>
            </li>
          ))}
        </ol>
      )}
      <Resultado titulo="Resultado" valor={final === null ? null : `${plata(final)}${base ? ` (${pct(variacion(base, final)!, true)})` : ""}`} destacado />
      <Numero etiqueta="Dividir en" valor={d.dividir} onChange={(v) => set({ ...d, dividir: v })} />
      {final !== null && divisor !== null && divisor > 1 && <Resultado titulo={`Cada parte (÷ ${divisor})`} valor={plata(final / divisor)} destacado />}
    </Tarjeta>
  );
}
