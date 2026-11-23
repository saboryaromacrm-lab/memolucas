import { useState, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, FileText, X } from "lucide-react";
import { Boton, Modal, useAccion, useAviso } from "../componentes/ui";
import { post } from "../lib/api";
import { aCampo, aNumero, plata } from "../lib/numeros";
import { leerPdf } from "../lib/pdf";
import { useRecordado } from "../lib/recordado";

type Cuota = { comercio: string; fechaCompra: string | null; cuotaActual: number; cuotaTotal: number; montoCuota: number };
type Lectura = {
  cierre: string;
  vencimiento: string;
  saldo: number;
  pagoMinimo: number;
  disponibleCompra: number;
  disponibleCuotas: number;
  cuotas: Cuota[];
  consumos: { nombre: string; monto: number }[];
  cargos: { descripcion: string; monto: number }[];
  faltan: string[];
};
type Resultado = { masNuevo: boolean; cuotasNuevas: number; cuotasActualizadas: number; consumos: number };

const CAMPOS = [
  ["cierre", "Cierre", "fecha"],
  ["vencimiento", "Vencimiento", "fecha"],
  ["saldo", "Saldo actual", "plata"],
  ["pagoMinimo", "Pago mínimo", "plata"],
  ["disponibleCompra", "Disponible para compras", "plata"],
  ["disponibleCuotas", "Disponible en cuotas", "plata"],
] as const;
type Clave = (typeof CAMPOS)[number][0];

const ERRORES_PDF = {
  clave: "El PDF tiene contraseña: escribila y volvé a elegir el archivo.",
  "clave-incorrecta": "La contraseña no es correcta.",
  ilegible: "No se pudo leer ese PDF. Probá copiando el texto y pegándolo abajo.",
};

/** Importar un resumen: el PDF se lee en el navegador (o se pega el texto), Claude lo ordena y se revisa antes de guardar. */
export function ImportarResumen({ tarjetaId, onCerrar }: { tarjetaId: number; onCerrar: () => void }) {
  const [texto, setTexto] = useState("");
  const [pdf, setPdf] = useRecordado("tarjetas-pdf", { clave: "" });
  const [errorPdf, setErrorPdf] = useState<string | null>(null);
  const [leyendo, setLeyendo] = useState(false);
  const [lectura, setLectura] = useState<Lectura | null>(null);
  const accion = useAccion();

  const elegirPdf = async (archivo: File | undefined) => {
    if (!archivo) return;
    setErrorPdf(null);
    setLeyendo(true);
    const r = await leerPdf(archivo, pdf.clave);
    setLeyendo(false);
    if ("error" in r) setErrorPdf(ERRORES_PDF[r.error]);
    else setTexto(r.texto);
  };
  const leer = async () => {
    setLeyendo(true);
    const r = await accion(() => post<Lectura>("/api/tarjetas/leer-resumen", { texto }));
    setLeyendo(false);
    if (r) setLectura(r);
  };

  if (lectura) return <Revisar tarjetaId={tarjetaId} lectura={lectura} onVolver={() => setLectura(null)} onCerrar={onCerrar} />;
  return (
    <Modal
      abierto
      onCerrar={onCerrar}
      titulo="Importar resumen · 1 de 2"
      pie={
        <>
          <Boton onClick={onCerrar}>Cancelar</Boton>
          <Boton variante="primario" cargando={leyendo} disabled={texto.trim().length < 50} onClick={() => void leer()}>
            Leer resumen
          </Boton>
        </>
      }
    >
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-[1fr_200px]">
          <label className="block">
            <span className="etiqueta">PDF del resumen</span>
            <input type="file" accept="application/pdf" className="campo file:mr-3 file:rounded file:border-0 file:bg-slate-100 file:px-2 file:py-1" onChange={(e) => void elegirPdf(e.target.files?.[0])} />
          </label>
          <label className="block">
            <span className="etiqueta">Contraseña (si tiene)</span>
            <input type="password" className="campo" autoComplete="off" value={pdf.clave} onChange={(e) => setPdf({ clave: e.target.value })} />
          </label>
        </div>
        {errorPdf && <p className="text-sm text-red-600">{errorPdf}</p>}
        <p className="text-xs text-slate-500">El PDF se lee en este navegador: no se sube a ningún lado. La contraseña se recuerda solo acá.</p>
        <label className="block">
          <span className="etiqueta">Texto del resumen (o pegalo acá)</span>
          <textarea className="campo min-h-48 font-mono text-xs" value={texto} onChange={(e) => setTexto(e.target.value)} placeholder="CIERRE ACTUAL 16 Nov 26 · VENCIMIENTO 25 Nov 26 · SALDO ACTUAL $ …" />
        </label>
        {leyendo && texto && <p className="text-sm text-slate-500">Leyendo el resumen con IA… (puede tardar unos segundos)</p>}
      </div>
    </Modal>
  );
}

