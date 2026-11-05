import { useEffect, useState, type ReactNode } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { useAccion } from "../componentes/ui";
import { post, put } from "../lib/api";
import type { Compra, ComprobanteDatos } from "../lib/tipos";
import { aNumero, Ventana, type Ancho } from "./comun";

type Datos = ComprobanteDatos;
type Renglon = Datos["renglones"][number];
type Cambiar = (f: (d: Datos) => Datos) => void;

const TIPOS = [
  ["factura", "Factura"],
  ["nota_credito", "Nota de crédito"],
  ["nota_debito", "Nota de débito"],
  ["remito", "Remito"],
  ["liquidacion", "Liquidación"],
  ["ticket", "Ticket"],
  ["otro", "Otro"],
] as const;
const RENGLON_NUEVO: Renglon = { clase: "mercaderia", codigo: "", descripcion: "", cantidad: 1, unidad: "UN", unidadesPorBulto: 0, precioUnitario: 0, descuentos: [], importe: 0, alicuotaIva: 0, cierra: true };

/** Corregir: escribiendo lo que está mal (lo aplica la IA) o tocando los datos. */
export function Correccion({ c, ancho, onCerrar, onListo }: { c: Compra & { datos: Datos }; ancho: Ancho; onCerrar: () => void; onListo: () => void }) {
  const [modo, setModo] = useState<"escribir" | "editar">("escribir");
  const [texto, setTexto] = useState("");
  const [d, setD] = useState<Datos>(() => structuredClone(c.datos));
  const [guardando, setGuardando] = useState(false);
  const accion = useAccion();

  const enviar = async () => {
    setGuardando(true);
    const ok =
      modo === "escribir"
        ? await accion(() => post(`/api/c/compras/${c.id}/corregir`, { texto }), "Corregida")
        : await accion(() => put(`/api/c/compras/${c.id}`, { datos: d }), "Guardada");
    setGuardando(false);
    if (ok) onListo();
  };

  return (
    <Ventana
      titulo={`Corregir · ${c.proveedor || c.titulo}`}
      onCerrar={onCerrar}
      ancho={modo === "escribir" ? "max-w-2xl" : "max-w-6xl"}
      pie={
        <div className="flex justify-end">
          <button
            onClick={() => void enviar()}
            disabled={guardando || (modo === "escribir" && texto.trim().length < 2)}
            className="flex w-full items-center justify-center gap-2 rounded-2xl bg-cafe px-8 py-4 font-semibold text-beige hover:bg-marca-profundo disabled:opacity-50 md:w-auto md:py-3"
          >
            {guardando && <Loader2 className="size-5 animate-spin" />}
            {modo === "escribir" ? (guardando ? "Corrigiendo… (puede tardar un poco)" : "Corregir") : "Guardar cambios"}
          </button>
        </div>
      }
    >
      <div className="px-4 py-4 md:px-6">
        <div className="mb-4 grid grid-cols-2 gap-1 rounded-xl bg-stone-200/70 p-1 text-sm font-medium md:max-w-md">
          {(["escribir", "editar"] as const).map((v) => (
            <button key={v} onClick={() => setModo(v)} className={`rounded-lg py-2 ${modo === v ? "bg-white shadow-sm" : "text-stone-500"}`}>
              {v === "escribir" ? "Escribir qué está mal" : "Editar los datos"}
            </button>
          ))}
        </div>
        {modo === "escribir" ? (
          <div className="space-y-2">
            <textarea
              className="campo min-h-36"
              autoFocus
              placeholder="Ej.: el renglón 3 son 12 unidades · el total es 15.300,50 · falta la percepción de IIBB de 896,90"
              value={texto}
              onChange={(e) => setTexto(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && (e.ctrlKey || e.metaKey) && texto.trim().length >= 2 && void enviar()}
            />
            <p className="text-xs text-stone-500">La IA vuelve a mirar la foto, aplica la corrección y rehace las cuentas.</p>
          </div>
        ) : ancho === "movil" ? (
          <Formulario d={d} setD={setD} />
        ) : (
          <Planilla d={d} setD={setD} />
        )}
      </div>
    </Ventana>
  );
}

/** Número que se escribe como en Argentina (coma decimal) y se guarda al salir del campo. */
function CampoNumero({ valor, onChange, className = "campo" }: { valor: number; onChange: (n: number) => void; className?: string }) {
  const [texto, setTexto] = useState(String(valor).replace(".", ","));
  useEffect(() => setTexto(String(valor).replace(".", ",")), [valor]);
  return <input className={`${className} tabular-nums`} inputMode="decimal" value={texto} onChange={(e) => setTexto(e.target.value)} onBlur={() => onChange(aNumero(texto))} />;
}

function Etiquetado({ etiqueta, children }: { etiqueta: string; children: ReactNode }) {
  return (
    <label className="block min-w-0">
      <span className="etiqueta">{etiqueta}</span>
      {children}
    </label>
  );
}

const Numero = ({ etiqueta, valor, onChange }: { etiqueta: string; valor: number; onChange: (n: number) => void }) => (
  <Etiquetado etiqueta={etiqueta}>
    <CampoNumero valor={valor} onChange={onChange} />
  </Etiquetado>
);
const Texto = ({ etiqueta, valor, onChange, tipo = "text" }: { etiqueta: string; valor: string; onChange: (s: string) => void; tipo?: string }) => (
  <Etiquetado etiqueta={etiqueta}>
    <input className="campo" type={tipo} value={valor} onChange={(e) => onChange(e.target.value)} />
  </Etiquetado>
);

/** Cambios comunes a las dos formas de editar. */
function editores(setD: Cambiar) {
  return {
    enc: (k: string, v: string | number) => setD((x) => ({ ...x, encabezado: { ...x.encabezado, [k]: v } })),
    ren: (i: number, cambios: Partial<Renglon>) => setD((x) => ({ ...x, renglones: x.renglones.map((r, j) => (j === i ? { ...r, ...cambios } : r)) })),
    quitar: (i: number) => setD((x) => ({ ...x, renglones: x.renglones.filter((_, j) => j !== i) })),
    agregar: () => setD((x) => ({ ...x, renglones: [...x.renglones, { ...RENGLON_NUEVO }] })),
    pie: (cambios: Partial<Datos["pie"]>) => setD((x) => ({ ...x, pie: { ...x.pie, ...cambios } })),
  };
}

const descuentosDe = (v: string) =>
  v
    .split("+")
    .map((x) => aNumero(x))
    .filter((x) => x > 0);

function Encabezado({ d, enc }: { d: Datos; enc: ReturnType<typeof editores>["enc"] }) {
  const e = d.encabezado;
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      <div className="col-span-2">
        <Texto etiqueta="Proveedor" valor={String(e.razonSocialEmisor)} onChange={(v) => enc("razonSocialEmisor", v)} />
      </div>
      <Texto etiqueta="CUIT" valor={String(e.cuitEmisor)} onChange={(v) => enc("cuitEmisor", v)} />
      <Texto etiqueta="Fecha" tipo="date" valor={String(e.fecha)} onChange={(v) => enc("fecha", v)} />
      <Etiquetado etiqueta="Tipo">
        <select className="campo" value={String(e.tipo)} onChange={(ev) => enc("tipo", ev.target.value)}>
          {TIPOS.map(([v, t]) => (
            <option key={v} value={v}>
              {t}
            </option>
          ))}
        </select>
      </Etiquetado>
      <Etiquetado etiqueta="Letra">
        <select className="campo" value={String(e.letra)} onChange={(ev) => enc("letra", ev.target.value)}>
          {["A", "B", "C", "M", "X", ""].map((l) => (
            <option key={l} value={l}>
              {l || "—"}
            </option>
          ))}
        </select>
      </Etiquetado>
      <Texto etiqueta="Punto de venta" valor={String(e.puntoVenta)} onChange={(v) => enc("puntoVenta", v)} />
      <Texto etiqueta="Número" valor={String(e.numero)} onChange={(v) => enc("numero", v)} />
    </div>
  );
}

