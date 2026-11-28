import { useState } from "react";
import { Sparkles } from "lucide-react";
import { archivoParaIa, CampoIa } from "../componentes/CampoIa";
import { Boton, useAccion } from "../componentes/ui";
import { post, put } from "../lib/api";
import type { ConfigPagos, PropuestaPagos } from "../lib/tipos";
import { useDatos } from "../lib/vivo";
import { filasDePropuesta, RevisionIa, type FilaIa } from "./PagosRevisionIa";

/**
 * La IA de Pagos, arriba de todo: lo que escribís, dictás o pegás (una foto o un PDF) se arma contra lo que ya tenés
 * (conceptos, montos de uno o varios meses, lo pagado y lo suelto) y lo revisás antes de aplicarlo.
 */
export function PagosIa() {
  const config = useDatos<ConfigPagos>("/api/pagos/config", ["pagos", "tarjetas"]).datos;
  const [texto, setTexto] = useState("");
  const [archivo, setArchivo] = useState<File | null>(null);
  const [armando, setArmando] = useState(false);
  const [revision, setRevision] = useState<{ filas: FilaIa[]; totalImagen: number | null; mensaje: string; cargaId: number } | null>(null);
  const [mensaje, setMensaje] = useState("");
  const accion = useAccion();

  const armar = async () => {
    if (!config) return;
    setArmando(true);
    setMensaje("");
    const r = await accion(async () => post<PropuestaPagos>("/api/pagos/ia/armar", { texto, archivo: archivo ? await archivoParaIa(archivo) : undefined }));
    setArmando(false);
    if (!r) return;
    const cargado = (id: number) => config.fijos.find((f) => f.id === id);
    const filas = filasDePropuesta({
      ...r,
      cambios: r.cambios.flatMap((c) => {
        const antes = cargado(c.id);
        return antes ? [{ antes, despues: c.despues }] : [];
      }),
      borrar: r.borrar.flatMap((id) => cargado(id) ?? []),
    });
    if (filas.length) setRevision({ filas, totalImagen: r.totalImagen, mensaje: r.mensaje, cargaId: r.cargaId });
    else setMensaje(r.mensaje || "No encontré nada para cargar.");
  };
  const listo = () => {
    setRevision(null);
    setTexto("");
    setArchivo(null);
  };

  return (
    <section className="mb-5 rounded-xl border border-teal-200 bg-gradient-to-br from-teal-50 to-white p-4">
      <h2 className="flex items-center gap-1.5 text-sm font-semibold text-marca-profundo">
        <Sparkles className="size-4" /> Cargá o cambiá con IA
      </h2>
      <p className="mt-1 text-sm text-slate-600">
        Escribí, dictá o pegá una foto o un PDF (el resumen de la contadora, una boleta): lo que pagás siempre, montos de uno o varios meses, lo que ya está pagado (y quién lo pagó) o pagos sueltos. Lo revisás antes de guardar (cuesta unos centavos).
      </p>
      <div className="mt-2">
        <CampoIa
          texto={texto}
          onTexto={setTexto}
          archivo={archivo}
          onArchivo={setArchivo}
          placeholder="Lo de octubre de la contadora, lo pagó ella el 12/11 · En el Express 1 pago alquiler 650 mil el 5 · Pagué 300 mil de alquiler por octubre, noviembre y diciembre · Le pagué 50 mil al plomero"
        />
      </div>
      {config && (
        <details className="mt-2 text-sm">
          <summary className="cursor-pointer text-slate-600">Lo que la IA tiene que saber de tus negocios</summary>
          <textarea
            className="campo mt-2 min-h-20"
            defaultValue={config.notasIa}
            placeholder="Qué locales son de qué empresa, cómo se reparte algo, cómo le decís a cada cosa, qué va a mes vencido…"
            onBlur={(e) => e.target.value.trim() !== config.notasIa && void accion(() => put("/api/pagos/ajustes", { notasIa: e.target.value }), "Guardado")}
          />
          <span className="text-xs text-slate-500">La IA lo tiene en cuenta cada vez que carga o cambia pagos (también con fotos y PDF).</span>
        </details>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <Boton variante="primario" icono={<Sparkles className="size-4" />} cargando={armando} disabled={!config || (texto.trim().length < 3 && !archivo)} onClick={() => void armar()}>
          Armar con IA
        </Boton>
        {mensaje && <p className="text-sm text-amber-700">{mensaje}</p>}
      </div>
      {revision && config && <RevisionIa config={config} {...revision} onCerrar={() => setRevision(null)} onListo={listo} />}
    </section>
  );
}