function Tabla({ titulo, columnas, filas, onQuitar }: { titulo: string; columnas: string[]; filas: ReactNode[][]; onQuitar: (i: number) => void }) {
  if (!filas.length) return null;
  return (
    <div>
      <div className="etiqueta">
        {titulo} ({filas.length})
      </div>
      <div className="overflow-x-auto rounded-lg border border-slate-200">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs text-slate-500">
            <tr>
              {columnas.map((c, i) => (
                <th key={c} className={`px-3 py-1.5 font-medium ${i ? "text-right" : ""}`}>
                  {c}
                </th>
              ))}
              <th className="w-8" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {filas.map((f, i) => (
              <tr key={i}>
                {f.map((celda, j) => (
                  <td key={j} className={`px-3 py-1.5 ${j ? "text-right tabular-nums" : ""}`}>
                    {celda}
                  </td>
                ))}
                <td className="pr-1 text-right">
                  <button onClick={() => onQuitar(i)} aria-label="Quitar" title="No es correcto: quitarlo" className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600">
                    <X className="size-3.5" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Revisar({ tarjetaId, lectura, onVolver, onCerrar }: { tarjetaId: number; lectura: Lectura; onVolver: () => void; onCerrar: () => void }) {
  const [campos, setCampos] = useState<Record<Clave, string>>(
    () => Object.fromEntries(CAMPOS.map(([k, , tipo]) => [k, tipo === "fecha" ? lectura[k] : lectura.faltan.includes(k) ? "" : aCampo(lectura[k] as number)])) as Record<Clave, string>,
  );
  const [cuotas, setCuotas] = useState(lectura.cuotas);
  const [consumos, setConsumos] = useState(lectura.consumos);
  const [cargos, setCargos] = useState(lectura.cargos);
  const [guardando, setGuardando] = useState(false);
  const accion = useAccion();
  const avisar = useAviso();
  const faltan = CAMPOS.filter(([k]) => !campos[k].trim()).map(([, nombre]) => nombre);
  const quitar = <T,>(lista: T[], set: (l: T[]) => void) => (i: number) => set(lista.filter((_, j) => j !== i));

  const guardar = async () => {
    setGuardando(true);
    const numero = (k: Clave) => aNumero(campos[k]) ?? 0;
    const datos = {
      cierre: campos.cierre,
      vencimiento: campos.vencimiento || null,
      saldo: numero("saldo"),
      pagoMinimo: numero("pagoMinimo"),
      disponibleCompra: numero("disponibleCompra"),
      disponibleCuotas: numero("disponibleCuotas"),
      cuotas,
      consumos,
      cargos,
    };
    const r = await accion(() => post<Resultado>(`/api/tarjetas/${tarjetaId}/resumenes`, datos));
    setGuardando(false);
    if (!r) return;
    avisar(
      r.masNuevo
        ? `Resumen guardado: ${r.cuotasNuevas} ${r.cuotasNuevas === 1 ? "compra nueva" : "compras nuevas"} en cuotas y ${r.cuotasActualizadas} ${r.cuotasActualizadas === 1 ? "actualizada" : "actualizadas"}`
        : "Era un resumen anterior: quedó en el historial sin cambiar los datos actuales",
    );
    onCerrar();
  };

  return (
    <Modal
      abierto
      onCerrar={onCerrar}
      titulo="Importar resumen · 2 de 2"
      ancho="max-w-3xl"
      pie={
        <>
          <Boton className="mr-auto" onClick={onVolver}>
            Volver
          </Boton>
          <Boton onClick={onCerrar}>Cancelar</Boton>
          <Boton variante="primario" cargando={guardando} disabled={!campos.cierre} onClick={() => void guardar()}>
            Guardar resumen
          </Boton>
        </>
      }
    >
      <div className="space-y-4">
        {faltan.length ? (
          <p className="flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" /> No encontré: {faltan.join(", ")}. Completalo a mano{!campos.cierre && " (el cierre es obligatorio)"}.
          </p>
        ) : (
          <p className="flex items-center gap-2 rounded-lg bg-marca-suave px-3 py-2 text-sm text-marca-profundo">
            <CheckCircle2 className="size-4 shrink-0" /> Encontré todos los datos. Revisalos y guardá.
          </p>
        )}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {CAMPOS.map(([k, nombre, tipo]) => (
            <label key={k} className="block">
              <span className="etiqueta">{nombre}</span>
              <input
                className="campo"
                type={tipo === "fecha" ? "date" : "text"}
                inputMode={tipo === "plata" ? "decimal" : undefined}
                value={campos[k]}
                onChange={(e) => setCampos({ ...campos, [k]: e.target.value })}
              />
            </label>
          ))}
        </div>
        <Tabla
          titulo="Compras en cuotas"
          columnas={["Comercio", "Cuota", "Monto"]}
          filas={cuotas.map((c) => [c.comercio, `${c.cuotaActual}/${c.cuotaTotal}`, plata(c.montoCuota)])}
          onQuitar={quitar(cuotas, setCuotas)}
        />
        <Tabla titulo="Consumos que se repiten cada mes" columnas={["Consumo", "Monto"]} filas={consumos.map((c) => [c.nombre, plata(c.monto)])} onQuitar={quitar(consumos, setConsumos)} />
        <Tabla titulo="Cargos del banco" columnas={["Cargo", "Monto"]} filas={cargos.map((c) => [c.descripcion, plata(c.monto)])} onQuitar={quitar(cargos, setCargos)} />
        {!cuotas.length && !consumos.length && !cargos.length && (
          <p className="flex items-center gap-2 text-sm text-slate-500">
            <FileText className="size-4" /> No encontré cuotas, consumos que se repiten ni cargos.
          </p>
        )}
      </div>
    </Modal>
  );
}