function Totales({ d, pie }: { d: Datos; pie: ReturnType<typeof editores>["pie"] }) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Numero etiqueta="Subtotal" valor={d.pie.subtotal} onChange={(n) => pie({ subtotal: n })} />
        <Numero etiqueta="Bonificación $" valor={d.pie.bonificacionImporte} onChange={(n) => pie({ bonificacionImporte: n })} />
        <Numero etiqueta="Impuestos internos" valor={d.pie.impuestosInternos} onChange={(n) => pie({ impuestosInternos: n })} />
        <Numero etiqueta="Otros impuestos" valor={d.pie.otrosImpuestos} onChange={(n) => pie({ otrosImpuestos: n })} />
        <Numero etiqueta="Total" valor={d.pie.total} onChange={(n) => pie({ total: n })} />
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-2">
          {d.pie.ivas.map((x, i) => (
            <div key={`iva${i}`} className="grid grid-cols-2 gap-3">
              <Numero etiqueta="IVA %" valor={x.alicuota} onChange={(n) => pie({ ivas: d.pie.ivas.map((y, j) => (j === i ? { ...y, alicuota: n } : y)) })} />
              <Numero etiqueta={`Importe IVA ${x.alicuota}%`} valor={x.importe} onChange={(n) => pie({ ivas: d.pie.ivas.map((y, j) => (j === i ? { ...y, importe: n } : y)) })} />
            </div>
          ))}
          <button className="text-xs font-medium text-naranja" onClick={() => pie({ ivas: [...d.pie.ivas, { alicuota: 21, importe: 0 }] })}>
            + Agregar IVA
          </button>
        </div>
        <div className="space-y-2">
          {d.pie.percepciones.map((x, i) => (
            <div key={`per${i}`} className="grid grid-cols-2 gap-3">
              <Texto etiqueta="Percepción" valor={x.nombre} onChange={(v) => pie({ percepciones: d.pie.percepciones.map((y, j) => (j === i ? { ...y, nombre: v } : y)) })} />
              <Numero etiqueta="Importe" valor={x.importe} onChange={(n) => pie({ percepciones: d.pie.percepciones.map((y, j) => (j === i ? { ...y, importe: n } : y)) })} />
            </div>
          ))}
          <button className="text-xs font-medium text-naranja" onClick={() => pie({ percepciones: [...d.pie.percepciones, { nombre: "Percepción IIBB", tipo: "iibb", alicuota: 0, importe: 0 }] })}>
            + Agregar percepción
          </button>
        </div>
      </div>
    </div>
  );
}

function Seccion({ titulo, children }: { titulo: string; children: ReactNode }) {
  return (
    <section className="tarjeta space-y-3 p-4">
      <h3 className="font-semibold text-stone-800">{titulo}</h3>
      {children}
    </section>
  );
}

/** Celular: un bloque por renglón. */
function Formulario({ d, setD }: { d: Datos; setD: Cambiar }) {
  const e = editores(setD);
  return (
    <div className="space-y-4 pb-4">
      <Seccion titulo="Comprobante">
        <Encabezado d={d} enc={e.enc} />
      </Seccion>
      {d.renglones.map((r, i) => (
        <Seccion key={i} titulo={`Renglón ${i + 1}`}>
          <Texto etiqueta="Descripción" valor={r.descripcion} onChange={(v) => e.ren(i, { descripcion: v })} />
          <div className="grid grid-cols-2 gap-3">
            <Numero etiqueta="Cantidad" valor={r.cantidad} onChange={(n) => e.ren(i, { cantidad: n })} />
            <Numero etiqueta="Precio unitario" valor={r.precioUnitario} onChange={(n) => e.ren(i, { precioUnitario: n })} />
            <Texto etiqueta="Descuentos % (ej. 10+5)" valor={r.descuentos.join("+")} onChange={(v) => e.ren(i, { descuentos: descuentosDe(v) })} />
            <Numero etiqueta="Importe" valor={r.importe} onChange={(n) => e.ren(i, { importe: n })} />
          </div>
          <button className="flex items-center gap-1 text-xs font-medium text-red-600" onClick={() => e.quitar(i)}>
            <Trash2 className="size-3.5" /> Quitar renglón
          </button>
        </Seccion>
      ))}
      <button className="flex w-full items-center justify-center gap-1.5 rounded-xl border-2 border-dashed border-stone-300 py-3 text-sm font-medium text-stone-600" onClick={e.agregar}>
        <Plus className="size-4" /> Agregar renglón
      </button>
      <Seccion titulo="Totales">
        <Totales d={d} pie={e.pie} />
      </Seccion>
      <p className="text-xs text-stone-500">Al guardar se rehacen las cuentas para ver si cierran.</p>
    </div>
  );
}

const celda = "w-full rounded-md border border-transparent bg-transparent px-2 py-1.5 text-sm outline-none hover:border-stone-300 focus:border-naranja focus:bg-white focus:ring-2 focus:ring-naranja/20";

/** Compu: los renglones como planilla, para pasar de campo en campo con Tab. */
function Planilla({ d, setD }: { d: Datos; setD: Cambiar }) {
  const e = editores(setD);
  return (
    <div className="space-y-4">
      <Seccion titulo="Comprobante">
        <Encabezado d={d} enc={e.enc} />
      </Seccion>
      <section className="tarjeta overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="bg-stone-50 text-left text-xs font-semibold uppercase tracking-wide text-stone-500">
              <tr>
                <th className="w-8 px-3 py-2">#</th>
                <th className="px-2 py-2">Descripción</th>
                <th className="w-24 px-2 py-2 text-right">Cantidad</th>
                <th className="w-32 px-2 py-2 text-right">Precio unit.</th>
                <th className="w-24 px-2 py-2 text-right">Desc. %</th>
                <th className="w-36 px-2 py-2 text-right">Importe</th>
                <th className="w-10" />
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {d.renglones.map((r, i) => (
                <tr key={i} className="hover:bg-stone-50/60">
                  <td className="px-3 text-xs text-stone-400">{i + 1}</td>
                  <td className="px-1">
                    <input className={celda} value={r.descripcion} onChange={(ev) => e.ren(i, { descripcion: ev.target.value })} />
                  </td>
                  <td className="px-1">
                    <CampoNumero className={`${celda} text-right`} valor={r.cantidad} onChange={(n) => e.ren(i, { cantidad: n })} />
                  </td>
                  <td className="px-1">
                    <CampoNumero className={`${celda} text-right`} valor={r.precioUnitario} onChange={(n) => e.ren(i, { precioUnitario: n })} />
                  </td>
                  <td className="px-1">
                    <input className={`${celda} text-right`} value={r.descuentos.join("+")} onChange={(ev) => e.ren(i, { descuentos: descuentosDe(ev.target.value) })} />
                  </td>
                  <td className="px-1">
                    <CampoNumero className={`${celda} text-right font-medium`} valor={r.importe} onChange={(n) => e.ren(i, { importe: n })} />
                  </td>
                  <td className="px-1 text-center">
                    <button aria-label="Quitar renglón" title="Quitar renglón" onClick={() => e.quitar(i)} className="rounded p-1.5 text-stone-400 hover:bg-red-50 hover:text-red-600">
                      <Trash2 className="size-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button className="flex w-full items-center justify-center gap-1.5 border-t border-stone-100 py-2.5 text-sm font-medium text-stone-600 hover:bg-stone-50" onClick={e.agregar}>
          <Plus className="size-4" /> Agregar renglón
        </button>
      </section>
      <Seccion titulo="Totales">
        <Totales d={d} pie={e.pie} />
      </Seccion>
      <p className="text-xs text-stone-500">Al guardar se rehacen las cuentas para ver si cierran.</p>
    </div>
  );
}
